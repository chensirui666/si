# 里程碑 2 Feature 1 模型范围调整计划

**目标**　移除已明确不需要的套餐和型号，完成 Moonshot 中国区 Kimi K3 的真实验收，扩大 Google AI Studio 上适合文本与工具调用的型号覆盖。

**实现方式**　在现有工作树调整模型层目录，沿用本机 API Key、Pi 流式适配及当前的设置与模型选择链路。Pi 的目录已有条目时优先复用。对 Google 官方已发布但 Pi 尚未收录的型号，先确认现有 Gemini 原生接口可以调用，再补对应的目录项。

**现有设计**　[Feature 1 技术设计](<../../../planning/里程碑2/feature1/feature1-多模型供应商与模型切换技术设计.md>) · [验收记录](<../../../planning/里程碑2/feature1/feature1-多模型供应商与模型切换验收记录.md>)

## 1. 收敛供应商和型号

涉及 `packages/model/src/catalog.ts`、`packages/model/test/model-discovery.test.ts`、`packages/model/test/model-stream.test.ts` 和 `packages/server/test/models.live.ts`。

- [x] MiniMax 中国区保留 `MiniMax-M3` 和 `MiniMax-M3.1-Flash`，移除 `MiniMax-M2.7` 与 `MiniMax-M2.7-highspeed`。
- [x] 移除 `qwen-token-plan-cn` 和 `zai-coding-cn` 的注册、设置入口和专项测试凭据映射。普通百炼继续只列 Qwen，智谱开放平台继续用普通 Key。两者复用的 Pi 模型元数据保留。
- [x] Moonshot 中国区按 `kimi-k3.1-pro` 和 `kimi-k3` 两款收敛。把流式测试使用的 K2.6 换成保留的型号。
- [x] 目录测试在相应 Key 均已配置时断言 MiniMax 和 Moonshot 的精确型号集合，以及两个套餐入口不在 `discoverModels()` 和 `isModelProvider()` 中。对移除的型号验证 `findModel()` 返回空。
- [x] 从网页打开曾选择已移除型号的旧会话，验证历史仍可看，发送前提示重选，切到可用型号后能继续。保留本机凭据文件和历史记录。

## 2. 扩充 Google AI Studio

涉及 `packages/model/src/catalog.ts`、现有模型目录与流式测试、`packages/server/test/models.live.ts`。

- [x] 首先检查普通 AI Studio Key 可访问的模型，再核对 Google 官方的文本输出、流式接口及自定义工具调用说明。候选仅纳入能走现有 Gemini 原生流式接口的文本工具模型。
- [x] 优先验收 `gemini-4-hydrogen`、`gemini-4-carbon`、`gemini-4-argon`。前两款于 11 月 12 日和 10 日正式开放，当前 Pi 1.5.2 目录缺这两款。Argon 已在 Pi 目录，9 月 30 日发布、10 月 13 日正式开放 API，列入补验。Pi 还没有条目时，按 Google 官方的模型 ID、容量和推理参数补静态目录，沿用同一个 Google Key 和流式适配器。 [Google API 发布记录](https://aistudio.google.com/docs/changelog) · [Google 模型目录](https://aistudio.google.com/docs/models)
- [x] 现有 Pi 1.5.2 的 Gemini 适配器支持 `low`、`medium`、`high` 等档位，未实现 `xhigh` 的原生映射。只显示实际能正确发送的档位。保留 Pi 的工具记录及思考签名转换，核对两轮工具调用和结果配对。 [Google 工具调用](https://ai.google.dev/gemini-api/docs/function-calling)
- [x] 保留已跑通的 `gemini-3.1-flash-lite` 和 `gemini-3.5-flash-lite`。Gemini 4 验收后，用当前 Key 补验目录已有且仍可调用的 `gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-3.5-flash` 和 `gemini-pro-latest`。记录 `latest` 实际解析到的版本，避免把同一个模型重复计入结果。

## 3. 真实验收和回归

- [x] 先运行 `npm run test --workspace @agent-learning/model` 和 `npm run build:packages`。
- [x] 复用当前普通 API Key 的验收文件，经项目的 HTTP 和 WebSocket 会话入口逐型号跑案例 17、19、18、07，检查流式输出、多轮工具、摘要后续做、中止与无效 Key。Kimi K3 曾在多轮工具通过后遇到 429。对同一供应商降低验收并发，按实际限额间隔复跑。Google 也按实际配额依次验收。 [Google 配额说明](https://aistudio.google.com/docs/rate-limits)
- [x] 用一款通过验收的 Gemini 4 复跑 DeepSeek → Gemini → DeepSeek 的同会话工具任务。Gemini 4 受账号限制时，使用已验收 Gemini 执行现有跨模型回归，并记录 Gemini 4 的实际状态。
- [x] 按开发指南用现有测试凭据跑完整 `npm test` 和 `test:tools:live`。更新技术设计和验收表，逐型号写明请求入口、档位、实测通过项、额度或权限限制。

Google 真实验收的额度和服务端阻塞，以及逐型号已通过的案例，见[本轮验收记录](<../../../planning/里程碑2/feature1/feature1-多模型供应商与模型切换验收记录.md>)。
