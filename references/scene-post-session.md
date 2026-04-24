# scene: post-session（训练后）

> **唯一触发**：`control_session({ action: "stop" })` 成功返回后，MCP Server 把 `state.active_session` 清为 null，按 SKILL.md §3 特例规则**在同一 turn 内紧接着执行本场景**。
>
> stop 的发起方可能是 `scene-during-session` 的三个分支（1.A 高严重度疼痛、1.B 用户在 Watch 上点结束、1.C 心率 critical）。**无论哪个分支调 stop 都走本场景**，由本场景统一写 `last_scene` + `daily_log`，调用方不重复写。

## pending_nodes 清单

`read_state` + `get_session_live` 后声明（Step 0 通过后）：

```json
[
  {"id":"s1_training_state","tool":"update_state","match":{"patch":"training_state"}},
  {"id":"s2_session_log","tool":"append_health_log","match":{"event_type":"session"}},
  {"id":"s3_show_report","tool":"show_report","match":{"report_type":"post_session"}},
  {"id":"s4_write_daily_log","tool":"write_daily_log"},
  {"id":"s5_close_done","tool":"update_state","match":{"patch":"last_scene"}}
]
```

硬规则：

- 本场景是 `control_session(stop)` 的接手方；进入前 pending_nodes 已被 stop 清空，**必须在本场景重新声明**。
- Step 0 发现 active_session 未清 → `last_scene.status = "blocked"`；Step 6 缺数据 → `needs_context`；show_report 失败 → `error`。这些异常终态 Server 会自动清空 pending_nodes，无需手动补完。

## Step 0：前置检查

1. `read_state` 拿到 `last_scene`、`training_state`、`user_state`、`profile`。
2. 确认 `state.active_session == null`（`control_session(stop)` 应该已经清掉）。若不为 null → 说明 stop 没成功，写 `last_scene = { name: "post_session", status: "blocked", ts: <now>, summary: "active_session 未清" }`，停手让用户重试 stop。
3. 调 `get_session_live` 一次拿本次 session 的最终数据（收尾后返回 `{ active: false, last_session: {...} }`）。

## Step 1：评估本次 session

模型综合下面信息判断：

- `duration_min`、`calories`（= HealthKit `activeEnergyBurned`，由 Watch 直接读取后上报，**不要自己估算**）、训练类型 / `session_mode`
- 心率走势（如果可拿）
- `profile.fitness_level`
- `recent_sessions` 最近几条对比

填出本次 session 的快照（写入 `recent_sessions` 数组）：

```json
{
  "date": "<today>",
  "type": "<力量训练 / 有氧 / HIIT / ...>",
  "session_mode": "<set-rest|continuous|interval|flow|timer|passive>",
  "intensity": "<high|medium|low>",
  "duration_min": <number>,
  "calories": <number from HealthKit activeEnergyBurned>,
  "source": "<planned|user_initiated>",
  "summary": "<一句话评估方向, 见下>"
}
```

`intensity` 由模型综合判定，**不要简单按时长**。瑜伽 60 分钟可能是 low，HIIT 15 分钟可能是 high。

**summary 必须给出评估方向**（不是流水账），举例：

- ✅ "偏量不偏强，恢复快，下次可以加组"
- ✅ "体感偏累但心率没拉起来，说明节奏偏快 / 休息不够"
- ✅ "完成度高，节奏稳"
- ❌ "做了 30 分钟力量训练"（等同 `type` + `duration_min`，冗余）
- ❌ "挺好的"（空话）

评估方向是为了让下一次 workout-confirm / 周报能直接引用——没方向等于没评估。

## Step 2：判断 fatigue_estimate

综合本次强度 + 最近 7 天累计 + 心率/HRV 数据：

| fatigue_estimate | 触发条件参考 |
|---|---|
| `low` | 本次低强度 + 最近无堆积 |
| `moderate` | 本次中等强度 / 连续训练 2-3 天 |
| `high` | 本次高强度 + 连续高强度训练 / HRV 已下降 |

## Step 3：训练状态字段更新

```
update_state({
  patch: {
    training_state: {
      // recent_sessions: 整体替换! 取出旧数组, push 新一条, 保留最近 7-10 条
      recent_sessions: [<新的快照>, ...<旧的最多 9 条>],
      consecutive_training_days: <旧值 + 1>,
      consecutive_rest_days: 0,
      fatigue_estimate: <low|moderate|high>,
      // 如果有 pending_adjustments 在本次 session 已经被消费, 移除它们
      pending_adjustments: <剩余未消费的数组>
    },
    user_state: {
      // 如果 during-session 期间用户反馈受伤, 上一个场景已经把 status 改成 injured 了, 这里别覆盖
    }
  }
})
```

