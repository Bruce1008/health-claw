#!/usr/bin/env node
"use strict";

// ============================================================================
// Health Claw — MCP Server v2
// ============================================================================
// 零外部依赖，只用 node 内置模块。
// 三个接口：1) stdio MCP (NDJSON)  2) 本地 HTTP (:7926)  3) child_process.spawn
// ============================================================================

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const http = require("http");
const { spawn } = require("child_process");
const os = require("os");

// ─── 枚举常量（与 references/state-schema.md 同步，修改需双向同步）──────────
const USER_STATE_STATUS_ENUM = ["available", "sick", "injured", "busy", "traveling", "low_motivation"];
const LAST_SCENE_STATUS_ENUM = ["done", "blocked", "needs_context", "error", "skipped"];
const INJURY_STATUS_ENUM = ["active", "recovered", "chronic"];
const FITNESS_LEVEL_ENUM = ["beginner", "intermediate", "advanced"];
const INTENSITY_ENUM = ["high", "medium", "low"];
const SESSION_MODE_ENUM = ["set-rest", "continuous", "interval", "flow", "timer", "passive"];
const SOURCE_ENUM = ["planned", "user_initiated"];
const FATIGUE_ENUM = ["low", "moderate", "high"];
const REPORT_TYPE_ENUM = ["readiness_assessment", "training_plan", "post_session", "daily_report", "weekly", "monthly"];
const HEALTH_LOG_EVENT_TYPES = ["scene_end", "session", "body_data", "signal", "status_change", "rest_day", "profile_update"];

// 只读工具：不消耗 pending_nodes 节点，也不会写 state
const READONLY_TOOLS = new Set([
  "read_state", "get_user_profile", "get_health_summary",
  "get_session_live", "get_workout_log", "query_health_log"
]);

// 由 update_state 自动镜像到 health-log 的事件类型——禁止模型手动 append_health_log 写这些
const AUTO_MIRRORED_EVENT_TYPES = new Set(["signal", "status_change", "session", "rest_day"]);

// ─── Mock 数据（eval 脚本通过正则替换这些常量）─────────────────────────────
const TODAY = "2026-04-12";
const healthSummary = { sleep: { total_min: 465, deep_min: 102, rem_min: 88, score: 82 }, hrv: { latest: 48, avg_7d: 52, trend: "falling" }, resting_hr: { latest: 58, avg_7d: 56 } };
const sessions = [{ date: "2026-04-11", type: "力量训练", session_mode: "set-rest", intensity: "high", duration_min: 55, calories: 420, source: "planned", summary: "胸+三头" }, { date: "2026-04-10", type: "有氧", session_mode: "continuous", intensity: "medium", duration_min: 30, calories: 280, source: "planned", summary: "5km 跑步" }];

// ─── 路径 ──────────────────────────────────────────────────────────────────
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

const DATA_ROOT = process.env.HEALTH_CLAW_DATA_ROOT || path.join(os.homedir(), "Library", "Application Support", "health-claw");
const CONTEXT_DIR = path.join(DATA_ROOT, "context");
const LOGS_DIR = path.join(DATA_ROOT, "logs");
const MEMORY_DIR = path.join(DATA_ROOT, "memory");
const STATE_PATH = path.join(CONTEXT_DIR, "state.json");
const STATE_BAK_PATH = path.join(CONTEXT_DIR, "state.json.bak");
const HEALTH_LOG_PATH = path.join(CONTEXT_DIR, "health-log.jsonl");
const MEMORY_FILE = path.join(DATA_ROOT, "MEMORY.md");

ensureDir(CONTEXT_DIR);
ensureDir(LOGS_DIR);
ensureDir(MEMORY_DIR);

// ─── 日期工具 ──────────────────────────────────────────────────────────────
function today() { return TODAY; }
function nowISO() { return new Date().toISOString(); }
function daysBetween(a, b) { return Math.floor((new Date(b) - new Date(a)) / 86400000); }

// ─── 文件读写（原子写入：先 .tmp 再 rename）──────────────────────────────
function readJSON(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJSON(p, obj) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function appendLine(p, line) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, line + "\n");
}

// ─── State 读写 ────────────────────────────────────────────────────────────
function readState() {
  const state = readJSON(STATE_PATH) || {
    user_state: { status: "available", since: today(), next_check: null },
    profile: null,
    training_state: {
      consecutive_training_days: 0,
      consecutive_rest_days: 0,
      recent_sessions: [],
      fatigue_estimate: "low",
      pending_adjustments: []
    },
    last_scene: null,
    signals: { body: [], schedule: [], motivation: [] },
    active_session: null,
    pending_nodes: []
  };
  if (!("active_session" in state)) state.active_session = null;
  if (!Array.isArray(state.pending_nodes)) state.pending_nodes = [];
  return state;
}

function buildReminders(state) {
  const reminders = [];
  const prof = state.profile;
  if (prof && Array.isArray(prof.injuries)) {
    for (const inj of prof.injuries) {
      if (inj.status !== "active") continue;
      // 首选 next_check_at，缺失时回退为 reported_at + 14 天
      let dueDate = inj.next_check_at;
      if (!dueDate && inj.reported_at) {
        const base = new Date(inj.reported_at);
        base.setDate(base.getDate() + 14);
        dueDate = base.toISOString().slice(0, 10);
      }
      if (dueDate && dueDate <= today()) {
        reminders.push({
          type: "injury_check",
          description: inj.description,
          due_date: dueDate,
          days_overdue: Math.max(0, daysBetween(dueDate, today()))
        });
      }
    }
  }
  if (prof && prof._meta) {
    const fields = [];
    if (prof._meta.goal_updated_at && daysBetween(prof._meta.goal_updated_at, today()) >= 30) fields.push("goal");
    if (prof._meta.fitness_level_updated_at && daysBetween(prof._meta.fitness_level_updated_at, today()) >= 30) fields.push("fitness_level");
    if (fields.length > 0) reminders.push({ type: "profile_review", fields });
  }
  if (Array.isArray(state.pending_nodes) && state.pending_nodes.length > 0) {
    reminders.push({
      type: "previous_scene_incomplete",
      remaining_count: state.pending_nodes.length,
      next_node: state.pending_nodes[0],
      hint: "上一个场景没走完。先补完 pending_nodes，或 control_session({action:'stop'}) 清场，再开新场景。"
    });
  }
  return reminders;
}

function cleanExpiredSignals(signals) {
  const cutoff72h = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  const cleaned = {};
  for (const cat of ["body", "motivation"]) {
    cleaned[cat] = (signals[cat] || []).filter(s => s.ts && s.ts >= cutoff72h);
  }
  // schedule 按日期自身过期
  cleaned.schedule = (signals.schedule || []).filter(s => {
    if (s.ts) return s.ts >= cutoff72h;
    return true;
  });
  return cleaned;
}

// ─── projection：按 dot-path 数组裁剪 state ────────────────────────────────
// projection 例：["profile.basic_info", "user_state", "training_state.recent_sessions"]
// 始终保留 pending_nodes（模型靠它判断剩余节点）。无效路径静默跳过。
function projectState(state, paths) {
  const result = {};
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const parts = p.split(".");
    let src = state;
    let dst = result;
    let ok = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (src == null || typeof src !== "object" || !(k in src)) { ok = false; break; }
      src = src[k];
      if (!dst[k] || typeof dst[k] !== "object" || Array.isArray(dst[k])) dst[k] = {};
      dst = dst[k];
    }
    if (!ok) continue;
    const last = parts[parts.length - 1];
    if (src && typeof src === "object" && last in src) dst[last] = src[last];
  }
  if (!("pending_nodes" in result)) result.pending_nodes = state.pending_nodes;
  return result;
}

// ─── 自动镜像 health-log ───────────────────────────────────────────────────
// update_state 触发的镜像规则：
//   patch.signals.body 新增项        → signal 事件（去重 by ts+type+detail）
//   patch.user_state.status 变化     → status_change 事件（reason 取自 patch.user_state._reason 或空）
//   patch.training_state.recent_sessions 新增项 → session 事件（去重 by date+type+duration_min）
//   patch.training_state.consecutive_rest_days 从 N → N+1 → rest_day 事件
function mirrorHealthLog(patch, oldState, _newState) {
  const events = [];
  const ts = nowISO();
  const date = today();

  // 1) signals.body 新增条目
  if (patch.signals && Array.isArray(patch.signals.body)) {
    const oldBody = (oldState.signals && Array.isArray(oldState.signals.body)) ? oldState.signals.body : [];
    const oldKeys = new Set(oldBody.map(e => `${e && e.ts}|${e && e.type}|${e && e.detail}`));
    for (const entry of patch.signals.body) {
      if (!entry || typeof entry !== "object") continue;
      const k = `${entry.ts}|${entry.type}|${entry.detail}`;
      if (oldKeys.has(k)) continue;
      const sig = {
        type: "signal",
        date,
        ts: entry.ts || ts,
        category: "body",
        signal_type: entry.type || "unspecified",
        detail: entry.detail || ""
      };
      if (entry.severity) sig.severity = entry.severity;
      events.push(sig);
    }
  }

  // 2) user_state.status 变化
  if (patch.user_state && patch.user_state.status) {
    const oldStatus = oldState.user_state && oldState.user_state.status;
    const newStatus = patch.user_state.status;
    if (oldStatus !== newStatus) {
      const ev = {
        type: "status_change",
        date,
        ts,
        from: oldStatus || "unknown",
        to: newStatus
      };
      if (patch.user_state._reason) ev.reason = patch.user_state._reason;
      events.push(ev);
    }
  }

  // 3) training_state.recent_sessions 新增条目
  if (patch.training_state && Array.isArray(patch.training_state.recent_sessions)) {
    const newSessions = patch.training_state.recent_sessions;
    const oldSessions = (oldState.training_state && Array.isArray(oldState.training_state.recent_sessions)) ? oldState.training_state.recent_sessions : [];
    const oldKeys = new Set(oldSessions.map(s => `${s && s.date}|${s && s.type}|${s && s.duration_min}`));
    for (const sess of newSessions) {
      if (!sess || typeof sess !== "object") continue;
      const k = `${sess.date}|${sess.type}|${sess.duration_min}`;
      if (oldKeys.has(k)) continue;
      events.push({
        type: "session",
        date: sess.date || date,
        ts,
        session: sess
      });
    }
  }

  // 4) training_state.consecutive_rest_days 从 N → N+1
  if (patch.training_state && typeof patch.training_state.consecutive_rest_days === "number") {
    const oldCount = (oldState.training_state && typeof oldState.training_state.consecutive_rest_days === "number") ? oldState.training_state.consecutive_rest_days : 0;
    const newCount = patch.training_state.consecutive_rest_days;
    if (newCount === oldCount + 1) {
      events.push({
        type: "rest_day",
        date,
        ts
      });
    }
  }

  return events;
}

