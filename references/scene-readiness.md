# scene: readiness（多维状态评估）

> 触发：
> - 用户点 App"今日身体状态"按钮 → `请使用 skill:health-claw 评估我今天的身体状态`
> - 用户在对话里问"我今天能练吗 / 我今天身体状态怎么样"
> - 训练前（被 `scene-workout-confirm` 调用）
> - **onboarding 完成后** Step 4 也走这里的判断逻辑

## pending_nodes 清单

`read_state` 后声明（按 SKILL.md §3）：

```json
[
  {"id":"s1_show_report","tool":"show_report","match":{"report_type":"readiness_assessment"}},
  {"id":"s2_write_daily_log","tool":"write_daily_log"},
  {"id":"s3_close_done","tool":"update_state","match":{"patch":"last_scene"}}
]
```

硬规则：

- **不得**调用 `get_workout_log`（`recent_sessions` 已够用）。
- 若 injury_check reminder 命中，在 s1 之后再插入两个节点：
  `{"id":"s1b_injury_ask","tool":"request_user_input"}`、
  `{"id":"s1c_injury_write","tool":"update_state","match":{"patch":"profile"}}`。
- Step 0 判定 onboarding 未完成或 health_summary 缺失时直接写 `last_scene.status = "blocked"|"needs_context"`，Server 会自动清空 pending_nodes，**不需要**补完余下节点。

## Step 0：前置检查

一行 `read_state`，看三个字段：

| 字段 | 触发动作 |
|---|---|
| `state.profile.basic_info.age` 不存在 | onboarding 未完成 → 写 `last_scene = { name: "readiness", status: "blocked", ts: <now>, summary: "onboarding 未完成" }`，告诉用户先完成首次设置，停手 |
| `reminders` 包含 `{type: "injury_check", ...}` | 记下待办，**在 Step 5 的 show_report 之后**执行一次"Injury check"交互（本文件末尾"Injury check 时机"节） |
| 其他 | 继续 Step 1 |

**不做**的检查（模型不手动做，MCP Server 不会暴露无效状态给 read_state）：
- 不用校验 state.json 是否存在——MCP 保证 read_state 永远返回合法结构
- 不用校验 signals 是否过期——MCP 在 read_state 内已清理
- 不用判断 reminders 的优先级——本场景只关心 injury_check，profile_review 是月报的事

## Step 1：拉数据

```
get_health_summary()  // 默认拉昨晚 + 今早最新
```

返回字段：

| 字段 | 用于评估维度 |
|---|---|
| `sleep`（昨晚总睡眠时长 + 深睡 + REM） | physical_readiness |
| `hrv`（最近 HRV + 7 日均值） | stress_load |
| `resting_hr`（今早静息心率 + 个人基线） | recovery_status |

如果 `get_health_summary` 返回空 / 失败 → 写 `last_scene = { name: "readiness", status: "needs_context" }`，告诉用户"今天的健康数据还没同步完，等一下再问我"，**不要硬编一个评估出来**。

## Step 2：读 state 中的 activity_context

`read_state` 返回的 `training_state.recent_sessions` + `training_state.consecutive_rest_days` + `training_state.consecutive_training_days` 提供 activity_context 维度。**不要再调一次 `get_workout_log`**，state 里的 `recent_sessions` 已经够用。

## Step 3：四维度评估

| 维度 | 数据来源 | 阈值（参考） |
|---|---|---|
| `physical_readiness` | `sleep.total_min`、`sleep.deep_min + sleep.rem_min` | green: 总睡眠 ≥ 7h；yellow: 5-7h；red: < 5h |
| `stress_load` | `hrv.latest` 与 `hrv.avg_7d` 的差值百分比 | green: 持平 / 上升；yellow: 下降 10-30%；red: 下降 ≥ 30% |
| `recovery_status` | `resting_hr.latest` 与 `resting_hr.baseline` 的差值；距上次 high intensity session 的天数 | green: 持平 + 间隔 ≥ 1 天；yellow: 上升 5-15% 或同日二训；red: 上升 ≥ 15% |
| `activity_context` | `recent_sessions` 数量、`consecutive_rest_days`、`consecutive_training_days` | green: 节奏正常；yellow: 连续休息 ≥ 4 天 / 连续训练 ≥ 4 天；red: 连续高强度 ≥ 3 天 |

