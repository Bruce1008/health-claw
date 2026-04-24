# scene: workout-confirm（训练确认）

> 触发：
> - 用户点 App"锻炼一下"按钮 → `请使用 skill:health-claw 根据我当前状态帮我安排一次锻炼`
> - 用户在对话里说"我准备 xxx / 我想练 xxx"
> - `daily_workout_reminder` cron 触发 → `请使用 skill:health-claw 根据当前状态帮我安排今天的训练`
> - 用户点"过一会儿"被 `schedule_one_shot` 30 分钟后重新触发

## pending_nodes 清单

正常路径（`read_state` + `get_health_summary` 完成后声明）：

```json
[
  {"id":"s1_set_workout_plan","tool":"set_workout_plan"},
  {"id":"s2_show_report","tool":"show_report","match":{"report_type":"training_plan"}},
  {"id":"s3_set_alert_rules","tool":"set_alert_rules"},
  {"id":"s4_confirm","tool":"request_user_input"},
  {"id":"s5_write_daily_log","tool":"write_daily_log"},
  {"id":"s6_close_done","tool":"update_state","match":{"patch":"last_scene"}}
]
```

硬规则：

- **不得**以 `get_session_live` 替代 `read_state` 作为入口。`get_session_live` 只返回当前 session 实时状态，不含 `profile`/`recent_sessions`/`reminders`。
- Step 0 命中 blocked/skipped 分支（onboarding 未完成 / active_session 已有 / sick|injured / 内联 readiness=red）时直接写 `last_scene.status` 非 done，Server 自动清空 pending_nodes，**不需要**补完中间节点。
- 用户点"开始"后，本场景以 `last_scene.status = "done"` 收尾；`control_session(start)` 本身**不**在清单里（由 during-session 监听 Watch 事件触发）。

## Step 0：前置检查（一次性读完 state 后统一判断，不逐条串行卡）

`read_state` 返回后，按**优先级**从上到下检查；命中一条即按其动作处理，**不再往下**：

| # | 触发条件 | 动作 |
|---|---|---|
| 1 | `profile.basic_info.age` 不存在 | onboarding 未完成 → `last_scene = { name: "workout_confirm", status: "blocked", ts: <now>, summary: "onboarding 未完成" }`，告诉用户先完成首次设置，停手 |
| 2 | `state.active_session != null` | 已有训练在进行 → `last_scene.status = "blocked"`, summary: "当前已有 session"，提示用户结束后再开新的，停手 |
| 3 | `user_state.status ∈ {sick, injured}` | 不安排训练 → `last_scene.status = "skipped"`, summary: "用户 sick/injured"，提示先休息，停手 |
| 4 | `user_state.status ∈ {traveling, busy}` | **走超轻量分支**：跳过 Step 2 readiness 评估，Step 3 直接生成 5-10 分钟拉伸/呼吸类 `passive` 或 `timer` plan，然后进 Step 4-6 |
| 5 | 以上都不触发 | 正常流程：Step 1 → 6 |

**pending_adjustments 不是卡点**，Step 3 生成 plan 时读取即可，不在 Step 0 校验。

## Step 1：拉上下文（硬规则）

**生成训练计划前必须调用 `read_state`**——Step 0 已经调过，这一步只是提醒：你现在拿到的 `recent_sessions` 是写计划的核心输入。如果近 7 天数据不够（`recent_sessions` 长度 < 5 且 `consecutive_rest_days` 不足以解释），可以再调一次：

```
get_workout_log({ filter_type: "recent", limit: 10 })
```

> 如果 `set_workout_plan` 返回 `warning: missing_recent_context`，**立即停下来**补 `read_state`/`get_workout_log` 后重新调用。MCP Server 的这个 warning 是模型违反规则的硬证据。

## Step 2：内联简化 readiness（不跑完整 scene-readiness）

**不要**整个跑一遍 scene-readiness——那场景负责向用户展示评估报告，这里只是为了拿到内部决策输入。内联一个精简版：

```
get_health_summary()  // 拿昨晚睡眠 / HRV / 静息心率
```

综合下面 4 个维度快速判断一个 **overall 等级**（不展示给用户，仅用于本场景决策）：

| 维度 | 数据源 | 红灯判据（参考） |
|---|---|---|
| 睡眠 | `sleep.total_min` | < 5h |
| 压力 | `hrv.latest` vs `hrv.avg_7d` | 下降 ≥ 30% |
| 恢复 | `resting_hr.latest` vs baseline；距上次 high intensity 天数 | 静息心率上升 ≥ 15% 或同日二训 |
| 活动堆积 | `recent_sessions` + `consecutive_training_days` | 连续高强度 ≥ 3 天 |

