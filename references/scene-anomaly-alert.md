# scene: anomaly-alert（异常预警）

> 触发：**仅在 `state.active_session == null`（无进行中训练）时**进入。两类来源：
> - 用户对话中主动反馈强烈不适（疼痛 / 头晕 / 恶心 / 受伤等强信号）
> - `signal_overload`：一周内 `signals.body` + health-log 中 `signal` 事件累计 ≥ 5 条（由 readiness / daily-report 等场景在 `query_health_log` 中发现后路由进来）
>
> **训练中的所有事件（疼痛、心率告警、Watch 点结束）一律走 `scene-during-session.md`**——本场景不处理进行中的 session。`injury_check` 常规复查走 `scene-readiness.md`，`profile_review` 走 `scene-monthly-report`，都不走本场景。

## pending_nodes 清单（按分支）

Step 0 分类后，按命中分支声明对应的一份：

> **自动镜像生效**：`update_state(user_state.status 变化)` 自动写 `status_change` 事件、`update_state(signals.body push)` 自动写 `signal` 事件——以下清单**已删去**手动 append_health_log 节点。

**2.A 高严重度**（pain_strong / dizziness）：

```json
[
  {"id":"s1_user_state","tool":"update_state","match":{"patch":"user_state"}},
  {"id":"s2_signal_state","tool":"update_state","match":{"patch":"signals"}},
  {"id":"s3_notify","tool":"send_notification"},
  {"id":"s4_finish","tool":"finish_scene","match":{"status":"done"}}
]
```

**2.B 中严重度**（pain_mild）：

```json
[
  {"id":"s1_signal_state","tool":"update_state","match":{"patch":"signals"}},
  {"id":"s2_notify","tool":"send_notification"},
  {"id":"s3_finish","tool":"finish_scene","match":{"status":"done"}}
]
```

**2.C signal_overload**（不发通知）：

```json
[
  {"id":"s1_signal_state","tool":"update_state","match":{"patch":"signals"}},
  {"id":"s2_finish","tool":"finish_scene","match":{"status":"done"}}
]
```

Step 1 去重命中（今日已有同类 signal）/ `active_session != null`（routing 错误）/ 用户表述含糊（走 skipped）→ 直接写 `last_scene.status` 非 done，Server 自动清空 pending_nodes，**不需要**补完。

## Step 0：分类异常严重度

### 用户主动反馈类（OpenClaw 在对话中识别）

| 类型 | 判据 | 严重度 |
|---|---|---|
| `pain_strong` | 用户用"很痛 / 剧痛 / 拉伤了 / 受伤了 / 拉不开 / 动不了"等**明确强烈**措辞 | 高 |
| `dizziness` | 用户说"头晕 / 想吐 / 站不稳 / 眼前发黑 / 快晕倒" | 高 |
| `pain_mild` | 用户说"有点疼 / 小痛 / 不太对劲 / 怪怪的"等**可继续生活但值得记录**的措辞 | 中 |

**严重度判据：**

- **高 = 急性受伤或风险明显**——更新 `user_state.status` 为 `injured` 或 `sick`，建议休息/就医
- **中 = 轻微不适，可观察**——只记录信号，不改 user_state
- 含糊措辞（"不太对劲"）默认**中**；用户追加强烈描述升为**高**

### 信号堆积类

| 类型 | 判据 | 严重度 |
|---|---|---|
| `signal_overload` | 一周内 `signals.body` + health-log 中 `signal` 事件累计 ≥ 5 条 | 中 |

## Step 1：前置检查 + 去重

1. `read_state` 拿当前 user_state / signals。
2. **必须确认 `state.active_session == null`**——若不为 null 说明 routing 错了（训练中事件应走 during-session），写 `last_scene = { name: "anomaly_alert", status: "blocked", ts: <now>, summary: "active_session 进行中，应走 during-session" }`，停手。
3. 去重：调 `query_health_log({ start_date: <today>, end_date: <today>, types: ["signal"] })` 看今日是否已有同 `category` + 相近 `detail` 的条目，有则**不重复写**也**不重复通知**——交互红线"异常只说一次"。

## Step 2：分支处理

### 2.A：高严重度（pain_strong / dizziness）

```
update_state({
  patch: {
    user_state: { status: "<injured|sick>", since: <today>, next_check: <today + 1 天>, _reason: <用户原话> },
    signals: { body: [...<旧条目>, { type: "<pain|dizziness>", detail: <用户原话>, ts: <now>, severity: "high" }] }
  }
})
// → 自动镜像 status_change（_reason 被消费后剥离）+ signal 两个事件

send_notification({
  title: "建议休息",
  body: "<一句话, 例: '记录了你说的不适。今天先休息，必要时就医，明天我会再问你状态。'>",
  target: "phone"
})
```

**不医学诊断。** 不说"你可能是 X 病"。最多说"建议关注 / 必要时就医"。

> **注：** 本场景不调 `control_session(stop)`——前置已确认无 active_session，无可停。如果用户 in-session 报疼，事件应被路由到 during-session 1.A 而不是这里。

### 2.B：中严重度（pain_mild）

不改 user_state，只记信号 + 通知：

```
update_state({
  patch: {
    signals: { body: [...<旧条目>, { type: "pain", detail: <用户原话>, ts: <now>, severity: "medium" }] }
  }
})
// → 自动镜像 signal 事件

send_notification({
  title: "记录了",
  body: "<一句话, 例: '记下了，如果加重再告诉我。'>",
  target: "phone"
})
```

### 2.C：信号堆积（signal_overload）

不发实时通知（避免打扰），把"本周信号偏多，建议安排休息"作为提示**留给下一次 readiness 或 daily_report 场景**附带提一句。本场景只追加 signal 标记：

```
update_state({
  patch: {
    signals: { body: [...<旧条目>, { type: "signal_overload", detail: "本周累计 N 条 signal", ts: <now>, severity: "medium" }] }
  }
})
// → 自动镜像 signal 事件
```

## Step 3：出口

```
finish_scene({
  name: "anomaly_alert",
  status: "done",
  summary: "<异常类型>",
  daily_log_content: "## 异常预警\n\n- 类型: <pain_strong|dizziness|pain_mild|signal_overload>\n- 严重度: <high|medium>\n- 处理: <updated_user_state|notify_only|log_only>\n- 用户状态: <user_state.status>\n"
})
```

---

## 不在本场景做的事

- **不处理进行中 session 的任何事件**——in-session 疼痛/头晕/心率告警/点结束都走 `scene-during-session`
- **不调 `control_session(stop)`**——本场景执行的前提是无 session
- **不调用 readiness_assessment**——异常处理是即时事件，不重新跑评估
- **不修改 cron**——异常处理不影响日报/周报/月报调度
- **不处理 `injury_check` reminder**——那是常规复查，走 `scene-readiness`
- **不处理 `profile_review` reminder**——那是月度复查，走 `scene-monthly-report`
- **不跨日重复报告**——今天已写 signal 的同类型事件，明天再次发生仍要报；但**同一天内不重复**

---

## 用户主动求助但没有具体异常的情况

如果用户在对话里说"我感觉不太对劲 / 我有点担心"但没有具体症状，**不要立刻进入 Step 2**。先用一句话问"哪里不对劲？"，根据回答再判断：

- 用户说出具体症状 → 按 Step 0 分类，进对应分支
- 用户说不出来 / 含糊 → **不进 Step 2**，**不写 signal**，告诉用户"如果有具体的不适随时告诉我"，把控制权还给用户。**不诊断、不施压、不追问**。出口写 `last_scene = { name: "anomaly_alert", status: "skipped", summary: "用户表达含糊，未记录" }`。
