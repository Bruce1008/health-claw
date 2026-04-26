# health-claw 改造方案

> 目标：把 OpenClaw 的 tool 调用次数砍 50–70%，长场景耗时下降同比例，模型质量不降反升。
> 原则：解耦"模型判断"与"MCP 内化"——MCP 负责机械写入和路由，模型负责创作和判断。

---

## 一、两种工具模式

| 模式 | 适用场景 | 工具形态 |
|---|---|---|
| **Pattern A：纯事务** | onboarding / lightweight / anomaly / during-session 写入 | "MCP 全包，模型一次调用" |
| **Pattern B：骨架内化 + 模型填空** | workout-confirm / post-session / readiness / reports | "MCP 给上下文 → 模型决策/创作 → MCP 收尾提交" |

> 文档里必须明确分这两种，避免后续被人提"为啥不能把 generate_report 也全内化"。

---

## 二、Stage 1：低风险降 token（先做，零架构风险）

### 2.1 `read_state` 增加 projection
- 入参：`{projection?: ["profile.basic_info", "user_state", "active_session", "training_state.recent_sessions[0:3]", ...]}`
- 默认（不传 projection）保持返回完整 state，向后兼容
- **必须默认下发 `reminders` 数组**——多场景子分支靠它触发
- 每个场景在 doc 里固定声明本场景的 projection slice

### 2.2 `update_state` 改返回值
- 旧：返回完整 state（每次 1-2K token）
- 新：`{ok, changed_keys, remaining_pending_nodes, warnings?}`
- 模型靠 `remaining_pending_nodes` 自检还剩几个节点

### 2.3 `get_workout_log` / `get_health_summary` 默认 aggregate
- 默认返回聚合（by_type、by_intensity、avg_*、trend）
- `detail: true` 兜底拿原始 sessions——daily_report 和 monthly_report 必须用
- weekly 默认 aggregate 够用

### 2.4 state ↔ health-log 自动镜像（新增项，原计划没有）
- 任何 `update_state(signals/user_state/training_state.recent_sessions/profile.injuries)` 由 server 自动 mirror 一条对应 `append_health_log` 事件
- **干掉 8 个场景里手写的 append_health_log 节点**：during-session 1.A 低/高、1.C critical/warning、post-session、anomaly 7.A/7.B、status_change、rest_day
- 文档同步禁止模型手动 `append_health_log({type:"signal|status_change|session|rest_day"})`，只允许写 server 不会自动镜像的类型

### 2.5 SKILL.md 精简
- 只留：路由表 + 工具调用硬规则 + 枚举值表 + 跨场景红线
- 删掉：每个场景的执行步骤说明（移到 docs，且 docs 也要进一步压缩）

### 避坑映射
- §4「不要重复完整工具 schema」 → projection key、新返回字段只在 schema 里定义一次
- §5「mock 字段名必须和 MCP handler 返回一致」 → update_state 改返回结构后 mock 必须同步
- §1「不要写"读取 state.json"」 → 改 read_state 文档时统一改成"调用 read_state MCP 工具"

---

## 三、Stage 2：降耗时

### 3.1 `finish_scene(name, status, summary, daily_log_content?)` 合并
- 取代 `write_daily_log` + `update_state(last_scene)` 两个节点
- daily_log_content 缺省时 server 用 `summary` 自动生成简短日志
- **每个场景节点 -1**

### 3.2 `reschedule_recurring(name, new_cron, new_prompt?)` 合并
- 取代 `cancel_scheduled` + `schedule_recurring`
- 内部原子操作（cancel 失败则不创建新 cron）

### 3.3 `request_user_input` 异步化（独立立项，最高风险，单独评估）
> **不与 Stage 2 其他改动一起发**——涉及 pending_nodes 协议改动。

- 旧：阻塞等回调，模型在同一 turn 内继续
- 新：立即返回 `request_id`，回调由 MCP 处理：
  - "开始" → MCP 自动调 `control_session(start)`
  - "跳过" → MCP 自动 `append_health_log(rest_day)` + `finish_scene(skipped)`
  - "过一会儿" → MCP 自动 `schedule_one_shot(30m)` + `finish_scene(skipped)`
  - "换一个" → 重新唤起模型，把 workout-confirm 上下文（recent_sessions + 已被拒类型 + readiness 缓存）一并喂回
