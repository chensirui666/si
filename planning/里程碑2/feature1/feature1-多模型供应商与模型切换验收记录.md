# 里程碑 2 Feature 1 验收记录

2026-11-12 · `codex/milestone2-feature1` · 首轮依赖 `@earendil-works/pi-ai@1.3.0`，升级结果见文末。

[技术设计](./feature1-多模型供应商与模型切换技术设计.md) · [27 个验收标准](./feature1-多模型供应商与模型切换验收标准.md)

## 受控验收

| 案例 | 验收结果 |
| --- | --- |
| 01–06 | 网页列出未配置项，保存第二家后两组模型立即可选。实际模型请求使用替换后的 Key。删除后禁用原模型，明确写入失败保留输入与原凭据。两个已连接页面都收到刷新通知。 |
| 08–12 | 模型切换使用目标默认档位，无可调档位时省略入口和请求字段。首发前只更新默认值。已有会话选择、独立会话选择及全局默认值重启后分别恢复。事务失败时两处保持上一次确认值。 |
| 13–16 | 运行中预选保留当前模型，后续工具回填、摘要和生成仍用原档位。跨页同步保留草稿。发送抢在同步前时返回 `409`，本页原稿与另一页新写入的草稿均保留。旧库从任务记录恢复 DeepSeek High。 |
| 21–22 | 目标供应商拒绝已有历史时显示对应原因，已保存的工具结果仍可读。供应商没有报告用量时保留空值。 |
| 23–27 | 用目标模型和档位自动压缩。摘要请求装不下及压缩后仍超限时显示同一句红字。实际网页验证切换到大模型手动压缩、切回小模型后恢复。供应商报超限时只恢复一次，已有工具只执行一次。 |

主要入口为 [网页模型切换 E2E](../../../web/tests/e2e/model-selection.spec.ts)、[模型菜单浏览器测试](../../../web/src/components/ModelPicker.browser.test.tsx)、[服务测试](../../../packages/server/test/webserver.test.ts)、[会话库测试](../../../packages/coding-agent/test/session-store.test.ts)、[容量与压缩测试](../../../packages/coding-agent/test/agent-compaction.test.ts)和[模型流测试](../../../packages/model/test/model-stream.test.ts)。

## 真实 API 验收

使用授权的本地 HTTP 与 WebSocket 入口，在临时工作区放入两份线索文件。验证实际模型流、工具调用与结果编号、文件随机验收编号、手动压缩后的续做，以及中止和无效 Key 的终态。真实 DeepSeek 网页回归还通过 Chromium 核对错误提示、中止和继续发送。日志仅保留型号、档位、脱敏结果和请求入口。

以下 **14 个型号全部通过案例 07、17、18、19**。

| 提供方与入口 | 型号 | 所测档位 |
| --- | --- | --- |
| DeepSeek · `api.deepseek.com` | `deepseek-flash`、`deepseek-v4-pro` | High |
| Google AI Studio · Gemini SDK | `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite` | Medium |
| 阿里百炼中国 · `dashscope.aliyuncs.com` | `qwen3.6-flash`、`qwen3.6-plus`、`qwen3.7-max`、`qwen3.7-plus` | High |
| 阿里百炼中国 · `dashscope.aliyuncs.com` | `qwen3.8-flash`、`qwen3.8-max` | Medium |
| MiniMax 中国 · `api.minimaxi.com` | `MiniMax-M3` | Medium |
| 智谱开放平台 · `open.bigmodel.cn` | `glm-4.6v` | High |
| 智谱开放平台 · `open.bigmodel.cn` | `glm-5.3`、`glm-5.3-flash` | Low |

**案例 20 通过。** 同一会话从 `deepseek-flash`（High）切到 `gemini-3.5-flash-lite`（Medium），再切回 `deepseek-flash`。每个阶段都核对了工具实际结果和文件中的随机验收编号。最终复验共 15 项通过。

## 尚未通过完整真实验收的目录型号

