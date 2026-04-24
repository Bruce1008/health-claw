# scene: lightweight（轻量场景集合）

本文件汇总 5 类触发门槛较低、步骤较少的场景：`chat` / `signal_capture_chat` / `rest_day` / `status_change` / `user_correction`。各场景的 pending_nodes 清单见 §0，各自章节只补充差异。

---

## §0 pending_nodes 清单（每个轻量场景一份，`read_state` 后声明）

`last_scene.name` 取本场景的 `scene_type`。异常收尾（用户取消 → `skipped`、工具失败 → `error`、onboarding 未完成 → `blocked`）由 Server 自动清空 pending_nodes。

**§1 chat**：

```json
[
  {"id":"s1_write_daily_log","tool":"write_daily_log"},
  {"id":"s2_close_done","tool":"update_state","match":{"patch":"last_scene"}}
]
```

**§2 signal_capture_chat**：

```json
[
  {"id":"s1_signal_log","tool":"append_health_log","match":{"event_type":"signal"}},
  {"id":"s2_write_daily_log","tool":"write_daily_log"},
  {"id":"s3_close_done","tool":"update_state","match":{"patch":"last_scene"}}
]
```

**§3 rest_day**：

```json
[
  {"id":"s1_rest_log","tool":"append_health_log","match":{"event_type":"rest_day"}},
  {"id":"s2_training_state","tool":"update_state","match":{"patch":"training_state"}},
  {"id":"s3_write_daily_log","tool":"write_daily_log"},
  {"id":"s4_close_done","tool":"update_state","match":{"patch":"last_scene"}}
]
```

**§4 status_change**：

```json
[
  {"id":"s1_status_log","tool":"append_health_log","match":{"event_type":"status_change"}},
  {"id":"s2_user_state","tool":"update_state","match":{"patch":"user_state"}},
  {"id":"s3_write_daily_log","tool":"write_daily_log"},
  {"id":"s4_close_done","tool":"update_state","match":{"patch":"last_scene"}}
]
```

**§5 user_correction**：

```json
[
  {"id":"s1_write_daily_log","tool":"write_daily_log"},
  {"id":"s2_close_done","tool":"update_state","match":{"patch":"last_scene"}}
]
```

- status_change 若涉及受伤，同时在 s2 之前增加一节点 `{"id":"s1b_profile_injuries","tool":"update_state","match":{"patch":"profile"}}`。
- user_correction 若需下发新计划，插入 `{"id":"s0a_set_workout_plan","tool":"set_workout_plan"}` + `{"id":"s0b_show_report","tool":"show_report","match":{"report_type":"training_plan"}}` 到 s1 之前。

---

## §1 chat

> 触发：用户闲聊 / 问一般健身常识 / 自然语言里不包含本 skill 其他场景的触发信号。

骨架：

```
read_state
→ 简答（不编数据、不下计划、不做医学判断）
→ update_state(last_scene={name:"chat", status:"done", summary:"<一句话话题>"})
→ write_daily_log({content:"## 对话\n- <一句话摘要>"})
```

不要：

- 不要在 chat 里 `set_workout_plan` / `show_report`。如果用户在聊天里**明确请求**评估/计划，跳去 readiness 或 workout-confirm 场景，chat 本身收尾即可。
- 不要重复讲已经在 recent_sessions / readiness 里给过的评估。

---

## §2 signal_capture_chat

> 触发：用户在对话里报告可量化的身体信号（体重、体脂、肌肉量、腰围、静息心率自测值等）。

骨架：

```
read_state
→ append_health_log({event:{type:"signal", signal_type:"<weight|body_fat|...>", value:<number>, unit:"<kg|%|bpm|cm>", ts:<now>}})
→ update_state({patch:{profile:{basic_info:{weight_kg:...}}}}) // 仅当确实需要长期更新 profile 时
→ update_state(last_scene={name:"signal_capture_chat", status:"done", summary:"记录 <signal_type>=<value>"})
→ write_daily_log({content:"## 信号采集\n- <signal_type>: <value><unit>"})
```

判断是否更新 profile：一次性"今天称了 73.5"不更新 profile；用户明确说"我的体重是 74"或连续多次上报稳定值时更新。

---

## §3 rest_day

> 触发：用户说"今天休息" / "今天不练" / 连续无训练日且用户确认。

骨架：

```
read_state
→ append_health_log({event:{type:"rest_day", date:"<stage_date>", ts:"<stage_date>T08:00:00+08:00"}})
→ update_state({patch:{training_state:{
    consecutive_rest_days: <before+1>,
    consecutive_training_days: 0
  }}})
→ update_state(last_scene={name:"rest_day", status:"done", summary:"主动休息，连续休息 <n> 天"})
→ write_daily_log({content:"## 休息日\n- 主动选择休息"})
```

硬规则：

- `consecutive_training_days` 必须置 **0**，不是递增。
- 日期字段必须用**本次 stage 的日期**（即 `read_state` 返回的 `user_state.since` / 今日）。不要从 recent_sessions 里复制旧日期，不要自己硬编码。
- 不要追问"为什么不练"、"你是不是受伤了"—— rest_day 是用户主动选择，不做因果追问。

---

## §4 status_change

> 触发：用户报告长期状态变化（生病、受伤、出差、工作忙、低动机）。

`user_state.status` 允许值：`available` / `sick` / `injured` / `busy` / `traveling` / `low_motivation`。

骨架：

```
read_state
→ append_health_log({event:{type:"status_change", from:"<before>", to:"<after>", reason:"<用户描述>", ts:<now>}})
→ update_state({patch:{user_state:{status:"<after>", since:"<stage_date>"}}})
→ update_state(last_scene={name:"status_change", status:"done", summary:"<before> → <after>"})
→ write_daily_log({content:"## 状态变更\n- <before> → <after>\n- 说明: <reason>"})
```

如果是"受伤"：

- 同时走 `profile.injuries` 增补（整数组替换）一条新 injury，字段参考 `references/state-schema.md`。
- `last_scene.summary` 带上受伤部位。

---

## §5 user_correction

> 触发：用户对前序训练计划 / 评估提出修正（"我更想练腿"、"别给我跑步"、"强度低一点"）。

骨架：

```
read_state
→ 判断修正类型：
   (a) 一次性修正 → 只改当次 set_workout_plan / show_report
   (b) 长期偏好变更 → update_state({patch:{profile:{preferences:{...}}}}) 并整组替换数组
→ (如需) set_workout_plan({...})  // 生成修正后的训练计划
→ (如需) show_report({report_type:"training_plan", data:{...}})
→ update_state(last_scene={name:"user_correction", status:"done", summary:"修正 <dim>: <before> → <after>"})
→ write_daily_log({content:"## 计划修正\n- <dim>: <before> → <after>\n- 类型: <一次性|长期>"})
```

判断一次性 vs 长期（参考 SKILL.md §5）：

- "今天不想练跑步" → 一次性
- "我以后都不想跑步了" / 用户连续 3 次拒绝同类 → 长期，更新 profile

---

## 与其他场景的衔接

- 这 5 类场景**不是** pipeline caller，不需要调 `control_session(stop)`、也不涉及 post-session 跨场景流。
- 任何一类场景内如果发现 `onboarding` 未完成（`profile.basic_info.age` 不存在），直接写 `last_scene.status="blocked"` 并提示用户先完成首次设置，不继续执行本场景主体。