// patch 顶层 key 列表（用于 update_state 返回 changed_keys）
function topLevelChangedKeys(patch) {
  if (!patch || typeof patch !== "object") return [];
  return Object.keys(patch);
}

// ─── 聚合：get_workout_log / get_health_summary 默认轻量返回 ───────────────
function aggregateSessions(list) {
  const byType = {};
  const byIntensity = { high: 0, medium: 0, low: 0 };
  let totalDuration = 0;
  let totalCalories = 0;
  for (const s of list) {
    if (!s) continue;
    if (s.type) byType[s.type] = (byType[s.type] || 0) + 1;
    if (s.intensity && byIntensity[s.intensity] !== undefined) byIntensity[s.intensity] += 1;
    if (typeof s.duration_min === "number") totalDuration += s.duration_min;
    if (typeof s.calories === "number") totalCalories += s.calories;
  }
  const dates = list.map(s => s && s.date).filter(Boolean).sort();
  return {
    total_sessions: list.length,
    total_duration_min: totalDuration,
    total_calories: totalCalories,
    by_type: byType,
    by_intensity: byIntensity,
    date_range: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null
  };
}

function summarizeHealth(latest) {
  if (!latest) return null;
  const out = {};
  if (latest.sleep) {
    out.sleep = {
      total_min: latest.sleep.total_min,
      score: latest.sleep.score
    };
  }
  if (latest.hrv) {
    out.hrv = {
      latest: latest.hrv.latest,
      avg_7d: latest.hrv.avg_7d,
      trend: latest.hrv.trend
    };
  }
  if (latest.resting_hr) {
    out.resting_hr = {
      latest: latest.resting_hr.latest,
      avg_7d: latest.resting_hr.avg_7d
    };
  }
  return out;
}

// ─── 深度合并 ──────────────────────────────────────────────────────────────
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (Array.isArray(sv)) {
      result[key] = sv; // 数组整体替换
    } else if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv, sv);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

// ─── pending_nodes 匹配 / 弹出 ────────────────────────────────────────────
// 节点格式: { id, tool, match? }
// match 可含:
//   - patch: 字符串，要求 args.patch 里有该 key；特例：patch=="last_scene" 时还要求 status === "done"
//   - report_type / name / action / status: 严格等值（status 用于 finish_scene 节点匹配）
//   - event_type: args.event.type 严格等值
function nodeMatches(node, toolName, args) {
  if (!node || node.tool !== toolName) return false;
  const m = node.match || {};
  if (m.patch !== undefined) {
    if (!args || !args.patch || args.patch[m.patch] === undefined) return false;
    if (m.patch === "last_scene") {
      if (!args.patch.last_scene || args.patch.last_scene.status !== "done") return false;
    }
  }
  if (m.report_type !== undefined && (!args || args.report_type !== m.report_type)) return false;
  if (m.name !== undefined && (!args || args.name !== m.name)) return false;
  if (m.action !== undefined && (!args || args.action !== m.action)) return false;
  if (m.status !== undefined && (!args || args.status !== m.status)) return false;
  if (m.event_type !== undefined) {
    const et = args && args.event && args.event.type;
    if (et !== m.event_type) return false;
  }
  return true;
}

function popMatchingNode(state, toolName, args) {
  if (!Array.isArray(state.pending_nodes) || state.pending_nodes.length === 0) {
    return { popped: null, remaining: [] };
  }
  for (let i = 0; i < state.pending_nodes.length; i++) {
    if (nodeMatches(state.pending_nodes[i], toolName, args)) {
      const popped = state.pending_nodes[i];
      const remaining = state.pending_nodes.slice(0, i).concat(state.pending_nodes.slice(i + 1));
      return { popped, remaining };
    }
  }
  return { popped: null, remaining: state.pending_nodes.slice() };
}

// ─── alert_hr 自动计算 ─────────────────────────────────────────────────────
function computeAlertHR(profile) {
  let maxHR = 190; // 最保守回退
  if (profile.max_hr_measured && typeof profile.max_hr_measured === "number") {
    maxHR = profile.max_hr_measured;
  } else if (profile.basic_info && typeof profile.basic_info.age === "number") {
    maxHR = 220 - profile.basic_info.age;
  }
  return { critical: Math.round(maxHR * 0.95), warning: Math.round(maxHR * 0.90) };
}

// ─── 工具调用日志 ──────────────────────────────────────────────────────────
function logToolCall(tool, payload) {
  const logFile = path.join(LOGS_DIR, `${today()}.tool-calls.jsonl`);
  const entry = JSON.stringify({ timestamp: nowISO(), tool, payload });
  appendLine(logFile, entry);
}

// ─── session 内工具调用记录（检查 7 天上下文）──────────────────────────────
const sessionToolsCalled = new Set();

// ─── SSE 客户端管理 ────────────────────────────────────────────────────────
const sseClients = [];

function pushSSE(tool, args) {
  const data = JSON.stringify({ tool, args });
  for (const res of sseClients) {
    try { res.write(`event: tool_call\ndata: ${data}\n\n`); } catch (_) { /* ignore broken connections */ }
  }
}

// ─── request_user_input 回调管理 ───────────────────────────────────────────
const pendingCallbacks = new Map(); // request_id → { resolve, timer }

function waitForCallback(requestId, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCallbacks.delete(requestId);
      reject(new Error("request_user_input timeout"));
    }, timeoutMs);
    pendingCallbacks.set(requestId, { resolve, timer });
  });
}

function resolveCallback(requestId, response) {
  const entry = pendingCallbacks.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingCallbacks.delete(requestId);
  entry.resolve(response);
  return true;
}

