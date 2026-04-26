# Phase 3 改动清单（eval 同步用）

> 用途：按本清单更新 `health-claw其余文件/eval/` 下的 mock、stages、断言。
> 涉及未提交改动（本地工作区）：7 个新复合工具 + 8 个 scene 文档迁移 + SKILL.md §2.5 速查表。

---

## A. 新增工具（7 个 Pattern A 复合工具，mock 必须新增）

> 共性：复合工具内部依次调既有 handler，**任一步失败立即返回** `{ok:false, failed_step:"<内部 step>", error, detail?, rolled_back?}`，不继续往下做。成功返回的字段见各小节。

### A1. `record_rest_day`
- **入参**：`{reason?: string}`
- **内部步骤**：
  1. 读 `state.training_state.consecutive_rest_days`，记 `oldRestDays`
  2. `update_state({patch:{training_state:{consecutive_rest_days:oldRestDays+1, consecutive_training_days:0}}})` → 自动镜像 `rest_day` 事件
  3. `finish_scene({name:"rest_day", status:"done", summary:"主动休息，连续休息 N 天（reason）", daily_log_content:"## 休息日\n\n- 主动选择休息\n- 原因: <reason>?\n"})`
- **成功返回**：`{ok:true, consecutive_rest_days:N+1, log_file}`
- **scene 影响**：lightweight §3 rest_day 现声明 1 个节点 `{tool:"record_rest_day"}`

### A2. `record_signal`
- **入参**：`{signal_type, detail, severity:"low|medium|high", notification_body?, scene_name?}`
- 默认 `scene_name="anomaly_alert"`
- **内部步骤**：
  1. 读 `state.signals.body`，记 `oldBody`
  2. `update_state({patch:{signals:{body:[...oldBody, {type:signal_type, detail, ts:now, severity}]}}})` → 自动镜像 `signal` 事件
  3. 若传 `notification_body`：`send_notification({body, target:"phone"})`
  4. `finish_scene({name:scene_name, status:"done", summary:"<signal_type> 已记录 (<severity>)", daily_log_content})`
- **成功返回**：`{ok:true, signal_logged:true, notification_sent:bool, log_file}`
- **scene 影响**：anomaly 2.B、2.C 各声明 1 个节点

### A3. `record_body_data`
- **入参**：`{weight_kg?, body_fat_pct?, muscle_mass_kg?, waist_cm?, resting_hr?, update_profile?, scene_name?}`
- 默认 `scene_name="signal_capture_chat"`；`update_profile=false`
- **校验**：必须至少传一个测量字段，否则 `{ok:false, error:"至少传一个测量字段"}`
- **内部步骤**：
  1. `append_health_log({event:{type:"body_data", date, ts, data:{...传入的字段}, source:"user_input"}})` —— **注意**：body_data 不在自动镜像集合，仍走 append
  2. 若 `update_profile===true` 且 `weight_kg`/`body_fat_pct` 至少一个非空：`update_state({patch:{profile:{basic_info:{...}}}})` → 触发 `profile_update` 自动事件 + alert_hr 重算
  3. `finish_scene({name:scene_name, status:"done", summary:"记录 weight_kg=X, body_fat_pct=Y", daily_log_content})`
- **成功返回**：`{ok:true, recorded:{...data}, profile_updated:bool, log_file}`
- **scene 影响**：lightweight §2 signal_capture_chat 改用本工具（**注意：signal_capture_chat 现走 body_data，不再走 signal**）

### A4. `change_status`
- **入参**：`{to:USER_STATE_STATUS_ENUM, reason, since?, next_check?, injuries_patch?, notification_body?, scene_name?}`
- 默认 `scene_name="status_change"`
- **内部步骤**：
  1. 读 `state.user_state.status` → `fromStatus`（缺省 "available"）
  2. 组装 `userStatePatch = {status:to, since:since||today, _reason:reason}`
  3. 若没传 `next_check` 且 `to ∈ {sick, injured}`：自动设 `today + 1 天`
  4. 若传 `injuries_patch`（数组）：合入 `patch.profile.injuries = injuries_patch`（整数组替换）
  5. `update_state({patch})` → 自动镜像 `status_change` 事件（reason 取 `_reason`，写完剥离）
  6. 若传 `notification_body`：`send_notification({body, target:"phone"})`
  7. `finish_scene({name:scene_name, status:"done", summary:"<from> → <to>", daily_log_content})`
- **成功返回**：`{ok:true, from:fromStatus, to, notification_sent:bool, log_file}`
- **scene 影响**：lightweight §4 status_change、anomaly 2.A 高都改用本工具

