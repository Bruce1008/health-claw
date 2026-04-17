# scene: reports（日报 / 周报 / 月报）

> 三种报告共享"前置检查 → 拉数据 → 组装 data → show_report → 落盘"的流程骨架，区别在于数据窗口、聚合维度、是否复查 profile。合并在一个文件减少切换成本。

---

## §1 daily-report（每晚日报）

> 触发：
> - cron `daily_report` 每晚 22:00 → `请使用 skill:health-claw 生成今日日报`
> - 用户主动说 "发今日日报 / 今天总结一下" / 用户从 App 二级菜单点"日报"
>
> 两条触发路径合并到本场景，**不区分来源**。

### 数据窗口

`daily_report` 覆盖 **前一天 22:00 → 当天 22:00** 的滑动 24 小时窗口。

为什么是 22:00 → 22:00 而不是 0:00 → 24:00：

- 22:00 时 HealthKit 的睡眠（昨晚）/HRV/静息心率数据已经完全同步
- 一份日报里同时包含"昨晚怎么睡的 → 今天做了什么 → 今天的状态"才有连贯性
- 0:00 触发会把睡眠数据拆到两份日报里

### Step 0：前置检查

1. `read_state`
2. 若 `profile.basic_info.age` 不存在 → onboarding 未完成 → 写 `last_scene = { name: "daily_report", status: "blocked", ts: <now>, summary: "onboarding 未完成" }`，**不要硬生成报告**。
3. 若 `state.active_session != null` → 用户正在训练中 → 写 `last_scene = { name: "daily_report", status: "skipped", ts: <now>, summary: "用户正在训练，日报延后" }`，并 `schedule_one_shot({ delay: "30m", prompt: "生成今日日报" })` 延后 30 分钟重触发。**不要硬生成报告**（会打断用户训练体验）。

### Step 1：拉数据

```
get_health_summary({ start_date: <yesterday>, end_date: <today> })
```

返回过去 24h 的睡眠 / HRV / 静息心率。

```
get_workout_log({ filter_type: "by_date", date: <today> })
```

返回今天发生的所有 session（可能为空）。

> 不要调 `get_workout_log({filter_type:"by_date", date: <yesterday>})`——昨晚 22:00 之后的 session 极少；如果真有，用 `get_workout_log({filter_type:"recent", limit:5})` 兜底捞最近几条然后按时间窗过滤。

### Step 2：组装 data

```json
{
  "date": "<today>",
  "sleep": {
    "total_min": "<number>",
    "deep_min": "<number>",
    "rem_min": "<number>",
    "summary": "<一句话>"
  },
  "activity": {
    "sessions": [
      { "type": "<...>", "duration_min": "<n>", "intensity": "<...>", "summary": "<...>" }
    ],
    "total_calories": "<number>",
    "summary": "<一句话>"
  },
  "body_signals": [
    { "type": "<pain|sick|fatigue>", "detail": "<原话>", "ts": "<...>" }
  ],
  "recovery_status": {
    "hrv_trend": "<rising|stable|falling>",
    "resting_hr": "<number>",
    "summary": "<一句话>"
  },
  "tomorrow_hint": "<一句话方向建议，不是计划>"
}
```

`body_signals` 取 state 中 `signals.body` 在过去 24h 的非过期条目。

### Step 3：show_report + 落盘

```
show_report({ report_type: "daily_report", data: { ... } })
write_daily_log({ content: "## 日报\n\n<简短摘要>\n" })
update_state({
  patch: {
    last_scene: { name: "daily_report", status: "done", ts: <now>, summary: "<一句话摘要>" }
  }
})
// MCP Server 自动追加 scene_end 到 health-log.jsonl。
```

### reminders 处理

| reminder | 处理 |
|---|---|
| `injury_check` | **不在 daily_report 处理**——日报是被动汇报，留给下次 readiness |
| `profile_review` | **不在 daily_report 处理**——留给月报 |

### 与 readiness 的区别

| 维度 | daily_report | readiness_assessment |
|---|---|---|
| 性质 | 回顾（过去 24h 怎么样） | 前瞻（现在适合干什么） |
| 触发 | 22:00 cron + 用户主动 | 训练前 + 用户主动问 |
| 输出 | 数据汇总 + 一句话方向建议 | 4 维度评估 + 建议方向 |
| 是否可能阻断训练 | 否 | 是（红灯时建议不练） |

**daily_report 不调用 readiness_assessment**。两者的数据来源类似，但聚合方式不同。

### 失败分支

| 情况 | 处理 |
|---|---|
| `get_health_summary` 返回空 / 失败 | 相关字段填 `null` 或 `"数据未同步"`，写 `last_scene.status = "needs_context"` |
| `get_workout_log` 返回空 | activity 字段填 `{ sessions: [], total_calories: 0, summary: "今天没有运动记录" }`，正常 done |
| `show_report` 失败 | 写 `last_scene.status = "error"`，记日志，不重试 |

