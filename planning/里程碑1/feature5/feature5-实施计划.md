# Feature5 实施计划

目标：按现有技术设计支持网页中止当前运行、保留结果并在收尾后继续发送。

设计依据：[技术设计](./feature5-用户停止当前调用技术设计.md)。2026-11-07 用户明确要求继续实现并完成全部校验，作为现有逐项确认方案的实施授权。使用现有 TypeScript、React、Vitest、Playwright，不引入依赖。

## 执行与验证

- [x] Agent / Model：先增加 A1–A3、M2 测试并确认失败，再实现 `Agent.abort(userMessageId): Promise<boolean>`、工具后取消检查、完整历史保留及请求输入缺失结果补齐。复跑 Agent、Model 全测，M1 复用已有取消测试。
- [x] Tools：先增加 T1 文件操作阶段测试，再补只读取消等待、写入后检查；执行 T2 真实进程取消和 T3 网络取消、缓存收尾测试。复用 ToolRuntime，无新超时或循环限制。
- [x] WebServer：先增加 W1–W4 测试，再接入 `POST /api/abort`、协议与可选 Agent 能力。沿用接入校验，等待指定 task，不随 HTTP 断开撤销。
- [x] 网页：先增加 U1–U4 与 client 测试，再接入可注入 `abortMessage`、绑定目标的页面状态和 MessageInput 的 send/abort/aborting。保留 Lexical 实例、撤销、草稿与既有发送门禁。
- [x] 完整校验：增加 E1，覆盖 Node/Vite 实际入口；执行根 `npm test`、真实 DeepSeek 网页验收、七工具真实调用，检查完整构建和 diff。记录通过数与任何跳过。
- [x] 收尾：核对设计覆盖，独立审查改动，更新 README、规划状态和验收记录；不合并主分支。

## 必查边界

- 旧目标或重复中止不能影响新运行；自然完成竞态保留实际结果。
- 模型终态早于清理时仍禁止发送；工具批次最后一项取消不能启动回答。
- 系统消息穿插、末尾缺结果、跨批相同工具编号，均只修补请求输入。
- HTTP 成功先到、失败后重同步、断线和刷新，均由后台快照决定操作。
- 文件已经修改后中止不会回滚；write/edit 等当前写入结束再恢复空闲。

## 执行记录

- 基线 `main f360e2e`；worktree `.worktrees/feature5`，分支 `codex/feature5`。
- 原目录未提交的 feature5 设计带入 worktree，规划索引和妥协记录只纳入 feature5 相关增量，原目录原件保留。
- Pi 源码已核对：Agent abort/waitForIdle、handleRunFailure、transformMessages、read/write/edit；沿用已确认的职责适配。
- 裁定：原生 worktree 工具不能指定项目内路径，按用户指定位置使用 Git 创建 worktree。

- 最终根回归 369 项、真实工具 7 项通过，无失败无跳过；完整构建和 diff 检查通过。独立代码审查未发现需修改问题，详细证据见验收记录。
- 同日按用户要求快进合并 main，在主目录重新完成 369 + 7 项验收；首轮出现一次未复现的 Tab 焦点断言失败，专项 8 次及完整重跑通过，细节已保留在验收记录。确认通过后删除本次 worktree 和分支，保留原有规划草稿及其他 worktree。
