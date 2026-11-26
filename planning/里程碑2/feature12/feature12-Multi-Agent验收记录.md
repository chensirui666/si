# 里程碑 2 Feature 12 Multi-Agent 验收记录

日期为 2026-11-26。验收基线从 `main` 的 `65b2d27` 建立，包含 Feature 10 的待发、插话与反问。每项场景对应 [验收标准](feature12-Multi-Agent验收标准.md)。

## 受控验收

| 案例 | 入口与证据 |
| --- | --- |
| 01–09 | 通过实际 HTTP 和 WebSocket 核对角色摘要、模型与工具选择、同名优先级、授权变更、指定目录及实际读写指南。 [角色集成测试](../../../packages/server/test/subagent-roles-webserver.test.ts) |
| 10–14、18–20、25–26、28–33、35–37、42–44 | 通过实际服务与受控流式模型核对独立会话、调用位置、并行与串行、并发边界、父子归属、等待与回填。 [前台入口测试](../../../packages/server/test/collaboration-webserver.test.ts) · [调度与协作测试](../../../packages/server/test/subagent-coordination-webserver.test.ts) |
| 15–17、21–24、38 | 控制接单和工具阶段，核对原会话续用、并发接单、停止中的拒绝、未交付的插话及方案审核门槛。 [接单与插话测试](../../../packages/server/test/subagent-admission-webserver.test.ts) |
| 34 | 用持久化会话重复投递同编号插话，检查回执、实际模型输入和 SQLite。 [会话输入测试](../../../packages/coding-agent/test/collaboration.test.ts) |
| 27、39–41、45 | 从真实 Chromium 聊天入口核对用户答复后的续用、原调用的后台输出、刷新恢复、单独停止和会话级停止。45 同时核对实际 Bash 进程退出及另一个聊天继续。 [网页端到端](../../../web/tests/e2e/subagent-tasks.spec.ts) |
| 46–49 | 在 Chromium 组件测试中核对 Tab、点击、首词匹配与普通正文提交，包含输入法确认。 [聊天页组件测试](../../../web/src/pages/ChatPage.browser.test.tsx) |
| 50–58 | 使用实际服务、SQLite 和 Bash 验证空闲或有工作在途时的停止、报告分流及进程重启。56 和 57 使用独立进程退出。58 在停机的数据库中重建接收已提交而发送未确认的窗口。 [恢复与停止测试](../../../packages/server/test/subagent-recovery-webserver.test.ts) |

额外回归覆盖主会话改为只读后的在途工具和续用工具，普通停止前的报告遇到收尾中新报告时的投递顺序，在下一次模型请求的上下文 Hook 内停止时的插话状态，以及项目角色撤权期间保留其报告、重新授权后只交付一次。

## 真实模型验收

使用真实 Chromium、DeepSeek Flash `deepseek-flash` 和临时工作区。凭据文件路径由用户提供。

- **59** 通过。主 Agent 读取应用指南，写入个人角色文件，按该角色委派。子会话读取测试材料，主 Agent 根据回填继续同一个子会话并使用它的结论。
- **60** 通过。主 Agent 前台并行派发侦查与审查，侦查通过实际 `team.list` 和 `team.steer` 找到审查会话并交付独有标记。审查在原轮使用标记，两个结果回填到主 Agent 的原委派调用。 [真实模型端到端脚本](../../../web/tests/e2e/subagent-tasks.live.spec.ts)

## 主干合并前复跑

在 Feature 12 合并候选上重新执行全仓受控回归、两项真实模型案例和 OAuth 身份文档测试。58 项受控案例与 2 项真实模型案例均通过。

- 根 `npm test` 退出码为 0。后端各包 790 项，网页单元 162 项，Chromium 组件 100 项，Node 和 Vite 端到端 63 项，共 1,115 项通过。默认跳过 23 项依赖外部服务的用例，其中 Feature 12 的 2 项已使用 `DEEPSEEK_LIVE_KEY_FILE` 单独启用并通过。
- `node --test deploy/mcp-client-identity/oauth.test.mjs` 通过 1 项。
- `git diff --check` 通过。