- pending_nodes 协议同步改：新增 `wait_user_input` 节点类型，被 MCP 代关闭时自动弹空
- **必须有 timeout 和 pending callback 清理**（避坑 §2）；eval 里 patch 后能跑不代表生产不会阻塞

### 避坑映射
- §2「request_user_input 必须有 timeout 和 pending callback 清理」 → 异步化设计文档里必须写明 timeout 行为和清理策略
- §6「反复打补丁而不是重写」 → request_user_input 异步化是协议级改动，**不要**在原同步实现上加补丁，整个工具 handler 重写

---

## 四、Stage 3：复合事务工具

### Pattern A 工具（全内化，模型一次调用）

#### 4.A.1 `setup_onboarding(bulk_payload)`
- 内部：防重复检查 → 写 profile/user_state/training_state → 建 4 个 cron（条件） → 拉 health_summary → show_report(readiness_assessment) → 写日志 → close scene
- 失败：原子回滚（cancel 已建 cron + 清空 profile + last_scene=error）
- 返回：`{ok, scene:"onboarding", cron_created:[...], readiness_overall, failed_step?}`
- **节点压缩 7→1**

#### 4.A.2 `record_signal({category, signal_type, value?, unit?, detail, severity, source})`
- 取代 lightweight signal_capture 全流程
- 内部：append_health_log + 条件 update_state(profile.basic_info) + finish_scene
- 返回：`{ok, log_id}`
- **节点压缩 3→1**

#### 4.A.3 `change_status({to, reason, since?, next_check?, injuries_patch?})`
- 取代 status_change + anomaly 7.A 主体
- 内部：update_state(user_state) + 条件 update_state(profile.injuries 整数组替换) + 自动镜像 status_change 事件 + 条件 send_notification + finish_scene
- 返回：`{ok, from, to, notification_sent}`
- **节点压缩 4-6→1**

#### 4.A.4 `record_rest_day({reason?})`
- 内部：append_health_log(rest_day) + update_state(training_state: rest_days+1, training_days=0) + finish_scene
- 返回：`{ok, consecutive_rest_days}`
- **节点压缩 4→1**

#### 4.A.5 `record_body_data({weight?, body_fat?, muscle_mass?, waist?, resting_hr?})`
- 与 record_signal 区分：record_body_data 写"可量化身体指标"，record_signal 写"主观症状"
- 内部：append_health_log(body_data) + 条件 update_state(profile.basic_info) + finish_scene

#### 4.A.6 `record_session_event({severity, category, detail, send_notification?})`
- 用于 during-session 1.A 低/中、1.C warning（不停训分支）
- 内部：update_state(signals.body push) + 自动镜像 signal log + 条件 send_notification + finish_scene
- **节点压缩 4→1**

#### 4.A.7 `stop_session_with_signal({trigger, severity, detail, status_change?})`
- 用于 during-session 1.A 高、1.C critical（停训分支）
- 内部：update_state(signals + 可选 user_state) + 镜像 signal/status_change log + control_session(stop) → 自动 handoff 给 post-session
- 返回：`{ok, session_stopped, last_session_data}` —— 同 turn 后续 finalize_session 可直接用
- **节点压缩 5→1**

### Pattern B 工具（骨架内化 + 模型填空）

#### 4.B.1 `prepare_workout_context()` + `commit_workout_plan(plan)`
- **prepare**: server 内部
  - 检查 onboarding/active_session/sick/injured/busy/traveling，自动路由：
    - blocked/skipped → 直接返回 `{routed:"blocked"|"skipped", reason}`，无需模型再决策
    - busy/traveling → 返回"必须 passive/timer 5-10 分钟"约束
  - 拉 health_summary + 跑内联 readiness 4 维（不调用 show_report）
  - 返回：`{readiness:{4 dims, overall}, profile_slice, recent_sessions, pending_adjustments, injuries, constraints:["必须降强度因为连续3天高强度", ...]}`
- **commit**: server 内部
  - 一次性 set_workout_plan + show_report(training_plan) + set_alert_rules
  - 模型只传 `{plan, session_mode, type, duration_min, plan_summary, safety_notes}`
  - 返回：`{ok, request_id_for_user_input}` —— 紧跟 request_user_input(开始/换一个/跳过/过一会儿)
- **模型只做**：plan 内容创作 + safety_notes 措辞
- **节点压缩 6→2**

