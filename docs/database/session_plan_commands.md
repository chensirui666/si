# `session_plan_commands` 计划模式指令

一行记录一次由应用直接处理的 `/plan` 或 `/plan off` 提交。服务重启后可用这条记录识别同一指令的重试。

## 运行案例

用户在已有会话中发送 `/plan`，开启计划模式。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 服务端处理指令时 | 新增一行，保存 `session_id`、本次提交的 `client_id`，以及包含 `text = '/plan'` 的原始提交。这一行和 [`session_plan_state`](session_plan_state.md) 的状态变更一起保存。 |

同一条提交因断线而重发时，应用按原提交 ID 读取已保存的指令，返回同一次处理结果。

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `session_id` | `TEXT` | 否 | 与 `client_id` 组成 PK，FK → `sessions.id` | 指令作用的会话。 |
| `client_id` | `TEXT` | 否 | 与 `session_id` 组成 PK | 客户端提交 ID。与 `data.clientMessageId` 一致。 |
| `data` | `TEXT` | 否 | 合法 JSON | 原始 `SubmissionInput`。恢复时核对提交 ID、模型 ID，以及 `text` 能否解析为 `/plan` 或 `/plan off`。 |

## 写入规则

- 应用直接处理这两条指令，并将指令记录和本次引发的状态更新放在同一事务里。
- 带任务内容的 `/plan <任务>` 走普通运行的写入流程，任务记录见 [`runs`](runs.md)。

[表定义](../../packages/coding-agent/src/session-store.ts#L130) · [指令恢复校验](../../packages/coding-agent/src/session-store.ts#L693) · [指令处理](../../packages/coding-agent/src/agent-session.ts#L666)