| 提供方 | 型号与结果 |
| --- | --- |
| Moonshot 中国 | `kimi-k2.6`、`kimi-k3` 已通过 17，后续请求遇到 HTTP 429。`kimi-k2.7-code`、`kimi-k2.7-code-highspeed` 短请求可达，完整工具链遇到 HTTP 429。 |
| MiniMax 中国 | `MiniMax-M2.7`、`MiniMax-M2.7-highspeed` 在当前测试入口返回 HTTP 404。 |
| Google AI Studio | `gemini-2.5-flash`、`gemini-2.5-flash-lite`、`gemini-2.5-pro` 返回 HTTP 404。Google 文档说明 2.5 系列对有既往使用记录的用户开放。 [Google 模型目录](https://ai.google.dev/gemini-api/docs/models?hl=en) |
| Google AI Studio | `gemini-3.1-flash-lite-preview` 已通过 17、18、19，修复无效 Key 的报错分类后复验在摘要后续做遇到 HTTP 429。 |
| Google AI Studio | `gemini-3-flash-preview`、`gemini-3.1-pro-preview`、`gemini-3.1-pro-preview-customtools`、`gemini-4-argon` 遇到 HTTP 429，其中 `gemini-3-flash-preview` 已通过 17。 |
| Google AI Studio | `gemini-3.6-flash` 已通过 17、19，中止用例未观测到可供中止的文字流。 |
| Google AI Studio | `gemini-3.5-flash`、`gemini-3.7-flash`、`gemini-3.8-flash`、`gemini-flash-latest`、`gemini-flash-lite-latest`、`gemma-4-26b-a4b-it`、`gemma-4-31b-it` 遇到超时、服务端错误或摘要未完成。`gemini-flash-lite-latest` 和 `gemma-4-26b-a4b-it` 已通过 17。 |
| OpenAI、Anthropic | GPT 和 Claude 的真实 API 测试按用户要求暂缓。 |
| Mistral、阿里 Token Plan、智谱 Coding Plan | 测试文件缺少对应入口的凭据。 |

验收脚本见 [逐型号 API 测试](../../../packages/server/test/models.live.ts)。受控证据、真实链路通过和外部服务限制均按本次测试条件记录。

## 全量回归

- 根目录 `npm test` 通过 595 项，包含 26 项真实浏览器入口 E2E，其中 8 项调用真实 DeepSeek。临时使用经过校验的 `fd 10.5.0`，使嵌套忽略规则测试实际执行。
- 另补测模型选择保存回滚的服务接口，通过 1 项。
- `test:tools:live` 通过 7 项，覆盖 DeepSeek 与 Tavily 的工具调用和回填。
- 逐型号最终复验覆盖 14 个型号及跨协议续做，共 15 项通过。其他入口与型号的结果见上表。

## Pi 1.5.2 升级补验

**Kimi K3.1 Pro 完整真实验收通过。** 2026-11-12 使用原 Moonshot 中国区测试 Key，通过授权的本地 HTTP 和 WebSocket 入口发起任务。实际请求发往 `https://api.moonshot.cn/v1/chat/completions`，型号为 `kimi-k3.1-pro`，档位为 Low。

| 案例 | 实测结果 |
| --- | --- |
| 17 流式与多轮工具 | 3 次真实流式模型请求，先后两次读取文件。核对了两组调用与结果编号、请求档位和最终文件验收编号。 |
| 19 压缩与续做 | 手动压缩生成有效摘要，下一轮从摘要找回验收编号。 |
| 18 中止 | 收到实际文字流后中止，已生成内容保留，任务进入已中止状态。 |
| 07 无效 Key | 隔离配置中的无效 Key 产生认证错误，任务进入失败状态，工具执行次数为零。 |

首次运行完成案例 17 后遇到 Moonshot HTTP 429，返回 `rate_limit_reached_error`。复验时仅在测试脚本中将 K3.1 请求间隔拉开至至少 32 秒，使用正式请求参数跑完四个案例。K3.1 Pro Highspeed 随新版目录可选，真实验收待执行。

本次 `npm test` 通过 597 项，含 26 项浏览器 E2E。DeepSeek 与 Tavily 真实工具专项通过 7 项。MiniMax M3 的四个逐型号案例复验通过。DeepSeek → Gemini → DeepSeek 跨协议回归首轮遇到 HTTP 503，单独复跑通过。

## 2026-11-13 普通 API 新模型验收与百炼范围调整（移除套餐入口前）

本轮新增验收以 2026-10-01 起首次发布的型号为范围。百炼普通 API 和现有 Token Plan 的目录均仅提供 Qwen 系列。使用普通百炼 Key 复验 Qwen 3.8 Max，确认现有接入仍可用。

| 官方 API 入口 | 型号 | 真实验收 |
| --- | --- | --- |
| DeepSeek | `deepseek-flash`（V4.1 Flash 1017） | High，案例 07、17、18、19 全部通过。[DeepSeek API 文档](https://api-docs.deepseek.com/) |
| MiniMax 中国 | `MiniMax-M3.1-Flash` | Medium，首轮 HTTP 529。后续两次复验案例 07、17、18、19 全部通过。 |
| Moonshot 中国 | `kimi-k3.1-pro-highspeed` | 现有 Key 请求返回 HTTP 404。标准版的完整验收见上节。 |
| 阿里百炼中国 | `qwen3.8-max` | Medium，作为现有型号回归，案例 07、17、18、19 全部通过。 |

目录回归覆盖普通百炼和现有 Token Plan 两个入口。构建后的两个入口各显示 6 个 Qwen 型号，第三方型号无法通过这两个入口选择。

最终根目录 `npm test` 通过 599 项，含 26 项浏览器 E2E。DeepSeek 与 Tavily 真实工具专项通过 7 项。

## 2026-11-13 收敛入口并扩充 Google AI Studio

Moonshot 中国区提供 Kimi K3 和 K3.1 Pro。MiniMax 中国区提供 M3 和 M3.1 Flash。阿里 Token Plan 和智谱 Coding Plan 已从设置与模型目录移除。用旧 Kimi K2.6 会话验证历史仍可查看，重选 DeepSeek 后可继续发送。

| 模型与入口 | 本轮真实结果 |
| --- | --- |
| Moonshot 中国 `kimi-k3` | Low，案例 07、17、18、19 全通过。验收请求间隔至少 32 秒。 |
| Google `gemini-4-hydrogen` | Medium，案例 17 通过。案例 19 的摘要生成并含验收编号，续做请求遇到 HTTP 429。复验确认当前项目的免费日请求量已用完。 |
| Google `gemini-4-carbon`、`gemini-4-argon` | 已列在模型目录。当前项目的免费额度为 0，生成请求 HTTP 429。Carbon 输出预算取当前 `v1beta/models` 返回的 32,768。 |
| Google `gemini-pro-latest` | 当前项目免费额度为 0，生成请求 HTTP 429。限额响应指向 Gemini 3.1 Pro。受控测试核对推理档位和响应版本回填。 |
| Google `gemini-3.5-flash` | Medium，案例 17 通过。复验在生成摘要时遇到 HTTP 429，Google 确认为当前项目的免费日请求量已用完。 |
| Google `gemini-3.6-flash`、`gemini-3.7-flash`、`gemini-3.8-flash` | 可选且模型信息可读。本轮真实验收遇到超时或 HTTP 503。 |

案例 20 的 `DeepSeek → Gemini 4 Hydrogen → DeepSeek` 和 `DeepSeek → Gemini 3.5 Flash-Lite → DeepSeek` 均通过。Gemini 4 拒绝直接回放缺少原生签名的外部工具记录。转换层把这类历史调用和结果传成文字，保留 Gemini 自己的签名、原始记录和工具配对。Google 真实测试经本机已有代理发起。

本轮最终 `npm test` 通过 602 项，含 26 项浏览器端到端测试。DeepSeek 与 Tavily 真实工具专项通过 7 项。

## 2026-11-13 Google AI Studio 目录按发布时间收敛

以 2026-08-13 正式发布的 Gemini 3.7 Flash 为下限。配置 Google Key 后，模型目录包含 `gemini-3.7-flash`、`gemini-3.8-flash`、`gemini-4-argon`、`gemini-4-carbon`、`gemini-4-hydrogen`。核对发现 Pro Latest 和 Flash-Lite Latest 指向更早版本，Flash Latest 两次未能确认具体版本，目录采用固定型号 ID。 [Google 发布记录](https://aistudio.google.com/docs/changelog#08-13-2026)

受控 HTTP 验证确认设置 Google Key 后只返回这 5 款。浏览器从旧 Gemini 3.5 Flash-Lite 会话验证历史仍可读，重选可用型号后能继续。3001 服务重启后恢复原有 4 个会话。

全量 `npm test` 通过 603 项，含 26 项浏览器端到端测试。
