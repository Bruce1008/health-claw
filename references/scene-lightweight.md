# scene: lightweight（轻量场景集合）

本文件汇总 5 类触发门槛较低、步骤较少的场景：`chat` / `signal_capture_chat` / `rest_day` / `status_change` / `user_correction`。它们共用 §0 通用骨架，各自章节只补充差异。

---

## §0 通用骨架（所有轻量场景必须走完）

```
1. read_state                                ← 入口，无一例外
2. 场景差异化工具（见下）
3. update_state({patch:{last_scene:{name, status, ts, summary}}})
4. write_daily_log({content:"..."})          ← 人类可读摘要
```

**硬规则**：

- 任何轻量场景在输出最终回复前，必须完成 `update_state(last_scene)` 和 `write_daily_log`。只输出文字不落盘 = FAIL。
- `last_scene.name` 取本场景的 `scene_type`（`chat` / `signal_capture_chat` / `rest_day` / `status_change` / `user_correction`）。
- `last_scene.status` 默认 `done`；用户明确取消则 `skipped`；工具失败则 `error`。
- MCP Server 在 `update_state` 写入 last_scene 时自动追加 `scene_end` 事件，**不要**手动 `append_health_log({type:"scene_end"})`。

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
