# `session_mcp_tool_loads` 会话加载的 MCP 工具

一行记录某个会话通过 `tool_search` 加载的一项远程工具，以及对应的工具结果消息。

## 运行案例

用户已经接入了提供资料查询工具的 MCP 服务，在会话中请助手查一下公司的照片归档规范。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 助手调用 `tool_search`，成功找到并加载该服务的 `search_docs` 工具时 | 新增一行，保存会话 ID、MCP 服务 ID、凭据引用和 `remote_tool_name = 'search_docs'`。`result_message_id` 指向这次工具搜索的结果消息，两条记录一起保存。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `session_id` | `TEXT` | 否 | 四列 PK 之一。与 `result_message_id` 组成 FK → `messages(session_id, id)` | 加载工具的会话。 |
| `server_id` | `TEXT` | 否 | 四列 PK 之一 | 远程工具所属的 MCP 服务 ID。 |
| `credential_ref` | `TEXT` | 否 | 四列 PK 之一 | MCP 服务使用的凭据引用标识，用于识别这次加载对应的配置。 |
| `remote_tool_name` | `TEXT` | 否 | 四列 PK 之一 | MCP 服务提供的原始工具名。 |
| `result_message_id` | `TEXT` | 否 | 与 `session_id` 组成上述 FK | 成功执行 `tool_search` 的工具结果消息 ID。一条结果可以对应多项工具。 |

## 写入规则

- 四列主键为 `(session_id, server_id, credential_ref, remote_tool_name)`。重复加载同一项时保留已有行。
- 工具加载记录和成功的工具结果消息一起提交。应用对照当前 MCP 工具目录清理已失效的加载记录。

[表定义与写入](../../packages/coding-agent/src/session-store.ts#L119) · [目录更新后的清理](../../packages/coding-agent/src/session-store.ts#L529) · [MCP 工具标识](../../packages/coding-agent/src/mcp/manager.ts#L59)
