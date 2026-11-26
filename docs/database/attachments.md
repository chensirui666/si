# `attachments` 附件

一行保存一个已上传附件的名称、大小和归属。上传时附件属于已有会话或待发送的草稿，发送成功后再绑定到具体的用户消息。

## 运行案例

用户在已有会话中上传 `照片清单.csv`，然后发送「请检查这份清单」。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 文件上传成功，消息还没发送时 | 新增一行，`staged_session` 指向当前会话，`data` 保存文件名、大小等信息。`bound_session` 和 `bound_message` 此时都为空。 |
| 服务端接收带附件的消息时 | 更新同一行，写入实际的 `bound_session` 和 `bound_message`。这次更新和用户消息一起保存。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | 否 | PK | 上传时生成的 UUID，也是附件文件目录名。 |
| `staged_session` | `TEXT` | 是 | 有值时，`workspace_id`、`draft_id` 必须同时为 `NULL` | 上传时选择的已有会话 ID。服务端在上传入口检查这个会话。 |
| `workspace_id` | `TEXT` | 是 | 当 `staged_session` 为 `NULL` 时，与 `draft_id` 必须都有值 | 草稿所在的工作区 ID。 |
| `draft_id` | `TEXT` | 是 | 与 `workspace_id` 同时有值或同时为 `NULL` | 上传时所属的草稿会话 ID。上传入口要求草稿 ID 为 UUID。 |
| `uploaded_at` | `INTEGER` | 否 | — | 上传时间，单位为 Unix 毫秒。应用用它检查待发送附件是否已过 24 小时。 |
| `data` | `TEXT` | 否 | 合法 JSON | 附件元数据。包含 `id`、`name`（文件名）、`mediaType`（PNG、JPEG、WebP 或纯文本的 MIME 类型）及 `size`（原文件字节数）。 |
| `bound_session` | `TEXT` | 是 | FK → `sessions.id`，与 `bound_message` 同时有值或同时为 `NULL` | 发送后附件实际归属的会话 ID。 |
| `bound_message` | `TEXT` | 是 | 与 `bound_session` 组成 FK → `messages(session_id, id)` | 发送该附件的用户消息 ID。 |

## 文件和生命周期

- 原文件保存在 `<数据库路径>.files/attachments/<id>/original`。图片上传时还会写入供模型读取的 `model` 文件。
- 发送时核对原始归属、有效期和未绑定状态，并在保存用户消息的同一事务里写入绑定。未绑定附件满 24 小时后可被清理。

[表定义及绑定](../../packages/coding-agent/src/session-store.ts#L90) · [上传与文件存储](../../packages/coding-agent/src/session-attachments.ts#L43) · [上传入口](../../packages/server/src/webserver/index.ts#L751)
