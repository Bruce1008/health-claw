# scene: onboarding

> 触发：收到 `请使用 skill:health-claw 完成 onboarding` 开头的 bulk prompt（来源于 App 前端表单提交）。

## 前置条件

- 必须有完整 bulk prompt 中的 JSON payload。**禁用 `request_user_input`**——onboarding 阶段一切字段已经在 App 前端收齐，禁止反问用户任何字段。
- App 前端已经做完了校验：Q1/Q2/Q3/Q8/Q9 必填，条件分支字段也已校验。如果 payload 中字段缺失，按 §5 的默认值兜底，**不向用户反问**。

## Step 0：防重复 onboarding

调用 `read_state`：

- 若 `profile.basic_info.age` 已存在 → onboarding 已经完成过。回复一句"已经初始化过了"，写 `last_scene = { name: "onboarding", status: "skipped" }`，**不再走后续步骤**。
- 若 `profile` 为空或缺 `basic_info.age` → 进入 Step 1。

## Step 1：写入 profile（一次性）

用 `update_state` 把 bulk prompt 的 JSON 翻译成完整 patch，**单次调用**完成所有写入：

```
update_state({
  patch: {
    user_state: { status: "available", since: <today>, next_check: null },
    profile: {
      basic_info: { age: <Q1>, gender: <Q2 映射: male|female|unspecified> },
      goal: <Q4 或默认 "保持健康、规律运动">,
      preferences: {
        preferred_types: <Q5 数组 或 []>,
        available_equipment: <Q6 数组 或 ["自重"]>,
        training_time: <Q7 或 "不固定">,
        reminder_mode: <Q9: scheduled|proactive>,
        reminder_time: <Q9a: "HH:MM" 或 不传>,
        weekly_report_time: <Q10 或 "Sun 20:00">
      },
      fitness_level: <Q3: beginner|intermediate|advanced>,
      injuries: <见 §3>,
      max_hr_measured: null
      // 不要手动算 alert_hr——MCP Server 会自动算并写入
    },
    training_state: {
      consecutive_training_days: 0,
      consecutive_rest_days: 0,
      recent_sessions: [],
      fatigue_estimate: "low",
      pending_adjustments: []
    }
  }
})
```

**MCP Server 自动副作用**（不要自己实现这些）：

- 检测到 `max_hr_measured = null` 且 `basic_info.age` 存在 → 自动计算 `alert_hr.critical = (220-age) × 0.95`、`alert_hr.warning = (220-age) × 0.90`，写入 profile。
- 检测到 profile 首次写入 → 自动追加 `profile_update` 事件到 health-log.jsonl。

## Step 2：创建 cron jobs（必创 3 个 + 条件 1 个）

按下面顺序，**每个都用独立的 `schedule_recurring` 调用**：

```
schedule_recurring({
  name: "daily_report",
  cron: "0 22 * * *",
  prompt: "请使用 skill:health-claw 生成今日日报"
})

schedule_recurring({
  name: "weekly_report",
  cron: <由 Q10 字符串转 cron, 默认 "0 20 * * 0">,
  prompt: "请使用 skill:health-claw 生成本周周报"
})

schedule_recurring({
  name: "monthly_report",
  cron: "0 20 1 * *",
  prompt: "请使用 skill:health-claw 生成上月月报"
})
```

**条件创建**——仅当 `reminder_mode == "scheduled"` 时：

```
schedule_recurring({
  name: "daily_workout_reminder",
  cron: <由 Q9a HH:MM 转 "MM HH * * *">,
  prompt: "请使用 skill:health-claw 根据当前状态帮我安排今天的训练"
})
```

**Q10 字符串到 cron 的映射**：

| Q10 选项 | cron |
|---|---|
| `Sun 20:00` | `0 20 * * 0` |
| `Mon 08:00` | `0 8 * * 1` |
| `Fri 20:00` | `0 20 * * 5` |
| 其他自定义 `<weekday> HH:MM` | 按相同规则拼接 |

## Step 3：写入 last_scene + 日志

```
update_state({
  patch: {
    last_scene: {
      name: "onboarding",
      status: "done",
      ts: <now ISO8601>,
      summary: "Onboarding 完成. fitness_level=<Q3>, reminder_mode=<Q9>, injuries_count=<Q8 数量>"
    }
  }
})
// MCP Server 会自动追加 scene_end 事件到 health-log.jsonl，模型不要手动调用 append_health_log。

write_daily_log({
  content: "## Onboarding 完成\n\n- 年龄: <age>\n- 体能基础: <fitness_level>\n- 主要目标: <goal>\n- 提醒模式: <reminder_mode>\n- 已创建 cron: <列表>\n"
})
```

## Step 4：首次 readiness_assessment

```
get_health_summary()  // 拉昨晚的睡眠/HRV/静息心率
```

根据返回数据 + `read_state` 的 profile，组装一份 `readiness_assessment` 报告（4 个维度结构见 `references/report-schema.md`），然后：

```
show_report({
  report_type: "readiness_assessment",
  data: { overall, dimensions: {...}, suggestions: [...] }
})
```

报告展示后用自然语言对用户说一句简短欢迎 + 解释他接下来能用本 skill 做什么（"今晚 22:00 我会发第一份日报""周日 20:00 周报"……）。**不要劝说**用户改 reminder_mode，**不要评价**用户的 goal。

## Step 5（如果选了 scheduled）：补一句提醒

如果 `reminder_mode == "scheduled"`，告诉用户"明天 <reminder_time> 我会主动提醒你训练，到时你可以点开始/换一个/跳过/过一会儿"。**只说一次**。

---

## 失败回滚

任一步骤失败 → **整体回滚**：

1. 把已写入的 cron 全部 `cancel_scheduled` 删掉。
2. 用 `update_state` 把 profile 改回空 / 删掉 user_state。
3. `update_state({ patch: { last_scene: { name: "onboarding", status: "error", ts: <now>, summary: "<错误原因>" } } })`（MCP Server 自动写 scene_end 到 health-log）。
4. `write_daily_log` 写失败摘要。

App 前端收到 SSE 错误事件后会让用户重新点"完成"重试。**禁止让用户半完成进入主流程**——profile 要么全写要么全空。

---

## 几个特殊细节

- **injuries 字段映射**：bulk prompt 里的 `injuries.type` 字段 → `injuries[].status`：`acute → active`，`chronic → chronic`，`none → 空数组`。`injuries[].reported_at` 全部设为 onboarding 当天。如果 `injuries.description` 含 `;` 或 `；`，可以拆成多条 injury，每条都有同样的 `reported_at` 和 `status`。
- **goal 兜底**：bulk prompt 中 goal 为空字符串时用 `"保持健康、规律运动"`。
- **`weekly_report_time` 是 "其他自定义"**：bulk prompt 里前端会传规范化后的 `<weekday> HH:MM` 字符串，按上面的映射规则转 cron 即可。
- **不创建 alert_hr**：alert_hr 由 MCP Server 在 `update_state` 检测到 age 时自动计算。手动传 alert_hr 字段也会被自动覆盖。
