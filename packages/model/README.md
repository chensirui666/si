# Model

保存模型消息、内容块和结束原因的共同类型，根据本地凭据给出可用模型，并通过 OpenAI SDK 调用一次 DeepSeek。公开入口为 `@agent-learning/model`，网页通过 `import type` 使用共享类型，不将后端凭据代码打入网页。

`discoverModels(credentials?)` 组合内置目录与 Credentials 的本地检查结果，返回 `ModelDiscovery`：`models` 是可用的 `ModelInfo[]`，`deepseek` 是非敏感凭据状态。默认使用 `~/.agent-learning/auth.json`；可信后端和测试可注入只有 `readStatus(providerId)` 的凭据对象。发现与调用分别读取 `readStatus('deepseek')` 和 `readApiKey('deepseek')`。

本阶段只支持 `deepseek-flash`，提供方为 `deepseek`，协议目录标识为 `openai-completions`。凭据为 `configured` 时返回模型，缺失或错误时返回空目录及对应状态。每次发现读取当前状态，不缓存旧模型，不发网络请求，也不验证远端 Key。

`findModel(modelId)` 只查内置支持目录，返回独立的模型信息或 `undefined`；不读凭据、不访问网络。Agent 可以同步校验所选模型，再原子接收消息。

目录返回 `contextWindow: 1_048_576` 与 `maxTokens: 65_536`；后者是本项目一次请求的输出预算。容量包含输入与输出，因此调用方必须为本次回复预留输出空间。2026-11-09 核对了 [DeepSeek 模型目录](https://api-docs.deepseek.com/api/list-models/)与 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)：当前服务商最大输出为 393,216，本项目没有把该最大值作为请求额度。

`estimateMessageTokens(message, includeThinking)` 为近期消息切分估算完整消息；`estimateContextTokens(context)` 返回 `ContextEstimate {systemTokens, toolsTokens, messageTokens}`。估算复用实际请求的消息与工具转换，计序列化内容与结构开销，包含缺失工具结果的协议补位，不计时间、来源、用量或页面编号。最后一个非空系统提示归系统；旧系统消息、正文、适用思考、工具调用与结果归对话；工具一项只含声明。每四字符约一个 token 是参考 Pi/dsh 的近似值，中文与 JSON 可能低估，服务商真实用量才是实测值。估算不发网络请求、不修改原文，也不表示三类是服务商报告的拆分。

`stream(model, context, { signal }?)` 立即返回 `ModelEventStream`，后台读取当次 Key 并发送一个请求。`context` 包含可选 `systemPrompt`、调用方准备的 `messages` 和可选 `tools`；本包不保存对话历史。固定开启 `thinking: { type: 'enabled' }`、`reasoning_effort: 'high'`、`max_tokens: 65_536` 和流式用量报告，不执行工具。Key 只进入认证头，替换凭据作用于后续请求。带工具声明时，纳入历史的助手消息携带 `reasoning_content`，包括执行前的思考与上次普通回答的思考；不带工具声明时省略服务商不计入上下文的历史思考。工具结果沿用原调用编号。

完整工具调用中缺少结果时，在请求输入中补充 `No result provided`，不修改传入历史或真实执行记录，不重新执行工具。按每批调用独立配对，系统消息暂缓到结果之后，跨批复用编号不会串联；失败或中止的未完成回复仍由 Agent 在准备历史时排除。

```typescript
const response = stream(model, { messages })
for await (const event of response) {
  // 根据 start、text/thinking/toolcall 的 start/delta/end、done/error 更新调用方状态。
}
const finalMessage = await response.result()
```

`Tool<TParameters extends TSchema = TSchema>` 是通用声明，包含 `name`、`description`、TypeBox `parameters`。调用方显式传入 `tools` 时，Model 将其转换为 SDK 函数工具声明；省略或传空数组时不发送 `tools` 字段，也不自动选择默认工具。Agent 每轮传入已注册的工具声明与有效历史。

```typescript
const response = stream(model, { messages, tools })
for await (const event of response) {
  // 展示进度，不在 toolcall_end 时提前执行。
}
const finalMessage = await response.result()
const calls = finalMessage.stopReason === 'stop' || finalMessage.stopReason === 'toolUse'
  ? finalMessage.content.filter(block => block.type === 'toolCall')
  : []
```

`calls` 仍是待校验请求：未知名称、缺少必填字段和带 `argumentsError` 的参数都会保留，不强制转换成本地参数类型。截断、失败和取消时不交付调用，但最终消息仍保留内容供核对。本期独立验收使用各自上下文，不执行工具、不回填结果、不写普通聊天历史。

事件与 `result()` 属于同一次调用；反复等待结果不会再次请求。`partial` 是同一个持续变化的回复对象，不能当作某次事件的历史快照。需要恢复状态的调用方应独立应用 delta，并在块结束和最终回复时校准。正文和思考按连续输出区间建块，切换类型或收到工具数据时先结束当前正文/思考块；再次输出正文或思考会新建块。工具块按响应位置归集，位置缺失时用调用编号回查。不同位置即使用了同一编号也保留独立工具块，供 Agent 拒绝整批调用。编号缺失先留空，后续再补，同一调用的后续参数继续写原工具块，整流收尾时只结束一次。

正常终止为 `stop`、`length` 或 `toolUse`；请求、协议、断流、尾部失败或超时为 `error`，明确取消为 `aborted`。准备失败可以直接产生 error；生成失败保留部分内容。最终结果 Promise 正常返回失败消息，不以拒绝 Promise 替代 error 事件。有效结束原因与正常读完整个 SDK 流必须同时成立，终止后不再发送片段。`usage` 仅保留服务商报告的字段，不补零；错误说明不包含原始异常或服务商错误正文。明确的上下文超限在脱敏前归类为 `errorCode: 'context_overflow'`；仅接受 400/413/422 中明确的上下文错误码或超限特征，普通参数、认证、限流和网络失败不归类，不增加 SDK 重试。

SDK 与本包均不重试。连续五分钟没有 SDK 模型数据才中止；原始 SSE 心跳不续期，持续产生数据可以超过五分钟。超时和调用方取消均中止上游，并清理计时器与监听。SDK 的默认等待时间设为 Node 支持的最大计时值，由本包的滚动计时器实际控制无数据等待。

工具参数为空白时按 `{}` 接收；其他参数严格使用 `JSON.parse` 并要求结果是非 null、非数组对象，不修复或补全。不合法参数保留工具块、原文和 `argumentsError`，不单独把正常结束变为 error；后续执行方必须拒绝这些参数。

可信后端可调用 `createModelStream(credentials, { fetch?, baseURL? }?)`，返回签名与默认 `stream` 相同的函数，复用同一个 Credentials 对象。`fetch` 和 `baseURL` 供集成测试接入受控 SDK/SSE；默认入口固定使用真实 DeepSeek 地址，不接收网页传来的服务地址。

Pi 将支持目录、可用性和实际请求认证分开；本包沿用单次调用、内容块、共享 partial 和同次 result 的分工。项目明确选择严格 JSON、无重试、不补用量零值、必须有结束原因，不移入 Pi 的其他服务商兼容分支。

在仓库根目录安装 workspace 依赖后：

```sh
npm --prefix packages/credentials run build
npm --prefix packages/model run build
npm --prefix packages/model test
```

测试在临时路径保存、替换和删除假 Key，发现测试不访问网络。流测试通过真实 SDK 读取受控 fetch Response/SSE，覆盖三类内容、十二类事件、五种终止、工具声明转换、工具参数、当前 Key、取消、断流和五分钟滚动超时，不访问用户配置或真实服务商。完整网页与真实 DeepSeek 验收由 Server/E2E 执行。

真实工具验收从 Feature4 的正式服务入口执行，运行命令和凭据设置见 [项目 README](../../README.md#校验)。
