# Feature2 阶段三实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans，按以下任务实施并记录验收。

**Goal:** 从已合并的阶段二接通提交、真实模型流、实时展示和恢复，并完成阶段三验收。

**Architecture:** 沿用 `server → agent → model → credentials`。Model 提供一次调用的事件与同次结果；Agent 独立累积正式状态；Server 只接入与转发；网页按正式编号、临时编号和连续序号更新。

**Tech Stack:** TypeScript、原生 HTTP、ws、OpenAI SDK、React、Lexical、mdast/micromark GFM、Vitest、Playwright。

**Spec:** [阶段三设计](./feature2-阶段三-提交生成与实时展示.md)与[总体设计](./feature2-单会话流式聊天技术设计.md)。用户本轮明确要求继续实现文档定义的功能；本计划仅拆解既定方案。

## Global Constraints

- `deepseek-flash`，`thinking: { type: 'enabled' }`，`reasoning_effort: 'high'`，本阶段不传假工具定义。
- `maxRetries: 0`，无外层重试；连续五分钟无 SDK 模型数据才超时；finish reason 有效且尾部正常读完才成功。
- Model shared partial 不得直接成为 Agent 状态；订阅先监听再截独立快照，更新序号连续。
- 空白工具参数为 `{}`；其他参数严格 JSON 对象，不修复，错误保留原文与工具块。
- 用户原文完整保留；接收原子切换忙碌；失败 assistant 保留展示、排除后续上下文。
- 回执与 WS 任意先后只显示一个正式气泡；十秒未确认重取快照；不重试、不去重、不恢复已清空草稿。
- Markdown 按 GFM 安全展示，禁模型 HTML、脚本及危险链接；稳定前块冻结、尾部更新、终值重解析。
- 不改真实用户配置；真实模型 E2E 的 Key 从用户指定位置读取，复制到测试临时文件，证据不含 Key/令牌。

## Review Focus

- Model 生产领先 Agent 消费：快照不能提前含未来内容，片段不能重复。
- HTTP 接收后 WS 尚未追上：旧空闲状态不能提前放开发送。
- 先收到正式 user 后 HTTP 失败：不得把已接收气泡降级或恢复草稿。
- finish reason 后尾部失败、心跳但无 SDK 数据：仍须失败并释放运行。
- 生成中刷新、断线或多页面：使用同一生成状态，不取消或重跑模型。

## Task 1: Model 单次流

**Files:** `packages/model/src/{types,index,deepseek,event-stream,tool-arguments}.ts`、`packages/model/test/model-stream.test.ts`、Model README/package、根 lock。

**Interfaces:** `stream(model: ModelInfo, context: ModelContext, options?: {signal?: AbortSignal}): ModelEventStream`；实例化可注入 Credentials/SDK fetch 的最小工厂供 Server 共享凭据及受控 SDK 测试，公开默认函数保持设计签名。

- [x] 先写并运行失败测试，覆盖请求、三类块/事件、同次 result、五种终止、严格参数、当前 Key、超时、取消、缺失 finish 与尾部断流。
- [x] 参考 Pi 事件流与 OpenAI 适配实现最小版本；不复制其重试、usage 补零与宽松终止。
- [x] `npm --prefix packages/model test` 通过，并更新包说明。

## Task 2: Agent 与 Server

**Files:** `packages/agent/src/{agent,types,index}.ts`、Agent 测试与 README；`packages/server/src/webserver/{index,protocol}.ts`、Server 测试与 README。

**Interfaces:** `Agent.submit({clientMessageId,modelId,text}): Promise<{clientMessageId,userMessageId,acceptedSeq}>`；`Agent.close(): Promise<void>`；构造参数注入 Model stream，默认生产函数可直接用；HTTP `POST /api/messages` 返回 `202`。

- [x] 先写并运行接收、并发拒绝、历史筛选、消费滞后、快照切点、工具半截恢复、订阅取消与运行关闭的失败测试。
- [x] Agent 按事件独立累积，复制后发布；错误也形成正式 assistant 并释放忙碌。
- [x] HTTP 复用授权与可信来源保护；严格校验 JSON、字符串、空白和支持模型；`400/409/401/403` 保持明确拒绝，`close()` 中止共享运行。
- [x] 后端包集成测试通过，更新模块说明。

## Task 3: 网页提交与展示

**Files:** `web/src/chat/*`、`ChatPage`、`MessageList`、`AssistantMessage`、`components/markdown/*`、样式、类型、对应单元与浏览器测试、测试 Harness。

**Interfaces:** Server 提交类型只做 type import；`LocalSubmission` 使用阶段三定义；现有 `Subscribe` 可返回带 `requestSnapshot()` 方法的清理函数，维持原调用兼容。

- [x] 先写并运行 HTTP/WS 顺序、迟到错误、十秒未确认、门禁与重复手势失败测试；原输入框行为不变。
- [x] 应用所有 ModelFrame；前端只累积已收到片段；临时气泡按编号合并，回执需等待 acceptedSeq。
- [x] 安全 Markdown、思考默认折叠并保留本页展开、工具错误与终止原因展示；沿用原滚动/焦点规则。
- [x] 网页单元、Chromium 组件测试和构建通过。

## Task 4: 完整链路与交付

**Files:** `web/tests/e2e/chat.spec.ts`、`deepseek-live.spec.ts`、测试启动辅助、根与网页 README、规划索引、阶段三状态与验收记录。

- [x] 受控 SDK/SSE 经真实后端、授权、HTTP、WS、网页校验流中内容、第二轮历史、刷新/断线/多页面和重启。
- [x] 真实 DeepSeek E2E 通过设置写入测试凭据，验证两轮对话、真实 SSE/WS、Key 更换与无效 Key；缺凭据时明确记录阻塞，不冒称通过。
- [x] `npm test`、`npm run build`、`git diff --check` 全通过；独立审查阶段三要求与改动，修复实质问题后重跑受影响检查。
- [x] 验收文档记录实际命令、数量、真实模型结果与尚未覆盖的系统输入法/Safari；保留 worktree 供用户审阅，不自动合并或推送。

## 执行记录

- 2026-11-04：从干净 `main`（02830b1）创建 Codex managed worktree，分支 `codex/feature2-stage3`。基线运行根 `npm test`。
- 初始默认 Credentials 状态为 missing，环境无 DeepSeek 变量；用户随后提供既有 dotenv 位置。真实 E2E 已从授权文件只读取得 Key，并通过页面配置到测试临时目录。

- 独立审查 4 项 P2 均已补失败回归后修复：SDK 吞尾部 AbortError、交错内容区间顺序、上一轮延迟清理影响下一轮、本地失败气泡排序。HTTP 明确 4xx 与未知结果也已补齐测试。

- 最终根验收：显式提供授权 dotenv 文件运行 `npm test`，262/262 通过、0 跳过；另 `npm run build`、`npm audit --json`（0 漏洞）和 `git diff --check` 均通过。Chromium 焦点回归已修复并无诊断重复 20 次通过。

- 后续用户指令：已快进合并 main（58d2eca）；主目录 npm ci、包含真实 Key 的根 npm test（262/262、0 跳过）、build、audit（0 漏洞）、diff-check 均通过。阶段三分支已删除。应用归档拒绝删除当前聊天主 checkout，且 attach_worktree 不接受普通 main checkout，因此保留该干净 detached worktree，待聊天切回主目录后再归档；没有绕过应用保护强删。
