# show_report 数据结构

> `show_report({report_type, data})` 是 Skill 向 App 前端展示结构化报告的唯一通道。本文档定义 6 种 `report_type` 各自的 `data` 字段结构。

## 通用调用约定

```
show_report({
  report_type: "<6 选 1>",
  data: { ... }
})
```

**副作用：**

- MCP Server 写入 `<DATA_ROOT>/logs/{date}.show_report.json`
- 同时通过 SSE `/outbound/stream` 推送给 App 前端渲染

**调用时机：** 每个场景在主流程结束、写 `last_scene` 之前。**一个场景内通常只调一次** `show_report`（onboarding 例外，可能调一次 readiness_assessment）。

**报告类型 6 选 1：**

| report_type | 触发场景 | 性质 |
|---|---|---|
| `readiness_assessment` | scene-readiness / scene-onboarding | 前瞻评估 |
| `training_plan` | scene-workout-confirm | 训练计划展示 |
| `post_session` | scene-post-session | 训练后复盘 |
| `daily_report` | scene-daily-report | 24h 健康日报 |
| `weekly` | scene-weekly-report | 7 天周报 |
| `monthly` | scene-monthly-report | 30 天月报 |

---

## 1. readiness_assessment

**用途：** 多维身体准备度评估。**前瞻性**——回答"现在适合干什么"。

