# scene: during-session（训练中）

> 触发：session 进行中，Watch 通过 SSE 上报下列三类事件之一：
> - 用户主动反馈强烈不适（疼痛 / 头晕 / 受伤）
> - 用户在 Watch 上点"结束训练"
> - 心率超过 critical 阈值**持续 ≥ 10 秒**（warning 30 秒），Watch 本地震动后上报 OpenClaw

## 核心原则：训练中 OpenClaw 尽量不参与

用户点"开始"后，Watch 按 `set_workout_plan` 下发的节奏独立运行，按 `set_alert_rules` 下发的规则本地告警和震动。**OpenClaw 不轮询**，只在上述三类事件到达时才进入本场景。

**不在本场景做的事（Watch 端本地处理，不经 OpenClaw）：**

- 用户问"现在心率多少 / 跑了多久了" → Watch 屏幕上已实时显示，不经 OpenClaw
- 用户反馈"太轻松 / 太累" → 用户自己在 Watch 上调，不实时改 plan
- 用户按"暂停 / 继续" → Watch 本地暂停计时和引导，**不上报 OpenClaw**
- 心率偶尔尖峰但未持续 10 秒 → Watch 本地判断，不上报

## Step 0：前置检查

1. `read_state`
2. 若 `state.active_session == null` → 事件不对应任何进行中的 session → 写 `last_scene = { name: "during_session", status: "blocked", ts: <now>, summary: "无进行中 session" }`，停手。

## Step 1：分支处理（三选一）

### 1.A：用户主动反馈疼痛/受伤（对话中捕获）

1. **不医学诊断**。一次性问清楚"哪个部位、什么感觉"，**不追问细节**。
2. 把信号写入 state + health-log（`signals.body` 是数组，**先 read_state 取出现有数组再 push 再完整写回**）：

```
update_state({
  patch: {
    signals: {
      body: [...<旧条目>, { type: "pain", detail: <用户原话>, ts: <now> }]
    }
  }
})

append_health_log({
  event: { type: "signal", date: <today>, ts: <now>, category: "body", detail: <用户原话>, severity: "<low|medium|high>" }
})
```

3. 按严重度决定下一步：

**低/中**（"小痛"、"有点疼"、"怪怪的"、"不太对劲"）：不停训。

```
send_notification({ target: "watch", body: "记录了，建议降低强度。要继续吗？" })
```

出口写 `last_scene = { name: "during_session", status: "done", ts: <now>, summary: "pain_mild 已记录" }`。

**高**（"很痛"、"剧痛"、"拉伤了"、"动不了"、"头晕"、"想吐"、"站不稳"）：

```
update_state({
  patch: {
    user_state: { status: "<injured|sick>", since: <today>, next_check: <today + 1 天> }
  }
})

append_health_log({
  event: { type: "status_change", date: <today>, ts: <now>, from: "available", to: "<injured|sick>", reason: <用户原话> }
})

control_session({ action: "stop" })
```

→ stop 返回后按 SKILL.md §3 特例规则，**同一 turn 内**直接执行 scene-post-session.md 全部步骤（`completion: "partial"`；`analysis` 开头写"本次因用户反馈强烈不适中止"）。本分支**不写自己的 last_scene**，由 post-session 出口统一写。

### 1.B：用户在 Watch 上点"结束训练"

```
control_session({ action: "stop" })
```

→ stop 返回后按 SKILL.md §3 特例规则，**同一 turn 内**直接执行 scene-post-session.md 全部步骤（`completion: "full"`，正常结束）。本分支**不写自己的 last_scene** / **不写 daily_log** / **不更新 recent_sessions**——全部由 post-session 出口统一处理。

### 1.C：心率告警事件（Watch 已本地震动 + 持续超阈值后上报）

由于 `set_alert_rules` 下发时已含 `duration_seconds`（critical 10s / warning 30s），Watch 端先本地震动告警且根据 `local_only` 可能本地暂停；OpenClaw 接到事件后：

1. **不催促用户，不刷屏**——异常只报一次。同日同类型 signal 去重靠 `query_health_log({start_date:<today>, end_date:<today>, types:["signal"]})` 查今日是否已有同 `category` + 相近 `detail` 的条目，有则不重复写。
2. 按级别处理：

**`critical` 级别：**

```
update_state({
  patch: {
    signals: { body: [...<旧条目>, { type: "hr_critical", detail: "心率超过 critical 持续 10 秒+", ts: <now> }] }
  }
})

append_health_log({
  event: { type: "signal", date: <today>, ts: <now>, category: "body", detail: "hr_critical 持续 10s+", severity: "high" }
})

control_session({ action: "stop" })
```

→ stop 返回后按 SKILL.md §3 特例规则，**同一 turn 内**直接执行 scene-post-session.md 全部步骤（`completion: "partial"`；`analysis` 开头写"本次因心率 critical 持续 10 秒+ 中止，实际训练 X 分钟"）。本分支**不写自己的 last_scene**，由 post-session 出口统一写。

**`warning` 级别：**

```
update_state({
  patch: {
    signals: { body: [...<旧条目>, { type: "hr_warning", detail: "心率偏高持续 30 秒", ts: <now> }] }
  }
})

append_health_log({
  event: { type: "signal", date: <today>, ts: <now>, category: "body", detail: "hr_warning 持续 30s", severity: "medium" }
})

send_notification({ target: "watch", body: "心率偏高，注意节奏" })
```

不强制停训，继续等后续事件。出口写 `last_scene = { name: "during_session", status: "done", ts: <now>, summary: "hr_warning 已记录" }`。

## Step 2：关于"换一个 plan"的边界

用户训练开始后说"这个太累了想换"——**不在本场景处理**。正确路径：

1. 引导用户走 Watch 上的"结束训练"（触发 1.B），本次 session 以 `partial` 完结进 post-session
2. 若用户还想继续练别的 → 让他从 App 重新点"锻炼一下"，走 `scene-workout-confirm` 重新生成 plan

**硬规则：session 中不做 plan 热替换**——Watch 已按 `set_workout_plan` 下发的节奏独立运行，中途改 plan 会让两边认知不同步。stop + restart 是唯一路径。

## 不在本场景做的事

- **不生成训练计划**——那是 `scene-workout-confirm`
- **不写训练复盘**——那是 `scene-post-session`
- **不修改 plan**——session 中想换内容必须先 stop 再走 confirm 重开
- **不做强度评估**——那是 `scene-post-session` 在结束后做
- **不轮询实时数据**——Watch 不上报就不打扰
