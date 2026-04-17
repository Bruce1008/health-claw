# health-log.jsonl 事件结构

> `health-log.jsonl` 是 health-claw 的**永不覆写**的事件流，存放在 `<DATA_ROOT>/context/health-log.jsonl`。每行一个 JSON 对象（NDJSON 格式）。本文档定义 7 种事件类型的字段结构。

## 文件位置

```
<DATA_ROOT>/context/health-log.jsonl
```

`<DATA_ROOT>` = `~/Library/Application Support/health-claw/`（方案 B，运行期数据，不进 git）

## 写入方式

### 主路径：`append_health_log`

```
append_health_log({
  event: { type: "<...>", date: <today>, ts: <now>, ... }
})
```

MCP Server 实现：

1. 校验 `event.type` 是否在 7 种允许类型内
2. 校验 `date` 和 `ts` 字段格式
3. 序列化为单行 JSON + `\n` 追加写入文件
4. **永不覆写**——只追加，不删除，不修改

### 自动追加：scene_end / profile_update

下列事件**由 MCP Server 自动追加**，模型**禁止**手动调用 `append_health_log`（会被拒绝返回错误）：

| 事件类型 | 自动触发条件 |
|---|---|
| `scene_end` | `update_state({last_scene: {name, status, ts, summary}})` 写入成功后 |
| `profile_update` | `update_state` 中检测到 `profile` 字段变更后 |

其他 5 种事件（`session` / `body_data` / `signal` / `status_change` / `rest_day`）都需要模型主动调用 `append_health_log` 写入。

## 通用字段

所有事件类型必须包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | enum | 7 种之一（见下方表） |
| `date` | `YYYY-MM-DD` | 事件发生日期（用户本地日期） |
| `ts` | ISO 8601 | 事件发生精确时间戳（UTC） |

其余字段因 type 而异。

---

## 事件类型总览（7 种）

| type | 触发时机 | 写入方 |
|---|---|---|
| `scene_end` | 每个场景结束 | **MCP Server 自动**（update_state 写 last_scene 时），模型不手写 |
| `session` | 训练/运动结束 | 模型（scene-post-session） |
| `body_data` | 用户提供体重/体脂等身体数据 | 模型（对话中捕获时） |
| `signal` | 信号捕获（疼痛/出差/没动力） | 模型（scene-anomaly-alert / 对话中） |
| `status_change` | `user_state.status` 变更 | 模型（变更时） |
| `rest_day` | 休息日记录 | 模型（休息日场景） |
| `profile_update` | profile 字段变更 | **MCP Server 自动**，模型不手写 |

---

## 1. scene_end

**由 MCP Server 自动追加，模型禁止手动调用 `append_health_log({type:"scene_end"})`（会被拒绝）。**

```json
{
  "type": "scene_end",
  "scene": "readiness_assessment",
  "status": "done",
  "date": "2026-04-12",
  "ts": "2026-04-12T08:30:15Z",
  "summary": "绿灯，建议中等强度训练"
}
```

| 字段 | 类型 | 来源 |
|---|---|---|
| `scene` | string | 取自 `last_scene.name` |
| `status` | enum | 取自 `last_scene.status`，5 值之一：done / blocked / needs_context / error / skipped |
| `date` | `YYYY-MM-DD` | MCP Server 填入当天本地日期 |
| `ts` | ISO 8601 | 取自 `last_scene.ts`（模型未传时 MCP 填当前时间） |
| `summary` | string | 取自 `last_scene.summary`（未传时为空字符串）；一句话摘要 |

**写入方式：** 模型调用 `update_state({ patch: { last_scene: { name, status, ts, summary } } })`，MCP Server 写完 state.json 后自动追加一条 scene_end。

**与 `last_scene` 的关系：** scene_end 是 last_scene 的"历史快照"——last_scene 在 state.json 中只存最后一次（被覆盖），scene_end 在 jsonl 中永久保留全部历史。

---

## 2. session

训练或运动结束时写一条，**与 `recent_sessions` 数据冗余但独立**——recent_sessions 是滚动 7-10 条快照，session 事件是完整历史。