---

## §2 weekly-report（周报）

> 触发：
> - cron `weekly_report` 在用户 onboarding 时选定的时间（默认周日 20:00） → `请使用 skill:health-claw 生成本周周报`
> - 用户主动说 "发本周周报 / 这周总结一下"

### 数据窗口

**最近自然 7 天**：从今天起往前推 7 天。用 `get_workout_log({filter_type:"recent", limit:30})` 一次拉够，再按日期过滤。

### Step 0：前置检查

1. `read_state`
2. 若 `profile.basic_info.age` 不存在 → `last_scene = { name: "weekly_report", status: "blocked", ts: <now>, summary: "onboarding 未完成" }`，停手。
3. 若 `state.active_session != null` → `last_scene = { name: "weekly_report", status: "skipped", ts: <now>, summary: "用户正在训练，周报延后" }`，`schedule_one_shot({ delay: "30m", prompt: "生成本周周报" })`，停手。

### Step 1：拉数据

```
get_workout_log({ filter_type: "recent", limit: 30 })
get_health_summary({ start_date: <7天前>, end_date: <today> })
```

### Step 2：组装 data

```json
{
  "period": { "start": "<7 天前>", "end": "<today>" },
  "training": {
    "total_sessions": "<number>",
    "total_duration_min": "<number>",
    "total_calories": "<number>",
    "by_type": {
      "力量训练": "<n>", "有氧": "<n>", "HIIT": "<n>",
      "瑜伽-普拉提": "<n>", "拉伸-恢复": "<n>", "休闲运动": "<n>"
    },
    "by_intensity": { "high": "<n>", "medium": "<n>", "low": "<n>" }
  },
  "health_trends": {
    "sleep_avg_min": "<number>",
    "sleep_quality_trend": "<rising|stable|falling>",
    "hrv_trend": "<rising|stable|falling>",
    "resting_hr_trend": "<rising|stable|falling>"
  },
  "highlights": ["<0-3 条事实层观察>"],
  "concerns": ["<0-3 条事实层观察>"],
  "next_week_hint": "<一句话方向建议>"
}
```

`by_type` **全部 6 个 key 必须存在**（0 也写）。

`highlights` / `concerns` 写作规则：

- ✅ "本周训练 4 次，比上周多 1 次"
- ✅ "HRV 7 日均值较上上周下降 12%"
- ❌ "你应该多休息"（劝说）
- ❌ "再坚持一下就达标了"（施压）

### Step 3：show_report + 落盘

```
show_report({ report_type: "weekly", data: { ... } })
write_daily_log({ content: "## 周报\n\n<简短摘要>\n" })
update_state({
  patch: {
    last_scene: { name: "weekly_report", status: "done", ts: <now>, summary: "<一句话摘要>" }
  }
})
// MCP Server 自动追加 scene_end 到 health-log.jsonl。
```

### reminders 处理

`profile_review` → **不在周报处理**，留给月报。  
`injury_check` → **不在周报处理**，留给下次 readiness。

### 失败分支

| 情况 | 处理 |
|---|---|
| 7 天内 0 次训练 | 仍生成报告，training 全 0，highlights / concerns 各写一句中性话（"本周休息为主"），正常 done |
| `get_health_summary` 返回空 | health_trends 字段填 `null`，写 `last_scene.status = "needs_context"` |
| `show_report` 失败 | 写 `last_scene.status = "error"` |

---

## §3 monthly-report（月报）

> 触发：
> - cron `monthly_report` 每月 1 号 20:00 → `请使用 skill:health-claw 生成上月月报`
> - 用户主动说 "发上月月报 / 这个月总结一下"

### 数据窗口

**上一个自然月**（如果今天是 4 月 1 日，覆盖 3 月 1 日 → 3 月 31 日）。

如果用户在月中主动要"这个月月报"，覆盖 **从本月 1 号到今天**——按 prompt 语义判断窗口起止。

### Step 0：前置检查

1. `read_state`
2. 若 `profile.basic_info.age` 不存在 → `last_scene = { name: "monthly_report", status: "blocked", ts: <now>, summary: "onboarding 未完成" }`，停手。
3. 若 `state.active_session != null` → `last_scene = { name: "monthly_report", status: "skipped", ts: <now>, summary: "用户正在训练，月报延后" }`，`schedule_one_shot({ delay: "30m", prompt: "生成上月月报" })`，停手。

### Step 1：拉数据

```
get_workout_log({ filter_type: "recent", limit: 100 })
get_health_summary({ start_date: <月初>, end_date: <月末> })
query_health_log({ start_date: <月初>, end_date: <月末>, types: ["body_data", "status_change"] })
```

