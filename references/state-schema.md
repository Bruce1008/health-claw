# state.json 字段树

> `state.json` 是 health-claw 的**单一可信来源**。所有场景的决策都从这里读，所有状态变化都通过 `update_state` 写。本文档定义其完整字段结构、类型和枚举值。

## 顶层结构

```
state.json
├── user_state          # 用户当下状态
├── profile             # 用户画像（长期）
├── training_state      # 训练状态（近期累积）
├── last_scene          # 最后一次场景执行的快照
├── signals             # 时效性信号（72h TTL）
└── active_session      # 当前进行中的 session（null 表示无）
```

**写入方式：** 全部通过 `update_state({patch: {...}})` 深度合并。**数组字段整体替换**，不追加——模型必须传完整新数组。

**读取方式：** `read_state()` 返回完整结构 + 附加 `reminders` 数组（见末尾）。

---

## 1. user_state

```json
{
  "status": "available",
  "since": "2026-04-12",
  "next_check": null
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | enum | 6 值：`available` / `sick` / `injured` / `busy` / `traveling` / `low_motivation` |
| `since` | `YYYY-MM-DD` | 进入当前 status 的日期 |
| `next_check` | `YYYY-MM-DD` 或 null | 下次复查日期；MCP Server 不强制，仅供模型参考 |

**`status` 枚举（6 值）：** `available` / `sick` / `injured` / `busy` / `traveling` / `low_motivation`

| 值 | 含义 |
|---|---|
| `available` | 默认状态，可正常训练 |
| `sick` | 生病中，不安排训练 |
| `injured` | 受伤中，不安排正常训练；可能安排极轻度恢复 |
| `busy` | 工作/事情多，时间紧；可安排短时低强度 |
| `traveling` | 出差/旅行中；按可用器材调整 |
| `low_motivation` | 动力低；不强推训练 |

**MCP 校验：** `update_state` 写入 `user_state.status` 时校验值在枚举内，违反时拒绝写入并返回错误。

---

## 2. profile

profile 是 OpenClaw 的"用户笔记本"——长期稳定，OpenClaw 在对话中捕获到的用户偏好都往这里写。Skill 不校验 `preferences` 的内部结构，只校验顶层 key 存在。

```json
{
  "basic_info": { "age": 28, "gender": "male" },
  "goal": "增肌，卧推 100kg",
  "preferences": {
    "preferred_types": ["力量训练"],
    "available_equipment": ["全器械健身房"],
    "training_time": "早上 7 点"
  },
  "fitness_level": "intermediate",
  "injuries": [
    { "description": "左膝半月板旧伤", "reported_at": "2026-01-10", "status": "chronic" }
  ],
  "max_hr_measured": 188,
  "alert_hr": { "critical": 179, "warning": 169 }
}
```

### 2.1 字段表

| 字段 | 类型 | 说明 |
|---|---|---|
| `basic_info.age` | int | **必填**，影响心率告警阈值 |
| `basic_info.gender` | string | 自由文本（male/female/other 或其他） |
| `goal` | string | 自由文本，由 OpenClaw 撰写，不限长度 |
| `preferences` | object | 开放结构，**Skill 不校验内部** |
| `fitness_level` | enum | `beginner` / `intermediate` / `advanced` |
| `injuries` | array | 见 §2.2（本文件内） |
| `max_hr_measured` | int 或 null | 实测历史最高心率 |
| `alert_hr.critical` | int | **MCP Server 自动维护**，不要手写 |
| `alert_hr.warning` | int | **MCP Server 自动维护**，不要手写 |

### 2.2 injuries 数组每条结构

```json
{
  "description": "右肩扭伤",
  "reported_at": "2026-03-20",
  "status": "active",
  "next_check_at": "2026-04-03"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `description` | string | 自由文本 |
| `reported_at` | `YYYY-MM-DD` | 首次记录日期；用户回答"还没好"时**重置为今天** |
| `status` | enum | `active` / `recovered` / `chronic` |
| `next_check_at` | `YYYY-MM-DD` | 下次询问进展的目标日期；到期后 MCP Server 在 `read_state` 返回 `injury_check` reminder |

**status 枚举：**

| 值 | 含义 |
|---|---|
| `active` | 急性伤病，影响训练；到 `next_check_at` 当天或之后 → MCP Server 返回 `injury_check` reminder |
| `recovered` | 已恢复，保留作历史记录，不触发提醒 |
| `chronic` | 长期/反复存在，不触发复查提醒，但 OpenClaw 安排训练时始终需要考虑 |

**`next_check_at` 默认值：** `reported_at + 14 天`。用户回答"快好了" → 改为 `today + 7 天`；"明显好转" → `today + 3 天`；"还没好" → 把 `reported_at` 重置为今天且 `next_check_at` 重置为 `today + 14 天`。

**写入约束：** 数组**整体替换**——更新某条伤病时，模型要把完整数组传回。

### 2.3 alert_hr 自动计算规则

`alert_hr` 由 MCP Server 在 `update_state` 中检测到 `max_hr_measured` 或 `basic_info.age` 变更时**自动重算**。模型不要自己算。

**max_hr 优先级：**

1. `profile.max_hr_measured`（实测）— 最准确
2. `220 - basic_info.age`（公式估算）— 粗略但比固定值安全
3. 固定 190 — 仅在年龄未知时使用

**计算公式：**

```
critical = round(max_hr × 0.95)
warning  = round(max_hr × 0.90)
```

**示例：** 28 岁男性，max_hr_measured = 188 → critical = 179, warning = 169

### 2.4 profile 更新自动记日志

MCP Server 在 `update_state` 检测到 `profile` 字段变更时，自动追加 `profile_update` 事件到 `health-log.jsonl`，**模型不需要手动调用 `append_health_log`**。

### 2.5 profile 写入时机（硬规则）

profile 是**长期稳定**的用户画像。写入要保守——宁可少写，不要多写。

**写的情况（3 类）：**

| 类别 | 触发 | 示例 |
|---|---|---|
| 用户明确给数值 | 用户说出具体数字、具体器材、具体伤病 | "我 28 岁"、"家里只有瑜伽垫"、"右肩拉伤了" |
| 用户明确表达长期偏好 | 用户连续多次（≥ 3 次）拒绝某类型，或明确说"以后都不..." | "我以后都不想跑步了"、用户连续 3 次拒绝有氧 |
| 用户主动校正既有字段 | 用户纠正之前的设置 | "我升级了，把等级改成 intermediate 吧" |

**不写的情况（4 类）：**

| 类别 | 为什么不写 | 示例 |
|---|---|---|
| 当下一次的意愿 | 临时选择不代表长期偏好 | "今天想试试游泳"、"今天想短一点"——OpenClaw 直接安排，**不**动 preferences |
| 含糊表达 | 含糊的话可能是情绪，不是偏好 | "最近状态不太行"、"好像不太对劲" |
| 短期状态波动 | 归 `user_state` 或 `signals`，不归 profile | "最近感冒"、"出差一周"、"今天动力低" |
| 单次训练反馈 | 归 session summary 或 signals | "今天太重了"、"下次少 5 公斤" |

**判断流程：**

1. 用户说的是**数值**还是**情绪**？情绪 → 不写
2. 是**这次**还是**长期**？这次 → 不写
3. 是**身体数据/长期偏好/长期目标**还是**执行反馈**？反馈 → 不写

**由 OpenClaw 自己判断——不要为了"记得多"而过度写入。** 每次 profile 变更都会被 MCP 自动记 `profile_update` 日志，写得多就等于日志噪音多。

### 2.6 goal / fitness_level 特殊规则

- 用户首次 onboarding 填入后，除非用户**主动说**想调，否则**不随意改**。
- `_meta.goal_updated_at` / `_meta.fitness_level_updated_at` 超过 30 天 → MCP 返回 `profile_review` reminder，由 scene-monthly-report 处理复查。
- 月报中的复查也只"问一次"——用户点"以后再说"就停，不重置 30 天计时。

---

## 3. training_state

```json
{
  "consecutive_training_days": 3,
  "consecutive_rest_days": 0,
  "recent_sessions": [...],
  "fatigue_estimate": "moderate",
  "pending_adjustments": [...]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `consecutive_training_days` | int >= 0 | 连续训练天数 |
| `consecutive_rest_days` | int >= 0 | 连续休息天数 |
| `recent_sessions` | array | 最近 7-10 条训练快照，**整体替换** |
| `fatigue_estimate` | enum | `low` / `moderate` / `high` |
| `pending_adjustments` | array | 待消费的训练调整指令 |

**互斥规则：** 训练后 `consecutive_training_days++`、`consecutive_rest_days = 0`；休息日 `consecutive_rest_days++`、`consecutive_training_days = 0`。两者不会同时 > 0。

### 3.1 recent_sessions 每条结构

```json
{
  "date": "2026-04-12",
  "type": "力量训练",
  "session_mode": "set-rest",
  "intensity": "high",
  "duration_min": 55,
  "calories": 420,
  "source": "planned",
  "summary": "胸+三头，完成率 92%"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `date` | `YYYY-MM-DD` | 训练日期 |
| `type` | string | 力量训练 / 有氧 / HIIT / 瑜伽-普拉提 / 拉伸-恢复 / 休闲运动 |
| `session_mode` | enum | 6 值：`set-rest` / `continuous` / `interval` / `flow` / `timer` / `passive` |
| `intensity` | enum | `high` / `medium` / `low`，**模型综合判断**，不简单按时长 |
| `duration_min` | int | 时长（分钟） |
| `calories` | int | 消耗（千卡） |
| `source` | enum | `planned`（OpenClaw 安排）/ `user_initiated`（用户自发） |
| `summary` | string | 一句话摘要，自由撰写 |

**training type 6 大类：**

```
力量训练 / 有氧 / HIIT / 瑜伽-普拉提 / 拉伸-恢复 / 休闲运动
```

**session_mode 6 值：**

| 值 | 用途 |
|---|---|
| `set-rest` | 力量训练（多组+组间休息） |
| `continuous` | 有氧（持续节奏） |
| `interval` | HIIT（高低交替） |
| `flow` | 瑜伽/普拉提（连贯流动） |
| `timer` | 拉伸/恢复（按时长） |
| `passive` | 用户自发运动，仅采集数据，不主动引导 |

### 3.2 pending_adjustments 每条结构

```json
{
  "type": "long_rest_deload",
  "reason": "连续休息 6 天后首次训练",
  "created_at": "2026-04-12"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 调整类型，自由文本（常见值：`long_rest_deload` / `injury_recovery` / `consecutive_high_intensity`） |
| `reason` | string | 一句话原因 |
| `created_at` | `YYYY-MM-DD` | 创建日期 |

**消费规则：** OpenClaw 在安排训练时检查此数组，执行对应调整后，**主动从数组中移除**已消费的条目（再次 `update_state` 写入剩余数组）。

### 3.3 fatigue_estimate

由 OpenClaw 在 post-session 复盘时综合判断：

| 值 | 参考触发条件 |
|---|---|
| `low` | 本次低强度 + 最近无堆积 |
| `moderate` | 本次中等 / 连续训练 2-3 天 |
| `high` | 本次高强度 + 连续高强度 / HRV 已下降 |

**Skill 不计算此值**，只读取它在强度护栏中作判断。

---

## 4. last_scene

```json
{
  "name": "readiness_assessment",
  "status": "done",
  "ts": "2026-04-12T08:30:15Z"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 场景名（与 SKILL.md 场景索引一致） |
| `status` | enum | 5 值：`done` / `blocked` / `needs_context` / `error` / `skipped` |
| `ts` | ISO 8601 | 场景结束时间戳 |
| `summary` | string | 一句话摘要，会被自动写进 health-log.jsonl 的 scene_end 事件 |

**`status` 枚举（5 值）：**

| 值 | 含义 |
|---|---|
| `done` | 正常完成 |
| `blocked` | 前置条件不满足（如 onboarding 未完成）→ 主动停手 |
| `needs_context` | 数据缺失，需要用户补充或下次重试 |
| `error` | 工具调用失败 |
| `skipped` | 主动跳过（如重复触发的去重） |

**MCP 校验：** `update_state` 校验 `last_scene.status` 在枚举内，违反时拒绝写入。

**协议要求：** 每个场景必须在出口写 `last_scene`（含 `summary`），**所有终态都要覆盖**——不能只写正常路径。写入后 MCP Server **自动追加** `scene_end` 事件到 health-log.jsonl，模型不需要（也禁止）手动 `append_health_log({type:"scene_end"})`。

---

## 5. signals

```json
{
  "body": [
    { "type": "pain", "detail": "右肩有点疼", "ts": "2026-04-12T08:30:00Z" }
  ],
  "schedule": [
    { "type": "travel", "detail": "下周出差北京", "ts": "2026-04-12T09:00:00Z" }
  ],
  "motivation": [
    { "type": "low", "detail": "今天不想动", "ts": "2026-04-12T09:30:00Z" }
  ]
}
```

| 子字段 | 来源 | 触发后果 |
|---|---|---|
| `body` | 用户主动反馈疼痛/生病/疲劳 | 影响状态评估 + 可能改变 user_state |
| `schedule` | 用户提到出差/忙/行程 | 影响 user_state |
| `motivation` | 用户说不想练 | 触发休息日流程 |

### 5.1 信号条目结构

```json
{
  "type": "pain",
  "detail": "右肩有点疼",
  "ts": "2026-04-12T08:30:00Z"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 自由文本（常见值：`pain` / `dizziness` / `fatigue` / `sick` / `travel` / `busy` / `low`） |
| `detail` | string | 用户原话或简短描述 |
| `ts` | ISO 8601 | 发生时间，**必填** |

### 5.2 TTL 规则

- `body` / `motivation`：**TTL 72h**，过期在下次 `read_state` 时由 MCP Server 自动清理
- `schedule`：按日期本身判断过期（如出差日期已过），不用 TTL

### 5.3 写入约束

数组**整体替换**——添加新信号时模型要把完整新数组传回，包括尚未过期的旧条目。常见模式：

```
body: [...<旧的未过期条目>, <新条目>]
```

### 5.4 不写入 signals 的情况

- 训练相关的对话（"太重""换动作""器械被占"）→ OpenClaw 在 session 中自行处理
- 用户含糊的不适（"不太对劲"）+ 没说出具体症状 → 不写 signals，先问一句具体症状，用户说得出来再按症状分类写

---

## 6. active_session

```json
{
  "started_at": "2026-04-12T07:55:00Z",
  "session_mode": "set-rest",
  "source": "planned"
}
```

`null` 表示当前无进行中的 session。

| 字段 | 类型 | 说明 |
|---|---|---|
| `started_at` | ISO 8601 | session 启动时间戳 |
| `session_mode` | enum | `set-rest` / `continuous` / `interval` / `flow` / `timer` / `passive` |
| `source` | enum | `planned` / `user_initiated` |

### 6.1 写入责任

**只能由 MCP Server 在 `control_session` 内部维护**，模型**不要**通过 `update_state` 直接写 `active_session`。

| `control_session.action` | 对 active_session 的影响 |
|---|---|
| `start` | 写入 `{started_at, session_mode, source}`；若已有 active_session 会返回 `active_session_exists` 错误 |
| `stop` | 置 `null` |
| `pause` / `resume` / `update` | 不变（session 仍在进行） |

### 6.2 使用场景

- `scene-workout-confirm` Step 0：若 `active_session != null` → 写 `last_scene.status = "blocked"`，提示已有训练在进行
- `scene-during-session` Step 0：若 `active_session == null` → 写 `last_scene.status = "blocked"`，说明无进行中训练
- `scene-daily-report` / `scene-weekly-report` / `scene-monthly-report` Step 0：若 `active_session != null` → 写 `last_scene.status = "skipped"`，用 `schedule_one_shot` 延后 30 分钟重触发；**不要硬生成报告**（会打断用户训练）

---

## 7. reminders（仅 read_state 返回，不持久化）

`read_state` 返回时附加的提示数组，**不阻断读取，不存储在 state.json 内**。MCP Server 每次读取时动态生成。

```json
{
  "user_state": {...},
  "profile": {...},
  "training_state": {...},
  "last_scene": {...},
  "signals": {...},
  "reminders": [
    { "type": "injury_check", "detail": "右肩扭伤已报告 16 天，状态仍为 active" },
    { "type": "profile_review", "detail": "goal 已 32 天未复查" }
  ]
}
```

**当前定义的 reminder 类型（2 个）：**

| type | 触发条件 | 处理场景 |
|---|---|---|
| `injury_check` | `injuries[].status == "active"` 且 `next_check_at` ≤ 今天 | **scene-readiness**（不在 daily/weekly/monthly 处理） |
| `profile_review` | `goal` 或 `fitness_level` 距上次更新超过 30 天 | **scene-monthly-report**（不在其他场景处理） |

**reminder 不是异常**——只是"该复查了"信号，不走 scene-anomaly-alert。

---

## 8. 字段所有权速查

| 字段 | 谁写 | 谁读 | 备注 |
|---|---|---|---|
| `user_state.status` | 模型（场景判断后） | 所有场景 | MCP 校验枚举 |
| `profile.basic_info` | 模型（onboarding） | 所有场景 | 改 age 触发 alert_hr 重算 |
| `profile.preferences` | 模型（对话中捕获） | readiness / workout-confirm | 开放结构 |
| `profile.injuries` | 模型 | 所有场景 | 14 天触发 reminder |
| `profile.max_hr_measured` | 模型（post-session 检测到新高） | 仅 MCP Server 内部用 | 触发 alert_hr 重算 |
| `profile.alert_hr` | **MCP Server 自动** | `set_alert_rules` 直接引用 | 模型勿手写 |
| `training_state.recent_sessions` | 模型（post-session） | 所有场景 | 整体替换 |
| `training_state.consecutive_*_days` | 模型（post-session / 休息日） | readiness | 互斥 |
| `training_state.fatigue_estimate` | 模型（post-session） | readiness | — |
| `training_state.pending_adjustments` | 模型（写入 + 消费后清除） | workout-confirm | 整体替换 |
| `last_scene` | 模型（每个场景出口） | 下一次场景前置 | MCP 校验 status；写入后自动追加 scene_end 到 health-log |
| `signals.*` | 模型（捕获时） | readiness / daily-report | TTL 72h，整体替换 |
| `active_session` | **MCP Server 自动**（control_session 内部） | workout-confirm / during-session / 三大 report | 模型勿手写 |
| `reminders` | **MCP Server 动态生成** | 模型按场景路由处理 | 不持久化 |

---

## 9. 与 mcp-server.js 的同步责任

**本文档是"主"，mcp-server.js 顶部的 const 数组是"从"。** 每次改本文档的枚举值，必须同步改代码常量（避坑清单 §2：零依赖原则，不程序化加载 markdown）。

涉及的 MCP Server 校验点：

- `USER_STATE_STATUS_ENUM`（6 值）
- `LAST_SCENE_STATUS_ENUM`（5 值）
- `INJURY_STATUS_ENUM`（3 值）
- `FITNESS_LEVEL_ENUM`（3 值）
- `INTENSITY_ENUM`（3 值）
- `SESSION_MODE_ENUM`（6 值）
- `SOURCE_ENUM`（2 值）
- `FATIGUE_ENUM`（3 值）