#### 4.B.2 `finalize_session({intensity, summary, analysis, next_check_in, completion?})`
- server 内部
  - get_session_live 拿 duration/calories/HR
  - update_state(training_state.recent_sessions push + consecutive_* + fatigue_estimate)
  - 条件 update_state(profile.max_hr_measured) → 自动重算 alert_hr
  - 消费 pending_adjustments（被本次 session 命中的移除）
  - 镜像 session 事件到 health-log
  - show_report(post_session) 用模型传入的 analysis/next_check_in
  - finish_scene
- **模型只做**：判断 intensity（瑜伽 60min 可能 low / HIIT 15min 可能 high）+ 写 summary 评估方向 + 2-3 句 analysis + next_check_in 时间词
- 返回：`{ok, recent_sessions_count, fatigue_estimate}`
- **节点压缩 5→1**

#### 4.B.3 `evaluate_readiness({suggestions, deliver?: true})`
- server 内部
  - 拉 health_summary
  - 计算 4 维度 level + detail（机械可内化）
  - 计算 overall（任一红→红，任一黄→黄，全绿→绿）
  - deliver=true 时调 show_report(readiness_assessment) + finish_scene
  - 处理 injury_check reminder：返回 `{injury_check_pending:{...}}` 让模型决定是否调 request_user_input
- **模型只做**：写 suggestions 数组（根据 profile.goal/recent_sessions/injuries 给方向）
- 返回：`{overall, dimensions, injury_check_pending?}`
- **节点压缩 3→1**（不含 injury_check 子流程）

#### 4.B.4 `generate_report({period, narrative, highlights?, concerns?, observation?, phase_advice?})`
- server 内部
  - 检查 onboarding/active_session：active_session 时自动 schedule_one_shot(30m) + skipped，无需模型决策
  - 取数（get_workout_log + get_health_summary + 月报另外 query_health_log(body_data, status_change)）
  - 聚合 by_type/by_intensity/total_*/trend（机械可内化）
  - 月报：自动 write_global_memory(milestone)
  - show_report(daily_report|weekly|monthly) 用模型传入的 narrative
  - finish_scene
- **模型只做**：narrative 2-5 段人感叙述 + highlights/concerns/observation 创作内容
- 月报的 profile_review 子流程拆出来：返回 `{profile_review_pending:{type:"fitness_level"|"goal", trend, current}}` 让模型决定是否调 request_user_input
- **节点压缩 3→1**（不含 profile_review 子流程）

### 避坑映射（Stage 3 共性）
- §1「禁止 exec 旧 CLI」 → 新工具 handler 全部走 MCP，不引入 child_process（除非 spawn openclaw 官方 CLI 调度 cron）
- §2「handler 和 schema 必须一一对应」 → 7 个 Pattern A + 6 个 Pattern B 工具上线时，schema 和 handler 必须同 PR 提交，禁止只补一边
- §2「工具内部错误返回稳定 JSON」 → 复合工具失败必须返回 `{ok:false, failed_step:"...", error:"...", rolled_back:true|false}`，让模型能定位
- §2「request_user_input 必须有 timeout」 → prepare_workout_context 和 generate_report 返回的 `_pending` 字段对应的子流程也要 timeout
- §4「不要在 SKILL.md 写场景具体步骤」 → 新工具上线后场景文档大幅缩水，只保留"何时调哪个工具 + 模型负责填什么"
- §4「自动事件由 MCP 写入要明确禁止模型手动调」 → state↔log 自动镜像后，文档明文禁止 `append_health_log({type:"signal|status_change|session|rest_day"})`

---

## 五、SKILL.md 精简后结构

```
1. 工具调用硬规则（保留，加强"禁止内置 read/write/edit/update"）
2. 场景路由表（保留）
3. 复合工具速查表（新增）
   - Pattern A vs Pattern B 标识
   - 每个工具 1 行说明 + 何时调用
4. last_scene.status 五选一（保留）
5. profile 字段更新规则（精简）
6. 字段枚举值（保留）
7. 训练计划上下文硬规则（保留）
8. 交互红线（保留）
9. cron 调度边界（更新：reschedule_recurring 取代 cancel+create）
```

**删掉**：§3 场景通用协议（pending_nodes 任务板）的细节——节点清单大幅缩水后，每个场景 doc 自己声明 1-2 个节点即可，SKILL.md 不需要解释清单的"格式"。

---

## 六、scene-*.md 改造

