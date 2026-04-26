# scene: onboarding

> 触发：收到 `请使用 skill:health-claw 完成 onboarding` 开头的 bulk prompt（来源于 App 前端表单提交）。

> **Phase 3 复合工具**：本场景全部步骤合并到 `setup_onboarding(bulk)` 1 次调用——server 内部按序写 profile/user_state/training_state、建 cron x3-4、拉 health_summary、show_report、finish_scene。任一步失败原子回滚。
>
> **Eval / 性能 note**：onboarding 现在仅 1 次模型 tool 调用（setup_onboarding），实际内部跑 7-8 步。eval 环境跑本 stage 前 `export SEND_TIMEOUT=900`（cron 创建串行慢）。

## pending_nodes 清单

`read_state` 后只声明 1 个节点：

```json
[
  {"id":"s1_setup_onboarding","tool":"setup_onboarding"}
]
```

硬规则：

- 所有 cron 都由 `setup_onboarding` 内部按 `bulk.reminder_mode` 决定数量（3 个或 4 个）；**不得**直接写 cron 配置文件，也不要再手动 `schedule_recurring`。
- 已初始化（profile.basic_info.age 存在）→ server 自动返回 `{ok:true, skipped:true, reason:"already_initialized"}` 并 `finish_scene(skipped)`；模型不再需要前置检查。
- 任一步失败 → server 自动 cancel 已建 cron + 清空 profile + finish_scene(error)，返回 `{ok:false, failed_step, rolled_back:true, cron_cancelled:[...]}`。模型只需读 `failed_step` 决定是否提示用户重试。

## 核心原则：一次性 bulk，无交互

**App 前端把所有 onboarding 字段一次性打包成 JSON 随第一条 prompt 送达**，本场景从开始到结束**不与用户做任何一问一答**。整个场景就是把 bulk payload 翻译成 `update_state` + `schedule_recurring` 调用。

- **禁用 `request_user_input`**——onboarding 阶段字段已在前端收齐
- **不追问缺失字段**——前端已校验 Q1/Q2/Q3/Q8/Q9 必填；payload 里如果缺选填字段，按 §"几个特殊细节"的默认值兜底
- **不向用户建议修改**——不评论用户填的 goal / fitness_level / reminder_mode

这意味着失败回滚也不需要和用户对话——全部靠 SSE 错误事件把状态还给前端，让前端重新触发 onboarding。

## Step 0：防重复 onboarding

调用 `read_state`：

- 若 `profile.basic_info.age` 已存在 → onboarding 已经完成过。直接进 Step 1（`setup_onboarding` 内部会自动检测 + 返回 `skipped`）。
- 若 `profile` 为空 → 进 Step 1。

## Step 1：调 `setup_onboarding(bulk)` —— 一次性走完全部

```
setup_onboarding({
  bulk: {
    basic_info: { age: <Q1>, gender: <Q2 映射: male|female|unspecified>, height_cm?, weight_kg? },
    fitness_level: <Q3: beginner|intermediate|advanced>,
    goal: <Q4 或默认 "保持健康、规律运动">,
    preferences: {
      preferred_types: <Q5 数组 或 []>,
      available_equipment: <Q6 数组 或 ["自重"]>,
      training_time: <Q7 或 "不固定">,
      reminder_mode: <Q9: scheduled|proactive>,
      reminder_time: <Q9a: "HH:MM" 或 不传>,
      weekly_report_time: <Q10 或 "Sun 20:00">
    },
    injuries: <数组; 见本文件"几个特殊细节"的 injuries 映射规则>,
    reminder_mode: <Q9>,
    reminder_time: <Q9a>,
    weekly_report_time: <Q10>,
    readiness: {
      // 模型预先填好的 4 维度评估（基于无历史数据 → 全 green）
      overall: "available",
      dimensions: {
        physical_readiness: { level: "green", detail: "首次评估，按 baseline 处理" },
        stress_load: { level: "green", detail: "无历史数据" },
        recovery_status: { level: "green", detail: "无历史数据" },
        activity_context: { level: "green", detail: "无历史数据" }
      },
      suggestions: ["按 fitness_level 起步训练，几次后再校准"]
    }
  }
})
```

