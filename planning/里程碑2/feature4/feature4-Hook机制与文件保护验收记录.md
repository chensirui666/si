# 里程碑 2 Feature 4 验收记录

验收日期为 2026-11-17。实现基于 `main` 的 `bd9d4e2`，参考 Pi `9b88b94e2` 和 DeepSeek Harness `e8f7b93a34`。[技术设计](./feature4-Hook机制与文件保护技术设计.md) · [34 项验收标准](./feature4-Hook触发验收标准.md)

| 案例 | 检查结果与复跑入口 |
| --- | --- |
| 01–03、12、14、34 | HTTP 确认个人扩展启动、草稿复用、失败入口隔离、输入改写持久化、原请求重放，以及首发回调等待期间的关闭和中止顺序。[WebServer 测试](../../../packages/server/test/webserver.test.ts) |
| 04–05、09、23、25–26 | 每轮先通知再处理上下文，请求用有效快照。续跑回调可读回已保存的回复和工具结果，追加指令在同一任务使用。流式回调按增量收到对应内容。[会话测试](../../../packages/coding-agent/test/extensions.test.ts) · [模型流测试](../../../packages/model/test/model-stream.test.ts) |
| 07–08、10–11、17–18、20、22、27 | 工具改写结果按原编号回填。拦截、权限变化、中止和回调报错都跳过实际工具并保留结果关联。重复停止等待同一次收尾。新工具在下一轮生效。[会话测试](../../../packages/coding-agent/test/extensions.test.ts) · [浏览器受控测试](../../../web/tests/e2e/extensions.spec.ts) |
| 13、15–16 | 回调遵循扫描顺序和包声明顺序。独立会话各自计数，入口登记失败时撤回该入口的全部登记。[扩展测试](../../../packages/coding-agent/test/extensions.test.ts) |
| 21 | 首发 `ping` 只显示 `pong`，继续发送仍复用同一草稿。后续正式会话的 `ping` 撤下临时气泡。两个标签页共享草稿时，各自等待对应的提交回执。[浏览器受控测试](../../../web/tests/e2e/extensions.spec.ts) · [首发测试](../../../web/src/pages/ChatPage.first-send.test.tsx) |
| 24、28–29 | `agent_end` 先于溢出压缩与续跑。压缩结果确定后才通知扩展，覆盖成功、失败和中止。[压缩测试](../../../packages/coding-agent/test/agent-compaction.test.ts) |
| 30–31 | 保存模型或推理强度后，只有发生变化的选项各通知一次。等待输入 Hook 时模型选择发生变化，拒绝旧的未确认提交。[会话测试](../../../packages/coding-agent/test/extensions.test.ts) |
| 32–33 | DeepSeek 和 Pi 适配路径的 HTTP 元数据先于响应体消费，解析后的数据块按顺序通知。Google 路径提供数据块通知。[模型流测试](../../../packages/model/test/model-stream.test.ts) |
| 06、19 | Chromium 经本地服务调用真实 DeepSeek。原版 Pi 扩展拦截对测试 `.env` 的 `edit`，同一任务成功编辑 `README.md`。移出扩展并重启后，`.env` 编辑成功。每个工具结果均按模型给出的调用编号核对，并从磁盘读回文件。[网页真模测试](../../../web/tests/e2e/extensions.live.spec.ts) |

受控校验运行根目录 `npm test`。仅复跑文件保护真模验收时，先运行 `npm run build`，再执行以下命令。测试目录、会话库、模型凭据副本和文件均为临时数据。

```sh
cd web
DEEPSEEK_LIVE_KEY_FILE=/absolute/path/to/test.env \
npx playwright test -c playwright.config.ts extensions.live.spec.ts
```

本次真模复验记录了三个调用编号。测试断言读取的是磁盘上的文件内容。

| 场景 | 调用编号 | 磁盘结果 |
| --- | --- | --- |
| 扩展启用，编辑 `.env` | `call_00_GEZaiQqqYdOWpAOMtcSC0993` | `DEMO=before`，工具返回路径受保护 |
| 扩展启用，编辑 `README.md` | `call_01_a4qzdWE9AKEqeHyz2JPi4995` | `README_DEMO=after` |
| 移出扩展并重启，编辑 `.env` | `call_01_5yoK81Ecgs11TCwuADBI6699` | `DEMO=after` |

最终 `npm test` 正常退出。后端 474 项、网页单元 155 项、Chromium 组件 71 项及受控端到端 36 项通过。默认命令跳过 14 项需要真实凭据的测试，本功能的真模用例已用提供的测试凭据单独通过。全量复跑前，给既有 Skill 端到端测试补上了设置弹窗恢复焦点的等待。
