---
name: health-claw
description: 个人私教 skill。采集健康/运动数据，评估身体状态，护栏式下发训练计划，管理训练闭环（确认→执行→复盘），并生成日/周/月报。当用户提及训练、健身、跑步、力量、HIIT、瑜伽、心率、睡眠、HRV、Apple Watch、HealthKit、疲劳、伤痛、运动报告，或用自然语言描述身体状态、精力、恢复、运动表现、训练意愿时必须激活（即使未出现上述关键词）。
---

# health-claw

> 触发本 skill 后必须遵守的全局规则。具体场景的执行步骤在 `references/scene-*.md`，按需读取，不要全部预读。

---

## 1. 工具调用硬规则

**所有文件 IO 必须走 MCP 工具**——skill 运行期数据不在工作区内，内置 `read` / `write` / `edit` 工具读不到。

### 禁止

- **禁止**使用内置 `read` / `write` / `edit` / `update` 文件工具。
- **禁止**通过 `bash` / `shell` / `exec` 调用命令读写 skill 文件。
- **禁止**绕过 MCP 工具直接拼 JSON 写盘。

### 必须

- 进入任何场景前必须 `read_state`，**即使本会话内已读过**。上一个场景可能已经修改了 state，缓存的旧值会让安全护栏失效。
- `read_state` 是 MCP 工具，**不是**内置 `read`；两者不可互换。除非读取 reference 文档且显式提供 `path`，否则**禁止**调用内置 `read`。
- **最小闭环** = `read_state` → 场景工具 → `show_report`（如适用） → `update_state({patch:{last_scene}})` → `write_daily_log`。**在这条闭环走完之前不要输出最终回复给用户**。
- 工具调用错误（含 `ok: false` 返回 / `isError: true`）必须立即中断当前场景，写 `last_scene.status = "error"`，不要继续往下做。

### request_user_input 的 target 选择

| target | 用途 |
|---|---|
| `phone` | 需要思考、需要看完整文字、需要输入复杂内容（默认值） |
| `watch` | 训练前/中需要即时点击的二选一/三选一按钮 |

---

## 2. 场景索引

每个场景的执行步骤在对应 doc 里，按需读取。**不要预读全部场景文档**。所有场景都会 `read_state`/`update_state`，`state-schema.md` 为隐含依赖，下表只列该场景额外涉及的 schema。

| 触发 | 场景 | 场景文档 | 额外 schema |
|---|---|---|---|
| `请使用 skill:health-claw 完成 onboarding` 开头的 bulk prompt | 初次使用 | `references/scene-onboarding.md` | `report-schema.md`（readiness_assessment） |
| 用户点"今日身体状态" / 用户问"我今天能练吗" / 训练前 / onboarding 完成后 | 状态评估 | `references/scene-readiness.md` | `report-schema.md`（readiness_assessment） |
| 用户点"锻炼一下" / 用户说"我准备 xxx" / `daily_workout_reminder` cron 触发 | 训练确认 | `references/scene-workout-confirm.md` | `report-schema.md`（training_plan） |
| 训练中用户主动反馈疼痛/受伤 / Watch 上点"结束训练" / 心率持续超阈值上报 | 训练中 | `references/scene-during-session.md` | `health-log-schema.md`（signal / status_change） |
| `control_session(stop)` 之后 | 训练后 | `references/scene-post-session.md` | `report-schema.md`（post_session）·`health-log-schema.md`（session） |
| `daily_report` cron 22:00 触发 / 用户主动说"发今日日报" | 日报 | `references/scene-reports.md` §1 | `report-schema.md`（daily_report） |
| `weekly_report` cron 触发 / 用户主动说"发本周周报" | 周报 | `references/scene-reports.md` §2 | `report-schema.md`（weekly） |
| `monthly_report` cron 触发 / 用户主动说"发上月月报" | 月报 | `references/scene-reports.md` §3 | `report-schema.md`（monthly） |
| **无进行中 session 时**用户对话反馈强烈不适（疼痛/头晕/受伤）/ `signal_overload`（一周内 signal 事件 ≥ 5 条） | 异常预警 | `references/scene-anomaly-alert.md` | `health-log-schema.md`（signal / status_change） |
| 用户闲聊 / 问一般健身知识 / 非本 skill 明确触发条件的自然语言 | 对话 | `references/scene-lightweight.md` §chat | — |
| 用户主动报告身体信号（体重、体脂、肌肉量、腰围、静息心率自测值等） | 信号采集 | `references/scene-lightweight.md` §signal_capture_chat | `health-log-schema.md`（signal） |
| 用户说"今天休息" / 连续无训练日 | 休息日 | `references/scene-lightweight.md` §rest_day | `health-log-schema.md`（rest_day） |
| 用户报告状态变化（生病/受伤/出差/忙/低动机） | 状态变更 | `references/scene-lightweight.md` §status_change | `health-log-schema.md`（status_change） |
| 用户对前序训练计划/评估提出修正（"我更想练腿"、"别给我跑步"） | 计划修正 | `references/scene-lightweight.md` §user_correction | — |

---

## 3. 场景通用协议

每个场景都遵守：