### A5. `record_session_event`
- **入参**：`{signal_type, detail, severity, notification_body?}`
- **前置校验**：`state.active_session == null` 时返回 `{ok:false, error:"no_active_session"}`
- **内部步骤**：
  1. 读 `signals.body` → `oldBody`
  2. `update_state({patch:{signals:{body:[...oldBody, {type, detail, ts, severity}]}}})` → 自动镜像 `signal`
  3. 若传 `notification_body`：`send_notification({body, target:"watch"})`
  4. `finish_scene({name:"during_session", status:"done", summary:"<signal_type> 已记录"})`
- **成功返回**：`{ok:true, signal_logged:true, notification_sent:bool, log_file}`
- **scene 影响**：during-session 1.A 低/中、1.C warning

### A6. `stop_session_with_signal`
- **入参**：`{trigger:"pain|hr_critical|user_stop|dizziness", detail, severity, status_change?:{to, reason, since?, next_check?}}`
- **前置校验**：`state.active_session == null` → 返回 `{ok:false, error:"no_active_session"}`
- **内部步骤**：
  1. 读 `signals.body`
  2. 组装 `patch.signals.body = [...old, {type:trigger, detail, ts, severity}]`
  3. 若传 `status_change`：合入 `patch.user_state = {status:sc.to, since:sc.since||today, _reason:sc.reason, next_check:sc.next_check||(if sick/injured: today+1)}`
  4. `update_state({patch})` → 自动镜像 `signal` + 可选 `status_change`
  5. 调 `get_session_live({})` 拿到 `last_session_data` 快照（在 stop 之前）
  6. `control_session({action:"stop"})` → 清 `active_session` + **清 pending_nodes**
- **不调 finish_scene** —— stop 后由 SKILL.md §3 特例规则 handoff 给 scene-post-session.md
- **成功返回**：`{ok:true, session_stopped:true, trigger, last_session_data, handoff_to:"scene-post-session.md", note}`
- **scene 影响**：during-session 1.A 高、1.B、1.C critical 全部 1 节点

### A7. `setup_onboarding`
- **入参**：`{bulk:{basic_info:{age, gender, height_cm?, weight_kg?}, fitness_level, goal?, preferences?, injuries?, reminder_mode?, reminder_time?, weekly_report_time?, readiness?:{overall,dimensions,suggestions}}}`
- **必填**：`bulk.basic_info.age`、`bulk.fitness_level`
- **防重复**：若 `state.profile.basic_info.age` 已存在 → `finish_scene({name:"onboarding", status:"skipped", summary:"已初始化过"})` 并返回 `{ok:true, skipped:true, reason:"already_initialized", log_file}`
- **内部步骤**（顺序敏感，任一步失败立即触发回滚）：
  1. `update_state({patch:{user_state:{status:"available", since:today, next_check:null}, profile:{basic_info, goal:goal||"保持健康、规律运动", preferences:preferences||{}, fitness_level, injuries:injuries||[], max_hr_measured:null}, training_state:{consecutive_training_days:0, consecutive_rest_days:0, recent_sessions:[], fatigue_estimate:"low", pending_adjustments:[]}}})`
  2. `schedule_recurring({name:"daily_report", cron:"0 22 * * *", prompt:"请使用 skill:health-claw 生成今日日报"})`
  3. `schedule_recurring({name:"weekly_report", cron:weeklyTimeToCron(weekly_report_time||"Sun 20:00"), prompt:"请使用 skill:health-claw 生成本周周报"})`
  4. `schedule_recurring({name:"monthly_report", cron:"0 20 1 * *", prompt:"请使用 skill:health-claw 生成上月月报"})`
  5. **条件**：若 `reminder_mode==="scheduled"` 且 `reminder_time` 形如 `HH:MM`：`schedule_recurring({name:"daily_workout_reminder", cron:"MM HH * * *", prompt:"请使用 skill:health-claw 根据当前状态帮我安排今天的训练"})`
  6. `get_health_summary({})`
  7. `show_report({report_type:"readiness_assessment", data: bulk.readiness || <默认全 green 模板>})`
  8. `finish_scene({name:"onboarding", status:"done", summary, daily_log_content})`
- **回滚（任一步失败）**：
  - 按已建顺序 `cancel_scheduled` 全部 cron
  - `update_state({patch:{profile:null, user_state:{status:"available", since:today, next_check:null}}})`
  - `finish_scene({name:"onboarding", status:"error", summary:"failed_step=<step>: <detail>", daily_log_content:"## Onboarding 失败\n\n- 失败步骤: <step>\n- 已回滚: cron xN, profile清空\n"})`
  - 返回 `{ok:false, failed_step, error, detail, rolled_back:true, cron_cancelled:[...]}`
- **成功返回**：`{ok:true, cron_created:[...], readiness_overall, log_file}`
- **辅助**：`weeklyTimeToCron("Sun 20:00")` → `"0 20 * * 0"`（其他星期/HH:MM 同理；不合法字符串兜底 `"0 20 * * 0"`）

---