**Server 自动按序执行**（**模型不需要再调下面任何工具**）：

1. 防重复：`profile.basic_info.age` 已存在 → 返回 `{ok:true, skipped:true, reason:"already_initialized"}`
2. `update_state` 写 user_state + profile + training_state（**alert_hr 自动算并写入**；profile_update 事件自动 append 到 health-log）
3. `schedule_recurring x3` 必建 daily_report / weekly_report / monthly_report
4. **条件**：`reminder_mode == "scheduled"` 时再 `schedule_recurring(daily_workout_reminder)`，cron 由 `reminder_time HH:MM` 自动拼成 `MM HH * * *`
5. `get_health_summary` 拉昨晚睡眠/HRV/静息心率（仅供未来用，模型不需要 review）
6. `show_report({report_type:"readiness_assessment", data: <bulk.readiness>})`
7. `finish_scene({name:"onboarding", status:"done", summary, daily_log_content})`

**任一步失败**：自动回滚——cancel 已建 cron + 清空 profile/user_state + finish_scene(error)，返回 `{ok:false, failed_step:"<step>", error, rolled_back:true, cron_cancelled:[...]}`。

## Step 2：成功后向用户说一句话

`setup_onboarding` 返回成功后，用自然语言对用户说一句简短欢迎 + 解释接下来能用本 skill 做什么（"今晚 22:00 我会发第一份日报""周日 20:00 周报"……）。

如果 `bulk.reminder_mode == "scheduled"`，补一句"明天 <reminder_time> 我会主动提醒你训练"。

**不要劝说**用户改 reminder_mode，**不要评价**用户的 goal。

**Q10 字符串到 cron 的映射**（仅供构造 bulk 时参考，server 内部按此规则转换）：

| Q10 选项 | cron |
|---|---|
| `Sun 20:00` | `0 20 * * 0` |
| `Mon 08:00` | `0 8 * * 1` |
| `Fri 20:00` | `0 20 * * 5` |

---

## 失败回滚

`setup_onboarding` 自带原子回滚——**模型不需要自己实现**。任一内部步骤失败时 server 自动：

1. cancel 已建 cron（按创建顺序逆向）
2. clear profile/user_state
3. finish_scene(name:"onboarding", status:"error", summary 含 failed_step + 已回滚信息)

返回 `{ok:false, failed_step:"<step>", error, rolled_back:true, cron_cancelled:[<已建被回滚的 name 数组>]}`。

App 前端收到 SSE 错误事件后会让用户重新点"完成"触发一次新的 bulk prompt。**模型不要写"请重试"给用户**——交互在前端完成，本场景的职责到 last_scene = error 为止。

---

## 几个特殊细节

- **injuries 字段映射**：bulk prompt 里的 `injuries.type` 字段 → `injuries[].status`：`acute → active`，`chronic → chronic`，`none → 空数组`。`injuries[].reported_at` 全部设为 onboarding 当天。如果 `injuries.description` 含 `;` 或 `；`，可以拆成多条 injury，每条都有同样的 `reported_at` 和 `status`。
- **goal 兜底**：bulk prompt 中 goal 为空字符串时用 `"保持健康、规律运动"`。
- **`weekly_report_time` 是 "其他自定义"**：bulk prompt 里前端会传规范化后的 `<weekday> HH:MM` 字符串，按上面的映射规则转 cron 即可。
- **不创建 alert_hr**：`profile.alert_hr` 由 MCP Server 从 `basic_info.age` 用 `(220 - age)` 推出来（critical=95%, warning=90%），手动传的值会被覆盖。