| 文档 | 改动 |
|---|---|
| scene-onboarding.md | **删 90%**，保留"触发条件 + 调用 setup_onboarding(bulk)" |
| scene-readiness.md | 保留 4 维度判据（模型要看）+ injury_check 子流程；其他删 |
| scene-workout-confirm.md | 改为"两阶段"叙述：prepare_workout_context 拿到 constraints 后怎么写 plan；commit_workout_plan 后怎么处理 user_input 回调 |
| scene-during-session.md | 改成"严重度判定表 + 调哪个工具"：1.A 低/中→record_session_event；1.A 高/1.C critical→stop_session_with_signal；1.B→stop_session_with_signal(trigger=user_stop)；1.C warning→record_session_event |
| scene-post-session.md | 改成"模型只填 intensity/summary/analysis/next_check_in 四字段"+ finalize_session 调用 |
| scene-reports.md | 改成"narrative 写作要求 + generate_report 调用"，三种报告共享一份 |
| scene-anomaly-alert.md | 改成"严重度判定→change_status 或 record_signal" |
| scene-lightweight.md | 改成"5 个轻量场景 → 5 个 Pattern A 工具映射" |
| reminders.md | 不变 |
| state-schema.md / health-log-schema.md / report-schema.md | 不变（仍是 schema 真源） |

---

## 七、eval / mock 同步改动

来自避坑清单 §5：

- mock 数据必须用新工具名（`setup_onboarding` 等），不能再 mock 旧 `update_state` 多次调用
- `tool-calls.jsonl` 判定：每场景调用次数从 5-8 降到 1-3，eval 断言阈值要同步改
- `state-after.json` / `health-log*.jsonl` / `show_report*.jsonl` 的最终产物**必须保持一致**——这是用户体验的真值，不能因为内部改了工具而变
- 删掉所有还在 mock 旧 `cli.js` 的 stage（避坑 §5「不要再要求 cli.js 和 mcp-server.js mock 一致」）
- mock 字段名 `sessions`/`workouts` 之类历史不一致**这次一并清理**
- 新工具的 mock 错误注入要覆盖 `failed_step` 字段（让 eval 验证模型能否定位失败步骤）

---

## 八、文件级 TODO list（按发布顺序）

### Phase 1（独立可发，零协议风险）
1. [x] ~~`scripts/mcp-server.js`: read_state 加 projection 参数~~ **已改**
2. [x] ~~`scripts/mcp-server.js`: update_state 改返回结构~~ **已改**
3. [x] ~~`scripts/mcp-server.js`: get_workout_log/get_health_summary 加 aggregate 默认~~ **已改**
4. [x] ~~`scripts/mcp-server.js`: update_state(signals/user_state/training_state/profile.injuries) 自动镜像 health-log~~ **已改**
5. [x] ~~`references/scene-*.md`: 同步删掉手动 append_health_log 步骤~~ **已改**
6. [x] ~~`SKILL.md`: 加"禁止手动 append_health_log 这些类型"硬规则~~ **已改**
7. [x] ~~`references/state-schema.md`: 标注哪些字段写入会自动镜像~~ **已改**

### Phase 2（finish_scene + reschedule_recurring）
1. [x] ~~`scripts/mcp-server.js`: 加 finish_scene handler + schema~~ **已改**
2. [x] ~~`scripts/mcp-server.js`: 加 reschedule_recurring handler + schema~~ **已改**
3. [x] ~~`references/scene-*.md`: 把 write_daily_log + update_state(last_scene) 改成 finish_scene~~ **已改**
4. [x] ~~`SKILL.md` §9: cron 调度边界改成 reschedule_recurring~~ **已改**
5. [ ] eval mock: 加 finish_scene/reschedule_recurring 的 mock — **未跟踪在 git repo（在 `health-claw其余文件/eval/`），跳过**

### Phase 3（Pattern A 复合工具，按风险从低到高）
1. [x] ~~`record_rest_day`（最简单，验证设计模式）~~ **已改**
2. [x] ~~`record_signal` + `record_body_data`~~ **已改**
3. [x] ~~`change_status`（含 anomaly 7.A 路径）~~ **已改**
4. [x] ~~`record_session_event`~~ **已改**
5. [x] ~~`stop_session_with_signal`（含 control_session(stop) handoff）~~ **已改**
6. [x] ~~`setup_onboarding`（最复杂，原子回滚要测充分）~~ **已改**
7. [x] ~~每个工具落地后同步：scene 文档简化 + eval mock 替换~~ **scene 文档已改；eval mock 跳过（在 `health-claw其余文件/eval/`，未跟踪）**