## B. 复合工具内部对自动镜像 / 既有工具的依赖

mock 实现复合工具时，**直接复用**已 mock 的下列单工具的 handler，不要再各自写一份：

| 复合工具 | 依赖的单工具 |
|---|---|
| record_rest_day | update_state（含 rest_day 自动镜像）、finish_scene |
| record_signal | update_state（signal 镜像）、send_notification（可选）、finish_scene |
| record_body_data | append_health_log（body_data）、update_state（profile 镜像；可选）、finish_scene |
| change_status | update_state（status_change 镜像 + injuries 整数组）、send_notification（可选）、finish_scene |
| record_session_event | update_state（signal 镜像）、send_notification(target:watch)（可选）、finish_scene |
| stop_session_with_signal | update_state（signal + 可选 status_change 镜像）、get_session_live、control_session(stop) |
| setup_onboarding | update_state、schedule_recurring x3-4、get_health_summary、show_report、finish_scene、回滚时 cancel_scheduled |

---

## C. pending_nodes 期望（每个场景的清单变化）

| 场景 | Phase 2 后清单 | Phase 3 后清单 |
|---|---|---|
| onboarding | 7 节点（profile + cron x3-4 + show_report + finish） | `[{tool:"setup_onboarding"}]` |
| lightweight rest_day | 2 节点（training_state + finish） | `[{tool:"record_rest_day"}]` |
| lightweight signal_capture_chat | 2 节点（signals + finish） | `[{tool:"record_body_data"}]` |
| lightweight status_change | 2 节点（user_state + finish） | `[{tool:"change_status"}]` |
| lightweight chat / user_correction | 1 节点（finish） | **不变** |
| anomaly 2.A 高 | 4 节点（user_state + signal_state + notify + finish） | `[{tool:"change_status"}]` |
| anomaly 2.B 中 | 3 节点（signal_state + notify + finish） | `[{tool:"record_signal"}]` |
| anomaly 2.C overload | 2 节点（signal_state + finish） | `[{tool:"record_signal"}]` |
| during-session 1.A 低/中 | 3 节点（signal_state + notify + finish） | `[{tool:"record_session_event"}]` |
| during-session 1.A 高 | 3 节点（signal_state + user_state + stop） | `[{tool:"stop_session_with_signal"}]` |
| during-session 1.B | 1 节点（stop） | `[{tool:"stop_session_with_signal"}]` |
| during-session 1.C critical | 2 节点（signal_state + stop） | `[{tool:"stop_session_with_signal"}]` |
| during-session 1.C warning | 3 节点（signal_state + notify + finish） | `[{tool:"record_session_event"}]` |

---

## D. 每场景 tool-call 次数最终态（Phase 1+2+3 累计）

| 场景 | 原始 | Phase 1 | Phase 2 | Phase 3（最终） |
|---|---|---|---|---|
| onboarding | 7 | 7 | 6 | **1** |
| readiness | 4 | 4 | 3 | 3（未改，仍是 Pattern B 待 Phase 4） |
| workout-confirm | 7 | 7 | 5 | 5（未改） |
| post-session | 5 | 4 | 4 | 4（未改） |
| during-session 1.A 低/中 | 5 | 3 | 3 | **1** |
| during-session 1.A 高 | 5 | 3 | 3 | **1** |
| during-session 1.B | 1 | 1 | 1 | **1**（改用 stop_session_with_signal） |
| during-session 1.C critical | 4 | 2 | 2 | **1** |
| during-session 1.C warning | 5 | 3 | 3 | **1** |
| anomaly 2.A 高 | 6 | 3 | 3 | **1** |
| anomaly 2.B 中 | 5 | 3 | 3 | **1** |
| anomaly 2.C overload | 3 | 2 | 2 | **1** |
| lightweight chat | 2 | 2 | 1 | 1（未改） |
| lightweight signal_capture | 4 | 2 | 2 | **1** |
| lightweight rest_day | 4 | 2 | 2 | **1** |
| lightweight status_change | 4 | 2 | 2 | **1** |
| lightweight user_correction | 2 | 2 | 1 | 1（未改） |
| daily_report | 3 | 3 | 2 | 2（未改） |
| weekly_report | 3 | 3 | 2 | 2（未改） |
| monthly_report | 4 | 4 | 3 | 3（未改） |

---

## E. health-log 事件来源（Phase 3 后整体不变，只改写入路径）

最终产物事件类型 + 字段结构**保持不变**——只是写入这些事件的工具变了：

