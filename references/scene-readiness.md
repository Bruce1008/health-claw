# scene: readiness（多维状态评估）

> 触发：
> - 用户点 App"今日身体状态"按钮 → `请使用 skill:health-claw 评估我今天的身体状态`
> - 用户在对话里问"我今天能练吗 / 状态怎么样"
> - 训练前（被 `scene-workout-confirm` 调用）
> - **onboarding 完成后** Step 4 也走这里的判断逻辑

## Step 0：前置检查

1. `read_state`
2. 若 `profile.basic_info.age` 不存在 → onboarding 未完成 → 不能评估，写 `last_scene = { name: "readiness", status: "blocked" }`，告诉用户先完成首次设置。
3. 若 `read_state` 返回 `reminders` 中含 `injury_check` → 见本 doc 末尾"Injury check 时机"。

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

append_health_log({
  event: { type: "scene_end", scene: "readiness", status: "done", date: <today>, ts: <now>, summary: "overall=<...>" }
})

update_state({ patch: { last_scene: { name: "readiness", status: "done", ts: <now> } } })
```

---

## Injury check 时机

如果 Step 0 的 `read_state` 返回 `reminders` 中有 `injury_check`，**在 Step 5 的 show_report 之后**插入一次复查交互：

```
request_user_input({
  prompt: "顺便问一下: 你之前提到的<injury.description>现在怎么样了？",
  input_type: "select",
  options: ["好了", "还没好", "老毛病了"],
  target: "phone"
})
```

收到回调后：

| 用户回答 | 动作 |
|---|---|
| 好了 | `update_state` 把对应 injury 的 `status` 改为 `recovered`（**传完整 injuries 数组**），并往 `pending_adjustments` 加一条 `{type: "injury_recovery", reason: <description>, created_at: <today>}`，下次首次训练时 `scene-workout-confirm` 会读到并降量 |
| 还没好 | `update_state` 把对应 injury 的 `reported_at` 改为今天（重置 14 天计时），其他字段保留 |
| 老毛病了 | `update_state` 把对应 injury 的 `status` 改为 `chronic` |

**复查只在每天第一次 readiness 时做一次**，不要在同一天反复问。判断方式：检查当天 `health-log.jsonl` 是否已有 `injury_check_done` 类型的事件——如果场景里有需要可以补一条；最简单的判断是看本会话上下文里是否已经做过这个交互。

---

## 与其他场景的衔接

- 训练确认场景调用本场景前会让本场景的输出（`overall` 和维度）作为输入。
- onboarding 场景的 Step 4 直接走本场景的 Step 1 → Step 5。
- daily_report 场景**不调用**本场景，它有自己的 24h 数据组装逻辑。
