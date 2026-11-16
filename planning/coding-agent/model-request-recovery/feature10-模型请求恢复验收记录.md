# 模型请求恢复验收记录

验收日期为 2026-11-16。功能分支为 `codex/model-request-recovery`，从 `1fa40ae` 开始实现。案例编号沿用用户提供的《模型请求恢复验收标准》和《状态文案记录表》。

## 受控故障和浏览器验收

| 案例 | 实际检查 |
| --- | --- |
| 01–06 | 六条模型路径分别经过本地 HTTP 端点。每条路径对建连拒绝、503、缺少协议结束事件、连接重置各尝试一次。Google 的 503 保留状态分类，等待建议缺失。请求无具体原因时，同样的模型输入在一秒后恢复。五分钟超时关闭请求。 |
| 07、35 | 网页入口收到 HTTP 429、配额耗尽码和 60 秒建议后直接失败，共一次请求。HTTP 418 在一秒后重发相同输入，原 Run 完成，共两次请求。 |
| 08–17、36 | 固定时钟验证建连等待 5、10、20、40、60、60 秒。断流和限流共用五次额度，下一模型步骤从第 1 次开始。等待建议按原截止时间执行，覆盖整数秒、过期日期、无效值、120 秒长等待及超过单个计时器上限的等待。用尽时共六次请求，若还有未到期的建议则保留最早手动重试时间。 |
| 18–22 | Chromium 检查 47 项状态文案及本轮详情位置。推理和工具参数到达时保留旧正文，新正文与清除提示同一次同步。仅返回完整工具调用也会清除旧片段。刷新保留失败原因和重试次数，旧错误消息仍可显示。 |
| 23–25 | 等待中止后跨过原截止时间仍只有一次请求。已发出的重试在中止后关闭连接。WebSocket 断开时服务端由第 2 次推进到第 3 次，重连快照使用原 Run，后续发送次数由服务端控制。 |
| 26–28 | 工具完整返回后写入一次，SQLite 中保留一条匹配结果。下一步骤发出六次请求，每次输入都包含原工具结果。失败后切换模型并发送「继续」，原会话新一轮完成，输入保留工具结果并排除失败片段。在等待中强制终止服务后，历史为「已中断」，可回看工具结果，重启后请求总数仍为两次。 |
| 29–31 | 合法长度终止保留正文。模型容量超限走既有压缩流程，在原 Run 继续，压缩后再次超限时结束并显示容量提示。压缩中止后记录已取消。 |
| 33–34 | 无错误码的 `response.failed` 共收到六次，用尽时保留回复异常原因。无法确认来源的本地准备异常未发出模型请求，使用固定兜底原因。 |

根目录 `npm test` 通过 716 项，跳过 13 项独立真实服务用例。其中网页端到端通过 35 项，本功能新增 5 项均通过。六条协议的请求与断流样本见 [模型流测试](../../../packages/model/test/model-stream.test.ts)，计数和取消见 [重试测试](../../../packages/coding-agent/test/model-retry.test.ts)，网页通过真实 HTTP 和 WebSocket 运行的案例见 [浏览器端到端测试](../../../web/tests/e2e/model-retry.spec.ts)。

## 真实服务验收

真实服务使用同一套 WebServer 提交与事件订阅入口。每家从当前模型目录选一个代表模型请求完整回答。结果通过 Run 终态与实际正文核对。复测入口如下。

```sh
npm run build:packages
MODEL_LIVE_KEY_FILE=/absolute/path/to/test.env npm --prefix packages/server run test:models:live -- -t '模型请求恢复正常调用' --reporter verbose --silent=false
```

[真实模型验收入口](../../../packages/server/test/models.live.ts)

| 提供方 | 模型 | 适配路径 | 结果 |
| --- | --- | --- | --- |
| DeepSeek | `deepseek-flash` | 独立 Chat Completions | 1 次，完成 |
| MiniMax CN | `MiniMax-M3` | Anthropic Messages | 1 次，完成 |
| 阿里千问 | `qwen3.6-flash` | 兼容 Chat Completions | 1 次，完成 |
| 智谱 GLM | `glm-4.6v` | 兼容 Chat Completions | 1 次，完成 |
| Moonshot AI CN | `kimi-k3` | 兼容 Chat Completions | 2 次，初次建连失败，进入独立等待后恢复，原 Run 完成 |
| Google | `gemini-3.7-flash` | Google Generative AI | 首轮完成。两次复核在 115 秒验收窗口内均未收到终态，单独复核期间未观察到重试事件。该适配路径的真实 HTTP 请求数未采集。 |
| OpenAI | — | OpenAI Responses | 缺少测试凭据 |
| Anthropic | — | Anthropic Messages | 缺少测试凭据 |
| Mistral | — | Mistral Conversations | 缺少测试凭据 |

六条适配路径的故障规则均在受控端点验证。模型服务已经接收请求后发生断流时，重发可能产生额外的模型费用。