| 事件 type | Phase 3 后的写入触发 |
|---|---|
| `scene_end` | `finish_scene`（无论是模型直接调还是复合工具内部调） |
| `profile_update` | `update_state(profile)` 自动 diff（含 record_body_data 内部 update_profile=true 时） |
| `signal` | `update_state(signals.body push)` 自动镜像（record_signal / record_session_event / stop_session_with_signal 内部） |
| `status_change` | `update_state(user_state.status 变化, _reason)` 自动镜像（change_status / stop_session_with_signal.status_change 内部） |
| `session` | `update_state(training_state.recent_sessions push)` 自动镜像（post-session 仍手写，Phase 4 才会被 finalize_session 内化） |
| `rest_day` | `update_state(training_state.consecutive_rest_days N→N+1)` 自动镜像（record_rest_day 内部） |
| `body_data` | `append_health_log({type:"body_data"})` 仍手动（record_body_data 内部） |

**eval 断言要点**：
- 任意 stage 的 `tool-calls.jsonl` 中**模型层面**对应场景应只见 1 个调用（例外：onboarding 是 1 个 setup_onboarding；workout-confirm/post-session/reports 仍是多个）
- mock 的复合 handler 必须**真的去调它依赖的子 handler**——不能"假装"成功，否则 `state-after.json` / `health-log.jsonl` / show_report 文件都会缺
- `state-after.json` / `health-log*.jsonl` / `show_report*.jsonl` 与 Phase 1/2 期望**完全一致**（用户体验真值不变）

---

## F. 错误注入（eval 必加用例）

每个复合工具至少加 2 个错误注入用例：

1. **入参错**：
   - record_rest_day：无入参也合法（无可错），跳过
   - record_signal：缺 `severity` → schema 拒绝（在 MCP layer 报错，不进 handler）
   - record_body_data：所有测量字段都不传 → `{ok:false, error:"至少传一个测量字段"}`
   - change_status：`to` 不在 USER_STATE_STATUS_ENUM → 由 update_state 拦截，复合返回 `{failed_step:"update_state", error:"user_state.status 不合法"}`
   - record_session_event / stop_session_with_signal：`active_session==null` → `{ok:false, error:"no_active_session"}`
   - setup_onboarding：缺 `bulk.basic_info.age` → `{ok:false, error:"bulk.basic_info.age 必填"}`
2. **内部步骤失败**（mock 模拟 schedule_recurring / show_report / send_notification 返回 `{ok:false}`）：
   - record_signal：notification 失败 → `{ok:false, failed_step:"send_notification", rolled_back:false}`（signal 已镜像，是部分成功——eval 验证模型能否识别）
   - setup_onboarding：第 3 步 schedule_recurring(weekly_report) 失败 → 验证回滚（cancel daily_report、profile 清空、finish_scene(error)、`cron_cancelled:["daily_report"]`、`rolled_back:true`）

---

## G. 文档侧变更

- `SKILL.md` 新增 §2.5 复合工具速查表（7 行表 + 选用规则 + 失败定位）
- 8 个 scene doc 都 trim 到："何时调哪个复合工具 + bulk 字段映射"，删掉所有手写 update_state/append_health_log 步骤
- `references/scene-onboarding.md` 体积缩水约 60%（cron 串调段落 / Step 1-5 全部合并为 1 个 setup_onboarding 调用块）

---

## H. eval 改动 checklist（按本 list 实操顺序）

- [ ] mock 7 个新复合 handler，**每个都直接复用** mock 的子 handler（不要重写自动镜像 / scene_end 等逻辑）
- [ ] 每个复合工具的 schema 加入 mock tools 列表
- [ ] 更新所有 stage 期望调用次数（按 §D 表的"Phase 3"列）
- [ ] 更新所有 stage 的 pending_nodes 初始声明（按 §C 表）
- [ ] `state-after.json` 期望保持与 Phase 2 一致（Phase 3 不改最终产物结构，只改写入路径）
- [ ] `health-log*.jsonl` / `show_report*.jsonl` 期望同样保持
- [ ] 加 §F 的错误注入用例
- [ ] **特别注意 setup_onboarding 回滚用例**：mock 必须能模拟"前 N 个 cron 建成后第 N+1 个失败"的场景，验证 `cron_cancelled` 数组顺序逆向且齐全
- [ ] **特别注意 stop_session_with_signal**：本工具不调 finish_scene；下个 stage 立即 hand off 给 scene-post-session.md，pending_nodes 此时已被 control_session(stop) 清空 —— mock 验证此时模型新声明 post-session 的 pending_nodes
- [ ] mock signal_capture_chat 改用 body_data 事件类型（**Phase 1 时遗留的 signal 事件期望要改成 body_data**）

---

## I. 已知未做 / 跳过项

- Phase 4 / Pattern B 工具（evaluate_readiness / prepare_workout_context / commit_workout_plan / finalize_session / generate_report）**未实现**——readiness/workout-confirm/post-session/reports 场景仍走 Phase 2 的 finish_scene 写法
- request_user_input 异步化（Phase 5）**未实现**
- eval mock 本身**未改**（在 `health-claw其余文件/eval/`，未跟踪 git，跳过）