// ─── 工具 schema 定义 ──────────────────────────────────────────────────────
const TOOLS = [
  // ── 本地文件工具 (1-9) ──
  {
    name: "read_state",
    description: "读取 state.json（附带时效性提醒 reminders）。可选 projection 按 dot-path 裁剪，省 token。pending_nodes 始终返回。",
    inputSchema: {
      type: "object",
      properties: {
        projection: {
          type: "array",
          items: { type: "string" },
          description: "dot-path 字段列表，例 [\"profile.basic_info\",\"user_state\",\"training_state.recent_sessions\"]。不传或空数组 → 返回完整 state（兼容旧调用）"
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_user_profile",
    description: "读取 state.json → profile（read_state 的快捷方式）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "update_state",
    description: "局部更新 state.json（深度合并 + 枚举校验 + 备份 + alert_hr 自动重算）。**自动镜像 health-log**：signals.body 新增→signal、user_state.status 变化→status_change（reason 取自 user_state._reason 透传字段）、training_state.recent_sessions 新增→session、consecutive_rest_days N→N+1→rest_day。返回 {ok, changed_keys, remaining_pending_nodes}，不再回传完整 state。",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "object", description: "要合并的字段。user_state._reason 字段会被消费用于 status_change 镜像，写入后从 state 剥离。" }
      },
      required: ["patch"],
      additionalProperties: false
    }
  },
  {
    name: "finish_scene",
    description: "**场景收尾合并工具**：一次性写 last_scene + 当天 daily log（取代 update_state(last_scene) + write_daily_log 两次调用）。Server 自动追加 scene_end 事件到 health-log。daily_log_content 不传时按 summary 自动生成简短日志。**所有场景的最后一步都应改用本工具**。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "场景名，如 onboarding / readiness / workout_confirm / post_session / chat 等" },
        status: { type: "string", enum: LAST_SCENE_STATUS_ENUM, description: "场景终态" },
        summary: { type: "string", description: "一句话场景摘要" },
        daily_log_content: { type: "string", description: "Markdown 日志正文；不传则按 summary 自动生成 `## <name>\\n\\n- <status>: <summary>`" },
        ts: { type: "string", description: "ISO 时间戳，不传用 now" }
      },
      required: ["name", "status"],
      additionalProperties: false
    }
  },
  {
    name: "write_daily_log",
    description: "追加 markdown 到当天日志 logs/{date}.md。**场景收尾改用 finish_scene** —— 本工具仅用于跨场景或非场景上下文的额外落盘。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Markdown 内容" },
        date: { type: "string", description: "YYYY-MM-DD，默认今天" }
      },
      required: ["content"],
      additionalProperties: false
    }
  },
  {
    name: "append_health_log",
    description: "追加 JSON 事件到 health-log.jsonl（永不覆写）。**禁止手动写 signal/status_change/session/rest_day** —— 这 4 类由 update_state 自动镜像；scene_end/profile_update 也由 Server 自动写入。本工具只用于无对应 state 字段的事件。",
    inputSchema: {
      type: "object",
      properties: {
        event: {
          type: "object",
          description: "事件对象，需含 type/date/ts",
          properties: {
            type: { type: "string", enum: HEALTH_LOG_EVENT_TYPES },
            date: { type: "string" },
            ts: { type: "string" }
          },
          required: ["type", "date", "ts"]
        }
      },
      required: ["event"],
      additionalProperties: false
    }
  },
  {
    name: "query_health_log",
    description: "按日期/类型过滤 health-log.jsonl 事件（避免全量读取浪费 token）",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD 起始日期（含），不传即不限" },
        end_date: { type: "string", description: "YYYY-MM-DD 结束日期（含），不传即不限" },
        types: { type: "array", items: { type: "string", enum: HEALTH_LOG_EVENT_TYPES }, description: "事件类型过滤；不传即所有 7 种" },
        limit: { type: "number", description: "返回条数上限，默认 100，最大 1000" }
      },
      additionalProperties: false
    }
  },
  {
    name: "write_global_memory",
    description: "写入全局记忆（daily → memory/{date}.md，milestone → MEMORY.md）",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Markdown 内容" },
        date: { type: "string", description: "YYYY-MM-DD，默认今天" },
        target: { type: "string", enum: ["daily", "milestone"], description: "写入目标，默认 daily" }
      },
      required: ["content"],
      additionalProperties: false
    }
  },
  {
    name: "get_workout_log",
    description: "查询本地训练记录（按日期/类型/最近 N 条）。**默认只返回聚合**（by_type / by_intensity / total_*），省 token；需要原始 sessions 数组传 detail:true（workout-confirm 写计划、daily_report 写 narrative 必须用）。",
    inputSchema: {
      type: "object",
      properties: {
        filter_type: { type: "string", enum: ["by_date", "by_type", "recent"], description: "过滤模式" },
        date: { type: "string", description: "用于 by_date 过滤" },
        type: { type: "string", description: "用于 by_type 过滤" },
        limit: { type: "number", description: "用于 recent 过滤的条数限制，默认 10" },
        detail: { type: "boolean", description: "true 时返回 sessions 原始数组；不传 / false 时只返回聚合" }
      },
      additionalProperties: false
    }
  },
  {
    name: "set_body_data",
    description: "记录体重/体脂到本地",
    inputSchema: {
      type: "object",
      properties: {
        weight: { type: "number", description: "体重 kg" },
        body_fat: { type: "number", description: "体脂百分比" },
        date: { type: "string", description: "YYYY-MM-DD，默认今天" }
      },
      additionalProperties: false
    }
  },

  // ── 设备通信工具 (10-19) ──
  {
    name: "get_health_summary",
    description: "通过 App 桥从 HealthKit 拉取睡眠、HRV、静息心率。**默认只返回精简字段**（total_min/score/latest/avg_7d/trend），省 token；需要完整原始字段（含 deep_min/rem_min 等）传 detail:true。",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        detail: { type: "boolean", description: "true 时返回完整原始字段；不传 / false 时只返回精简" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_session_live",
    description: "查询当前 session 的实时数据（心率、时长、消耗）",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "默认 current" }
      },
      additionalProperties: false
    }
  },
  {
    name: "set_workout_plan",
    description: "下发训练计划到 Watch（含 session 模式）",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "object", description: "训练计划内容" },
        session_mode: { type: "string", enum: SESSION_MODE_ENUM },
        date: { type: "string", description: "YYYY-MM-DD，默认今天" }
      },
      required: ["plan", "session_mode"],
      additionalProperties: false
    }
  },
  {
    name: "set_alert_rules",
    description: "下发 Watch 心率告警规则（引用 profile.alert_hr）",
    inputSchema: {
      type: "object",
      properties: {
        rules: {
          type: "array",
          description: "告警规则数组",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              condition: { type: "string" },
              level: { type: "string", enum: ["critical", "warning", "info"] },
              duration_seconds: { type: "number", description: "条件需持续多少秒才触发告警，避免瞬时抖动；默认 10s；hr_critical 建议 10s, hr_warning 建议 30-60s" },
              local_only: { type: "boolean" }
            },
            required: ["id", "condition", "level"]
          }
        }
      },
      required: ["rules"],
      additionalProperties: false
    }
  },
  {
    name: "control_session",
    description: "session 控制（start/pause/resume/stop）",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "pause", "resume", "stop", "update"] },
        session_mode: { type: "string", enum: SESSION_MODE_ENUM },
        source: { type: "string", enum: SOURCE_ENUM },
        session_id: { type: "string" }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "send_notification",
    description: "推送通知到手机/手表",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        type: { type: "string" },
        target: { type: "string", enum: ["phone", "watch", "both"] }
      },
      additionalProperties: false
    }
  },
  {
    name: "start_health_monitoring",
    description: "触发 Watch 被动数据采集",
    inputSchema: {
      type: "object",
      properties: {
        metrics: { type: "array", items: { type: "string" } },
        interval_seconds: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "show_report",
    description: "展示结构化报告到 iPhone（同时写入 logs/{date}.show_report.json）",
    inputSchema: {
      type: "object",
      properties: {
        report_type: { type: "string", enum: REPORT_TYPE_ENUM },
        data: { type: "object", description: "报告数据，结构因 report_type 而异" }
      },
      required: ["report_type", "data"],
      additionalProperties: false
    }
  },
  {
    name: "show_countdown",
    description: "在 Watch 上展示倒计时（支持 actions 按钮）",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number" },
        label: { type: "string" },
        actions: { type: "array", items: { type: "string" } }
      },
      required: ["seconds"],
      additionalProperties: false
    }
  },
  {
    name: "request_user_input",
    description: "请求用户在 iPhone 或 Watch 上选择/输入",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        prompt: { type: "string" },
        input_type: { type: "string", enum: ["confirm", "select", "number", "text"] },
        options: { type: "array", items: { type: "string" } },
        target: { type: "string", enum: ["phone", "watch"] }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },

  // ── 调度工具 (20-22) ──
  {
    name: "schedule_recurring",
    description: "创建周期性 cron job（日报/周报/月报/定时提醒）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "唯一 job 名" },
        cron: { type: "string", description: "5/6 字段 cron 表达式" },
        prompt: { type: "string", description: "触发时注入的 prompt" },
        tz: { type: "string", description: "时区，默认系统时区" }
      },
      required: ["name", "cron", "prompt"],
      additionalProperties: false
    }
  },
  {
    name: "schedule_one_shot",
    description: "创建一次性延迟 job",
    inputSchema: {
      type: "object",
      properties: {
        delay: { type: "string", description: "延迟时间，如 30m / 2h / ISO 8601 绝对时间" },
        prompt: { type: "string", description: "触发时注入的 prompt" },
        name: { type: "string", description: "可选 job 名，不传自动生成" }
      },
      required: ["delay", "prompt"],
      additionalProperties: false
    }
  },
  {
    name: "reschedule_recurring",
    description: "**原子改 cron**：取代 cancel_scheduled + schedule_recurring 两步调用。内部按序：cancel(name) → schedule_recurring(name, new_cron, new_prompt)。cancel 失败时不创建新 cron（rolled_back:true）。**改 cron 一律用本工具**。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "要改动的 job name" },
        new_cron: { type: "string", description: "新的 5/6 字段 cron 表达式" },
        new_prompt: { type: "string", description: "新触发 prompt（必填，server 不缓存旧 prompt）" },
        tz: { type: "string", description: "时区，默认系统时区" }
      },
      required: ["name", "new_cron", "new_prompt"],
      additionalProperties: false
    }
  },
  {
    name: "cancel_scheduled",
    description: "按 name 删除已注册的 cron job。**改 cron 用 reschedule_recurring**——除非确实只想删除而不重建，否则不要单独调本工具。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "要删除的 job 名" }
      },
      required: ["name"],
      additionalProperties: false
    }
  },

  // ── Pattern A 复合工具（Phase 3）：场景全内化，1 次调用走完一个场景 ──
  {
    name: "record_rest_day",
    description: "**复合工具**：lightweight rest_day 场景全内化。内部：update_state(consecutive_rest_days+1, consecutive_training_days:0)（自动镜像 rest_day 事件）+ finish_scene。模型 1 次调用。",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "可选的休息原因（写入 daily log）" }
      },
      additionalProperties: false
    }
  },
  {
    name: "record_signal",
    description: "**复合工具**：记录主观症状信号（疼痛/头晕/不适），用于 anomaly 2.B 中严重度、lightweight signal 类。内部：update_state(signals.body push)（自动镜像 signal 事件）+ 可选 send_notification + finish_scene。**主观症状用本工具；可量化身体指标用 record_body_data**。",
    inputSchema: {
      type: "object",
      properties: {
        signal_type: { type: "string", description: "信号类型，如 pain / dizziness / fatigue 等" },
        detail: { type: "string", description: "用户原话或简短描述" },
        severity: { type: "string", enum: ["low", "medium", "high"], description: "严重度" },
        notification_body: { type: "string", description: "可选；非空时同时 send_notification 到 phone" },
        scene_name: { type: "string", description: "出口 last_scene.name，缺省 anomaly_alert" }
      },
      required: ["signal_type", "detail", "severity"],
      additionalProperties: false
    }
  },
  {
    name: "record_body_data",
    description: "**复合工具**：记录可量化身体指标（体重/体脂/肌肉量/腰围/静息心率），用于 lightweight signal_capture_chat。内部：append_health_log(body_data) + 可选 update_state(profile.basic_info)（仅 update_profile:true 时）+ finish_scene。",
    inputSchema: {
      type: "object",
      properties: {
        weight_kg: { type: "number" },
        body_fat_pct: { type: "number" },
        muscle_mass_kg: { type: "number" },
        waist_cm: { type: "number" },
        resting_hr: { type: "number" },
        update_profile: { type: "boolean", description: "true 时同时把 weight_kg/body_fat_pct 写回 profile.basic_info（长期值）；缺省 false 只记一次性数据" },
        scene_name: { type: "string", description: "缺省 signal_capture_chat" }
      },
      additionalProperties: false
    }
  },
  {
    name: "change_status",
    description: "**复合工具**：状态变化（lightweight status_change + anomaly 2.A 高严重度）。内部：update_state(user_state.status + _reason)（自动镜像 status_change）+ 可选 update_state(profile.injuries 整数组替换) + 可选 send_notification + finish_scene。**禁止手动 append_health_log(status_change)**——已自动镜像。",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", enum: USER_STATE_STATUS_ENUM, description: "新 user_state.status" },
        reason: { type: "string", description: "变化原因（用户原话），由 server 写入 _reason 透传镜像后剥离" },
        since: { type: "string", description: "YYYY-MM-DD，缺省今天" },
        next_check: { type: "string", description: "YYYY-MM-DD 下次复查日期，缺省 +1 天（仅 sick/injured）" },
        injuries_patch: {
          type: "array",
          description: "整数组替换 profile.injuries；不传则不动",
          items: { type: "object" }
        },
        notification_body: { type: "string", description: "可选；非空时 send_notification 到 phone（高严重度建议传）" },
        scene_name: { type: "string", description: "缺省 status_change；anomaly 路径传 anomaly_alert" }
      },
      required: ["to", "reason"],
      additionalProperties: false
    }
  },
  {
    name: "record_session_event",
    description: "**复合工具**：训练中非停训信号（during-session 1.A 低/中、1.C warning）。内部：update_state(signals.body push)（自动镜像 signal）+ 可选 send_notification(target:watch) + finish_scene(during_session)。**只用于不停训分支**——停训分支用 stop_session_with_signal。",
    inputSchema: {
      type: "object",
      properties: {
        signal_type: { type: "string", description: "如 pain / hr_warning" },
        detail: { type: "string" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        notification_body: { type: "string", description: "可选；非空时 send_notification(target:watch)" }
      },
      required: ["signal_type", "detail", "severity"],
      additionalProperties: false
    }
  },
  {
    name: "stop_session_with_signal",
    description: "**复合工具**：训练中停训分支（during-session 1.A 高、1.B 用户停、1.C critical）。内部：update_state(signals.body push + 可选 user_state with _reason)（自动镜像 signal + 可选 status_change）+ control_session(stop)（清 active_session + 清 pending_nodes）。**stop 后由 SKILL.md §3 特例规则自动 handoff 给 scene-post-session**——本工具不调 finish_scene。",
    inputSchema: {
      type: "object",
      properties: {
        trigger: { type: "string", enum: ["pain", "hr_critical", "user_stop", "dizziness"], description: "停训触发源" },
        detail: { type: "string", description: "信号详情；user_stop 可传 '用户在 Watch 上点结束'" },
        severity: { type: "string", enum: ["low", "medium", "high"], description: "user_stop 可传 low" },
        status_change: {
          type: "object",
          description: "可选；当用户疼痛/头晕导致状态变化时一并写",
          properties: {
            to: { type: "string", enum: USER_STATE_STATUS_ENUM },
            reason: { type: "string" },
            since: { type: "string" },
            next_check: { type: "string" }
          },
          required: ["to", "reason"]
        }
      },
      required: ["trigger", "detail", "severity"],
      additionalProperties: false
    }
  },
  {
    name: "setup_onboarding",
    description: "**复合工具**：onboarding 全内化。内部：防重复检查 → update_state(profile/user_state/training_state) → schedule_recurring x3-4（按 reminder_mode 决定是否建 daily_workout_reminder）→ get_health_summary → show_report(readiness_assessment) → finish_scene(onboarding/done)。**任一步失败原子回滚**：cancel 已建 cron + 清空 profile/user_state + finish_scene(error)。",
    inputSchema: {
      type: "object",
      properties: {
        bulk: {
          type: "object",
          description: "Onboarding bulk payload（前端一次性收齐）",
          properties: {
            basic_info: { type: "object", description: "{age, gender, height_cm?, weight_kg?}" },
            fitness_level: { type: "string", enum: FITNESS_LEVEL_ENUM },
            goal: { type: "string" },
            preferences: { type: "object" },
            injuries: { type: "array", items: { type: "object" } },
            reminder_mode: { type: "string", enum: ["scheduled", "proactive"] },
            reminder_time: { type: "string", description: "HH:MM；reminder_mode=scheduled 时必填" },
            weekly_report_time: { type: "string", description: "如 'Sun 20:00'，缺省 'Sun 20:00'" },
            readiness: {
              type: "object",
              description: "模型预先填好的 readiness 报告 data（4 维度+overall+suggestions）；server 拉 health_summary 后由模型 review，再传入；缺省 server 用占位 'available' 报告兜底",
              properties: {
                overall: { type: "string" },
                dimensions: { type: "object" },
                suggestions: { type: "array", items: { type: "string" } }
              }
            }
          },
          required: ["basic_info", "fitness_level"]
        }
      },
      required: ["bulk"],
      additionalProperties: false
    }
  }
];

