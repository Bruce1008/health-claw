# reminders 处理

`read_state` 返回的 `reminders` 数组由 MCP Server 自动维护。reminders **不是阻断信号**——不要因为存在 reminder 就跳过本来要做的事，按下表在当前场景的合适位置补一句询问即可。

## `injury_check`

**触发条件**：`profile.injuries` 中存在 `status = "active"` 且 `next_check_at ≤ 今天` 的伤病（缺 `next_check_at` 时回退为 `reported_at + 14 天`）。

**处理**：在当前场景合适位置插入一句"你之前提到的 X 部位现在怎么样了？"——**问一次，不追问细节**。按用户回答更新对应 injury：

| 用户回答 | `status` | 其他变更 |
|---|---|---|
| "好了" / 已恢复 | `recovered` | 往 `training_state.pending_adjustments` 追加一条 `injury_recovery` |
| "快好了" / 好转中 | 保持 `active` | `next_check_at` → `今天 + 7 天` |
| "还没好" / 仍疼 | 保持 `active` | `reported_at` 重置为今天，`next_check_at` → `今天 + 14 天` |
| "老毛病" / 长期 | `chronic` | 不再产生 injury_check |

写入时遵守 SKILL.md §5 的数组字段整体替换规则（`profile.injuries` 必须传完整数组）。

## `profile_review`

**触发条件**：`profile._meta.goal_updated_at` 或 `fitness_level_updated_at` 距今 ≥ 30 天。

**处理**：**只在月报场景处理**。其他场景遇到此 reminder 一律忽略，等到月报触发时再统一复查。
