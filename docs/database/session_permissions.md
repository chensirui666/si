# `session_permissions` 会话权限

一行保存会话当前的工具权限模式。应用恢复历史时读取该模式，并在执行工具前检查权限。

## 运行案例

用户想先让助手查看照片目录，于是把会话从普通模式切换为只读。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 服务端接受会话权限的修改时 | 按 `session_id` 更新这行，把 `mode` 从 `normal` 改为 `read-only`。如果旧会话缺少权限记录，就新增一行。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `session_id` | `TEXT` | 否 | PK，FK → `sessions.id` | 权限所属会话。每个会话最多一行。 |
| `mode` | `TEXT` | 否 | 仅允许 `normal` 或 `read-only` | `normal` 为普通模式，`read-only` 将工具限制在允许的只读范围内。缺少记录时按 `normal` 恢复。 |

[表定义](../../packages/coding-agent/src/session-store.ts#L105) · [权限恢复](../../packages/coding-agent/src/session-store.ts#L678) · [工具权限检查](../../packages/coding-agent/src/agent-session.ts#L345)