// ─── 工具 handler 实现 ─────────────────────────────────────────────────────
const handlers = {};

// #1 read_state
handlers.read_state = (args) => {
  sessionToolsCalled.add("read_state");
  const state = readState();
  // 清理过期信号
  if (state.signals) state.signals = cleanExpiredSignals(state.signals);
  const reminders = buildReminders(state);
  const projection = args && Array.isArray(args.projection) && args.projection.length > 0 ? args.projection : null;
  const payload = projection ? projectState(state, projection) : state;
  const result = { ok: true, state: payload };
  if (projection) result.projection_applied = projection;
  if (reminders.length > 0) result.reminders = reminders;
  return result;
};

// #2 get_user_profile
handlers.get_user_profile = (_args) => {
  const state = readState();
  return { ok: true, profile: state.profile };
};

// #3 update_state
handlers.update_state = (args) => {
  const { patch } = args;
  if (!patch || typeof patch !== "object") return { error: "patch 参数必须是对象" };

  // 枚举校验
  if (patch.user_state && patch.user_state.status) {
    if (!USER_STATE_STATUS_ENUM.includes(patch.user_state.status)) {
      return { error: `user_state.status 不合法: ${patch.user_state.status}，允许值: ${USER_STATE_STATUS_ENUM.join("/")}` };
    }
  }
  if (patch.last_scene && patch.last_scene.status) {
    if (!LAST_SCENE_STATUS_ENUM.includes(patch.last_scene.status)) {
      return { error: `last_scene.status 不合法: ${patch.last_scene.status}，允许值: ${LAST_SCENE_STATUS_ENUM.join("/")}` };
    }
  }
  if (patch.training_state && patch.training_state.fatigue_estimate) {
    if (!FATIGUE_ENUM.includes(patch.training_state.fatigue_estimate)) {
      return { error: `fatigue_estimate 不合法: ${patch.training_state.fatigue_estimate}` };
    }
  }
  if (patch.profile && Array.isArray(patch.profile.injuries)) {
    for (const inj of patch.profile.injuries) {
      if (inj.status && !INJURY_STATUS_ENUM.includes(inj.status)) {
        return { error: `injury status 不合法: ${inj.status}` };
      }
    }
  }
  if (patch.profile && patch.profile.fitness_level) {
    if (!FITNESS_LEVEL_ENUM.includes(patch.profile.fitness_level)) {
      return { error: `fitness_level 不合法: ${patch.profile.fitness_level}` };
    }
  }

  // 读取当前 state
  const current = readState();

  // 备份
  if (fs.existsSync(STATE_PATH)) {
    fs.copyFileSync(STATE_PATH, STATE_BAK_PATH);
  }

  // 检测 profile 变更（在合并前记录旧值）
  const oldProfile = current.profile ? JSON.parse(JSON.stringify(current.profile)) : null;

  // 深度合并
  const merged = deepMerge(current, patch);

  // 自动镜像 health-log（在剥 _reason 之前算）
  const mirrorEvents = mirrorHealthLog(patch, current, merged);
  for (const ev of mirrorEvents) appendLine(HEALTH_LOG_PATH, JSON.stringify(ev));

  // 剥离 user_state._reason 透传字段，避免污染 state
  if (merged.user_state && Object.prototype.hasOwnProperty.call(merged.user_state, "_reason")) {
    delete merged.user_state._reason;
  }

  // alert_hr 自动重算
  if (merged.profile) {
    const needRecalc =
      (patch.profile && patch.profile.max_hr_measured !== undefined) ||
      (patch.profile && patch.profile.basic_info && patch.profile.basic_info.age !== undefined);
    if (needRecalc || !merged.profile.alert_hr) {
      merged.profile.alert_hr = computeAlertHR(merged.profile);
    }
  }

  // 写入
  writeJSON(STATE_PATH, merged);

  // last_scene 变更自动追加 scene_end 事件
  if (patch.last_scene && merged.last_scene && merged.last_scene.name && merged.last_scene.status) {
    const event = {
      type: "scene_end",
      scene: merged.last_scene.name,
      status: merged.last_scene.status,
      date: today(),
      ts: merged.last_scene.ts || nowISO(),
      summary: merged.last_scene.summary || ""
    };
    appendLine(HEALTH_LOG_PATH, JSON.stringify(event));
  }

  // profile 变更自动记日志
  if (patch.profile) {
    const changedFields = [];
    if (!oldProfile) {
      // 从 null → 有值：整个 profile 都是新的
      changedFields.push(...Object.keys(patch.profile).filter(k => k !== "_meta" && k !== "alert_hr"));
    } else {
      function diffProfile(oldObj, newObj, prefix) {
        const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
        for (const k of allKeys) {
          const fp = prefix ? `${prefix}.${k}` : k;
          const ov = oldObj ? oldObj[k] : undefined;
          const nv = newObj ? newObj[k] : undefined;
          if (JSON.stringify(ov) !== JSON.stringify(nv)) {
            if (fp.startsWith("_meta") || fp.startsWith("alert_hr")) continue;
            changedFields.push(fp);
          }
        }
      }
      diffProfile(oldProfile, merged.profile, "");
    }
    if (changedFields.length > 0) {
      const event = {
        type: "profile_update",
        date: today(),
        ts: nowISO(),
        changed_fields: changedFields,
        trigger: oldProfile ? "user_dialogue" : "onboarding"
      };
      appendLine(HEALTH_LOG_PATH, JSON.stringify(event));
    }
  }

  // 更新 profile _meta 时间戳
  if (patch.profile) {
    if (!merged.profile._meta) merged.profile._meta = {};
    if (patch.profile.goal !== undefined) merged.profile._meta.goal_updated_at = today();
    if (patch.profile.fitness_level !== undefined) merged.profile._meta.fitness_level_updated_at = today();
    writeJSON(STATE_PATH, merged);
  }

  const result = {
    ok: true,
    changed_keys: topLevelChangedKeys(patch)
  };
  if (mirrorEvents.length > 0) result.mirrored_events = mirrorEvents.map(e => e.type);
  return result;
};