每个维度填 `{ level: "green"|"yellow"|"red", detail: <一句话说明> }`。

## Step 4：综合 + suggestions

`overall`：

- 任一维度 red → `red`
- 任一维度 yellow（且无 red） → `yellow`
- 全部 green → `green`

`suggestions`（数组，每条一句话，**不超过 3 条**）：

- 不要写具体训练内容（"做 5×5 深蹲"），只写方向（"建议低强度有氧"/"建议拉伸恢复"/"建议放松类训练"）
- 不要做医学诊断
- 不要重复维度 detail 里已经说过的内容

参考组合（仅作判断启发，不是死规则）：

| 维度组合 | 建议方向 |
|---|---|
| 身体绿 + 压力黄 | 减压类（瑜伽、轻有氧），避免高对抗 |
| 身体黄 + 压力绿 | 低强度训练 |
| 身体绿 + 压力绿 + 连续休息 ≥ 3 天 | 可中高强度 |
| 任一维度红 | 休息 / 仅拉伸恢复 |

## Step 5：展示 + 落盘

```
show_report({
  report_type: "readiness_assessment",
  data: {
    overall: <"green"|"yellow"|"red">,
    dimensions: { physical_readiness: {...}, stress_load: {...}, recovery_status: {...}, activity_context: {...} },
    suggestions: [...]
  }
})
```

写日志 + last_scene：

```
write_daily_log({
  content: "## 状态评估\n\n- overall: <...>\n- 摘要: <一句话>\n- 建议方向: <列表>\n"
})

update_state({
  patch: {
    last_scene: { name: "readiness", status: "done", ts: <now>, summary: "overall=<...>" }
  }
})
// MCP Server 自动追加 scene_end 到 health-log.jsonl。
```

---

## Injury check 时机

如果 Step 0 的 `read_state` 返回 `reminders` 中有 `injury_check`，**在 Step 5 的 show_report 之后**插入一次复查交互：

```
request_user_input({
  prompt: "顺便问一下: 你之前提到的<injury.description>现在怎么样了？",
  input_type: "select",
  options: ["好了", "快好了", "还没好", "老毛病了"],
  target: "phone"
})
```

收到回调后（注意：MCP Server 的 `request_user_input` 是 Promise 阻塞实现——回调返回后模型仍然在**本 turn 内**，场景上下文完整，继续执行下面的 `update_state` 即可，**不需要重读文件**）：

| 用户回答 | injuries 该条的动作 | pending_adjustments |
|---|---|---|
| 好了 | `status` → `recovered`（**传完整 injuries 数组**） | 加一条 `{type: "injury_recovery", reason: <description>, created_at: <today>}`，下次首次训练时 `scene-workout-confirm` 会消费并降量 |
| 快好了 | 保持 `status: "active"`；`next_check_at` → `<today + 7 天>`（比默认 14 天短，因为用户自己说快好了） | 不加（还未恢复，不走 injury_recovery） |
| 还没好 | 保持 `status: "active"`；`reported_at` → `today`；`next_check_at` → `<today + 14 天>`（重置计时） | 不加 |
| 老毛病了 | `status` → `chronic` | 不加（chronic 伤病由训练时长期避开相关动作） |

**复查只在每天第一次 readiness 时做一次**，不要在同一天反复问。判断方式：靠本 turn 的会话上下文——本场景执行中已经调过 request_user_input 就不再调。cron 每天只触发一次 readiness；用户主动再问时，模型看对话历史知道已经问过。

**手动抑制机制（可选）：** 如果想在多轮 session 间也记住"今天问过了"，可以用 `query_health_log({ start_date: <today>, end_date: <today>, types: ["scene_end"] })` 查今天是否已有 `scene: "readiness"` 且 summary 里包含 "injury_check_asked" 的记录——但 MVP 阶段不要求这么做。

---

## 与其他场景的衔接

- 训练确认场景调用本场景前会让本场景的输出（`overall` 和维度）作为输入。
- onboarding 场景的 Step 4 直接走本场景的 Step 1 → Step 5。
- daily_report 场景**不调用**本场景，它有自己的 24h 数据组装逻辑。