## Step 4：max_hr 自动更新（可选）

如果本次 session 中观察到的最高心率 > `profile.max_hr_measured`（或 `max_hr_measured` 为 null）：

```
update_state({
  patch: {
    profile: { max_hr_measured: <新的最高值> }
  }
})
```

→ MCP Server 会自动重算 `alert_hr` 并写入。**不要自己算 alert_hr**。

## Step 5：写 health-log

```
append_health_log({
  event: {
    type: "session",
    date: <today>,
    ts: <now>,
    session: <Step 1 的快照, 完整记录>
  }
})
```

如果 user_state 在 during-session 中被改成了 `injured` 或 `sick`，再追加：

```
append_health_log({
  event: { type: "status_change", date: <today>, ts: <now>, from: "available", to: "injured", reason: "<原因>" }
})
```

## Step 6：show_report 复盘

```
show_report({
  report_type: "post_session",
  data: {
    type: <训练类型>,
    session_mode: <session_mode>,
    duration_min: <number>,
    calories: <number, HealthKit activeEnergyBurned>,
    intensity: <high|medium|low>,
    completion: "<full|partial>",  // 2 值; 被告警中止的记 partial, 在 analysis 里说明
    metrics: { avg_hr, max_hr, ... },
    analysis: "<2-3 句话事实层复盘: 这次发生了什么, 不预测下次>",
    next_check_in: "<只说时间, 例 '明天'/'后天'/'休息 2 天后再练', 不说练什么>"
  }
})
```

**关于 `next_check_in` 的严格边界**：只写**时间**（"明天"、"后天"、"休息 1 天"），**不写内容**（不写"下次练力量"、"下次做有氧"）。训练内容调整走 `pending_adjustments`（降量 / injury_recovery），让下次 scene-workout-confirm 消费，**不通过 UI 文字传递**。

**其他禁忌**：

- **不写完成度评估给 user_initiated 的 session**——用户自发的运动只记录事实，不评价"完成 / 未完成"。
  - `source == "planned"`：`completion` 字段正常填 `full` / `partial`
  - `source == "user_initiated"`：`completion` 字段**省略**，只说时长 / 消耗
- **不施压** "下次再加 5 公斤" 这种话不说。
- **不医学诊断** 心率异常 / 痛感只描述事实，不给病名。

## Step 7：消耗评估（仅 user_initiated）

如果 `source == "user_initiated"`，根据本次消耗 + 用户的 `goal` 判断是否建议追加训练：

| 情况 | 建议 |
|---|---|
| 消耗已达到日常训练水平 | 不建议追加，正常结束 |
| 消耗明显不足 + 身体状态非红/黄 | 用一句话**建议**是否追加（"今天活动量比较小，要不要再做点什么？"）——**只问一次**，用户拒绝就停 |
| 消耗明显不足 + 身体状态红/黄 | 不建议，让用户休息 |

是建议不是要求。**用户拒绝绝对不再追问**。

## Step 8：写日志 + last_scene

```
write_daily_log({
  content: "## 训练复盘\n\n- 类型: <type>\n- 时长: <duration_min> 分钟\n- 强度: <intensity>\n- 评估方向: <summary>\n- 下次检查: <next_check_in>\n"
})

update_state({
  patch: {
    last_scene: { name: "post_session", status: "done", ts: <now>, summary: "<一句话>" }
  }
})
// MCP Server 自动追加 scene_end 到 health-log.jsonl。
```

---

## 失败 / 中止分支

| 情况 | 处理 |
|---|---|
| `get_session_live` 返回 `{ active: false }` 且没有 last_session 数据 | 至少写 `last_scene = { name: "post_session", status: "needs_context" }`，告诉用户"今天的运动数据没拿到，要不要手动告诉我练了什么"，然后让用户用对话补 |
| user_state 被改成 `injured` | recent_sessions 里的 intensity 强制为 `low`（无论实际多重）；fatigue_estimate 强制为 `high`；写 status_change 事件 |
| 用户提前结束（pause 后 stop） | `completion: "partial"`，正常走 Step 1-8 |
| 训练中被心率 critical 强制停 | `completion: "partial"`，`analysis` 开头点明"本次因心率告警中止, 实际训练 X 分钟"，并在 Step 5 追加 `signal` 事件 |

---

## 不在本场景做的事

- **不创建/取消 cron**——cron 只在 onboarding 和用户改时间时动
- **不更新 profile.preferences**——用户偏好的更新由对话场景自然捕获，不在 post-session 推断
- **不调用 readiness**——下次的 readiness 由下次的 trigger 触发
