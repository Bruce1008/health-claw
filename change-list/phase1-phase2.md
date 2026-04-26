# Phase 1 + Phase 2 改动清单（eval 同步用）

> 用途：按本清单逐项更新 `health-claw其余文件/eval/` 下的 mock、stages、断言。
> 涉及提交：`a78ba8d`（Phase 1）、`1736e9d`（Phase 2）。

---

## A. 新增工具（mock 必须新增）

### A1. `finish_scene`
**Phase 2 新增**。取代 `update_state(last_scene) + write_daily_log` 两步。

- **入参**：
  - `name` (string, **required**)：场景名
  - `status` (enum, **required**)：`done` / `blocked` / `needs_context` / `error` / `skipped`
  - `summary` (string, optional)
  - `daily_log_content` (string, optional)：缺省时 server 用 `## <name>\n\n- 状态: <status>\n- 摘要: <summary 或 "(无)">\n` 自动生成
  - `ts` (string, optional)：ISO，缺省 `now`
- **返回**：`{ok:true, last_scene:{name,status,ts,summary}, log_file, scene_end_logged:true, remaining_pending_nodes, next_pending_node?}`
- **副作用**：
  - 写 `state.last_scene`
  - 自动追加 `scene_end` 事件到 `health-log.jsonl`（沿用既有 update_state 镜像逻辑）
  - 追加内容到 `logs/<today>.md`
- **pending_nodes 匹配**：`{tool:"finish_scene", match:{status:"done"}}` —— 通过新增的 `status` 子集匹配键
- **enum 校验失败**：`{ok:false, error:"status 不合法: ..."}`

### A2. `reschedule_recurring`
**Phase 2 新增**。原子改 cron。

- **入参**：
  - `name` (string, **required**)
  - `new_cron` (string, **required**)：5/6 字段 cron 表达式（同 `schedule_recurring` 的 cron 校验）
  - `new_prompt` (string, **required**)：server 不缓存旧 prompt，必须传
  - `tz` (string, optional)
- **返回**：
  - 成功：`{ok:true, name, new_cron, tz}`
  - cancel 失败：`{ok:false, error:"cancel_failed", failed_step:"cancel_scheduled", detail, rolled_back:true}`
  - create 失败：`{ok:false, error:"create_failed", failed_step:"schedule_recurring", detail, rolled_back:false, hint:"原 cron <name> 已删除..."}`
- **内部行为**：依次 `cancel_scheduled({name})` → `schedule_recurring({name, cron:new_cron, prompt:new_prompt, tz})`

---

## B. 既有工具 — 入参/出参/行为变更

### B1. `read_state`（Phase 1）
- **新增可选入参** `projection: string[]`：dot-path 数组，如 `["user_state", "profile.basic_info", "training_state.recent_sessions"]`
- 传 projection 时返回 `{ok, state:<只含被选 slice + pending_nodes>, projection_applied:[...], reminders?:[...]}`
- 不传时行为完全向后兼容（返回完整 state）
- **`pending_nodes` 始终保留**，无论 projection 是否包含

### B2. `update_state`（Phase 1）
- **返回结构变化**：旧版返回完整 state；**新版只返回** `{ok:true, changed_keys:["..."], mirrored_events?:["signal","status_change",...]}`
  - 完整 state 不再回传，模型靠 `changed_keys` + 后续 `read_state(projection)` 自检
  - 由 request 后处理另行追加 `remaining_pending_nodes` / `next_pending_node`
- **新增自动镜像 health-log**（4 类事件）：
  | patch 触发 | 自动写入的 health-log 事件 |
  |---|---|
  | `signals.body` push 新条目（按 `ts\|type\|detail` 去重） | `{type:"signal", date, ts, category:"body", detail, severity?}` |
  | `user_state.status` 变化 | `{type:"status_change", date, ts, from, to, reason}` （reason 取自 `_reason` 字段） |
  | `training_state.recent_sessions` push 新条目（按 `date\|type\|duration_min` 去重） | `{type:"session", date, ts, session:<完整快照>}` |
  | `training_state.consecutive_rest_days` N→N+1 | `{type:"rest_day", date, ts}` |
