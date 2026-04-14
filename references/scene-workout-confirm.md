# scene: workout-confirm（训练确认）

> 触发：
> - 用户点 App"锻炼一下"按钮 → `请使用 skill:health-claw 根据我当前状态帮我安排一次锻炼`
> - 用户在对话里说"我准备 xxx / 我想练 xxx"
> - `daily_workout_reminder` cron 触发 → `请使用 skill:health-claw 根据当前状态帮我安排今天的训练`
> - 用户点"过一会儿"被 `schedule_one_shot` 30 分钟后重新触发

## Step 0：前置检查

1. `read_state`
2. 若 `profile.basic_info.age` 不存在 → onboarding 未完成 → `last_scene = { name: "workout_confirm", status: "blocked" }`，告诉用户先完成首次设置。
3. 若 state 中有未释放的 `session.lock`（同时另一个 session 在跑） → `last_scene.status = "blocked"`，提示用户当前已有训练在进行。
4. **检查 user_state.status**：
   - `sick` / `injured` → 不安排训练，提示先休息，写 `last_scene = { name: "workout_confirm", status: "skipped" }`
   - `traveling` / `busy` → 走"超轻量训练"分支（5-10 分钟拉伸即可）
   - `available` / `low_motivation` → 正常往下走
5. **检查 pending_adjustments**：若数组非空，记下要应用的调整（降量、injury_recovery 的首次降强度），后续 Step 3 生成 plan 时考虑。

## Step 1：拉上下文（硬规则）

**生成训练计划前必须调用 `read_state`**——Step 0 已经调过，这一步只是提醒：你现在拿到的 `recent_sessions` 是写计划的核心输入。如果近 7 天数据不够（`recent_sessions` 长度 < 5 且 `consecutive_rest_days` 不足以解释），可以再调一次：

```
get_workout_log({ filter_type: "recent", limit: 10 })
```

> 如果 `set_workout_plan` 返回 `warning: missing_recent_context`，**立即停下来**补 `read_state`/`get_workout_log` 后重新调用。MCP Server 的这个 warning 是模型违反规则的硬证据。

## Step 2：跑一次 readiness（复用 scene-readiness）

按 `references/scene-readiness.md` 的 Step 1-4 跑完，但**不调用 show_report**——这次的目的是拿到 `overall` 和 4 维度结果作为输入。

如果 `overall == "red"` → 不安排训练，告诉用户今天身体不适合，建议拉伸或休息，写 `last_scene = { name: "workout_confirm", status: "skipped" }`。

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

选定后，给出 `session_mode`（六种之一）+ `plan` 内容（结构由 session_mode 决定，参见 `references/state-schema.md` 末尾的 plan 形态参考）。

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
| `开始` | `control_session({ action: "start", session_mode: <s>, source: "planned" })` → 进入 `references/scene-during-session.md` |
| `换一个` | 回到 Step 3 重新选一个，但要避开刚才已被拒绝的类型；最多换 2 次，第三次仍拒 → 写 `last_scene.status = "skipped"` 并停手 |
| `跳过` | 不开 session，写 `last_scene = { name: "workout_confirm", status: "skipped" }`，记一条 `rest_day` 事件 |
| `过一会儿` | `schedule_one_shot({ delay: "30m", prompt: "请使用 skill:health-claw 30 分钟前问过的训练现在方便开始吗" })`，写 `last_scene.status = "skipped"`。**不要在前端做缓存**——30 分钟后用户状态可能变了，让 cron 重新触发本场景重新评估 |

## Step 6：落盘

无论分支结果如何，出口都要写：

```
append_health_log({ event: { type: "scene_end", scene: "workout_confirm", status: <last_scene.status>, ... } })
update_state({ patch: { last_scene: { name: "workout_confirm", status: <...>, ts: <now> } } })
write_daily_log({ content: "## 训练确认\n\n- 决策: <开始 / 换一个 / 跳过 / 过一会儿>\n- 计划: <摘要 或 ->\n" })
```

如果决策是"开始"，则**不在本场景写 last_scene = done**——等 `scene-during-session` 和 `scene-post-session` 跑完再写。本场景只写 `last_scene = { name: "workout_confirm", status: "done" }` 表示"用户确认开始训练"。
