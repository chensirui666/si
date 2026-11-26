# `compactions` 上下文压缩

一行代表一次把较早对话整理成摘要的尝试。应用保留压缩进度和结果，成功时可用摘要和保留的消息构造后续模型上下文。

## 运行案例

照片归档的对话已经很长。用户在已有会话中发送 `/compact`，让应用总结较早的对话。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 服务端接收 `/compact` 时 | 新增一行，记录 `data.trigger = 'manual'`、`data.status = 'running'` 和开始时间，同时创建对应的手动压缩运行。 |
| 应用成功生成摘要时 | 更新同一行，把 `data.status` 改为 `success`，保存摘要、第一条保留消息的 ID，以及压缩前后估计需要发给模型的内容量。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `seq` | `INTEGER` | 否 | PK，插入时由 SQLite 分配 | 压缩记录的插入顺序。 |
| `session_id` | `TEXT` | 否 | 与 `run_id` 组成 FK → `runs(session_id, id)` | 发生压缩的会话。 |
| `run_id` | `TEXT` | 否 | 与 `session_id` 组成上述 FK | 宿主运行 ID。手动压缩有独立的 `compaction` 运行，自动或溢出压缩挂在已有的 `task` 运行上。 |
| `id` | `TEXT` | 否 | 与 `session_id` 组成 UNIQUE | 压缩记录 ID，与 `data.id` 一致。手动压缩时也作为运行 ID。 |
| `data` | `TEXT` | 否 | 合法 JSON | 压缩的触发来源、状态和结果，结构为 `CompactionRecord`。同一次尝试更新原来的记录。 |

## `data` 的内容

| JSON 字段 | 含义与应用规则 |
| --- | --- |
| `id`、`clientMessageId` | 压缩 ID。手动压缩还会保存运行中的提交 ID。 |
| `trigger` | `manual` 用户主动请求，`auto` 自动触发，`overflow` 模型上下文超限时触发。 |
| `status`、`reason` | 可从库中恢复的状态为 `running`、`success`、`failed`、`aborted`、`skipped`。失败、中止和跳过时要求原因。恢复会话时，仍在运行的压缩在内存中显示为 `interrupted`。 |
| `startedAt`、`finishedAt` | 开始及结束时间，单位为 Unix 毫秒。结束状态要求 `finishedAt`。 |
| `summary`、`estimatedBefore`、`estimatedAfter` | 成功时保存非空摘要与压缩前后的估算 token 数。压缩后估算须非负且小于压缩前。 |
| `firstKeptMessageId`、`contextLastMessageId` | 成功时保存保留内容的起始消息和压缩时上下文的末条消息。两条消息须存在于同一会话，起始消息须为用户或助手消息，顺序由应用校验。 |
| `followupMessageId` | 可选。可用于查看压缩后实际输入量的后续助手消息。若存在，须排在压缩范围之后，并附有有效的输入 token 数。 |
| `summaryUsage`、`fileOperations` | 可选。摘要生成的 token 用量，以及压缩中汇总的已读或已改文件列表。 |

[表定义与恢复校验](../../packages/coding-agent/src/session-store.ts#L125) · [压缩记录结构](../../packages/coding-agent/src/types.ts#L67) · [会话恢复](../../packages/coding-agent/src/agent-session.ts#L153)
