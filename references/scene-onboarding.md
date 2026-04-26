# scene: onboarding

> 触发：收到 `请使用 skill:health-claw 完成 onboarding` 开头的 bulk prompt（来源于 App 前端表单提交）。

> **Eval / 性能 note**：onboarding 包含 6 次 tool 调用（`update_state` ×1、`schedule_recurring` ×3–4、`get_health_summary`、`show_report`、`finish_scene`），在 `kimi-code` provider 下单次耗时 350–600s。eval 环境跑本 stage 前 `export SEND_TIMEOUT=900`。

## pending_nodes 清单

`read_state` 后先声明清单（按 SKILL.md §3）。基础 7 条必走；`reminder_mode == "scheduled"` 时在 s4 之后插入 `s4b_cron_reminder`：

```json
[
  {"id":"s1_profile_write","tool":"update_state","match":{"patch":"profile"}},
  {"id":"s2_cron_daily","tool":"schedule_recurring","match":{"name":"daily_report"}},
  {"id":"s3_cron_weekly","tool":"schedule_recurring","match":{"name":"weekly_report"}},
  {"id":"s4_cron_monthly","tool":"schedule_recurring","match":{"name":"monthly_report"}},
  {"id":"s4b_cron_reminder","tool":"schedule_recurring","match":{"name":"daily_workout_reminder"}},
  {"id":"s5_show_report","tool":"show_report","match":{"report_type":"readiness_assessment"}},
  {"id":"s6_finish","tool":"finish_scene","match":{"status":"done"}}
]
```

硬规则：

- 所有 cron 必须通过 `schedule_recurring` 建立；**不得**直接写 cron 配置文件。
- Step 0 发现 onboarding 已完成（profile.basic_info.age 已存在）→ 直接写 `last_scene = { status: "skipped" }`，**不声明 pending_nodes**。
- 失败回滚走 `last_scene.status = "error"`，Server 会自动清空 pending_nodes。

## 核心原则：一次性 bulk，无交互

**App 前端把所有 onboarding 字段一次性打包成 JSON 随第一条 prompt 送达**，本场景从开始到结束**不与用户做任何一问一答**。整个场景就是把 bulk payload 翻译成 `update_state` + `schedule_recurring` 调用。

- **禁用 `request_user_input`**——onboarding 阶段字段已在前端收齐
- **不追问缺失字段**——前端已校验 Q1/Q2/Q3/Q8/Q9 必填；payload 里如果缺选填字段，按 §"几个特殊细节"的默认值兜底
- **不向用户建议修改**——不评论用户填的 goal / fitness_level / reminder_mode

这意味着失败回滚也不需要和用户对话——全部靠 SSE 错误事件把状态还给前端，让前端重新触发 onboarding。

## Step 0：防重复 onboarding

调用 `read_state`：

- 若 `profile.basic_info.age` 已存在 → onboarding 已经完成过。回复一句"已经初始化过了"，调 `finish_scene({ name: "onboarding", status: "skipped", summary: "已初始化过" })`，**不再走后续步骤**。
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
      injuries: <数组; 见本文件"几个特殊细节"的 injuries 映射规则>,
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

**MCP Server 自动副作用**（不要自己实现这些，也不要手动传这些字段）：

- **alert_hr 自动算**：检测到 `basic_info.age` 且未设 `max_hr_measured` → 按 `(220 - age)` 做基准，critical = 95%，warning = 90%，自动写回 `profile.alert_hr`。模型**绝不**自己算这俩数字，手动传也会被覆盖。
- **profile_update 自动写日志**：profile 首次写入时自动 append `profile_update` 事件到 health-log.jsonl。

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

## Step 3：finish_scene 收尾

```
finish_scene({
  name: "onboarding",
  status: "done",
  summary: "Onboarding 完成. fitness_level=<Q3>, reminder_mode=<Q9>, injuries_count=<Q8 数量>",
  daily_log_content: "## Onboarding 完成\n\n- 年龄: <age>\n- 体能基础: <fitness_level>\n- 主要目标: <goal>\n- 提醒模式: <reminder_mode>\n- 已创建 cron: <列表>\n"
})
// → 内部一次性完成 update_state(last_scene) + write_daily_log + 自动 scene_end 镜像
```

## Step 4：首次 readiness_assessment

```
get_health_summary()  // 拉昨晚的睡眠/HRV/静息心率
```

根据返回数据 + `read_state` 的 profile，组装一份 `readiness_assessment` 报告——4 个维度固定 key：`physical_readiness`（睡眠）/ `stress_load`（HRV）/ `recovery_status`（静息心率）/ `activity_context`（最近 session）。每个维度填 `{level: "green"|"yellow"|"red", detail: "<一句话>"}`，再给 `overall` + `suggestions`。然后：

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

因为**前端一次性 bulk submit 所有字段、本场景无用户交互**，失败只能由模型自己检测 + 自己回滚，不能中断去问用户"要不要重试"。

任一步骤失败 → **整体回滚**：

1. 把已写入的 cron 全部 `cancel_scheduled` 删掉。
2. 用 `update_state` 把 profile 改回空 / 删掉 user_state。
3. `finish_scene({ name: "onboarding", status: "error", summary: "<错误原因>", daily_log_content: "<失败摘要>" })`——一次性完成 last_scene + daily_log + scene_end 镜像。

App 前端收到 SSE 错误事件后会让用户重新点"完成"触发一次新的 bulk prompt。**禁止让用户半完成进入主流程**——profile 要么全写要么全空。**模型不要写"请重试"给用户**——交互在前端完成，本场景的职责到 last_scene = error 为止。

---

## 几个特殊细节

- **injuries 字段映射**：bulk prompt 里的 `injuries.type` 字段 → `injuries[].status`：`acute → active`，`chronic → chronic`，`none → 空数组`。`injuries[].reported_at` 全部设为 onboarding 当天。如果 `injuries.description` 含 `;` 或 `；`，可以拆成多条 injury，每条都有同样的 `reported_at` 和 `status`。
- **goal 兜底**：bulk prompt 中 goal 为空字符串时用 `"保持健康、规律运动"`。
- **`weekly_report_time` 是 "其他自定义"**：bulk prompt 里前端会传规范化后的 `<weekday> HH:MM` 字符串，按上面的映射规则转 cron 即可。
- **不创建 alert_hr**：`profile.alert_hr` 由 MCP Server 从 `basic_info.age` 用 `(220 - age)` 推出来（critical=95%, warning=90%），手动传的值会被覆盖。
