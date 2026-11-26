# `schedules` 定时任务计划

一行定义一条定时任务要做什么、何时触发，以及触发时在哪个会话执行。实际发生的每次触发另存于 [`scheduled_runs`](scheduled_runs.md)。

## 运行案例

用户在会话里请助手「每天早上 9 点检查新照片，并发一份清单」。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 助手调用定时任务工具，成功创建计划时 | 新增一行。任务文本写入 `prompt`，每天 9 点写为 `schedule_rule = {"kind":"daily","time":"09:00"}`。计划状态为 `enabled`，同时按计划时区算出 `next_run_at`。 |
| 用户随后暂停计划时 | 更新同一行，把 `status` 改为 `paused`，把 `next_run_at` 清空。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | 否 | PK | 定时任务计划 ID，创建时生成 UUID。 |
| `session_id` | `TEXT` | 否 | FK → `sessions.id`，与 `creation_run_id` 组成 UNIQUE。未删除计划按此列唯一 | 创建并管理该计划的原始会话 ID。 |
| `creation_run_id` | `TEXT` | 否 | 与 `session_id` 组成 UNIQUE | 创建计划的运行 ID。应用将该组合用于识别重试。 |
| `workspace_id` | `TEXT` | 否 | — | 计划所属的工作区。创建时核对它与所属会话的工作区一致。 |
| `prompt` | `TEXT` | 否 | — | 触发时提交的任务文本。入口要求去掉首尾空白后非空，原长度不超过 32,000。 |
| `schedule_rule` | `TEXT` | 否 | 合法 JSON | 重复规则和本地时间，格式见下方。 |
| `timezone` | `TEXT` | 否 | — | 创建时取服务进程的时区名称，例如 `Asia/Shanghai`，用于计算下一次触发。 |
| `session_mode` | `TEXT` | 否 | 仅允许 `reuse` 或 `new` | `reuse` 复用原会话，`new` 每次触发使用新会话。创建时为 `reuse`。 |
| `status` | `TEXT` | 否 | 仅允许 `enabled` 或 `paused` | 表示启用或暂停。创建时为 `enabled`。是否删除另看 `deleted`。 |
| `next_run_at` | `INTEGER` | 是 | 当且仅当 `deleted = 0` 且 `status = 'enabled'` 时有值 | 下一次触发时间，单位为 Unix 毫秒。 |
| `deleted` | `INTEGER` | 否 | 默认 `0`，仅允许 `0` 或 `1` | `0` 表示仍保留为当前计划，`1` 表示已删除。删除通过标记保留原计划和触发历史。 |

## `schedule_rule` 的内容

| 字段或取值 | 含义与应用规则 |
| --- | --- |
| `kind: daily` | 每天。 |
| `kind: weekdays` | 周一到周五。 |
| `kind: weekly` | 每周指定星期几，需要提供 `weekdays`。 |
| `time` | 本地 24 小时制时间，格式为 `HH:mm`，范围为 `00:00` 到 `23:59`。 |
| `weekdays` | 仅用于 `weekly`。至少一项，周一为 `1`，周日为 `7`。写入前去重并升序排列。 |

## 索引

- `schedules_active_session` 对 `deleted = 0` 的行按 `session_id` 保证唯一，暂停中的计划也占用这个位置。
- `schedules_due` 为存在下次触发时间的行按 `next_run_at` 建索引，供定时扫描使用。

[表定义与索引](../../packages/coding-agent/src/schedule-store.ts#L47) · [创建与更新规则](../../packages/server/src/schedules.ts#L52) · [重复规则校验](../../packages/server/src/schedule-time.ts#L4)
