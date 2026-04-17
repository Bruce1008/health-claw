# scene: anomaly-alert（异常预警）

> 触发：
> - 训练中 Watch 触发 `set_alert_rules` 中的 `critical` / `warning` 级别规则，告警事件通过 SSE 上报
> - 用户主动反馈强烈不适（疼痛 / 头晕 / 恶心 / 受伤等强信号）
> - `read_state` reminders 中出现"时效性异常"（注意：injury_check 的 14 天提醒**不算异常**，那是常规复查，走 readiness 场景处理）

## Step 0：识别异常类型

### 心率类（Watch 本地判断，持续超过阈值才上报）

| 类型 | 判据 | 严重度 |
|---|---|---|
| `hr_critical` | 心率 > `profile.alert_hr.critical` **持续 ≥ 10 秒** | 高 |
| `hr_warning` | 心率 > `profile.alert_hr.warning` **持续 ≥ 30 秒** | 中 |

**持续时长由 `set_alert_rules` 的 `duration_seconds` 下发**——Watch 在本地做滑动窗口判断，只有持续达到时长才震动 + 上报 OpenClaw。瞬时超阈值不报。

### 用户主动反馈类（即时判据，OpenClaw 在对话中识别）

| 类型 | 判据 | 严重度 |
|---|---|---|
| `pain_strong` | 用户用"很痛 / 剧痛 / 拉伤了 / 受伤了 / 拉不开 / 动不了" 等**明确强烈**措辞 | 高 |
| `dizziness` | 用户说"头晕 / 想吐 / 站不稳 / 眼前发黑 / 快晕倒" | 高 |
| `pain_mild` | 用户说"有点疼 / 小痛 / 不太对劲 / 怪怪的" 等**可继续但值得留意**的措辞 | 中 |

**高/中严重度判据总则：**

- **高 = 无法继续训练或风险明显**（强烈疼痛 / 头晕 / 心率持续危险区 / 明确受伤）——立即 stop
- **中 = 可继续但需记录提醒**（轻微不适 / 心率略高 / 信号堆积）——不 stop，记录 + 通知
- 含糊不清的措辞（"不太对劲"）倾向于**中**严重度；若用户追加强烈描述升级到**高**

### 信号堆积类

| 类型 | 判据 | 严重度 |
|---|---|---|
| `signal_overload` | 一周内 `signals.body` + health-log 中 `signal` 事件累计 ≥ 5 条（通过 `query_health_log({start_date:<7天前>, types:["signal"]})` 判断） | 中 |

## Step 1：通用前置

1. `read_state` 拿当前 session / user_state / signals
2. 检查异常是否**已经在本日报告过**——调 `query_health_log({ start_date: <today>, end_date: <today>, types: ["signal"] })` 拿今日所有 signal，看是否已有同类型（`category` + `detail` 关键词）。**已报过的不重复报**——交互红线"异常只说一次"。

## Step 2：分支处理

### 2.A：高严重度（hr_critical / pain_strong / dizziness）

```
control_session({ action: "stop" })
```

→ 立即停止训练，跳转 scene-post-session 走复盘流程。复盘的 `analysis` 字段写明因为告警而中止。

更新 user_state：

```
update_state({
  patch: {
    user_state: {
      status: "<sick 或 injured, 按情况>",
      since: <today>,
      next_check: <today + 1 天>
    },
    signals: {
      body: [<旧的> + { type: "<pain|dizziness>", detail: <用户原话或告警内容>, ts: <now> }]
    }
  }
})
```

写 health-log：

```
append_health_log({
  event: { type: "signal", date: <today>, ts: <now>, category: "body", detail: "<...>", severity: "high" }
})

append_health_log({
  event: { type: "status_change", date: <today>, ts: <now>, from: "available", to: "<sick|injured>", reason: "<...>" }
})
```

通知用户：

```
send_notification({
  title: "训练已停止",
  body: "<一句话, 比如 '心率超过安全上限，已停止训练。建议先休息 + 喝水，必要时就医。'>",
  target: "both"
})
```

**不要医学诊断。** 不说"你可能是 X 病"。最多说"建议关注 / 必要时就医"。

### 2.B：中严重度（hr_warning / pain_mild / signal_overload）

不停训，但记录 + 通知：

```
update_state({
  patch: {
    signals: {
      body: [<旧的> + { type: "<...>", detail: "<...>", ts: <now> }]
    }
  }
})

append_health_log({
  event: { type: "signal", date: <today>, ts: <now>, category: "body", detail: "<...>", severity: "medium" }
})

send_notification({
  title: "<提示标题>",
  body: "<一句话提示, 不强制停训>",
  target: "watch"
})
```

如果用户在 send_notification 后没有响应 → 不重复发。

如果是 `signal_overload`（一周内累积太多）→ 在下次 `readiness` 或 `daily_report` 场景中提一句"本周身体信号比较多，要不要安排几天休息"，**不在本场景再额外发通知**。

## Step 3：写 last_scene + 出口

```
update_state({
  patch: {
    last_scene: { name: "anomaly_alert", status: "done", ts: <now>, summary: "<异常类型>" }
  }
})
// MCP Server 自动追加 scene_end 到 health-log.jsonl。

write_daily_log({
  content: "## 异常预警\n\n- 类型: <...>\n- 严重度: <high|medium>\n- 处理: <stop|notify_only>\n- 用户状态: <user_state.status>\n"
})
```

---

## 几个边界

### 不在本场景做

- **不调用 readiness_assessment**——异常预警是即时事件，不重新跑评估
- **不修改 cron**——异常处理不影响日报/周报/月报调度
- **不跨日重复报告**——今天告警过 `hr_critical`，明天再次心率超阈值仍要报；但**同一天内不重复**

### 与 during-session 的关系

`during-session` 的 1.G 已经描述了心率告警的初步处理。本场景是它的"详细分支"——`during-session` 收到告警事件后，如果是高严重度就直接跳到本场景；中严重度可以在 `during-session` 内联处理，也可以跳过来。两个场景的边界不需要绝对清晰，按需选择。

### 与 readiness 的 reminders 处理

| reminder | 处理位置 |
|---|---|
| `injury_check`（active 伤病 `next_check_at` 到期） | **scene-readiness**，不走异常 |
| `profile_review`（30 天未复查 goal/fitness_level） | **scene-monthly-report**，不走异常 |

reminders 是常规的"该复查了"信号，**不是异常**。本场景只处理实时的、突发的、高强度的安全事件。

---

## 用户主动求助但没有具体异常的情况

如果用户在对话里说"我感觉不太对劲 / 我有点担心"但没有具体症状，**不要立刻进异常场景**。先用一句话问"哪里不对劲？"，根据回答再判断走哪个分支：

- 用户说出具体症状 → 按 Step 0 分类，进对应分支
- 用户说不出来 / 含糊 → 不进异常场景，不写 signal，告诉用户"如果有具体的不适随时告诉我"，把控制权还给用户。**不诊断、不施压、不追问**。
