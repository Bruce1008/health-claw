# show_report 数据结构

> `show_report({report_type, data})` 是 Skill 向 App 前端展示结构化报告的唯一通道。本文档定义 6 种 `report_type` 各自的 `data` 字段结构。

## 索引

| 看什么 | 章节 |
|---|---|
| 通用调用约定 | 下方 |
| readiness 评估 | §1 |
| training_plan 训练计划 | §2 |
| post_session 训练复盘 | §3 |
| daily_report 日报 | §4 |
| weekly 周报 | §5 |
| monthly 月报 | §6 |
| 通用写作红线 | §7 |
| 字段分级（必填/选填）通则 | §8 |
| MCP 同步责任 | §9 |

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
  "analysis": "胸部三组动作完成度高，心率峰值接近 critical 阈值；组间休息略短。",
  "next_check_in": "明天"
}
```

| 字段 | 类型 | 核心/选填 | 说明 |
|---|---|---|---|
| `type` | string | 核心 | 训练类型 |
| `session_mode` | enum | 核心 | 6 值之一 |
| `duration_min` | int | 核心 | 实际时长 |
| `calories` | int | 选填 | 消耗（HealthKit 缺数据时可省略） |
| `intensity` | enum | 核心 | `high` / `medium` / `low` |
| `completion` | enum | 核心 | `full` / `partial` |
| `metrics` | object | 选填 | 心率/分区时间等；Watch 未采集到可整体省略 |
| `analysis` | string | 核心 | 2-3 句话复盘（**只描述这次，不预测下次**） |
| `next_check_in` | string | 选填 | 下次再见时间提示，例："明天 / 后天 / 休息 2 天后"；**只说时间，不说练什么** |

### 3.1 completion 枚举

| 值 | 触发 |
|---|---|
| `full` | 正常完成 |
| `partial` | 用户提前结束（pause 后 stop）或被告警强制停止 |

**注意：** 原先有过第三个值 `aborted`（告警强制停）。现在合并进 `partial`——告警停止和用户主动停止在复盘展示上没必要分开，区别可以在 `analysis` 里用文字说明；告警事件本身有 `scene-anomaly-alert` 的 `signal` 日志留痕。

### 3.2 为什么删掉 `next_hint`

老版本有 `next_hint: "明天可安排背部或休息一天"` 这种字段。问题：

- "建议练什么"是**训练决策**，属于下次 `scene-workout-confirm` 的职责，而不是本次复盘的展示文案
- 写进 `next_hint` 会被前端展示 + 进日志（scene_end.summary 会引用）→ 变成"对未来的承诺"，违反"不施压"
- 真正需要影响下次训练的决策（降量、避开肩部、连续高强度后轻练），通过写 `training_state.pending_adjustments` 传递给 `scene-workout-confirm`，**不走 UI**

所以复盘里只保留 `next_check_in`（时间）+ `analysis`（事实描述），其余归 `pending_adjustments`。

### 3.3 两点禁忌

- **`source == "user_initiated"` 时不写 `completion`**——用户自发运动只记录事实，不评价"完成 / 未完成"
- **不施压**："下次再加 5 公斤"这种话不写。分析只描述**这次**发生了什么

### 3.4 partial（告警停止）情况下 analysis 必须说明原因

```
"analysis": "训练 18 分钟时心率超过 critical 阈值（179），自动停止。建议休息 + 喝水，必要时就医。"
```

### 3.5 分级降级

- **核心字段全缺** → 说明 session 根本没跑完，**不要硬生成 post_session 报告**，写 `last_scene.status = "needs_context"`
- **选填字段缺（calories / metrics / next_check_in）** → 照常生成，对应字段省略或填 `null`，**不写 needs_context**

---

## 4. daily_report

**用途：** 24h 健康日报。**回顾性**——回答"过去 24h 怎么样"。

**数据窗口：** 前一天 22:00 → 今天 22:00（滑动 24h）

```json
{
  "date": "2026-04-12",
  "narrative": "今天睡了 7 小时 45 分钟，深睡占比不错。下午跑了 5 公里，强度中等偏下；晚上自己也说了有点累，估计是昨晚 HIIT 的后劲。HRV 基本持平，身体没有明显堆积疲劳的信号。",
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
  }
}
```

| 字段 | 类型 | 核心/选填 | 说明 |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | 核心 | 日报覆盖的"今天" |
| `narrative` | string | 核心 | **2-3 段自然语言叙述**，有"人感"地把今天的状态串起来；事实层描述，不施压不预测 |
| `sleep` | object | 选填 | 睡眠数据；缺失时整体省略或字段填 `null` |
| `activity` | object | 选填 | 24h 内的运动记录；无运动见 §4.4 |
| `body_signals` | array | 选填 | 过去 24h 内的非过期 `signals.body` 条目，为空时 `[]` |
| `recovery_status` | object | 选填 | HRV / 静息心率快照；缺失时整体省略 |

### 4.1 narrative 写作规则

- **有"人感"的一长段/2-3 段**，而不是几个干巴巴的要点
- 把睡眠 / 运动 / 信号 / 恢复数据**串联成完整的一天叙述**
- 用平实的第三人称或第二人称（"你今天 / 今天" 都可以），不用命令式
- **只描述今天发生了什么**，不预测明天，不给建议
- 缺数据时自然绕过（"睡眠数据今天没同步到" 而不是硬填 null）

**老版本有 `tomorrow_hint` 字段**——已删除。理由同 post_session 的 `next_hint`：给下次训练的建议属于 `pending_adjustments`（走 scene-workout-confirm 时消费），不走 UI。

### 4.2 sleep 子字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `total_min` | int | 总睡眠时长 |
| `deep_min` | int | 深睡时长 |
| `rem_min` | int | REM 时长 |
| `summary` | string | 一句话摘要 |

### 4.3 activity.sessions 每条结构

```json
{ "type": "...", "duration_min": <n>, "intensity": "...", "summary": "..." }
```

注意：daily_report 的 sessions 是简化版，**不需要带 session_mode / source**——这些只在 state.json 的 recent_sessions 中保留。

### 4.4 recovery_status 子字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `hrv_trend` | enum | `rising` / `stable` / `falling` |
| `resting_hr` | int 或 null | 静息心率 bpm |
| `summary` | string | 一句话摘要 |

### 4.5 分级降级（缺数据时）

**核心字段缺 → needs_context；选填字段缺 → 照常出报告**：

| 数据 | 处理 |
|---|---|
| 所有数据源全失败（HealthKit + workout_log 都空） | 写 `last_scene.status = "needs_context"`，不硬生成 |
| `get_health_summary` 部分返回（如有 sleep 无 HRV） | 有的字段照写，缺的字段省略或填 `null`；**仍然生成报告**，`last_scene.status = "done"`；narrative 里自然提一句"今天 HRV 没同步到" |
| 当天无运动 | `activity = { sessions: [], total_calories: 0, summary: "今天没有运动记录" }`；narrative 里写"今天没有运动"；不算缺数据 |
| 所有选填字段都缺，只剩 narrative | 仍可输出——narrative 把能说的说清楚即可 |

**判据：** 能写出**至少 2 句事实**（"今天睡了 X 小时" / "今天没有运动记录" / "今天出差了没数据"）就能出报告；连这点都写不出 → `needs_context`。

---

## 5. weekly

**用途：** 7 天周报。**不复查 profile。**

**数据窗口：** 最近自然 7 天（不卡周一/周日）

```json
{
  "period": { "start": "2026-04-06", "end": "2026-04-12" },
  "narrative": "这周你练了 4 次，比上周多一次，强度以中等为主。睡眠均值持平，HRV 本周整体还在往上走，身体恢复得不错。唯一值得留意的是周三只睡了 5 小时多，明显低于你平时的水平。",
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
  ]
}
```

| 字段 | 类型 | 核心/选填 | 说明 |
|---|---|---|---|
| `period.start` / `period.end` | `YYYY-MM-DD` | 核心 | 数据窗口起止 |
| `narrative` | string | 核心 | 2-3 段自然语言叙述，把本周串起来；事实描述，不施压 |
| `training.total_*` | int | 核心 | 本周累计 |
| `training.by_type` | object | 核心 | 6 大类计数，**全部 6 个 key 必须存在**（0 也写） |
| `training.by_intensity` | object | 核心 | high/medium/low 计数 |
| `health_trends.sleep_avg_min` | int 或 null | 选填 | 7 天均值；HealthKit 无数据时填 `null` |
| `health_trends.*_trend` | enum | 选填 | `rising` / `stable` / `falling`；数据不足 `null` |
| `highlights` | string[] | 选填 | 0-3 条事实层观察 |
| `concerns` | string[] | 选填 | 0-3 条事实层观察 |

**老版本 `next_week_hint` 已删除**——理由同 post_session 的 `next_hint`（见 §3.2）。方向性调整走 `pending_adjustments`。

### 5.1 highlights / concerns 写作规则

**只写事实，不写劝说：**

- ✅ "本周训练 4 次，比上周多 1 次"
- ✅ "HRV 7 日均值较上周下降 12%"
- ❌ "你应该多休息"
- ❌ "再坚持一下就达标了"

### 5.2 0 训练时

**判据：** `recent_sessions` 在本周窗口内 `total_sessions == 0`。

处理：`training` 全 0；highlights / concerns 各写一句中性话（"本周休息为主"）；narrative 自然描述"这周没有训练记录"；正常 `done`，不写 `needs_context`。

### 5.3 分级降级

- **核心全缺**（无 profile / 无任何 session 历史） → `needs_context`
- **只有 training 没有 health_trends**（如 HealthKit 完全无数据） → 照出报告，`health_trends` 整块省略，narrative 里说明
- **只有 health_trends 没有 training** → 见 §5.2（0 训练）

---

## 6. monthly

**用途：** 30 天月报。**复查 profile**（fitness_level 或 goal，二选一）。

**数据窗口：** 上一个自然月（cron 触发）或本月 1 号到今天（用户主动要求）

```json
{
  "period": { "start": "2026-03-01", "end": "2026-03-31" },
  "narrative": "三月份你一共训练了 18 次，平均一周四次多，节奏稳定。力量训练是重点，其次是有氧。卧推从 80 公斤推到了 85 公斤，方向上和你的增肌目标是对得上的。体重轻了 0.7 公斤，体脂下降 0.7 个百分点，身体在往更紧致的方向走。HRV 整月在上升，静息心率下降——这两个信号同时出现，通常说明身体恢复能力在变好。",
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

| 字段 | 类型 | 核心/选填 | 说明 |
|---|---|---|---|
| `period.start` / `period.end` | `YYYY-MM-DD` | 核心 | 月份起止 |
| `narrative` | string | 核心 | 3-5 段自然语言叙述；比 daily/weekly 更深，把训练 + 体征 + goal 进展串起来 |
| `training.*` | — | 核心 | 同 weekly，多 `frequency_per_week_avg` |
| `health_trends.body_data_changes` | array | 选填 | 月初/月末体重体脂对比；为空时填 `[]` |
| `goal_progress.current_goal` | string | 核心 | 当前 `profile.goal` |
| `goal_progress.observation` | string | 核心 | 一段话描述本月与 goal 的关系，**不评价不施压** |
| `goal_progress.alignment` | enum | 核心 | 4 值（见 §6.1） |
| `fitness_level_observation.current` | enum | 核心 | 当前 `profile.fitness_level` |
| `fitness_level_observation.trend` | enum | 选填 | `improving` / `stable` / `declining`；数据不足留 `null` |
| `fitness_level_observation.evidence` | string | 选填 | 一句话证据 |
| `phase_advice` | string[] | 选填 | 1-3 条阶段建议 |

### 6.1 alignment 枚举（4 值）

| 值 | 含义 | 判据 |
|---|---|---|
| `aligned` | 训练方向与 goal 一致 | 主类型匹配 + 关键指标朝目标方向移动 |
| `partial` | 部分一致，部分偏离 | 主类型匹配但频次/强度不够，或指标方向对但幅度小 |
| `drifting` | 明显偏离 | 主类型与 goal 要求严重不符 |
| `too_early` | 目标设定时间过短，尚无法评估 | `profile._meta.goal_updated_at` 在本周期窗口内（goal 设定/更新 < 30 天），训练样本不足以判断方向 |

**`too_early` 的用途：** 避免用户刚改完 goal 就被"drifting"评判施压；这种情况 observation 写"目标刚设定不久，本月先按新方向跑看看"。

### 6.2 trend 枚举

| 值 | 含义 |
|---|---|
| `improving` | 数据明显上升 |
| `stable` | 持平 |
| `declining` | 数据明显下降 |

### 6.3 复查触发位置

monthly 是**唯一**会主动向用户提问复查的报告（fitness_level 或 goal，**最多一次**）。详见 scene-reports.md §3 Step 3。

### 6.4 0 训练时

**判据：** `recent_sessions` 在本月窗口内 `total_sessions == 0`。

处理：`training` 全 0；observation 写中性话（"本月几乎没有训练记录"）；`alignment` 写 `too_early`（无样本可判）；**不触发 fitness_level 复查**；narrative 里自然描述；phase_advice 可以提一句"上月活动较少"。不写 `needs_context`。

### 6.5 分级降级

- **无 profile** → `blocked`（onboarding 未完成）
- **无 session 且无 health 数据** → 仍出报告，全部中性描述，`goal_progress.alignment = "too_early"`，`fitness_level_observation.trend = null`
- **有 session 无 health 数据** → `health_trends` 整块省略，narrative 里说明
- **单月样本不足以判断 trend/alignment** → 对应字段用 `too_early` / `null`，不硬评

---

## 7. 通用写作红线

适用于所有 6 种 report：

- **不施压。** 不写"你应该 / 必须 / 一定要"
- **不诊断。** 不说"你可能是 X 病"，最多说"建议关注 / 必要时就医"
- **不追问。** 报告是单向呈现，不在报告里塞反问句
- **数据缺失填 null 或 "数据未同步"**，不要编造
- **不写"下次练什么"**——训练决策走 `pending_adjustments`；报告里只描述**这次/本周/本月发生了什么**
- **narrative 要像人在说话**，不是列要点——有温度、有连贯性、事实层、不鼓吹

---

## 8. 字段分级（必填/选填）通则

每种 report 的字段表里都有"核心/选填"标记。总则：

- **核心字段**：缺了就无法生成这份报告——数据全缺时写 `last_scene.status = "needs_context"`
- **选填字段**：可以省略或填 `null`/`[]`；**选填字段缺失不触发 needs_context**
- **narrative 是核心字段**：即使数值数据全缺，只要能写出几句事实描述，就能出报告
- 单一选填字段缺 ≠ 整份报告缺——前端 UI 需要按选填字段做容错渲染

**`needs_context` 的唯一触发条件：** 核心字段全部拿不到，或 narrative 凑不出 2 句事实。**不要因为单个选填字段空就跳 needs_context**——老版本的"缺一项就 needs_context"过于脆弱。

---

## 9. 与 mcp-server.js 的同步责任

`show_report` 在 MCP Server 内**不强制校验 data 结构**——前端渲染容错处理。但本文档定义的字段是前端 UI 的契约，**改字段时需要同步通知前端开发**。

`report_type` 的 6 个枚举值在 mcp-server.js 顶部定义为 `REPORT_TYPE_ENUM` 常量，与本文档同步。
