# scene: during-session（训练中）

> 触发：
> - 上一个场景 `scene-workout-confirm` 调用了 `control_session(start)` 并收到用户在 Watch 上的"暂停 / 结束训练"等回调
> - 用户在对话里问"现在心率多少 / 跑了多久了"
> - 用户主动反馈"有点不舒服 / 太累了 / 太轻松了"
> - 用户自发运动场景的 session 进行中

## 适用范围

本场景**只处理 session 进行中的实时事件**。不处理：

- session 启动 → `scene-workout-confirm`
- session 结束 → `scene-post-session`

## Step 0：前置检查

1. `read_state`
2. 确认 state 中有未释放的 session lock，且 `last_scene.name` 是 `workout_confirm` 或 `during_session`。否则用户的操作可能针对的不是本场景，写 `last_scene = { name: "during_session", status: "blocked" }` 并提示用户没有正在进行的训练。

## Step 1：识别当前事件类型

### 1.A：用户问实时数据（"现在心率多少 / 跑了多久了"）

```
get_session_live()
```

返回：

```json
{ "hr": 156, "duration_min": 23, "calories": 210, "current_phase": "work", "session_mode": "continuous", "ts": "..." }
```

用自然语言告诉用户。**不要写 last_scene**（这是查询，不算独立场景一次完整执行）。

如果返回 `{ active: false }` → 说明 session 已经被 Watch 端独立结束（罕见，可能是 Watch 强制停了）→ 立即调 `control_session({ action: "stop" })` 同步状态，然后跳到 `scene-post-session`。

### 1.B：用户主动反馈"有点不舒服 / 痛"

1. **不要医学诊断**。问一次是哪个部位、什么感觉，**不追问细节**。
2. 把信号写入 state：

```
update_state({
  patch: {
    signals: {
      body: [{ type: "pain", detail: <用户原话>, ts: <now> }]
    }
  }
})

append_health_log({
  event: { type: "signal", date: <today>, ts: <now>, category: "body", detail: <用户原话> }
})
```

> `signals.body` 是数组，写入时**追加**而不是替换——但 MCP Server 的 `update_state` 数组合并是整体替换，所以需要先 `read_state` 取出现有数组，再 push 新的，再传完整数组。

3. 根据严重度决定动作：
   - 用户说"小痛 / 还能继续" → 不强制停训，建议降强度，让用户自己决定
   - 用户说"很痛 / 受伤了" → 立即 `control_session({ action: "stop" })`，跳到 `scene-post-session`，并把 `user_state.status` 改为 `injured`
4. 写 `last_scene = { name: "during_session", status: "done" }`。

### 1.C：用户主动反馈"太轻松 / 太累"

只调整 session 内的"建议"——通过 `send_notification(target: "watch")` 推一条提示，不改 state，不重新生成 plan。如果用户多次反馈太累 → 走 1.D 让他停。

### 1.D：用户在 Watch 上点"暂停"

```
control_session({ action: "pause" })
```

写一条短日志，等用户后续点"继续"或"结束"。**不要主动催促用户**。

### 1.E：用户在 Watch 上点"继续"

```
control_session({ action: "resume" })
```

### 1.F：用户在 Watch 上点"结束训练"

```
control_session({ action: "stop" })
```

→ 跳到 `references/scene-post-session.md`。**不在本场景做 post-session 的工作**。

### 1.G：心率告警触发（Watch 本地震动 + Server SSE 上报）

由于 `set_alert_rules` 已经下发了 `local_only: true` 的紧急规则，Watch 端会自动暂停或震动告警。OpenClaw 收到告警事件后：

1. 不要催促用户，**不要刷屏**——异常只报一次
2. 把信号写 health-log + signals.body
3. 如果是 `critical` 级别 → 主动 `control_session(stop)`，跳到 `scene-post-session`
4. 如果是 `warning` 级别 → 不强制停，记日志即可

详见 `references/scene-anomaly-alert.md`。

## Step 2：出口

每次本场景的事件处理完都写 last_scene：

```
update_state({
  patch: {
    last_scene: { name: "during_session", status: <done|skipped|error>, ts: <now>, summary: "<本次事件摘要>" }
  }
})
// MCP Server 自动追加 scene_end 到 health-log.jsonl。
```

`during_session` 不写 `write_daily_log`——session 中可能触发多次本场景，全部交给 `scene-post-session` 在结束时合并写一次。

---

## 不在本场景做的事

- **不生成训练计划**——那是 `scene-workout-confirm`
- **不写训练复盘**——那是 `scene-post-session`
- **不修改 plan**——一旦 session 已经在跑就按现有 plan 走完，要换内容必须先 stop 再走 confirm 重开
- **不做强度评估**——那是 `scene-post-session` 在结束后做