// #4 write_daily_log
handlers.write_daily_log = (args) => {
  const d = args.date || today();
  const logFile = path.join(LOGS_DIR, `${d}.md`);
  appendLine(logFile, args.content);
  return { ok: true, file: logFile };
};

// #4b finish_scene —— 场景收尾合并工具（取代 update_state(last_scene) + write_daily_log）
handlers.finish_scene = (args) => {
  const { name, status, summary = "", daily_log_content, ts } = args || {};
  if (!name) return { ok: false, error: "name 必填" };
  if (!status) return { ok: false, error: "status 必填" };
  if (!LAST_SCENE_STATUS_ENUM.includes(status)) {
    return { ok: false, error: `status 不合法: ${status}，允许值: ${LAST_SCENE_STATUS_ENUM.join("/")}` };
  }

  const sceneTs = ts || nowISO();

  // 1. 通过 update_state 写 last_scene（复用枚举校验、scene_end 自动镜像、_meta 维护等逻辑）
  const updateRes = handlers.update_state({
    patch: { last_scene: { name, status, ts: sceneTs, summary } }
  });
  if (!updateRes || updateRes.ok === false || updateRes.error) {
    return { ok: false, error: "update_last_scene_failed", detail: updateRes && (updateRes.error || updateRes), failed_step: "update_state" };
  }

  // 2. 写当天 daily log（缺省按 summary 自动生成）
  const d = today();
  const logFile = path.join(LOGS_DIR, `${d}.md`);
  const content = daily_log_content || `## ${name}\n\n- 状态: ${status}\n- 摘要: ${summary || "(无)"}\n`;
  appendLine(logFile, content);

  return {
    ok: true,
    last_scene: { name, status, ts: sceneTs, summary },
    log_file: logFile,
    scene_end_logged: true
  };
};

// #5 append_health_log
handlers.append_health_log = (args) => {
  const { event } = args;
  if (!event || !event.type) return { error: "event.type 必填" };
  if (!HEALTH_LOG_EVENT_TYPES.includes(event.type)) {
    return { error: `event.type 不合法: ${event.type}，允许值: ${HEALTH_LOG_EVENT_TYPES.join("/")}` };
  }
  // scene_end / profile_update 由 MCP Server 自动追加，拒绝手动写入防止重复
  if (event.type === "scene_end") {
    return { ok: false, error: "scene_end 由 update_state({last_scene:{name,status,ts,summary}}) 自动写入，不要手动调用" };
  }
  if (event.type === "profile_update") {
    return { ok: false, error: "profile_update 由 update_state(profile 变更) 自动写入，不要手动调用" };
  }
  // signal/status_change/session/rest_day 由 update_state 自动镜像
  if (AUTO_MIRRORED_EVENT_TYPES.has(event.type)) {
    const hint = {
      signal: "改用 update_state({patch:{signals:{body:[...old, {type, detail, ts, severity?}]}}})",
      status_change: "改用 update_state({patch:{user_state:{status, since, _reason?}}})；reason 写在 user_state._reason，写完会被 Server 剥离不入 state",
      session: "改用 update_state({patch:{training_state:{recent_sessions:[新条, ...旧条]}}})",
      rest_day: "改用 update_state({patch:{training_state:{consecutive_rest_days: <旧值+1>, consecutive_training_days:0}}})"
    };
    return { ok: false, error: `${event.type} 由 update_state 自动镜像，不要手动 append_health_log。${hint[event.type]}` };
  }
  if (!event.date) return { ok: false, error: "event.date 必填" };
  if (!event.ts) return { ok: false, error: "event.ts 必填" };
  appendLine(HEALTH_LOG_PATH, JSON.stringify(event));
  return { ok: true };
};

// #5.5 query_health_log
handlers.query_health_log = (args) => {
  const { start_date, end_date, types, limit } = args || {};
  const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;
  const maxLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);

  if (!fs.existsSync(HEALTH_LOG_PATH)) {
    return { ok: true, events: [], count: 0, total_matched: 0, truncated: false };
  }
  const content = fs.readFileSync(HEALTH_LOG_PATH, "utf8");
  const lines = content.split("\n").filter(l => l.trim());
  const matched = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || !e.type) continue;
    if (typeSet && !typeSet.has(e.type)) continue;
    if (start_date && e.date && e.date < start_date) continue;
    if (end_date && e.date && e.date > end_date) continue;
    matched.push(e);
  }
  // 倒序（最新在前），便于模型按时间优先处理
  matched.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const truncated = matched.length > maxLimit;
  const events = matched.slice(0, maxLimit);
  return { ok: true, events, count: events.length, total_matched: matched.length, truncated };
};

// #6 write_global_memory
handlers.write_global_memory = (args) => {
  const target = args.target || "daily";
  const d = args.date || today();
  let filePath;
  if (target === "milestone") {
    filePath = MEMORY_FILE;
  } else {
    filePath = path.join(MEMORY_DIR, `${d}.md`);
  }
  appendLine(filePath, args.content);
  return { ok: true, file: filePath };
};

// #7 get_workout_log
handlers.get_workout_log = (args) => {
  sessionToolsCalled.add("get_workout_log");
  let result = [...sessions]; // mock 数据
  const ft = args.filter_type || "recent";
  if (ft === "by_date" && args.date) {
    result = result.filter(s => s.date === args.date);
  } else if (ft === "by_type" && args.type) {
    result = result.filter(s => s.type === args.type);
  } else if (ft === "recent") {
    const limit = args.limit || 10;
    result = result.slice(0, limit);
  }
  const aggregate = aggregateSessions(result);
  if (args.detail === true) {
    return { ok: true, aggregate, sessions: result, source: "mock" };
  }
  return { ok: true, aggregate, source: "mock" };
};

// #8 set_body_data
handlers.set_body_data = (args) => {
  const d = args.date || today();
  const record = { date: d, weight: args.weight, body_fat: args.body_fat, ts: nowISO() };
  const filePath = path.join(LOGS_DIR, `${d}.set_body_data.json`);
  writeJSON(filePath, record);
  // 同时追加 health-log
  const event = { type: "body_data", date: d, ts: nowISO(), data: { weight_kg: args.weight, body_fat_pct: args.body_fat }, source: "user_input" };
  appendLine(HEALTH_LOG_PATH, JSON.stringify(event));
  return { ok: true, record };
};

// #9 get_health_summary
handlers.get_health_summary = (args) => {
  // mock 实现——真实版通过 HTTP 桥从 HealthKit 拉取
  const period = { start: args.start_date || today(), end: args.end_date || today() };
  if (args.detail === true) {
    return { ok: true, period, latest: healthSummary, source: "mock" };
  }
  return { ok: true, period, latest: summarizeHealth(healthSummary), source: "mock" };
};

// #10 get_session_live
handlers.get_session_live = (_args) => {
  // mock：无活跃 session
  return { ok: true, active: false };
};

// #11 set_workout_plan
handlers.set_workout_plan = (args) => {
  // 护栏：onboarding 检查
  const state = readState();
  if (!state.profile || !state.profile.basic_info || !state.profile.basic_info.age) {
    return { ok: false, error: "onboarding_incomplete", hint: "profile.basic_info.age 缺失，先完成 onboarding" };
  }
  // 护栏：7 天上下文检查
  let warning;
  if (!sessionToolsCalled.has("read_state") && !sessionToolsCalled.has("get_workout_log")) {
    warning = "missing_recent_context";
  }
  const d = args.date || today();
  const filePath = path.join(LOGS_DIR, `${d}.set_workout_plan.json`);
  writeJSON(filePath, { plan: args.plan, session_mode: args.session_mode, ts: nowISO() });
  pushSSE("set_workout_plan", args);
  const result = { ok: true, file: filePath };
  if (warning) result.warning = warning;
  return result;
};

// #12 set_alert_rules
handlers.set_alert_rules = (args) => {
  // 护栏：确保 alert_hr 存在
  const state = readState();
  if (state.profile && !state.profile.alert_hr) {
    state.profile.alert_hr = computeAlertHR(state.profile);
    writeJSON(STATE_PATH, state);
  }
  const d = today();
  const filePath = path.join(LOGS_DIR, `${d}.set_alert_rules.json`);
  writeJSON(filePath, { rules: args.rules, ts: nowISO() });
  pushSSE("set_alert_rules", args);
  return { ok: true, file: filePath };
};

