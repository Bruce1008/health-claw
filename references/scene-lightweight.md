# scene: lightweight（轻量场景集合）

本文件汇总 5 类触发门槛较低、步骤较少的场景：`chat` / `signal_capture_chat` / `rest_day` / `status_change` / `user_correction`。各场景的 pending_nodes 清单见 §0，各自章节只补充差异。

---

## §0 pending_nodes 清单（每个轻量场景一份，`read_state` 后声明）

`last_scene.name` 取本场景的 `scene_type`。异常收尾（用户取消 → `skipped`、工具失败 → `error`、onboarding 未完成 → `blocked`）由 Server 自动清空 pending_nodes。

**§1 chat**：

```json
[
  {"id":"s1_finish","tool":"finish_scene","match":{"status":"done"}}
]
```

> **Phase 3 复合工具**：§2/§3/§4 各自全部步骤已合并到一个工具，pending_nodes 清单只剩 1 个节点。手动 update_state + finish_scene 仍然可用（fallback），但**首选复合工具**。

**§2 signal_capture_chat**（用 `record_body_data` 复合工具）：

```json
[
  {"id":"s1_record_body_data","tool":"record_body_data"}
]
```

**§3 rest_day**（用 `record_rest_day` 复合工具）：

```json
[
  {"id":"s1_record_rest_day","tool":"record_rest_day"}
]
```

**§4 status_change**（用 `change_status` 复合工具）：

```json
[
  {"id":"s1_change_status","tool":"change_status"}
]
```

**§5 user_correction**：

```json
[
  {"id":"s1_finish","tool":"finish_scene","match":{"status":"done"}}
]
```

- status_change 若涉及受伤：用 `change_status({to:"injured", reason, injuries_patch:[<整数组>]})` 一次完成，**不需要**额外节点。
- user_correction 若需下发新计划，插入 `{"id":"s0a_set_workout_plan","tool":"set_workout_plan"}` + `{"id":"s0b_show_report","tool":"show_report","match":{"report_type":"training_plan"}}` 到 s1 之前。

---

## §1 chat

> 触发：用户闲聊 / 问一般健身常识 / 自然语言里不包含本 skill 其他场景的触发信号。

骨架：

```
read_state
→ 简答（不编数据、不下计划、不做医学判断）
→ finish_scene({name:"chat", status:"done", summary:"<一句话话题>", daily_log_content:"## 对话\n- <一句话摘要>"})
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
→ record_body_data({weight_kg?, body_fat_pct?, muscle_mass_kg?, waist_cm?, resting_hr?, update_profile?})
   // 内部：append_health_log(body_data) + 可选 update_state(profile.basic_info) + finish_scene 一气呵成
   // update_profile=true 时把 weight_kg/body_fat_pct 同步进 profile.basic_info 作为长期值
```

判断是否更新 profile：一次性"今天称了 73.5"不更新 profile；用户明确说"我的体重是 74"或连续多次上报稳定值时更新。

---

## §3 rest_day

> 触发：用户说"今天休息" / "今天不练" / 连续无训练日且用户确认。

骨架：

```
read_state
→ record_rest_day({reason?})
   // 内部：update_state(consecutive_rest_days+1, consecutive_training_days:0) → 自动镜像 rest_day + finish_scene
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
→ change_status({to:"<after>", reason:"<用户描述>", since?, next_check?, injuries_patch?, notification_body?})
   // 内部：update_state(user_state + 可选 profile.injuries) → 自动镜像 status_change + 可选 send_notification + finish_scene
   // 受伤 / 生病自动设 next_check=今天+1天
```

如果是"受伤"：

- 直接通过 `change_status` 的 `injuries_patch` 字段一次性整数组替换，字段参考 `references/state-schema.md`。
- 高严重度建议同时传 `notification_body` 让 server 自动发手机通知。

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
→ finish_scene({name:"user_correction", status:"done", summary:"修正 <dim>: <before> → <after>", daily_log_content:"## 计划修正\n- <dim>: <before> → <after>\n- 类型: <一次性|长期>"})
```

判断一次性 vs 长期（参考 SKILL.md §5）：

- "今天不想练跑步" → 一次性
- "我以后都不想跑步了" / 用户连续 3 次拒绝同类 → 长期，更新 profile

---

## 与其他场景的衔接

- 这 5 类场景**不是** pipeline caller，不需要调 `control_session(stop)`、也不涉及 post-session 跨场景流。
- 任何一类场景内如果发现 `onboarding` 未完成（`profile.basic_info.age` 不存在），直接写 `last_scene.status="blocked"` 并提示用户先完成首次设置，不继续执行本场景主体。
