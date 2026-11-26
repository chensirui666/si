# `model_selections` 模型选择

一行保存一份模型选择。每个已保存的会话最多有一份独立选择，应用也可以保存一份默认选择。

## 运行案例

用户在已有会话里把模型切换为 `deepseek-flash`。

| 写入时机 | 这张表写入什么 |
| --- | --- |
| 服务端保存会话的模型选择时 | 写入以会话 ID 为 `scope` 的一行，`data.provider` 为 `deepseek`，`data.modelId` 为 `deepseek-flash`。如果该会话已经有选择记录，就更新原来的行。 |
| 同一次保存 | 也写入或更新默认选择行。该行的 `scope` 为空字符串，`session_id` 为 `NULL`。 |

## 字段

| 字段 | SQLite 类型 | 可空 | 数据库规则 | 含义与应用规则 |
| --- | --- | --- | --- | --- |
| `scope` | `TEXT` | 否 | PK，等于 `coalesce(session_id, '')` | 读取选择时用的键。会话选择使用会话 ID，默认选择使用空字符串。 |
| `session_id` | `TEXT` | 是 | FK → `sessions.id` | 会话选择对应的会话 ID。默认选择为 `NULL`。 |
| `data` | `TEXT` | 否 | 合法 JSON | `ModelSelection` 对象。包含非空字符串 `provider`（服务商）、`modelId`（模型 ID）和可选字符串 `reasoningEffort`（推理强度）。 |

## 写入规则

- 首次接收运行时，可以保存该会话的初始模型选择。
- 用户显式切换已有会话的模型时，同时更新会话选择和默认选择。为草稿切换模型时，更新默认选择。

[表定义与写入](../../packages/coding-agent/src/session-store.ts#L101) · [模型选择结构](../../packages/model/src/types.ts#L114) · [会话模型选择入口](../../packages/coding-agent/src/sessions.ts#L71)
