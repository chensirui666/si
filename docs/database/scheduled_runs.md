# `scheduled_runs` 定时任务触发

一行代表一条定时任务到达某个预定时间后的触发记录。先记录待提交的任务，服务接收后再连到实际的 [`runs`](runs.md) 记录。

## 运行案例

到了计划时区的早上 9 点后，后台调度器在扫描计划时发现「检查新照片，并发一份清单」这次任务已经到点。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 调度器发现计划到点，领取这次触发时 | 新增一行，`status` 为 `pending`，保存计划 ID、预定触发时间 `scheduled_at`、实际领取时间 `claimed_at` 和待提交内容。 |
| 调度器准备提交时 | 更新同一行，补齐模型和权限设置，把 `status` 改为 `submitting`。 |
| 会话成功接收这次任务时 | 把 `status` 改为 `accepted`，写入实际接收的 `session_id` 和 `run_id`。助手回答的完成状态随后由运行记录保存。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | 否 | PK | 触发 ID，生成 UUID，提交时也用作 `runs.client_id`。 |
| `schedule_id` | `TEXT` | 否 | FK → `schedules.id`，与 `scheduled_at` 组成 UNIQUE | 产生这次触发的计划 ID。 |
| `scheduled_at` | `INTEGER` | 否 | 与 `schedule_id` 组成 UNIQUE | 预定触发时间，单位为 Unix 毫秒。同一计划同一时刻最多记录一次。 |
| `claimed_at` | `INTEGER` | 否 | — | 调度器实际领取这次触发的时间，单位为 Unix 毫秒。 |
| `status` | `TEXT` | 否 | 允许下表的六种状态。只有 `accepted` 要求关联到运行 | 该触发在调度和提交过程中的状态。 |
| `reason` | `TEXT` | 是 | — | 跳过、失败或未能确认提交时记录的原因。 |
| `submission` | `TEXT` | 是 | 有值时为合法 JSON | 待提交内容的快照。创建时含 `workspaceId`、`sessionId` 和 `text`，进入提交阶段时补齐 `modelSelection` 和 `permissionMode`。 |
| `session_id` | `TEXT` | 是 | 与 `run_id` 同时有值或同时为 `NULL`，组成 FK → `runs(session_id, id)` | 实际接收任务的会话 ID，可能与计划所属会话不同。 |
| `run_id` | `TEXT` | 是 | 与 `session_id` 组成上述 FK，且仅 `accepted` 时有值 | 服务接收后创建的运行 ID。 |

## 状态

| 值 | 含义 |
| --- | --- |
| `pending` | 已领取，等待提交。 |
| `submitting` | 已补齐提交所需设置，正在向会话提交。 |
| `accepted` | 会话已持久化接收，能通过外键查到实际运行。运行是否完成记录在 `runs.data.status`。 |
| `skipped` | 本次触发已跳过，例如上一轮尚未结束，或计划已暂停。 |
| `failed` | 准备或提交发生明确失败。 |
| `unknown` | 提交发生异常，结果待核对。恢复时应用检查是否留下已接收的运行记录。 |

[表定义及状态更新](../../packages/coding-agent/src/schedule-store.ts#L59) · [领取与接收流程](../../packages/server/src/schedule-runner.ts#L51)