- `get_workout_log`：训练记录，在内存里按日期窗口过滤
- `get_health_summary`：睡眠 / HRV / 静息心率
- `query_health_log`：拿 `body_data` 事件用于 `body_data_changes`（取月初、月末各一条做对比）；拿 `status_change` 用于观察月内状态波动（sick / injured 天数）

**不要 `Read health-log.jsonl` 全量**——文件一年 1MB+，走 `query_health_log` 过滤才合理。

### Step 2：组装 data

```json
{
  "period": { "start": "<月初>", "end": "<月末 或 today>" },
  "training": {
    "total_sessions": "<number>",
    "total_duration_min": "<number>",
    "total_calories": "<number>",
    "by_type": { "力量训练": "<n>", "有氧": "<n>", "HIIT": "<n>", "瑜伽-普拉提": "<n>", "拉伸-恢复": "<n>", "休闲运动": "<n>" },
    "by_intensity": { "high": "<n>", "medium": "<n>", "low": "<n>" },
    "frequency_per_week_avg": "<number>"
  },
  "health_trends": {
    "sleep_avg_min": "<number>",
    "sleep_quality_trend": "<rising|stable|falling>",
    "hrv_trend": "<rising|stable|falling>",
    "resting_hr_trend": "<rising|stable|falling>",
    "body_data_changes": [
      { "date": "<...>", "weight": "<n>", "body_fat": "<n>" }
    ]
  },
  "goal_progress": {
    "current_goal": "<profile.goal>",
    "observation": "<一段话，描述本月数据与 goal 的关系，不评价不施压>",
    "alignment": "<aligned|partial|drifting>"
  },
  "fitness_level_observation": {
    "current": "<profile.fitness_level>",
    "trend": "<improving|stable|declining>",
    "evidence": "<一句话证据>"
  },
  "phase_advice": ["<1-3 条阶段建议>"]
}
```

### Step 3：profile 复查（月报独有）

`read_state` 在月初触发时通常返回 `profile_review` reminder。

**3.1 fitness_level 复查**

| trend | 动作 |
|---|---|
| `improving` | 通过 `request_user_input(target: "phone")` 问用户是否升档——**问一次**，答"是"才更新，答"否"或"以后再说"不动 |
| `declining` | **默认不主动建议降档**（降档容易让用户有挫败感）。除非数据下降非常明显（次数减半 + 持续 2 月），否则只在月报中作为 observation 提一句 |
| `stable` | 不动 |

**3.2 goal 复查**

| alignment | 动作 |
|---|---|
| `aligned` | 不动，月报中肯定一句"目标进展顺利" |
| `drifting` | 通过 `request_user_input(target: "phone")` 问用户是否调整目标——**问一次** |
| `partial` | 不主动问，留作 observation |

**3.3 复查硬规则**

- 一份月报里**最多**触发一次复查交互（fitness_level 或 goal，二选一，按 trend 显著程度选）。**不要连问两次**。
- 用户选"以后再说"→ 不更新 profile，不重置 30 天计时（下次月报仍然提示 reminder）。

### Step 4：show_report + 落盘

```
show_report({ report_type: "monthly", data: { ... } })
write_daily_log({ content: "## 月报\n\n<简短摘要 + 下月方向>\n" })
write_global_memory({
  target: "milestone",
  content: "## <YYYY-MM> 月度小结\n\n- 训练 <n> 次, <n> 分钟\n- 强度分布: high <n> / medium <n> / low <n>\n- goal: <goal>, alignment: <...>\n- fitness_level: <current>, trend: <...>\n"
})
update_state({
  patch: {
    last_scene: { name: "monthly_report", status: "done", ts: <now>, summary: "<一句话摘要>" }
  }
})
// MCP Server 自动追加 scene_end 到 health-log.jsonl。
```

> 月报是少数几个会写 `write_global_memory(target: "milestone")` 的场景——把每月关键数字 + 目标进展写进 MEMORY，便于以后回顾。

### 失败分支

| 情况 | 处理 |
|---|---|
| 整月 0 次训练 | 仍生成月报；training 全 0；observation 写中性话；**不触发 fitness_level 复查**（数据不足）；可在 phase_advice 中提一句"上月活动较少"——问一次是否调整提醒方式 |
| 用户在复查中点"以后再说" | 不更新 profile，不重置 30 天计时 |
| `show_report` 失败 | 写 `last_scene.status = "error"` |

---

## 三种报告对比

| 维度 | daily_report | weekly | monthly |
|---|---|---|---|
| 数据窗口 | 24h（22:00→22:00） | 7 天 | 30 天（自然月） |
| 性质 | 状态 + 当天活动 | 频次 / 类型分布 / 短期趋势 | 目标进度 / 阶段建议 |
| 是否复查 profile | 否 | 否 | **是**（fitness_level 或 goal，最多一次） |
| 是否写 MEMORY | 否 | 否 | **是** |
| 方向建议 | 一句话 hint | 一句话 hint | 1-3 条阶段建议 |
