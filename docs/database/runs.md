# `runs` 运行

一行代表服务已接收的一次聊天任务或手动压缩。运行开始时写入，后续更新同一行来保留运行结果。客户端重试时，应用可通过提交 ID 找回原有接收记录。

## 运行案例

用户在已有会话中发送「请建议怎么按拍摄日期归档照片」，助手正常完成回答。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 服务端接收提交、开始处理时 | 新增一行，保存 `session_id`、本次提交的 `client_id` 和首条用户消息的 ID。运行记录中的 `data.kind` 为 `task`，`data.status` 为 `running`。 |
| 助手正常答完，服务端保存结果时 | 更新同一行，把 `data.status` 改为 `completed` 并记录 `data.finishedAt`。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `seq` | `INTEGER` | 否 | PK，插入时由 SQLite 分配 | 运行记录的插入顺序，恢复会话时按它读取。 |
| `session_id` | `TEXT` | 否 | FK → `sessions.id` | 运行所属会话。与 `data.sessionId` 一致。 |
| `id` | `TEXT` | 否 | 与 `session_id` 组成 UNIQUE | 会话内的运行 ID。聊天任务沿用首条用户消息的 ID，手动压缩沿用压缩记录 ID。与 `data.id` 一致。 |
| `client_id` | `TEXT` | 否 | 与 `session_id` 组成 UNIQUE | 提交 ID，用于识别同一提交的重试。与 `data.clientMessageId` 一致。应用接收时要求去掉首尾空白后非空，且原长度不超过 128。 |
| `data` | `TEXT` | 否 | 合法 JSON | 完整运行记录，结构为 `StoredRun`。 |

## `data` 的内容

| JSON 字段 | 含义与应用规则 |
| --- | --- |
| `id`、`sessionId`、`clientMessageId` | 与表中的三个标识列一致。 |
| `kind` | `task` 为聊天任务，`compaction` 为手动压缩。 |
| `status` | `running`、`completed`、`failed` 或 `aborted`。有 `scheduledRunId` 的运行也可在重启恢复时持久化为 `interrupted`。 |
| `startedAt`、`finishedAt` | 开始及结束时间，单位为 Unix 毫秒。结束状态要求 `finishedAt`。 |
| `provider`、`modelId`、`reasoningEffort` | 运行使用的服务商、模型 ID 及可选推理强度。旧记录缺少 `provider` 时按 DeepSeek 和 `high` 恢复模型选择。 |
| `text`、`finalText` | 原始提交内容及实际提交内容。两者有差异时才附带 `finalText`。 |
| `acceptedSeq` | 提交被接收时的会话更新序号，须为正安全整数。 |
| `firstPermissionMode`、`firstTitle` | 首次接收时可保存初始权限和标题。 |
| `attachmentIds`、`referenceSessionIds` | 提交时可选的附件 ID 和引用会话 ID 列表。 |
| `approvedPlanId` | 可选。由确认计划发起的任务保存计划消息 ID，此时提交 ID 形如 `plan:<计划消息 ID>`。 |
| `scheduledRunId` | 可选。定时触发 ID，同时作为该任务的提交 ID。 |
| `openaiMode` | 可选。提交入口指定的 OpenAI 使用方式，取值为 `api-key` 或 `chatgpt`。 |

[表定义与恢复校验](../../packages/coding-agent/src/session-store.ts#L108) · [运行写入](../../packages/coding-agent/src/agent-session.ts#L1065)