// #13 control_session
// start/stop 同时维护 state.active_session：start 写入 lock，stop 清除。
// pause/resume/update 不改动 active_session（session 仍在进行）。
handlers.control_session = (args) => {
  const state = readState();
  if (args.action === "start") {
    if (state.active_session) {
      return { ok: false, error: "active_session_exists", detail: "已有 session 在进行，先 stop 才能开新的" };
    }
    state.active_session = {
      started_at: nowISO(),
      session_mode: args.session_mode || null,
      source: args.source || null
    };
    writeJSON(STATE_PATH, state);
  } else if (args.action === "stop") {
    state.active_session = null;
    writeJSON(STATE_PATH, state);
  }
  pushSSE("control_session", args);
  return { ok: true, action: args.action };
};

// #14 send_notification
handlers.send_notification = (args) => {
  pushSSE("send_notification", args);
  return { ok: true, target: args.target || "phone" };
};

// #15 start_health_monitoring
handlers.start_health_monitoring = (args) => {
  pushSSE("start_health_monitoring", args);
  return { ok: true };
};

// #16 show_report
handlers.show_report = (args) => {
  if (!REPORT_TYPE_ENUM.includes(args.report_type)) {
    return { error: `report_type 不合法: ${args.report_type}` };
  }
  const d = today();
  const filePath = path.join(LOGS_DIR, `${d}.show_report.json`);
  // 追加写入（一天可能多次 show_report）
  appendLine(filePath, JSON.stringify({ report_type: args.report_type, data: args.data, ts: nowISO() }));
  pushSSE("show_report", args);
  return { ok: true, report_type: args.report_type };
};

// #17 show_countdown
handlers.show_countdown = (args) => {
  pushSSE("show_countdown", args);
  return { ok: true };
};

// #18 request_user_input
handlers.request_user_input = async (args) => {
  const requestId = args.request_id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = { ...args, request_id: requestId };
  pushSSE("request_user_input", payload);
  try {
    const response = await waitForCallback(requestId);
    return { ok: true, request_id: requestId, response };
  } catch (e) {
    return { ok: false, error: e.message, request_id: requestId };
  }
};

// #19 schedule_recurring
handlers.schedule_recurring = (args) => {
  // cron 格式快速校验
  if (!/^[\d*\/,\-]+(\s[\d*\/,\-]+){4,5}$/.test(args.cron.trim())) {
    return { ok: false, error: "cron 表达式格式不合法" };
  }
  // prompt 自动补全前缀
  let prompt = args.prompt;
  if (!prompt.startsWith("请使用 skill:health-claw ")) {
    prompt = "请使用 skill:health-claw " + prompt;
  }
  const tz = args.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;

  return new Promise((resolve) => {
    const proc = spawn("openclaw", [
      "cron", "add",
      "--name", args.name,
      "--cron", args.cron,
      "--tz", tz,
      "--session", "main",
      "--message", prompt
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr.includes("already exists") || stderr.includes("name_exists")) {
          resolve({ ok: false, error: "name_exists", detail: `job "${args.name}" 已存在，先 cancel_scheduled 再重建` });
        } else {
          resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
        }
      } else {
        // schedule_recurring 不写 scene_end（这不是场景执行，工具调用审计由 logToolCall 兜底）
        resolve({ ok: true, name: args.name, cron: args.cron, tz });
      }
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        resolve({ ok: false, error: "openclaw_cli_not_found", hint: "openclaw 不在 PATH 中" });
      } else {
        resolve({ ok: false, error: err.message });
      }
    });
  });
};

// #20 schedule_one_shot
handlers.schedule_one_shot = (args) => {
  const name = args.name || `oneshot_${Date.now()}`;
  let prompt = args.prompt;
  if (!prompt.startsWith("请使用 skill:health-claw ")) {
    prompt = "请使用 skill:health-claw " + prompt;
  }

  return new Promise((resolve) => {
    const proc = spawn("openclaw", [
      "cron", "add",
      "--name", name,
      "--at", args.delay,
      "--session", "main",
      "--message", prompt
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
      } else {
        resolve({ ok: true, name, delay: args.delay });
      }
    });
    proc.on("error", (err) => {
      resolve({ ok: false, error: err.code === "ENOENT" ? "openclaw_cli_not_found" : err.message });
    });
  });
};

// #20b reschedule_recurring —— 原子改 cron（cancel + create 一次完成）
handlers.reschedule_recurring = async (args) => {
  if (!args || !args.name) return { ok: false, error: "name 必填" };
  if (!args.new_cron) return { ok: false, error: "new_cron 必填" };
  if (!args.new_prompt) return { ok: false, error: "new_prompt 必填（server 不缓存旧 prompt）" };
  if (!/^[\d*\/,\-]+(\s[\d*\/,\-]+){4,5}$/.test(args.new_cron.trim())) {
    return { ok: false, error: "new_cron 表达式格式不合法" };
  }

  // Step 1: cancel 旧 job
  const cancelRes = await handlers.cancel_scheduled({ name: args.name });
  if (!cancelRes.ok) {
    return { ok: false, error: "cancel_failed", failed_step: "cancel_scheduled", detail: cancelRes.error, rolled_back: true };
  }

  // Step 2: create 新 job
  const createRes = await handlers.schedule_recurring({
    name: args.name,
    cron: args.new_cron,
    prompt: args.new_prompt,
    tz: args.tz
  });
  if (!createRes.ok) {
    return {
      ok: false,
      error: "create_failed",
      failed_step: "schedule_recurring",
      detail: createRes.error,
      rolled_back: false,
      hint: `原 cron "${args.name}" 已删除，新 cron 创建失败；请手动 schedule_recurring 恢复`
    };
  }

  return { ok: true, name: args.name, new_cron: args.new_cron, tz: createRes.tz };
};

// #21 cancel_scheduled
handlers.cancel_scheduled = (args) => {
  return new Promise((resolve) => {
    const proc = spawn("openclaw", [
      "cron", "remove",
      "--name", args.name
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr.includes("not found") || stderr.includes("not_found")) {
          resolve({ ok: false, error: "not_found" });
        } else {
          resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
        }
      } else {
        resolve({ ok: true });
      }
    });
    proc.on("error", (err) => {
      resolve({ ok: false, error: err.code === "ENOENT" ? "openclaw_cli_not_found" : err.message });
    });
  });
};

// ─── Pattern A 复合工具 handlers (Phase 3) ─────────────────────────────
// 设计原则：内部复用既有 handler（拿到自动镜像 / 枚举校验 / scene_end 等所有副作用）；
// 任一步失败立即返回 {ok:false, failed_step, rolled_back?}，让模型能定位。

// 小工具：把复合返回值收敛
function composeFail(step, detail, rolledBack) {
  return { ok: false, failed_step: step, error: detail && detail.error ? detail.error : (typeof detail === "string" ? detail : "step_failed"), detail, rolled_back: !!rolledBack };
}

// #c1 record_rest_day —— lightweight rest_day 全内化
handlers.record_rest_day = async (args) => {
  const cur = readState();
  const oldRestDays = (cur.training_state && cur.training_state.consecutive_rest_days) || 0;
  const newRestDays = oldRestDays + 1;

  // 1. update_state（自动镜像 rest_day 事件）
  const upd = handlers.update_state({
    patch: {
      training_state: {
        consecutive_rest_days: newRestDays,
        consecutive_training_days: 0
      }
    }
  });
  if (!upd.ok) return composeFail("update_state", upd, false);

  // 2. finish_scene
  const summary = `主动休息，连续休息 ${newRestDays} 天${args && args.reason ? `（${args.reason}）` : ""}`;
  const fin = handlers.finish_scene({
    name: "rest_day",
    status: "done",
    summary,
    daily_log_content: `## 休息日\n\n- 主动选择休息\n${args && args.reason ? `- 原因: ${args.reason}\n` : ""}`
  });
  if (!fin.ok) return composeFail("finish_scene", fin, false);

  return { ok: true, consecutive_rest_days: newRestDays, log_file: fin.log_file };
};

// #c2 record_signal —— 主观症状（anomaly 2.B / lightweight 主观信号）
handlers.record_signal = async (args) => {
  const sceneName = (args && args.scene_name) || "anomaly_alert";
  const cur = readState();
  const oldBody = (cur.signals && Array.isArray(cur.signals.body)) ? cur.signals.body : [];

  const upd = handlers.update_state({
    patch: {
      signals: {
        body: [...oldBody, { type: args.signal_type, detail: args.detail, ts: nowISO(), severity: args.severity }]
      }
    }
  });
  if (!upd.ok) return composeFail("update_state", upd, false);

  let notificationSent = false;
  if (args.notification_body) {
    const notif = handlers.send_notification({ body: args.notification_body, target: "phone" });
    if (!notif.ok) return composeFail("send_notification", notif, false);
    notificationSent = true;
  }

  const fin = handlers.finish_scene({
    name: sceneName,
    status: "done",
    summary: `${args.signal_type} 已记录 (${args.severity})`,
    daily_log_content: `## ${sceneName === "anomaly_alert" ? "异常预警" : "信号记录"}\n\n- 类型: ${args.signal_type}\n- 严重度: ${args.severity}\n- 详情: ${args.detail}\n`
  });
  if (!fin.ok) return composeFail("finish_scene", fin, false);

  return { ok: true, signal_logged: true, notification_sent: notificationSent, log_file: fin.log_file };
};

