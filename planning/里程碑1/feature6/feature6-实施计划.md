# Feature6 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 一次提交可连续依据真实工具结果决策，支持同批并行、截断恢复及准确中止展示。
**Architecture:** 沿用现有 Agent / Model / Tools / WebServer / 网页分工；不新增协调层或依赖。
**Tech Stack:** TypeScript、Node.js、React、Vitest、Playwright。
**Spec:** [ReAct循环技术设计](../../../docs/里程碑1/feature6/feature6-ReAct循环技术设计.md)

## Global Constraints

- 用户于 2026-11-08 要求创建当前目录内 worktree、继续实现并完成全部校验，按现有设计实施。
- Pi 为核心参考。每轮等完整回复，再执行整批，整批结果收齐后继续请求；同批任一 sequential 则整批串行，否则默认并行。
- 不引入固定轮数、任务排队、压缩、网络重试、聊天持久化、文件冲突分析或回滚。
- 中止等待全部已启动操作，保留真实结果；不得把普通失败追认为中止。
- 原目录文档改动仅复制，保留原件；不修改用户凭据。真实验收用临时目录，禁止日志输出密钥。

## Review Focus

- 工具执行或结果发布意外抛错时仍等待其他已启动操作（Task 1）。
- 超时后收到中止、子进程 exit 与 close 之间的竞态（Task 1）。
- 并行结果乱序、跨轮重复编号、刷新取得尚无新助手消息的进度（Task 2）。
- 结果位置和工具关联损坏时保留原记录并重新订阅（Task 2）。
- 多轮工具只在实际启动时执行一次，刷新不重复，下一请求始终有工具（Task 3）。

### Task 1: 后台循环、并行和实际结束原因

**Files:** packages/agent/src/{agent,types}.ts、packages/agent/test/agent.test.ts；packages/server/src/{tools,local-tools,tool-runtime}.ts 及现有取消/执行测试。
**Interfaces:** ExecutableTool.executionMode?: parallel|sequential；RunningState.phase: model|tools，activeTools 数组；ConversationMessage.toolErrorCode?: string；task 结果必须携带 messageIndex。

- [x] 补写 A1—A7 测试：三轮 index.txt→note.txt→青禾；B 先完成但历史 A/B；整批 sequential；截断零执行后恢复；普通失败不影响同批；缺失/重复 ID 拒绝；中止及 close 等待全部操作。执行 Agent 测试，确认新行为失败。
- [x] 最小修改现有 runTask 为循环，逐项及时保存并按 contentIndex 插入；Promise.allSettled 等待并行收尾；所有轮共用取消信号。
- [x] 用实际取消来源标记 interrupted，ChildResult 首次结束原因冻结；T1—T2.3 验证部分输出、超时、失败与成功不被后来的中止覆盖。
- [x] Run: npm run test:packages。Expected: 全部通过。

### Task 2: 网页协议和五状态

**Files:** web/src/chat/{state,client}.test.ts、state.ts；components/{AssistantMessage,MessageList}.tsx 及其测试；ChatPage 测试中的进度 fixture。
**Interfaces:** 消费 Task 1 的 activeTools、toolErrorCode、messageIndex；ToolResults 值保留完整 ConversationMessage。

- [x] 新增 W1—W4 失败测试：五状态、结果优先、未知错误码、插入一致性、非法位置/关联/进度、旧连接、跨轮重复编号和整任务折叠。
- [x] 更新 applyFrame 校验与插入；异常返回重订阅；模型阶段允许助手尚未出现。
- [x] 更新卡片五状态及详细原因、跨轮展示和所有旧 fixture，复用现有组件与折叠行为。
- [x] Run: npm --prefix web test && npm --prefix web run build。Expected: 单元/Chromium组件和构建全部通过。

### Task 3: 完整应用、真实模型与交付

**Files:** web/tests/e2e/{model-server,react-loop.spec,deepseek-live.spec}.ts；packages/server/test/tool-execution.live.ts；README、包说明、规划和 feature6 验收记录。
**Interfaces:** 保持正式 HTTP/WebSocket 入口，测试模型按结果推进，实际本地工具执行。

- [x] 新增 E1：index→并行 note/status→等待命令，刷新恢复，中止后可继续且无第四次请求。先跑失败再完成 fixture。
- [x] E2 用真实 DeepSeek 根据 index 找 note，核对后续请求中实际结果；E3 真实 write 一次且后续请求仍有八工具。沿用现有凭据文件条件，缺少条件必须如实标未执行。
- [x] Run: npm test（提供可用测试凭据时同时跑 live）；npm --prefix packages/server run test:tools:live（DeepSeek/Tavily 条件允许时）。Expected: 全部通过，未具备条件单独记录。
- [x] 独立整分支审查，修复重要问题并回归；git diff --check。更新验收记录及限制说明，不合并主分支。

首次交付：根测试 414 项、独立真实工具 7 项全部通过，审查两项问题已修复。详细证据及执行判断见[验收记录](../../../docs/里程碑1/feature6/feature6-验收记录.md)。保留 worktree，未提交、合并或推送。

main 合并与复验完成：根测试 415 项、独立真实工具 7 项全部通过，无失败或跳过。复验定位并修复延迟选区同步抢焦点，新增一项回归；真实模型用例按实际路径及写入参数验收。worktree 与分支已清理，未推送。
