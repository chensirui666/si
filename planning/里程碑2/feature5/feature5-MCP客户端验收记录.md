# 里程碑 2 Feature 5 MCP 客户端验收记录

## 开关与后台恢复改造验收

`npm test` 通过 845 项受控测试。后端 553 项、网页单元 159 项、Chromium 组件 87 项、端到端 46 项。全量命令跳过 18 项需要真实服务或凭据的用例。最终界面复跑了全部网页测试和 3 项 MCP Chromium 端到端测试，公开身份文件测试也通过。

Chromium 核对了双标签页的开关同步、三点菜单、工具列表、DCR 自动打开和 CIMD 弹窗受阻入口。受控服务断开后，后端在下一次工具调用前发起恢复。恢复期间开关保持开启。重试耗尽后关闭并撤下工具。远端结果未知的调用只回填一次，后台恢复连接不会重发该调用。

真实 DeepWiki 验证了保存关闭、发现工具后开启和停用撤下工具。GitHub 只读端点与 DeepSeek 重新通过 Issue 读取，标题、状态和链接均与 GitHub API 一致。[GitHub Issue](https://github.com/github/github-mcp-server/issues/1)

真实 Notion 端点验证了从开关准备授权、选用 SI 公开身份和匹配实际回环地址，随后在设置取消。这轮复查停在账号同意授权之前。此前的真实授权和页面读取见下方记录。

## 受控验证

`npm test` 通过。后端 543 项、网页单元 158 项、Chromium 组件 86 项、端到端 45 项。根命令默认跳过 18 项需要真实服务或凭据的用例。

| 验收项 | 校验入口与核对结果 |
| --- | --- |
| 01–07 配置与首次连接 | 模拟远端确认保存时零请求、工具发现完成才显示连接成功、改名保留连接。注入两类文件提交失败和清理失败，核对原凭据引用及重启清理。 |
| 08–13 启动恢复和全局管理 | 真实本机 HTTP 模拟服务核对启动恢复范围、全局撤下旧工具、重新启用、重连时停用、删除后重启和设置写入失败。 |
| 14–20 OAuth | 协议测试覆盖四种客户端身份和令牌端点重定向。Chromium 从设置打开模拟授权页，回环回调只兑换一次，两个标签页都收到状态变化。后端测试覆盖错误回调、取消、凭据写入失败、工具发现失败和刷新。 |
| 21–27 工具调用和恢复 | 正式网页入口与受控模型核对实际 MCP 调用和原编号回填。后端覆盖权限变化、明确失败、已发出结果未知、共享重连、工具参数变化和会话过期的单次重试。 |

[设置与存储测试](../../../packages/coding-agent/test/mcp-settings.test.ts) · [运行管理测试](../../../packages/coding-agent/test/mcp-manager.test.ts) · [协议测试](../../../packages/mcp/test/) · [浏览器端到端](../../../web/tests/e2e/mcp.spec.ts)

## 真实服务验证

- 28、29 已通过。GitHub 官方 Issues 只读端点返回 6 个工具。DeepSeek 从正式网页调用 `mcp__github__issue_read`，回填与最终回复均核对出 Issue 标题 `Port CLI Server`、状态 `closed` 和原链接。 [调用证据](evidence/github-mcp-live.json) · [GitHub Issue](https://github.com/github/github-mcp-server/issues/1)
- 30 已通过。Notion 通过动态登记完成浏览器授权，回环回调后成功发现工具。DeepSeek 实际调用 `mcp__notion__notion_fetch` 读取「一些想法」，工具回填和最终回复均核对出页面标题和链接。GitHub 与 Notion 同时启用时，系统估算该次模型请求的工具声明占 61,405 tokens，包含内置工具。 [调用证据](evidence/notion-mcp-live.json)

## 本次实现取舍

协议包复用固定版本的 Pi 客户端，并限制认证请求的目标和重定向。线上协商支持 MCP `2025-11-25` 及更早版本。最初的 Notion 验收使用动态登记。公开身份文件接入后的验收见下节。所有真实验证使用独立临时配置，测试报告只保留协议和任务的必要字段。

## 公开身份文件验收

SI 默认使用 Vercel 生产域名提供的公开客户端身份。通用地址和带服务标识的地址均返回 HTTP 200、规范的 JSON 和对应的回环回调地址。格式错误的服务标识返回 404。[公开身份文件](https://si-mcp-identity.vercel.app/oauth/client.json)

从全新临时配置通过正式网页连接 Notion。浏览器实际发给 Notion 的 `client_id` 是 SI 生产身份文件的 URL。浏览器回调进入实际监听端口，Notion 换令牌返回 HTTP 200，动态登记请求为 0 次。工具发现后，DeepSeek 调用了 `mcp__notion__notion_fetch`，工具回填与最终回复均核对出「一些想法」的标题和链接。[脱敏验收证据](evidence/notion-mcp-cimd-live.json)

受控测试核对已有登记继续优先、CIMD 回调与历史回调分开、支持或缺少签发者校验时选择不同的回调路径、换令牌与续期都沿用相同的公开身份。浏览器集成分别通过 DCR 和 CIMD 流程。已使用生产域名在 Notion 真验，服务专属文件路径的验收使用受控授权服务和生产 HTTP 请求。