// #c3 record_body_data —— 可量化身体指标（lightweight signal_capture_chat）
handlers.record_body_data = async (args) => {
  const sceneName = (args && args.scene_name) || "signal_capture_chat";
  const data = {};
  if (args.weight_kg !== undefined) data.weight_kg = args.weight_kg;
  if (args.body_fat_pct !== undefined) data.body_fat_pct = args.body_fat_pct;
  if (args.muscle_mass_kg !== undefined) data.muscle_mass_kg = args.muscle_mass_kg;
  if (args.waist_cm !== undefined) data.waist_cm = args.waist_cm;
  if (args.resting_hr !== undefined) data.resting_hr = args.resting_hr;
  if (Object.keys(data).length === 0) {
    return { ok: false, error: "至少传一个测量字段" };
  }

  // 1. append body_data 事件（body_data 不在 auto-mirror 集，需手动 append）
  const evRes = handlers.append_health_log({
    event: { type: "body_data", date: today(), ts: nowISO(), data, source: "user_input" }
  });
  if (!evRes.ok) return composeFail("append_health_log", evRes, false);

  // 2. 可选写回 profile.basic_info（仅长期值才传 update_profile:true）
  if (args.update_profile === true) {
    const basicPatch = {};
    if (data.weight_kg !== undefined) basicPatch.weight_kg = data.weight_kg;
    if (data.body_fat_pct !== undefined) basicPatch.body_fat_pct = data.body_fat_pct;
    if (Object.keys(basicPatch).length > 0) {
      const upd = handlers.update_state({ patch: { profile: { basic_info: basicPatch } } });
      if (!upd.ok) return composeFail("update_state", upd, false);
    }
  }

  // 3. finish_scene
  const summaryParts = Object.entries(data).map(([k, v]) => `${k}=${v}`);
  const fin = handlers.finish_scene({
    name: sceneName,
    status: "done",
    summary: `记录 ${summaryParts.join(", ")}`,
    daily_log_content: `## 信号采集\n\n${summaryParts.map(s => `- ${s}`).join("\n")}\n`
  });
  if (!fin.ok) return composeFail("finish_scene", fin, false);

  return { ok: true, recorded: data, profile_updated: args.update_profile === true, log_file: fin.log_file };
};

// #c4 change_status —— lightweight status_change + anomaly 2.A 高严重度
handlers.change_status = async (args) => {
  const sceneName = (args && args.scene_name) || "status_change";
  const cur = readState();
  const fromStatus = (cur.user_state && cur.user_state.status) || "available";

  const userStatePatch = {
    status: args.to,
    since: args.since || today(),
    _reason: args.reason  // 自动镜像 status_change 后被剥离
  };
  if (args.next_check) {
    userStatePatch.next_check = args.next_check;
  } else if (args.to === "sick" || args.to === "injured") {
    // 默认 +1 天复查
    const d = new Date(today());
    d.setDate(d.getDate() + 1);
    userStatePatch.next_check = d.toISOString().slice(0, 10);
  }

  const patch = { user_state: userStatePatch };
  if (Array.isArray(args.injuries_patch)) {
    patch.profile = { injuries: args.injuries_patch };
  }

  const upd = handlers.update_state({ patch });
  if (!upd.ok) return composeFail("update_state", upd, false);

  let notificationSent = false;
  if (args.notification_body) {
    const notif = handlers.send_notification({ body: args.notification_body, target: "phone" });
    if (!notif.ok) return composeFail("send_notification", notif, false);
    notificationSent = true;
  }

  const fin = handlers.finish_scene({
    name: sceneName,
    status: "done",
    summary: `${fromStatus} → ${args.to}`,
    daily_log_content: `## 状态变更\n\n- ${fromStatus} → ${args.to}\n- 说明: ${args.reason}\n`
  });
  if (!fin.ok) return composeFail("finish_scene", fin, false);

  return { ok: true, from: fromStatus, to: args.to, notification_sent: notificationSent, log_file: fin.log_file };
};

// #c5 record_session_event —— during-session 1.A 低/中、1.C warning（不停训）
handlers.record_session_event = async (args) => {
  const cur = readState();
  if (!cur.active_session) {
    return { ok: false, error: "no_active_session", hint: "无进行中 session，本工具仅用于 during-session" };
  }
  const oldBody = (cur.signals && Array.isArray(cur.signals.body)) ? cur.signals.body : [];

  const upd = handlers.update_state({
    patch: {
      signals: {
        body: [...oldBody, { type: args.signal_type, detail: args.detail, ts: nowISO(), severity: args.severity }]
      }
    }
  });
  if (!upd.ok) return composeFail("update_state", upd, false);

  let notificationSent = false;
  if (args.notification_body) {
    const notif = handlers.send_notification({ body: args.notification_body, target: "watch" });
    if (!notif.ok) return composeFail("send_notification", notif, false);
    notificationSent = true;
  }

  const fin = handlers.finish_scene({
    name: "during_session",
    status: "done",
    summary: `${args.signal_type} 已记录`,
    daily_log_content: `## 训练中信号\n\n- 类型: ${args.signal_type}\n- 严重度: ${args.severity}\n- 详情: ${args.detail}\n`
  });
  if (!fin.ok) return composeFail("finish_scene", fin, false);

  return { ok: true, signal_logged: true, notification_sent: notificationSent, log_file: fin.log_file };
};

// #c6 stop_session_with_signal —— during-session 停训分支（1.A 高/1.B/1.C critical）
// 不调 finish_scene；control_session(stop) 后由 SKILL.md §3 特例规则 handoff 给 scene-post-session。
handlers.stop_session_with_signal = async (args) => {
  const cur = readState();
  if (!cur.active_session) {
    return { ok: false, error: "no_active_session", hint: "无 session 在进行，无可停" };
  }
  const oldBody = (cur.signals && Array.isArray(cur.signals.body)) ? cur.signals.body : [];

  // 组装 patch：signals 必有，user_state 可选
  const patch = {
    signals: {
      body: [...oldBody, { type: args.trigger, detail: args.detail, ts: nowISO(), severity: args.severity }]
    }
  };
  if (args.status_change) {
    const sc = args.status_change;
    const userStatePatch = { status: sc.to, since: sc.since || today(), _reason: sc.reason };
    if (sc.next_check) {
      userStatePatch.next_check = sc.next_check;
    } else if (sc.to === "sick" || sc.to === "injured") {
      const d = new Date(today()); d.setDate(d.getDate() + 1);
      userStatePatch.next_check = d.toISOString().slice(0, 10);
    }
    patch.user_state = userStatePatch;
  }

  const upd = handlers.update_state({ patch });
  if (!upd.ok) return composeFail("update_state", upd, false);

  // 拿 last_session 数据（在 stop 之前快照）
  const liveBefore = handlers.get_session_live({});

  // control_session(stop) —— 自动清 active_session + 清 pending_nodes
  const stopRes = handlers.control_session({ action: "stop" });
  if (!stopRes.ok) return composeFail("control_session", stopRes, false);

  return {
    ok: true,
    session_stopped: true,
    trigger: args.trigger,
    last_session_data: liveBefore && liveBefore.ok ? liveBefore : null,
    handoff_to: "scene-post-session.md",
    note: "本 turn 内立即加载执行 scene-post-session.md（pending_nodes 已被 control_session(stop) 清空）"
  };
};

