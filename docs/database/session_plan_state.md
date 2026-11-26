# `session_plan_state` 计划模式状态

一行保存会话当前的计划模式状态。打开计划模式后会进入规划，生成可供确认的方案后会进入待确认状态。

## 运行案例

用户在一个已保存、尚未开启计划模式的会话里发送 `/plan`，然后请助手列出照片归档步骤。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 服务端处理 `/plan`、开启计划模式时 | 按 `session_id` 新增一行，`state` 为 `planning`，`assistant_message_id` 和 `steps` 都为空。 |
| 规划任务完成，助手给出可确认的方案时 | 更新同一行，把 `state` 改为 `review`，写入方案消息的 ID 和步骤数组，例如 `["读取拍摄日期","按年月归档"]`。 |
| 用户确认方案，执行任务被接收时 | 删除这条待确认状态。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `session_id` | `TEXT` | 否 | PK，FK → `sessions.id` | 状态所属会话。每个会话最多一行。 |
| `state` | `TEXT` | 否 | `planning` 要求 `assistant_message_id` 与 `steps` 同时为 `NULL`，`review` 要求两列同时有值 | `planning` 表示正在规划，`review` 表示等待用户确认方案。 |
| `assistant_message_id` | `TEXT` | 是 | 与 `session_id` 组成 FK → `messages(session_id, id)` | 待确认方案来自哪条消息。恢复时要求它属于已完成运行，且是正常结束的助手回复。 |
| `steps` | `TEXT` | 是 | 有值时为合法 JSON | 待确认的计划步骤。恢复时要求为非空字符串数组，每一项去掉首尾空白后仍须有内容。 |

## 写入规则

退出计划模式或确认执行后，应用删除这一行。会话缺少此行时按无计划状态读取。

[表定义](../../packages/coding-agent/src/session-store.ts#L134) · [状态恢复](../../packages/coding-agent/src/session-store.ts#L681) · [计划确认入口](../../packages/coding-agent/src/agent-session.ts#L389)