- **新增透传字段** `user_state._reason`：写完镜像 status_change 后被 server 剥离，**不入 state**。mock 必须模拟"消费即剥离"行为。
- 既有自动事件继续生效：`scene_end`（last_scene 写入时）、`profile_update`（profile diff 时）

### B3. `append_health_log`（Phase 1）
- **新增拒绝 4 类**：`signal` / `status_change` / `session` / `rest_day` 一律返回 `{ok:false, error:"<type> 由 update_state 自动镜像，不要手动 append_health_log。<hint>"}`
- 旧已有的拒绝继续：`scene_end`、`profile_update`
- 仅 `body_data` 仍可手动 append

### B4. `get_workout_log`（Phase 1）
- **新增可选入参** `detail: boolean`
- **默认（不传 / false）**：`{ok:true, aggregate:{total_sessions, total_duration_min, total_calories, by_type:{...}, by_intensity:{high,medium,low}}, source}`
- **`detail:true`**：`{ok:true, aggregate:{...}, sessions:[<原始数组>], source}`
- 调用方修改：
  - workout-confirm 写计划：必传 `detail:true`
  - daily_report：必传 `detail:true`
  - weekly / monthly：默认 aggregate 即可

### B5. `get_health_summary`（Phase 1）
- **新增可选入参** `detail: boolean`
- 默认返回汇总；`detail:true` 返回完整 healthSummary
- mock 需准备两种返回形态

### B6. `cancel_scheduled` / `schedule_recurring`（Phase 2 软弱化，无字段变更）
- 改 cron 一律改用 `reschedule_recurring`，不再在 docs/示例里出现 cancel + create 串调
- mock 可保留旧两个工具（仍可用），但 stages 期望减少调用

---

## C. pending_nodes 匹配规则变更（Phase 2）

`nodeMatches()` 新增支持的 match 字段：

| match 字段 | 含义 |
|---|---|
| `status: "<x>"` | `args.status === x`，专用于 `finish_scene` close 节点 |

旧字段保留：`patch` / `report_type` / `name` / `action` / `event_type`。

特例 `match:{patch:"last_scene"}` 仍兼容旧场景文档（仍要求 `status==="done"`），但所有新文档已迁移到 finish_scene 节点。

---

## D. 每个场景的 tool-call 序列变化

> 模型一次 turn 内的成功调用次数。eval 断言阈值要按下表更新。

| 场景 | 旧调用数 | 新调用数 | 删除 / 替换 |
|---|---|---|---|
| **onboarding** | 7 | 6 | 删 `update_state(last_scene)` + `write_daily_log`，加 `finish_scene` |
| **readiness** | 4 | 3 | 同上 |
| **workout-confirm** | 6+1（confirm read+health summary 不计） | 5 | 删 close 二步，合并为 finish_scene |
| **post-session** | 5 | 4 | 删 close 二步 + 删手动 `append_health_log(session)`（已自动镜像） |
| **during-session 1.A 低/中** | 5 | 3 | 删 `append_health_log(signal)` + 删 close 二步 |
| **during-session 1.A 高** | 5 | 3 | 删 `append_health_log(signal)` + `append_health_log(status_change)`，stop 后由 post-session 收尾 |
| **during-session 1.B** | 1 | 1 | 不变（只 control_session(stop)） |
| **during-session 1.C critical** | 4 | 2 | 删 `append_health_log(signal)`，stop 后由 post-session 收尾 |
| **during-session 1.C warning** | 5 | 3 | 删 `append_health_log(signal)` + close 二步合并 |
| **anomaly 2.A 高** | 6 | 3 | 删 2 次手动 append + close 二步合并 |
| **anomaly 2.B 中** | 5 | 3 | 删手动 signal append + close 二步合并 |
| **anomaly 2.C overload** | 3 | 2 | 改用 `update_state(signals.body push)` 自动镜像，close 二步合并 |
| **lightweight chat** | 2 | 1 | finish_scene |
| **lightweight signal_capture** | 4 | 2 | 删 `append_health_log(signal)` 改为 update_state 自动镜像，close 二步合并 |
| **lightweight rest_day** | 4 | 2 | 删 `append_health_log(rest_day)` 改为 update_state 自动触发 |
| **lightweight status_change** | 4 | 2 | 同上（status_change 自动镜像） |
| **lightweight user_correction** | 2 | 1 | finish_scene |
| **daily_report** | 3 | 2 | close 二步合并 |
| **weekly_report** | 3 | 2 | close 二步合并 |
| **monthly_report** | 4 | 3 | close 二步合并（write_global_memory milestone 仍保留） |