```json
{
  "overall": "yellow",
  "dimensions": {
    "physical_readiness": {
      "level": "green",
      "detail": "睡眠 7.5h，深睡占比 23%"
    },
    "stress_load": {
      "level": "yellow",
      "detail": "HRV 较 7 日均值下降 22%，提示压力偏高"
    },
    "recovery_status": {
      "level": "green",
      "detail": "静息心率正常，距上次高强度训练已 2 天"
    },
    "activity_context": {
      "level": "yellow",
      "detail": "连续休息 2 天，无活动记录"
    }
  },
  "suggestions": [
    "压力指标偏高，建议避免高强度对抗性训练",
    "可考虑低强度有氧或身心类训练帮助减压"
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `overall` | enum | `green` / `yellow` / `red`，4 维度的快速摘要 |
| `dimensions.<name>.level` | enum | `green` / `yellow` / `red` |
| `dimensions.<name>.detail` | string | 一句话事实描述（不施压、不诊断） |
| `suggestions` | string[] | 0-3 条方向性建议，**不写具体计划** |

### 1.1 4 个维度的固定 key

- `physical_readiness` — 睡眠时长、深睡+REM 比例
- `stress_load` — HRV 及其趋势
- `recovery_status` — 静息心率、距上次高强度训练间隔
- `activity_context` — recent_sessions、consecutive_rest_days

**4 个 key 必须都存在**，缺数据时 `level` 写 `null` 或 `unknown`，detail 写 `"数据未同步"`。

### 1.2 overall 计算规则

- **red**：任一维度触发红灯阈值（HRV 下降 ≥ 30% / 静息心率上升 ≥ 15% / 睡眠 < 5h）
- **yellow**：任一维度触发黄灯阈值
- **green**：所有维度均未触发

### 1.3 suggestions 写作规则

- ✅ "压力指标偏高，建议避免高强度对抗性训练"
- ❌ "今天做 30 分钟瑜伽"（这是计划，不是建议）
- ❌ "你应该多休息"（劝说）

---

## 2. training_plan

**用途：** 在 iPhone 展示本次 session 的训练计划总览。**`set_workout_plan` 之后立即调用。**

```json
{
  "type": "力量训练",
  "session_mode": "set-rest",
  "estimated_duration_min": 50,
  "intensity_target": "medium",
  "exercises": [
    {
      "name": "杠铃卧推",
      "sets": 4,
      "reps": "8-10",
      "rest_sec": 90,
      "note": "首组热身 60% 重量"
    },
    {
      "name": "哑铃飞鸟",
      "sets": 3,
      "reps": "12",
      "rest_sec": 60
    }
  ],
  "notes": "本次降量 10%（连续高强度后恢复）",
  "alert_summary": "心率上限 169（warning）/ 179（critical）"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 训练类型，6 大类之一 |
| `session_mode` | enum | 6 值之一（与 state-schema 一致） |
| `estimated_duration_min` | int | 预估总时长 |
| `intensity_target` | enum | `high` / `medium` / `low` |
| `exercises` | array | 动作列表，结构因 session_mode 不同而异 |
| `notes` | string | 一句话备注（如降量原因） |
| `alert_summary` | string | 心率告警阈值的人类可读摘要 |

### 2.1 不同 session_mode 的 exercises 结构

| session_mode | exercises 字段 |
|---|---|
| `set-rest` | `{name, sets, reps, rest_sec, note?}` |
| `continuous` | `{name, target_pace?, target_hr_zone?, duration_min}` |
| `interval` | `{name, work_sec, rest_sec, rounds}` |
| `flow` | `{sequence: ["体式 1", "体式 2", ...], total_min}` |
| `timer` | `{name, duration_min}` |
| `passive` | **不需要 exercises 字段**——用户自发运动，不安排动作 |

### 2.2 写作规则

- **不施压。** 不写"今天必须练完"
- **降量要写原因**，让用户理解为什么计划比平常轻
- **passive 模式时只写 type + notes**，其他字段可省略

---

## 3. post_session

**用途：** 训练结束后的复盘报告。`control_session(stop)` 之后调用。

```json
{
  "type": "力量训练",
  "session_mode": "set-rest",
  "duration_min": 52,
  "calories": 405,
  "intensity": "high",
  "completion": "full",
  "metrics": {
    "avg_hr": 142,
    "max_hr": 178,
    "time_in_zone": { "low": 8, "moderate": 30, "high": 14 }
  },
  "analysis": "胸部三组动作完成度高，心率峰值接近 critical 阈值；建议下次组间多休息 15 秒。",
  "next_hint": "明天可安排背部或休息一天"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 训练类型 |
| `session_mode` | enum | 6 值之一 |
| `duration_min` | int | 实际时长 |
| `calories` | int | 消耗 |
| `intensity` | enum | `high` / `medium` / `low` |
| `completion` | enum | `full` / `partial` / `aborted` |
| `metrics` | object | 心率/分区时间等，字段可选 |
| `analysis` | string | 2-3 句话复盘 |
| `next_hint` | string | 下次方向建议（一句话） |

### 3.1 completion 枚举

| 值 | 触发 |
|---|---|
| `full` | 正常完成 |
| `partial` | 用户提前结束（pause 后 stop） |
| `aborted` | 被告警强制停止（hr_critical 等） |

### 3.2 两点禁忌

- **`source == "user_initiated"` 时不写 `completion`**——用户自发运动只记录事实，不评价"完成 / 未完成"
- **不施压**："下次再加 5 公斤"这种话不写

### 3.3 aborted 情况下 analysis 必须说明原因

```
"analysis": "训练 18 分钟时心率超过 critical 阈值（179），自动停止。建议休息 + 喝水，必要时就医。"
```

---

## 4. daily_report

**用途：** 24h 健康日报。**回顾性**——回答"过去 24h 怎么样"。

**数据窗口：** 前一天 22:00 → 今天 22:00（滑动 24h）

```json
{
  "date": "2026-04-12",
  "sleep": {
    "total_min": 465,
    "deep_min": 102,
    "rem_min": 88,
    "summary": "7h45min, 深睡 22%"
  },
  "activity": {
    "sessions": [
      {
        "type": "有氧",
        "duration_min": 30,
        "intensity": "medium",
        "summary": "30 分钟跑步，5km"
      }
    ],
    "total_calories": 280,
    "summary": "一节 30 分钟有氧"
  },
  "body_signals": [
    { "type": "fatigue", "detail": "下午有点累", "ts": "2026-04-12T15:00:00Z" }
  ],
  "recovery_status": {
    "hrv_trend": "stable",
    "resting_hr": 58,
    "summary": "HRV 平稳，静息心率正常"
  },
  "tomorrow_hint": "明天可中等强度"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `date` | `YYYY-MM-DD` | 日报覆盖的"今天" |
| `sleep` | object | 睡眠数据；字段缺失时填 `null` |
| `activity` | object | 24h 内的运动记录 |
| `body_signals` | array | 过去 24h 内的非过期 `signals.body` 条目 |
| `recovery_status` | object | HRV / 静息心率快照 |
| `tomorrow_hint` | string | 一句话方向性建议，**不是计划** |

### 4.1 sleep 子字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `total_min` | int | 总睡眠时长 |
| `deep_min` | int | 深睡时长 |
| `rem_min` | int | REM 时长 |
| `summary` | string | 一句话摘要 |

### 4.2 activity.sessions 每条结构

```json
{ "type": "...", "duration_min": <n>, "intensity": "...", "summary": "..." }
```

注意：daily_report 的 sessions 是简化版，**不需要带 session_mode / source**——这些只在 state.json 的 recent_sessions 中保留。

### 4.3 recovery_status 子字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `hrv_trend` | enum | `rising` / `stable` / `falling` |
| `resting_hr` | int 或 null | 静息心率 bpm |
| `summary` | string | 一句话摘要 |

### 4.4 缺数据时

| 数据 | 处理 |
|---|---|
| `get_health_summary` 返回空 | 相关字段填 `null` 或 `"数据未同步"`，写 `last_scene.status = "needs_context"` |
| 当天无运动 | `activity = { sessions: [], total_calories: 0, summary: "今天没有运动记录" }` |

---

## 5. weekly

**用途：** 7 天周报。**不复查 profile。**

**数据窗口：** 最近自然 7 天（不卡周一/周日）

```json
{
  "period": { "start": "2026-04-06", "end": "2026-04-12" },
  "training": {
    "total_sessions": 4,
    "total_duration_min": 195,
    "total_calories": 1620,
    "by_type": {
      "力量训练": 2,
      "有氧": 1,
      "HIIT": 0,
      "瑜伽-普拉提": 1,
      "拉伸-恢复": 0,
      "休闲运动": 0
    },
    "by_intensity": { "high": 1, "medium": 2, "low": 1 }
  },
  "health_trends": {
    "sleep_avg_min": 442,
    "sleep_quality_trend": "stable",
    "hrv_trend": "rising",
    "resting_hr_trend": "stable"
  },
  "highlights": [
    "本周训练 4 次，比上周多 1 次",
    "HRV 7 日均值上升 8%"
  ],
  "concerns": [
    "周三睡眠仅 5h20min，明显低于均值"
  ],
  "next_week_hint": "可保持当前节奏，下周适合再加一节力量"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `period.start` / `period.end` | `YYYY-MM-DD` | 数据窗口起止 |
| `training.total_*` | int | 本周累计 |
| `training.by_type` | object | 6 大类计数，**全部 6 个 key 必须存在**（0 也写） |
| `training.by_intensity` | object | high/medium/low 计数 |
| `health_trends.sleep_avg_min` | int 或 null | 7 天均值 |
| `health_trends.*_trend` | enum | `rising` / `stable` / `falling` |
| `highlights` | string[] | 0-3 条事实层观察 |
| `concerns` | string[] | 0-3 条事实层观察 |
| `next_week_hint` | string | 一句话方向 |

### 5.1 highlights / concerns 写作规则

**只写事实，不写劝说：**

- ✅ "本周训练 4 次，比上周多 1 次"
- ✅ "HRV 7 日均值较上周下降 12%"
- ❌ "你应该多休息"
- ❌ "再坚持一下就达标了"

### 5.2 0 训练时

`training` 全 0；highlights / concerns 各写一句中性话（"本周休息为主"）；正常 done。

---

## 6. monthly

**用途：** 30 天月报。**复查 profile**（fitness_level 或 goal，二选一）。

**数据窗口：** 上一个自然月（cron 触发）或本月 1 号到今天（用户主动要求）

```json
{
  "period": { "start": "2026-03-01", "end": "2026-03-31" },
  "training": {
    "total_sessions": 18,
    "total_duration_min": 920,
    "total_calories": 7430,
    "by_type": {
      "力量训练": 9,
      "有氧": 4,
      "HIIT": 2,
      "瑜伽-普拉提": 2,
      "拉伸-恢复": 1,
      "休闲运动": 0
    },
    "by_intensity": { "high": 5, "medium": 9, "low": 4 },
    "frequency_per_week_avg": 4.2
  },
  "health_trends": {
    "sleep_avg_min": 438,
    "sleep_quality_trend": "stable",
    "hrv_trend": "rising",
    "resting_hr_trend": "falling",
    "body_data_changes": [
      { "date": "2026-03-01", "weight": 72.5, "body_fat": 18.2 },
      { "date": "2026-03-31", "weight": 71.8, "body_fat": 17.5 }
    ]
  },
  "goal_progress": {
    "current_goal": "增肌，卧推 100kg",
    "observation": "本月力量训练 9 次，卧推最大重量从 80kg 提升至 85kg，方向一致。",
    "alignment": "aligned"
  },
  "fitness_level_observation": {
    "current": "intermediate",
    "trend": "improving",
    "evidence": "本月卧推最大重量较上月提升 6%"
  },
  "phase_advice": [
    "下月可尝试加入复合动作组数",
    "保持每周至少 1 次拉伸恢复"
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `period.start` / `period.end` | `YYYY-MM-DD` | 月份起止 |
| `training.*` | — | 同 weekly，多 `frequency_per_week_avg` |
| `health_trends.body_data_changes` | array | 月初/月末体重体脂对比；为空时填 `[]` |
| `goal_progress.current_goal` | string | 当前 `profile.goal` |
| `goal_progress.observation` | string | 一段话描述本月与 goal 的关系，**不评价不施压** |
| `goal_progress.alignment` | enum | `aligned` / `partial` / `drifting` |
| `fitness_level_observation.current` | enum | 当前 `profile.fitness_level` |
| `fitness_level_observation.trend` | enum | `improving` / `stable` / `declining` |
| `fitness_level_observation.evidence` | string | 一句话证据 |
| `phase_advice` | string[] | 1-3 条阶段建议 |

### 6.1 alignment 枚举

| 值 | 含义 |
|---|---|
| `aligned` | 训练方向与 goal 一致 |
| `partial` | 部分一致，部分偏离 |
| `drifting` | 明显偏离 |

### 6.2 trend 枚举

| 值 | 含义 |
|---|---|
| `improving` | 数据明显上升 |
| `stable` | 持平 |
| `declining` | 数据明显下降 |

### 6.3 复查触发位置

monthly 是**唯一**会主动向用户提问复查的报告（fitness_level 或 goal，**最多一次**）。详见 scene-monthly-report.md Step 3。

### 6.4 0 训练时

`training` 全 0；observation 写中性话；**不触发 fitness_level 复查**（数据不足）；可在 phase_advice 中提一句"上月活动较少"。

---

## 7. 通用写作红线

适用于所有 6 种 report：

- **不施压。** 不写"你应该 / 必须 / 一定要"
- **不诊断。** 不说"你可能是 X 病"，最多说"建议关注 / 必要时就医"
- **不追问。** 报告是单向呈现，不在报告里塞反问句
- **数据缺失填 null 或 "数据未同步"**，不要编造
- **suggestions / hints / advice 都是方向性建议**，不是具体计划

---

## 8. 与 mcp-server.js 的同步责任

`show_report` 在 MCP Server 内**不强制校验 data 结构**——前端渲染容错处理。但本文档定义的字段是前端 UI 的契约，**改字段时需要同步通知前端开发**。

`report_type` 的 6 个枚举值在 mcp-server.js 顶部定义为 `REPORT_TYPE_ENUM` 常量，与本文档同步。