// #c7 setup_onboarding —— onboarding 全内化（含原子回滚）
handlers.setup_onboarding = async (args) => {
  const bulk = (args && args.bulk) || {};
  const createdCron = [];

  // 0. 防重复：profile.basic_info.age 已存在 → 直接返回
  const cur = readState();
  if (cur.profile && cur.profile.basic_info && cur.profile.basic_info.age) {
    const fin = handlers.finish_scene({
      name: "onboarding",
      status: "skipped",
      summary: "已初始化过",
      daily_log_content: "## Onboarding\n\n- 状态: 已初始化过，跳过\n"
    });
    return { ok: true, skipped: true, reason: "already_initialized", log_file: fin.log_file };
  }

  // 校验必填
  if (!bulk.basic_info || bulk.basic_info.age === undefined) {
    return { ok: false, error: "bulk.basic_info.age 必填" };
  }
  if (!bulk.fitness_level) {
    return { ok: false, error: "bulk.fitness_level 必填" };
  }

  // 内部回滚函数：取消已建 cron + 清空 profile/user_state + finish_scene(error)
  async function rollback(failedStep, detail) {
    for (const name of createdCron) {
      try { await handlers.cancel_scheduled({ name }); } catch (_) {}
    }
    handlers.update_state({
      patch: { profile: null, user_state: { status: "available", since: today(), next_check: null } }
    });
    handlers.finish_scene({
      name: "onboarding",
      status: "error",
      summary: `failed_step=${failedStep}: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}`,
      daily_log_content: `## Onboarding 失败\n\n- 失败步骤: ${failedStep}\n- 已回滚: cron x${createdCron.length}, profile清空\n`
    });
    return { ok: false, failed_step: failedStep, error: typeof detail === "string" ? detail : (detail && detail.error) || "step_failed", detail, rolled_back: true, cron_cancelled: createdCron.slice() };
  }

  // 1. 写 profile + user_state + training_state
  const profilePatch = {
    basic_info: bulk.basic_info,
    goal: bulk.goal || "保持健康、规律运动",
    preferences: bulk.preferences || {},
    fitness_level: bulk.fitness_level,
    injuries: Array.isArray(bulk.injuries) ? bulk.injuries : [],
    max_hr_measured: null
  };
  const upd = handlers.update_state({
    patch: {
      user_state: { status: "available", since: today(), next_check: null },
      profile: profilePatch,
      training_state: {
        consecutive_training_days: 0,
        consecutive_rest_days: 0,
        recent_sessions: [],
        fatigue_estimate: "low",
        pending_adjustments: []
      }
    }
  });
  if (!upd.ok) return rollback("update_state", upd);

  // 2. cron x3 必建
  const cronJobs = [
    { name: "daily_report", cron: "0 22 * * *", prompt: "请使用 skill:health-claw 生成今日日报" },
    { name: "weekly_report", cron: weeklyTimeToCron(bulk.weekly_report_time || "Sun 20:00"), prompt: "请使用 skill:health-claw 生成本周周报" },
    { name: "monthly_report", cron: "0 20 1 * *", prompt: "请使用 skill:health-claw 生成上月月报" }
  ];
  // 3. 条件建 daily_workout_reminder
  if (bulk.reminder_mode === "scheduled" && bulk.reminder_time) {
    const [hh, mm] = bulk.reminder_time.split(":").map(s => parseInt(s, 10));
    if (!Number.isNaN(hh) && !Number.isNaN(mm)) {
      cronJobs.push({
        name: "daily_workout_reminder",
        cron: `${mm} ${hh} * * *`,
        prompt: "请使用 skill:health-claw 根据当前状态帮我安排今天的训练"
      });
    }
  }
  for (const job of cronJobs) {
    const r = await handlers.schedule_recurring(job);
    if (!r.ok) return rollback("schedule_recurring", { job, error: r.error });
    createdCron.push(job.name);
  }

  // 4. get_health_summary
  const hs = handlers.get_health_summary({});
  if (!hs.ok) return rollback("get_health_summary", hs);

  // 5. show_report(readiness_assessment)
  const readinessData = bulk.readiness || {
    overall: "available",
    dimensions: {
      physical_readiness: { level: "green", detail: "首次评估，按 baseline 处理" },
      stress_load: { level: "green", detail: "无历史数据" },
      recovery_status: { level: "green", detail: "无历史数据" },
      activity_context: { level: "green", detail: "无历史数据" }
    },
    suggestions: ["按 fitness_level 起步训练，几次后再校准"]
  };
  const sr = handlers.show_report({ report_type: "readiness_assessment", data: readinessData });
  if (!sr.ok) return rollback("show_report", sr);

  // 6. finish_scene(done)
  const fin = handlers.finish_scene({
    name: "onboarding",
    status: "done",
    summary: `Onboarding 完成. fitness_level=${bulk.fitness_level}, reminder_mode=${bulk.reminder_mode || "proactive"}, injuries=${profilePatch.injuries.length}`,
    daily_log_content: `## Onboarding 完成\n\n- 年龄: ${bulk.basic_info.age}\n- 体能基础: ${bulk.fitness_level}\n- 主要目标: ${profilePatch.goal}\n- 提醒模式: ${bulk.reminder_mode || "proactive"}\n- 已创建 cron: ${createdCron.join(", ")}\n`
  });
  if (!fin.ok) return rollback("finish_scene", fin);

  return {
    ok: true,
    cron_created: createdCron,
    readiness_overall: readinessData.overall,
    log_file: fin.log_file
  };
};

// 辅助：weekly time → cron
function weeklyTimeToCron(s) {
  const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}):(\d{2})$/.exec((s || "").trim());
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  if (!m) return "0 20 * * 0";
  return `${parseInt(m[3], 10)} ${parseInt(m[2], 10)} * * ${wd[m[1]]}`;
}

// ─── MCP stdio 主循环 (NDJSON) ─────────────────────────────────────────────
function log(...args) { process.stderr.write(`[health-claw-mcp] ${args.join(" ")}\n`); }

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function makeResult(content) {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }] };
}

function makeError(content) {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }], isError: true };
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "health-claw-mcp-server", version: "2.0.0" }
      }
    });
    return;
  }

  if (method === "notifications/initialized") {
    // 通知不需要回复
    return;
  }

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    logToolCall(toolName, args);

    // ── pending_nodes 前置护栏：last_scene.status=done 必须把节点清单走空 ──
    if (toolName === "update_state" && args && args.patch && args.patch.last_scene && args.patch.last_scene.status === "done") {
      const cur = readState();
      if (Array.isArray(cur.pending_nodes) && cur.pending_nodes.length > 0) {
        const { remaining } = popMatchingNode(cur, "update_state", args);
        if (remaining.length > 0) {
          const errPayload = {
            ok: false,
            error: "cannot_close_done_with_pending_nodes",
            remaining_pending_nodes: remaining,
            hint: `pending_nodes 里还有 ${remaining.length} 个节点没走完。完成所有节点再把 last_scene.status 写成 done；要中止场景请用 blocked/error/needs_context/skipped，或 control_session({action:"stop"}) 清场。`
          };
          send({ jsonrpc: "2.0", id, result: makeError(errPayload) });
          return;
        }
      }
    }

    const handler = handlers[toolName];
    if (!handler) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
      return;
    }

    try {
      const result = await handler(args);

      // ── pending_nodes 后处理（仅成功的非只读工具）──
      if (result && result.ok !== false && !READONLY_TOOLS.has(toolName)) {
        const cur = readState();
        let remaining = Array.isArray(cur.pending_nodes) ? cur.pending_nodes.slice() : [];
        let stateChanged = false;
        // 异常收尾（非 done 终态）：清空 pending_nodes
        if (toolName === "update_state" && args && args.patch && args.patch.last_scene && args.patch.last_scene.status && args.patch.last_scene.status !== "done") {
          if (remaining.length > 0) { remaining = []; cur.pending_nodes = []; stateChanged = true; }
        }
        // control_session(stop) handoff：清空 pending_nodes
        else if (toolName === "control_session" && args && args.action === "stop") {
          if (remaining.length > 0) { remaining = []; cur.pending_nodes = []; stateChanged = true; }
        }
        // 正常路径：弹出一个匹配节点
        else if (remaining.length > 0) {
          const { popped, remaining: next } = popMatchingNode(cur, toolName, args);
          if (popped) { remaining = next; cur.pending_nodes = next; stateChanged = true; }
        }
        if (stateChanged) writeJSON(STATE_PATH, cur);
        if (typeof result === "object" && result !== null) {
          result.remaining_pending_nodes = remaining.length;
          if (remaining.length > 0) result.next_pending_node = remaining[0];
          // 若 result 附带了 state 快照（update_state 等），同步 pending_nodes 避免返回旧值
          if (result.state && typeof result.state === "object") result.state.pending_nodes = remaining;
        }
      }

      if (result && result.error && !result.ok) {
        send({ jsonrpc: "2.0", id, result: makeError(result) });
      } else {
        send({ jsonrpc: "2.0", id, result: makeResult(result) });
      }
    } catch (err) {
      log("Tool error:", toolName, err.message);
      send({ jsonrpc: "2.0", id, result: makeError({ error: err.message }) });
    }
    return;
  }

  // 未知 method
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleRequest(msg).catch((err) => log("handleRequest error:", err.message));
  } catch (err) {
    log("JSON parse error:", err.message, "line:", trimmed.slice(0, 200));
  }
});
rl.on("error", (err) => { log("readline error:", err.message); });
process.stdin.on("error", (err) => { log("stdin error:", err.message); });

// ─── 本地 HTTP 接口 ────────────────────────────────────────────────────────
const HTTP_PORT = parseInt(process.env.HEALTH_CLAW_HTTP_PORT || "7926", 10);

const httpServer = http.createServer((req, res) => {
  // CORS for local
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);

  // GET /outbound/stream — SSE
  if (req.method === "GET" && url.pathname === "/outbound/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.write("event: connected\ndata: {}\n\n");
    sseClients.push(res);
    req.on("close", () => {
      const idx = sseClients.indexOf(res);
      if (idx >= 0) sseClients.splice(idx, 1);
    });
    return;
  }

  // POST 路由——需要读取 body
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let json;
      try { json = JSON.parse(body); } catch (_) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "invalid json" })); return; }

      // POST /inbound/message
      if (url.pathname === "/inbound/message") {
        let prompt = json.prompt;
        if (!prompt) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "prompt required" })); return; }
        if (!prompt.startsWith("请使用 skill:health-claw ")) {
          prompt = "请使用 skill:health-claw " + prompt;
        }
        const session = json.session || "main";
        const proc = spawn("openclaw", [
          "agent", "--message", prompt, "--to", session, "--deliver"
        ], { stdio: "ignore" });
        proc.on("error", (err) => {
          if (err.code === "ENOENT") {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: "openclaw_cli_not_found" }));
          }
        });
        // spawn 异步，立即返回
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, dispatched: true }));
        return;
      }

      // POST /inbound/callback
      if (url.pathname === "/inbound/callback") {
        const { request_id, response } = json;
        if (!request_id) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "request_id required" })); return; }
        const resolved = resolveCallback(request_id, response);
        res.writeHead(resolved ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resolved ? { ok: true } : { ok: false, error: "unknown request_id" }));
        return;
      }

      // POST /health
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, server: "health-claw-mcp-server", version: "2.0.0" }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    });
    return;
  }

  // GET /health
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "health-claw-mcp-server", version: "2.0.0" }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`⚠️ Port ${HTTP_PORT} already in use — running in MCP-only mode (no HTTP). Companion app features disabled.`);
  } else {
    log("HTTP server error:", err.code, err.message);
  }
});

httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
  log(`HTTP server listening on 127.0.0.1:${HTTP_PORT}`);
});

// ─── 全局异常兜底（保持 stdio MCP 可用）───────────────────────────────────
process.on("uncaughtException", (err) => {
  log("Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  log("Unhandled rejection:", String(reason));
});

// ─── 优雅关闭 ──────────────────────────────────────────────────────────────
process.on("SIGTERM", () => { httpServer.close(); process.exit(0); });
process.on("SIGINT", () => { httpServer.close(); process.exit(0); });

log("MCP Server started (stdio + HTTP)");
