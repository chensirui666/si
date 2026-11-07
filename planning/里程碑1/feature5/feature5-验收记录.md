# Feature5 验收记录

2026-11-07，基于 `main f360e2e`，在 `.worktrees/feature5`、`codex/feature5` 实现并验收。Node.js `v24.16.0`、npm `11.13.0`，macOS，Chromium。实施依据为[用户停止当前调用技术设计](./feature5-用户停止当前调用技术设计.md)。

## 交付结果

用户发送后可点击「中止」，停止本次模型或工具运行。后台等待当前操作收尾，保留已生成内容、完整工具调用与实际结果，再恢复发送。运行和中止期间仍可编辑草稿，按钮切换不重建编辑器，不清空撤销记录。

- `Agent.abort(userMessageId)` 按正式编号定位，重复请求等待同次任务，旧编号返回 false；自然完成竞态保留实际终态。
- 新增 `POST /api/abort`，沿用来源、Cookie、JSON、64KiB 和编号校验；等待收尾后返回同一编号及 handled，不随请求断线撤销。
- read 与 grep 的只读等待可响应取消；write/edit 在当前操作返回后检查取消，取消不会回滚已发生的修改。Bash/find/grep 继续使用既有进程停止机制。
- 两个网页工具沿用网络信号，web_fetch 等待已经开始的正文缓存写入。
- Model 只为下次请求补充缺失工具结果，保留真实结果和思考；系统消息、历史末尾、重复准备与跨批复用编号均覆盖。
- 网页通过实际后台状态恢复；回执先到仍等待空闲，失败后重取快照，旧回执不影响新运行。

## 最终自动校验

| 范围 | 结果 |
| --- | --- |
| Credentials | 54 通过 |
| Model | 52 通过 |
| Agent | 32 通过 |
| Server / Tools | 93 通过 |
| 网页单元测试 | 95 通过 |
| Chromium 组件测试 | 31 通过 |
| Node / Vite 实际入口 E2E、真实 DeepSeek | 12 通过 |
| 根 `npm test` 合计 | **369 通过，0 失败，0 跳过** |
| 独立真实工具 T2–T8 | **7 通过，0 失败，0 跳过** |
| 完整 TypeScript / Vite 构建 | 通过 |
| `git diff --check` | 通过 |

合计 **376 项通过**。基线完整回归曾因未提供凭据跳过两项 live 用例、因未安装 fd 跳过一项；上述最终运行均已消除这些跳过。fd 由项目现有 ToolRuntime 从固定官方发布下载、核对 SHA-256，并复制到测试临时 PATH；未增加项目依赖或安装到系统目录。

实际命令如下。测试凭据来自用户指定的已有 dotenv，仅读入内存并经设置页面保存到测试临时目录；不输出 Key、不修改原文件。示例路径不包含真实凭据。

```sh
PATH="/tmp/agent-feature5-bin:$PATH" \
DEEPSEEK_LIVE_KEY_FILE=/absolute/path/to/test.env \
TAVILY_LIVE_KEY_FILE=/absolute/path/to/test.env \
npm test

PATH="/tmp/agent-feature5-bin:$PATH" \
DEEPSEEK_LIVE_KEY_FILE=/absolute/path/to/test.env \
TAVILY_LIVE_KEY_FILE=/absolute/path/to/test.env \
npm --prefix packages/server run test:tools:live
```

完整运行日志保存在本机 `/tmp/agent-feature5-full.log` 和 `/tmp/agent-feature5-live-tools.log`；Chromium JSON 报告和受控案例截图在 `web/test-results/`，属于可重建的测试产物。

## 关键证据与设计覆盖

| 设计案例 | 测试与实际结果 |
| --- | --- |
| A1–A3 | `packages/agent/test/agent.test.ts`：部分文字保留、重复中止等待、自然完成竞态、旧编号隔离；第二或最后一项工具中止时，保留完整调用及已取得结果，不启动回答；收尾前拒绝提交，收尾后可继续。 |
| T1 | `packages/server/test/local-tools-abort.test.ts`：控制 stat/readFile/mkdir/writeFile 的返回时点；read 结束取消等待且清理监听，write/edit 等当前读写返回后取消。检查真实文件，已写入内容不回滚。 |
| T2 | `packages/server/test/tool-execution.test.ts`：通过真实 Bash 及替代 fd/rg 的受控子进程测试任务取消，取消后不产生门控的后续标记文件；真实 fd/rg 正常搜索及既有进程组关闭、超时回归也通过。 |
| T3 | `packages/server/test/web-tools-abort.test.ts`：真实本地 HTTP 响应读到一半取消，本机连接关闭并返回取消；DNS 等待可取消且不发起服务商请求；真实缓存写入等待释放，服务关闭后文件清理。 |
| M1–M2 | `packages/model/test/model-stream.test.ts`：复用开始前与流式取消、单次终态及响应释放测试；新增捕获真实 SDK 请求，确认缺失结果补齐、系统消息位置、跨批编号和原历史不变。 |
| W1–W4 | `packages/server/test/webserver.test.ts`：校验失败不交付 Agent，缺能力 503、内部异常脱敏；HTTP 等收尾才返回；断开 HTTP 和 WS 后重新订阅，仍恢复实际中止结果及空闲。 |
| U1、U3、U4 | `web/src/pages/ChatPage.test.tsx`、`web/src/chat/client.test.ts`：提交确认门禁、空草稿中止、重复点击、回执校验、失败重同步、手工重试、旧回执隔离；配置和目录失效或订阅断线仍能中止已知运行。 |
| U2 | `web/src/components/MessageInput.browser.test.tsx`：在真实 Chromium 切换发送/中止/正在中止，核对同一 DOM 编辑器、焦点、原文、撤销与重做；Enter 在运行中不提交。 |
| E1 | `web/tests/e2e/abort.spec.ts`：Node 和 Vite 均从真实页面点击中止，经正式 HTTP、Agent 与 SDK 关闭受控服务商连接，保留文字与草稿，下一次请求排除未完成回复并成功回答。 |

**真实服务商额外验收：** 新增 DeepSeek 网页案例，在真实正文已开始返回时点击中止，收到唯一 aborted 终态，部分文字和草稿保留；同一对话随后得到“中止后继续成功”。原有真实凭据替换、两轮历史、无效 Key 恢复和两次实际 read 随文件变化的案例全部通过。另从正式 HTTP / WS 入口跑通 bash、edit、write、find、grep、web_search、web_fetch 七项真实执行、结果回填与最终回答。

这些真实工具案例证明正常调用回归；工具取消证据来自上表分层测试，不据此声称 Tavily 远端任务已停止。

## 审查与保留边界

独立只读审查已核对取消等待、完整工具历史、消息配对、输入校验、恢复竞态与测试覆盖，未发现需要修改的代码问题。已目视检查中止后实际页面截图；不输出真实凭据或包含凭据的浏览器 trace。

未单独实测 Safari 和系统中文输入法。本次未新增或修改输入法处理。构建保留既有约 628kB 的单包体积提示，测试保留环境中的 FORCE_COLOR / NO_COLOR 提示；均不影响通过结果。

停止不保证瞬间结束，也不撤销文件修改；只读底层 I/O 与远端处理不保证物理上同时消失。提交尚未确认时不能中止；刷新和断线不自动停止。完整多轮循环内的停止仍在 Feature6 验收。

实现保留在 feature5 分支与 worktree，未合并、未推送；原主目录的未提交规划文档保持原样。本 worktree 只纳入 feature5 相关规划增量，其他后续规划仍保留在原目录。
