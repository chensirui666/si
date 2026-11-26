# `messages` 消息

一行代表一条已持久化的消息。用户消息、助手回复和工具结果沿着同一会话的消息顺序保存，用于重建对话。

## 运行案例

用户发送「请建议怎么按拍摄日期归档照片」，助手直接回复「可以按年和月建文件夹」。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 服务端接收用户提交时 | 新增一条 `data.message.role = 'user'` 的消息，正文是用户的原话。这条消息和 [`runs`](runs.md) 的运行记录一起保存。 |
| 服务端保存助手的完整回复时 | 新增一条 `data.message.role = 'assistant'` 的消息，内容块存放回答的文字。两条消息使用相同的 `run_id`，各自有独立的 `id`。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `seq` | `INTEGER` | 否 | PK，插入时由 SQLite 分配 | 消息的插入顺序，恢复历史时按它读取。 |
| `session_id` | `TEXT` | 否 | 与 `run_id` 组成 FK → `runs(session_id, id)` | 消息所属会话。 |
| `run_id` | `TEXT` | 否 | 与 `session_id` 组成上述 FK | 产生该消息的运行 ID。应用只接受聊天任务（`task`）的消息。 |
| `id` | `TEXT` | 否 | 与 `session_id` 组成 UNIQUE | 会话内的消息 ID，与 `data.id` 一致。每次聊天任务首条用户消息的 ID 等于运行 ID。 |
| `data` | `TEXT` | 否 | 合法 JSON | 完整消息记录，结构为 `ConversationMessage`。 |

## `data` 的内容

| JSON 字段 | 含义与应用规则 |
| --- | --- |
| `id`、`clientMessageId` | 消息 ID。用户提交产生的首条消息还保存本次提交 ID。 |
| `message` | 正文及角色。用户消息保存输入，助手消息保存文本、思考和工具调用等内容块，工具结果保存工具名、调用 ID、结果及错误标记。时间 `timestamp` 使用 Unix 毫秒。 |
| `toolCall`、`toolErrorCode` | 工具结果通过 `assistantMessageId` 和 `contentIndex` 指向同一次运行中之前保存的工具调用。还可保存实际参数与工具错误码。 |
| `imageOmitted` | 工具结果含图片时，写入库前保留文本块，并设此值为 `true`。 |
| `skillInvocation`、`extension` | 可选。分别保存用户调用 Skill 的信息和扩展插入消息的来源信息。 |
| `attachments`、`references` | 可选。分别保存附件元数据和其他会话的引用摘录及快照信息。 |
| `fileOperation` | 可选。记录本条消息涉及的文件路径，以及读取（`read`）或修改（`modified`）类型。 |

[表定义与恢复校验](../../packages/coding-agent/src/session-store.ts#L114) · [消息结构](../../packages/coding-agent/src/types.ts#L20) · [各角色的消息结构](../../packages/model/src/types.ts#L5)