### Phase 4（Pattern B 复合工具）
1. [ ] `evaluate_readiness`（不含 injury_check）
2. [ ] `prepare_workout_context` + `commit_workout_plan`
3. [ ] `finalize_session`
4. [ ] `generate_report`（先 daily，后 weekly，最后 monthly + milestone + profile_review）

### Phase 5（独立立项：request_user_input 异步化）
1. [ ] 设计文档：pending_nodes 协议加 wait_user_input 节点类型
2. [ ] MCP server: request_user_input handler 重写（含 timeout + pending callback 清理）
3. [ ] MCP server: 4 个回调路径（开始/跳过/过一会儿/换一个）的 server 内代关闭逻辑
4. [ ] eval: 异步回调的 mock + timeout 分支测试

---

## 九、不要做的（来自避坑清单的硬性约束）

- **不要**留旧 `cli.js`（避坑 §1, §6）。本次改造同时删掉旧 CLI，避免诱导
- **不要**让 SKILL.md 和 docs 重复定义工具调用方式（避坑 §1）
- **不要**对一个工具半改半留——`record_signal` 上线后，`update_state(signals)+append_health_log` 旧路径必须关掉（在 schema description 里标 deprecated 还不够，handler 直接拒绝才稳）
- **不要**把 `child_process.spawn("openclaw", ["cron", ...])` 和"让模型 exec 旧 CLI"混为一谈（避坑 §1）
- **不要**承诺 bundle"零配置"（避坑 §3, §6）。新工具上线后 `.mcp.json` 必须更新 tool list
- **不要**eval 验证通过就认为生产稳定——request_user_input 异步化、复合工具事务性都需要在生产路径单独压测（避坑 §2, §5）
- **不要**反复打补丁——这次发布是"重写"，每个工具的 handler 全新写，不在旧实现上加分支（避坑 §6）

---

## 十、风险与对冲

| 风险 | 对冲 |
|---|---|
| 复合工具失败时模型无法定位子步骤错 | server 必须返回 `{failed_step, rolled_back}`；eval 加错误注入用例验证模型能否处理 |
| 模型不读新 SKILL.md 直接调旧 update_state 多次 | 旧工具 schema description 加 `[DEPRECATED] 请改用 record_signal` 提示；handler 在 active_session/特定 patch key 模式下直接拒绝 |
| Pattern B 模型创作内容质量下降 | A/B 测试：保留 1 个场景跑旧路径作对照，比较 narrative/plan 质量 |
| state↔log 自动镜像导致历史数据双写 | 加 dry-run 开关，灰度期对比双写前后 health-log 结构差异 |
| Onboarding setup_onboarding 失败回滚不彻底 | server 实现里用文件级事务（写临时目录 → rename）；测试覆盖每一步失败注入 |
| request_user_input 异步化导致 watch 端协议改动 | 单独立项发布，与 Stage 1-3 解耦；watch 端 SSE 改动同步设计 |

---

## 十一、预期收益（量化）

| 场景 | 当前节点 | 改后节点 | 当前 tool 调用 | 改后 | tool 耗时占比 |
|---|---|---|---|---|---|
| Onboarding | 7-8 | 1 | 9 | 1 | -89% |
| Readiness | 3-5 | 1 | 5 | 2 | -60% |
| Workout-confirm | 6 | 2 | 8 | 4 | -50% |
| During-session 1.A 高 | 5 | 1 | 6 | 2 | -67% |
| During-session 1.A 低 | 4 | 1 | 5 | 2 | -60% |
| Post-session | 5 | 1 | 7 | 2 | -71% |
| Daily report | 3 | 1 | 5 | 2 | -60% |
| Weekly/Monthly report | 3-4 | 1-2 | 5-6 | 2-3 | -50% |
| Anomaly 7.A | 6 | 1 | 7 | 2 | -71% |
| Chat | 2 | 1 | 3 | 2 | -33% |
| Rest day | 4 | 1 | 5 | 2 | -60% |

**整体**：tool 调用次数下降 50-70%，长场景（onboarding/reports）耗时下降 70-90%，输入 token 下降 60-80%，输出 token 下降 40-60%。