- 任一红灯 → `overall = "red"` → **不安排训练**，告诉用户"今天身体信号偏强，建议休息或拉伸"，写 `last_scene.status = "skipped"`, summary: "readiness=red, 建议休息"
- 任一黄灯（阈值略低于红灯，由模型自行判断） → `overall = "yellow"` → **降强度**继续 Step 3
- 全绿 → `overall = "green"` → Step 3 按常规强度

**硬规则：本场景不调 `show_report({report_type:"readiness_assessment"})`、不做 injury_check 复查、不 write_daily_log 独立评估报告**——这些是 scene-readiness 的职责，本场景只要内部拿到 4 维度等级做 plan 决策。用户想看评估报告走"今日身体状态"按钮触发 scene-readiness。

## Step 3：决定训练内容

综合输入：

- `profile.fitness_level`、`profile.preferences.preferred_types`、`profile.preferences.available_equipment`、`profile.goal`
- `recent_sessions`（最近练了什么类型 / 强度 / 是否堆积）
- readiness 的 4 维度结果
- `pending_adjustments`（降量 / injury_recovery）
- `injuries`（active / chronic 都要避开相关动作）

决策原则（**模型自己判断**，skill 不写死）：

- 红黄灯阶梯降强度
- 连续高强度 ≥ 3 次 → 必须降强度
- 连续同类型 ≥ 4 次 → 穿插其他类型
- 长期未训练（`consecutive_rest_days ≥ 5`）后首次训练 → 降量
- injury_recovery 在 pending_adjustments 中 → 首次降强度

选定后，给出 `session_mode`（`set-rest` / `continuous` / `interval` / `flow` / `timer` / `passive` 之一）+ `plan` 内容。不同 session_mode 的 exercises 结构定义在 report-schema.md §2.1。

## Step 4：下发到 Watch + 展示到 iPhone

```
set_workout_plan({
  plan: { ... 计划详情 ... },
  session_mode: <session_mode>,
  date: <today>
})

show_report({
  report_type: "training_plan",
  data: {
    session_mode: <session_mode>,
    type: <运动类型>,
    duration_min: <预计时长>,
    plan_summary: <一句话摘要>,
    safety_notes: <降量原因 / 避开动作 / 等>
  }
})

set_alert_rules({
  rules: [
    { id: "emergency_hr", condition: "hr > profile.alert_hr.critical", level: "critical", local_only: true },
    { id: "high_hr", condition: "hr > profile.alert_hr.warning", level: "warning" },
    // 根据 session_mode 添加: 有氧加心率下限, set-rest 加组间休时长, interval 加工作/休息比, 等
  ]
})
```

> alert_hr 的具体数值由 MCP Server 在 `set_alert_rules` 内部把 `profile.alert_hr.critical` / `profile.alert_hr.warning` 替换为实际数字。**不要自己算**。

## Step 5：让用户确认

```
request_user_input({
  prompt: "今日训练: <type> <duration_min> 分钟, 准备好了吗？",
  input_type: "select",
  options: ["开始", "换一个", "跳过", "过一会儿"],
  target: "watch"
})
```

按用户回调分支：

| 回调 | 下一步 |
|---|---|
| `开始` | `control_session({ action: "start", session_mode: <s>, source: "planned" })` → 进入 scene-during-session。**用户点开始后 Watch 独立运行 plan**（按 `set_workout_plan` 下发的节奏 + `set_alert_rules` 下发的告警规则）——OpenClaw **不轮询** Watch 数据，只在 Watch 通过 SSE 主动上报事件（告警 / 暂停 / 结束）时才响应 |
| `换一个` | 回到 Step 3 重新选一个，但要避开刚才已被拒绝的类型；最多换 2 次，第三次仍拒 → 写 `last_scene.status = "skipped"` 并停手 |
| `跳过` | 不开 session，写 `last_scene = { name: "workout_confirm", status: "skipped" }`，记一条 `rest_day` 事件 |
| `过一会儿` | `schedule_one_shot({ delay: "30m", prompt: "请使用 skill:health-claw 30 分钟前问过的训练现在方便开始吗" })`，写 `last_scene.status = "skipped"`。**不要在前端做缓存**——30 分钟后用户状态可能变了，让 cron 重新触发本场景重新评估 |

## Step 6：落盘

无论分支结果如何，出口都要写：

```
update_state({
  patch: {
    last_scene: { name: "workout_confirm", status: <...>, ts: <now>, summary: "<决策摘要>" }
  }
})
// MCP Server 自动追加 scene_end 到 health-log.jsonl。

write_daily_log({ content: "## 训练确认\n\n- 决策: <开始 / 换一个 / 跳过 / 过一会儿>\n- 计划: <摘要 或 ->\n" })
```

如果决策是"开始"，则**不在本场景写 last_scene = done**——等 `scene-during-session` 和 `scene-post-session` 跑完再写。本场景只写 `last_scene = { name: "workout_confirm", status: "done" }` 表示"用户确认开始训练"。