---

## E. health-log 事件来源映射（mock 校验产物用）

最终 `health-log.jsonl` 的事件来源现在分两类：

| 事件 type | 来源 |
|---|---|
| `scene_end` | server 自动（update_state(last_scene) 或 finish_scene 触发） |
| `profile_update` | server 自动（update_state(profile) diff 出 changed_fields） |
| `signal` | server 自动镜像（update_state(signals.body push)） |
| `status_change` | server 自动镜像（update_state(user_state.status 变化, _reason 提供原因）） |
| `session` | server 自动镜像（update_state(training_state.recent_sessions push)） |
| `rest_day` | server 自动镜像（update_state(training_state.consecutive_rest_days N→N+1)） |
| `body_data` | 模型手动 `append_health_log({event:{type:"body_data",...}})` —— **唯一仍允许手动写的类型** |

**eval 断言要点**：
- 任意 stage 的 `tool-calls.jsonl` 中**不应再出现** `append_health_log` 调用 type 为前 6 类
- `health-log.jsonl` 最终产物的事件总数和字段结构**保持不变**（这是用户体验真值）
- update_state 调用之后必检 `mirrored_events` 字段（如果应该触发镜像）

---

## F. state.json 不变量

- `pending_nodes` 始终是数组（缺省 `[]`），projection 调用时也总会返回此 key
- `user_state._reason` **永远不应出现在最终 state.json**——若 mock state-after.json 看到则是 bug
- `profile.alert_hr` 由 server 自动算（age 或 max_hr_measured 变更时触发）

---

## G. 文档侧变更（不影响 mock，但 eval prompts 可能引用）

- `SKILL.md` §1 新增"自动镜像规则"硬规则段
- `SKILL.md` §3 节点格式表加 `status` 行，close 节点改用 finish_scene 表述
- `SKILL.md` §9 cron 段：`reschedule_recurring` 取代 cancel+create 串调
- `references/state-schema.md` 新增"health-log 自动镜像"表
- `references/scene-*.md` 全部 8 个场景文档已迁移到新节点 + finish_scene 写法

---

## H. eval 改动 checklist（按本 list 实操顺序）

- [ ] mock 增加 `finish_scene` handler：模拟入参校验 + 写 last_scene 到 state-after + 自动 scene_end 事件 + daily log 文本
- [ ] mock 增加 `reschedule_recurring` handler：模拟两步链 + 三种返回（成功/cancel 失败/create 失败）
- [ ] mock `read_state` 支持 `projection` 入参，按 dot-path 切片返回
- [ ] mock `update_state`：
  - [ ] 返回结构改为 `{ok, changed_keys, mirrored_events?}`
  - [ ] 实现 4 类自动镜像写入 health-log.jsonl
  - [ ] 剥离 `_reason` 透传字段
- [ ] mock `append_health_log` 拒绝 6 类自动事件（仅留 body_data）
- [ ] mock `get_workout_log` / `get_health_summary` 默认返回 aggregate，`detail:true` 返回 detail
- [ ] 更新所有 stage 期望调用次数（按 §D 表）
- [ ] 更新 `state-after.json` 期望（剥 `_reason`、新增 last_scene 由 finish_scene 写入等结构应保持）
- [ ] 更新 `health-log*.jsonl` 期望（事件总数 / 字段不变；来源声明由手动改自动镜像）
- [ ] cron 相关 stage：`reschedule_recurring` 单调用替代旧 cancel+create 序列
- [ ] 新工具的错误注入：finish_scene 传非法 status；reschedule_recurring 模拟 cancel/create 失败检测 `failed_step` + `rolled_back`