```json
{
  "type": "session",
  "date": "2026-04-12",
  "ts": "2026-04-12T07:55:00Z",
  "session": {
    "date": "2026-04-12",
    "type": "力量训练",
    "session_mode": "set-rest",
    "intensity": "high",
    "duration_min": 52,
    "calories": 405,
    "source": "planned",
    "summary": "胸+三头，完成率 92%"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `session` | object | session 完整快照，结构与 state-schema 中的 `recent_sessions` 每条一致 |

**为什么是嵌套对象 `session`** 而不是平铺：与 recent_sessions 结构对齐，方便周/月报扫描时复用同一段解析逻辑。

**写入位置：** scene-post-session.md Step 5。

---

## 3. body_data

用户在对话中提供身体数据（体重、体脂、围度等）时写一条。

```json
{
  "type": "body_data",
  "date": "2026-04-12",
  "ts": "2026-04-12T22:15:00Z",
  "data": {
    "weight_kg": 71.8,
    "body_fat_pct": 17.5,
    "waist_cm": 78
  },
  "source": "user_input"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `data` | object | 开放结构，常见 key：`weight_kg` / `body_fat_pct` / `waist_cm` / `chest_cm` / `arm_cm` 等 |
| `source` | enum | `user_input`（对话）/ `healthkit_sync`（HealthKit 同步） |

**为什么放 health-log 而不是 state.json：** body_data 是时序数据，需要保留历史变化（月报会用到）。state.json 只存"当下"，不存历史。

**月报使用：** scene-monthly-report Step 2 在 `health_trends.body_data_changes` 中读取月初/月末两条记录做对比。

---

## 4. signal

捕获到 body / schedule / motivation 信号时写一条。

```json
{
  "type": "signal",
  "date": "2026-04-12",
  "ts": "2026-04-12T08:30:00Z",
  "category": "body",
  "detail": "右肩有点疼",
  "severity": "medium"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `category` | enum | `body` / `schedule` / `motivation` |
| `detail` | string | 用户原话或简短描述 |
| `severity` | enum | `low` / `medium` / `high`（仅 body 信号有意义；schedule / motivation 一般填 `low`） |

**与 state.json `signals.*` 的关系：** state.json 中的 signals 是 72h TTL 的"当下信号"，过期会被 MCP Server 清理；signal 事件是永久历史。

**severity 与 anomaly 的关系：**

| severity | 触发场景 |
|---|---|
| `low` | 一般信号捕获（出差、动力低） |
| `medium` | scene-anomaly-alert 中的中严重度（hr_warning / pain_mild / signal_overload） |
| `high` | scene-anomaly-alert 中的高严重度（hr_critical / pain_strong / dizziness） |

**写入位置：** scene-anomaly-alert（异常场景）+ 任何场景中对话捕获到信号时。

---

## 5. status_change

`user_state.status` 变更时写一条。

```json
{
  "type": "status_change",
  "date": "2026-04-12",
  "ts": "2026-04-12T08:35:00Z",
  "from": "available",
  "to": "injured",
  "reason": "训练中右肩拉伤"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `from` | enum | 变更前的 status，6 值之一 |
| `to` | enum | 变更后的 status，6 值之一 |
| `reason` | string | 一句话原因 |

**写入时机：** 在 `update_state({patch:{user_state:{status:"<新值>"}}})` 之后立即追加。

**不写入的情况：** `since` / `next_check` 字段变更但 status 没变 → **不写** status_change（因为 status 没变）。

---

## 6. rest_day

休息日记录。当用户主动说"今天不练"或符合休息日触发条件时写一条。

```json
{
  "type": "rest_day",
  "date": "2026-04-12",
  "ts": "2026-04-12T20:00:00Z",
  "reason": "user_chose_rest",
  "consecutive_rest_days": 2,
  "note": "用户说今天累，明天再说"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `reason` | enum | `user_chose_rest`（用户主动）/ `low_motivation`（动力低）/ `injury_recovery`（伤病恢复中）/ `scheduled_rest`（按训练周期安排） |
| `consecutive_rest_days` | int | 包含本日的连续休息天数（与 state.json `training_state.consecutive_rest_days` 一致） |
| `note` | string | 一句话备注 |

**写入位置：** 休息日场景（framework §7.1 中的"休息日"场景）；本期 P0 阶段未单独编写 scene-rest-day.md，临时由 scene-workout-confirm 用户拒绝训练时兜底写入。

---

## 7. profile_update

**MCP Server 自动追加**——模型在 `update_state` 写入 profile 字段时，MCP Server 检测到变更后自动追加此事件。**模型不要手动调用 append_health_log 写这种事件**（会重复）。

```json
{
  "type": "profile_update",
  "date": "2026-04-12",
  "ts": "2026-04-12T22:30:00Z",
  "changed_fields": ["preferences.preferred_types", "fitness_level"],
  "before": {
    "preferences": { "preferred_types": ["力量训练"] },
    "fitness_level": "beginner"
  },
  "after": {
    "preferences": { "preferred_types": ["力量训练", "瑜伽"] },
    "fitness_level": "intermediate"
  },
  "trigger": "monthly_review"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `changed_fields` | string[] | 变更的字段路径列表（点路径） |
| `before` | object | 变更前的字段值（仅含变更字段） |
| `after` | object | 变更后的字段值（仅含变更字段） |
| `trigger` | string | 触发原因，由 MCP Server 推断或留空（常见值：`monthly_review` / `injury_update` / `user_dialogue`） |

**特殊字段：alert_hr 自动重算不算 profile_update**——当 `max_hr_measured` 或 `basic_info.age` 变更触发 alert_hr 重算时，MCP Server 写入的 profile_update 事件**只记录原始变更字段**（`max_hr_measured` 或 `basic_info.age`），**不**为 alert_hr 单独写一条事件，避免日志噪音。

---

## 字段格式约定

### date

`YYYY-MM-DD`，**用户本地日期**。例：`2026-04-12`

### ts

ISO 8601 with timezone，**UTC**。例：`2026-04-12T08:30:15Z`

为什么 date 用本地、ts 用 UTC：

- date 用于按"自然天"扫描（周/月报），必须用本地
- ts 用于精确排序，UTC 避免时区混乱

### 数值字段

- 时长统一用 `_min`（分钟）后缀
- 心率统一用 bpm，不写单位
- 体重统一用 `_kg` 后缀
- 体脂用 `_pct` 后缀

---

## 扫描使用模式

### 周报 / 月报

```
1. 读 health-log.jsonl 全量
2. 按 date 字段过滤窗口期
3. 按 type 字段分组：
   - session 用于训练统计
   - body_data 用于体征趋势
   - status_change 用于状态变化追溯
4. 不读 scene_end / signal / rest_day（这些是辅助审计用，不进周月报）
```

### 异常审计

```
1. 读 jsonl 最近 100 行
2. 过滤 type == "signal" 且 severity in [medium, high]
3. 用于 scene-anomaly-alert 的"今天是否已经报过同类型异常"判断
```

---

## 文件管理

### 大小限制

`health-log.jsonl` 是单文件追加，没有自动滚动。预期增长：

- 每天约 5-15 条事件
- 一年约 2000-5000 条
- 单条平均 200 字节，年文件约 1MB

**不分文件**——简化扫描逻辑。一年 1MB 在现代存储下完全可接受。

### 备份

- 不自动备份。如果用户数据珍贵，由用户系统级 Time Machine 兜底
- MCP Server **永不删除或截断** health-log.jsonl

### 错误恢复

- 如果某行 JSON 解析失败 → 跳过该行，记录到 `<DATA_ROOT>/logs/{date}.tool-calls.jsonl` 的错误段
- 不修复，不删除——保留原始数据供人工排查

---

## 与 mcp-server.js 的同步责任

7 种事件类型在 mcp-server.js 顶部定义为 `HEALTH_LOG_EVENT_TYPES` 常量数组。`append_health_log` 工具的 schema 中，`event.type` 字段的 enum 必须与本文档一致。

每次本文档新增或重命名事件类型，必须同步：

1. mcp-server.js 顶部的 `HEALTH_LOG_EVENT_TYPES` 常量
2. `append_health_log` 工具的 JSON Schema enum
3. 受影响场景文档（scene-*.md）中的事件示例
