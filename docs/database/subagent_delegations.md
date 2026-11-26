# 子 Agent 的会话与委派表

**变更来源**　里程碑 2 Feature 12 Multi-Agent。 [技术设计 §3.2](../../planning/里程碑2/feature12/feature12-Multi-Agent技术设计.md#32-委派子-agent-任务) · [建表代码](../../packages/coding-agent/src/subagent-store.ts#L5)

三张表与原有会话库共用一个 SQLite 文件。普通会话字段继续保存在 [`sessions`](sessions.md)，每轮任务和聊天消息沿用 [`runs`](runs.md) 和 [`messages`](messages.md)。将子会话元数据放入关联表，可以保留已有 `sessions` 行的结构。单独保存委派项，可以用 SQLite 外键约束每项所引用的运行，并逐项更新结果。

## subagent_sessions

每个子会话一行。`session_id` 是主键，`parent_session_id` 指向所属主会话，两者都引用 `sessions.id`。`data` 保存工作目录、工具配置和可选的角色快照。服务保存时检查两个会话属于同一工作区，且父方为主会话。 [关联与校验](../../packages/coding-agent/src/subagent-store.ts#L60)

## delegations

每次工具委派一行。`id` 是委派编号，`caller_session_id` 是发起会话，`root_session_id` 是任务归属的主会话。原调用由 `run_id`、`assistant_message_id`、`content_index` 和 `tool_call_id` 定位。同一发起会话中的相同消息位置只能建立一次委派。

`background` 记录等待方式，`mode` 保存单项、并行、串行或续用。结束后写入 `finished_at`。后台报告的 `report` 保存待送 `pending`、已确认接收 `delivered` 或抑制投递 `suppressed`。发起方按委派编号重试，接收方用同一编号去重。 [创建、收尾与补送](../../packages/coding-agent/src/subagent-store.ts#L73)

## delegation_items

委派中的每个任务一行，主键为 `(delegation_id, item_index)`。接单时由 `(session_id, run_id)` 关联实际运行。每项记录状态和结果或错误。同一项接单后保留原运行编号。

每项的终态和对应运行在同一个 SQLite 事务内保存。整批结束时，应用按项序号汇总结果。服务重启时，已完成的项保留结果，执行中的项标记为中断，未启动的项保留原状态。恢复还会继续处理待送报告。 [逐项写入与恢复](../../packages/coding-agent/src/subagent-store.ts#L96) · [Feature 12 验收记录](../../planning/里程碑2/feature12/feature12-Multi-Agent验收记录.md)