1. **入口必须 `read_state`**（即使本会话内已读过）。
2. 检查 `read_state` 返回的 `reminders` 数组，若非空按 §4 处理。
3. 执行场景对应 doc 中的步骤。
4. **出口必须更新 `last_scene`**（`name` + `status` + `ts` + `summary`）。MCP Server 在 `update_state` 写入 last_scene 时**自动追加** scene_end 事件到 health-log.jsonl，模型**禁止**手动调用 `append_health_log({type:"scene_end"})`（会返回错误）。
5. **出口必须 `write_daily_log`** 把当前场景的人类可读摘要追加到当天日志。

**跨场景特例**：`control_session({action:"stop"})` 成功返回后必须**同一 turn 内**立即加载执行 `references/scene-post-session.md`。调用方场景（during-session、手动 stop）不写自己的 last_scene / daily_log，由 post-session 出口统一写入。这是唯一允许的跨场景执行流。

`last_scene.status` 必须是以下五个之一，**不允许只写正常路径**：

| 值 | 用法 |
|---|---|
| `done` | 正常走完 |
| `blocked` | 被前置条件挡住（如 onboarding 未完成、profile 缺关键字段、session 已被锁） |
| `needs_context` | 缺数据无法决策（如 `get_health_summary` 返回空、HealthKit 权限被撤销） |
| `error` | 工具调用失败、护栏拒绝、回滚 |
| `skipped` | 用户主动取消 / "过一会儿"推迟 |

**任何场景的写法都不能假设只有 `done` 一种结尾。**

---

## 4. read_state 返回的 reminders 处理

`read_state` 会附带 `reminders` 数组（MCP Server 自动维护）。reminders **不是阻断信号**，不要因为存在 reminder 就跳过本来要做的事。具体分支（`injury_check` / `profile_review` 的响应逻辑）见 `references/reminders.md`。

---

## 5. profile 字段更新规则

`profile` 是 OpenClaw 的"笔记本"，可以自由扩展。更新时遵守：

- 用 `update_state({ patch: { profile: {...} } })`，深度合并，不需要传完整 profile。
- **数组字段（`injuries` / `preferences.preferred_types` / `preferences.available_equipment`）整体替换**，更新一条 injury 时必须传完整数组。
- 区分"当下意愿" vs "长期偏好"：
  - "我今天想试试游泳" → **不更新** profile
  - "我以后都不想跑步了" / 用户连续多次拒绝某类训练 → **更新** profile
- `basic_info.age` 必填，影响 `alert_hr`。`alert_hr` 由 MCP Server 基于 `age` / `max_hr_measured` 自动维护，**不要自己计算**；训练后发现新最高心率时更新 `max_hr_measured`，Server 会自动重算。

---

## 6. 字段枚举值（写入前必须对照）

`update_state` 会校验枚举值，写错会被拒绝。**不要凭印象写**，对照下表：

| 字段 | 允许值 |
|---|---|
| `user_state.status` | `available` / `sick` / `injured` / `busy` / `traveling` / `low_motivation` |
| `last_scene.status` | `done` / `blocked` / `needs_context` / `error` / `skipped` |
| `injuries[].status` | `active` / `recovered` / `chronic` |
| `training_state.fatigue_estimate` | `low` / `moderate` / `high` |
| `recent_sessions[].intensity` | `high` / `medium` / `low` |
| `recent_sessions[].source` | `planned` / `user_initiated` |
| `set_workout_plan.session_mode` / `control_session.session_mode` | `set-rest` / `continuous` / `interval` / `flow` / `timer` / `passive` |

---

## 7. 训练计划上下文硬规则

**生成任何训练计划前，必须先 `read_state` 拿到 `recent_sessions`**（或调用 `get_workout_log({filter_type:"recent"})` 拿更多）。MCP Server 的 `set_workout_plan` 会在本会话内未读过 state 的情况下返回 `warning: missing_recent_context`——这是模型违反规则的硬证据，看到这个 warning 必须立即停下来补读 state，**不要忽略**。

**Onboarding 未完成时 `set_workout_plan` 会被 MCP Server 直接拒绝**（返回 `ok: false, error: "onboarding_incomplete"`）。看到这个错误一律走 onboarding 场景。

---

## 8. 交互红线

- **不追问**：伤病复查、信号采集都问一次，问完写状态，不二次追问细节。
- **不诊断**：任何身体异常都不要给医学结论，最多说"建议关注"或"必要时就医"。
- **异常只报一次**：同一异常不要在多个场景里反复提，只在第一次发现时通知用户。

---

## 9. cron 调度边界

- 创建/删除 cron job 只能通过 `schedule_recurring` / `schedule_one_shot` / `cancel_scheduled` 三个工具，**不要尝试**直接读写任何 cron 配置文件。
- onboarding 场景固定创建 3 个（日报/周报/月报）+ 条件创建 1 个（定时运动提醒），详见 `references/scene-onboarding.md`。
- 用户需要更改日报汇报时间 → **先 `cancel_scheduled({name:"daily_report"})` 再 `schedule_recurring`**，不要试图"修改"已存在的 job。
- 用户在训练确认场景点表达“等一下”或"过一会儿"等意思时 → 用 `schedule_one_shot({delay:"30m", prompt:"..."})`，30 分钟后由 cron 重新触发训练确认场景；**不要在前端做倒计时缓存重发**。
