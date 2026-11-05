# Model

保存模型消息、内容块和结束原因的共同类型，根据本地凭据给出可用模型，并通过 OpenAI SDK 调用一次 DeepSeek。公开入口为 `@agent-learning/model`，网页通过 `import type` 使用共享类型，不将后端凭据代码打入网页。

`discoverModels(credentials?)` 组合内置目录与 Credentials 的本地检查结果，返回 `ModelDiscovery`：`models` 是可用的 `ModelInfo[]`，`deepseek` 是非敏感凭据状态。默认使用 `~/.agent-learning/auth.json`；可信后端和测试可注入只有 `readStatus()` 的凭据对象。

本阶段只支持 `deepseek-flash`，提供方为 `deepseek`，协议目录标识为 `openai-completions`。凭据为 `configured` 时返回模型，缺失或错误时返回空目录及对应状态。每次发现读取当前状态，不缓存旧模型，不发网络请求，也不验证远端 Key。

`findModel(modelId)` 只查内置支持目录，返回独立的模型信息或 `undefined`；不读凭据、不访问网络。Agent 可以同步校验所选模型，再原子接收消息。

`stream(model, context, { signal }?)` 立即返回 `ModelEventStream`，后台读取当次 Key 并发送一个请求。`context` 包含可选 `systemPrompt`、调用方准备的 `messages` 和可选 `tools`；本包不保存对话历史。固定开启 `thinking: { type: 'enabled' }`、`reasoning_effort: 'high'` 和流式用量报告，不执行工具。Key 只进入认证头，替换凭据作用于后续请求。

```typescript
const response = stream(model, { messages })
for await (const event of response) {
  // 根据 start、text/thinking/toolcall 的 start/delta/end、done/error 更新调用方状态。
}
const finalMessage = await response.result()
```

`Tool<TParameters extends TSchema = TSchema>` 是通用声明，包含 `name`、`description`、TypeBox `parameters`。调用方显式传入 `tools` 时，Model 将其转换为 SDK 函数工具声明；省略或传空数组时不发送 `tools` 字段，也不自动选择默认工具。Server 的 `src/tools.ts` 提供 `read`、`bash`、`edit`、`write` 四种声明及其推导参数类型；普通网页聊天继续省略声明。

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

事件与 `result()` 属于同一次调用；反复等待结果不会再次请求。`partial` 是同一个持续变化的回复对象，不能当作某次事件的历史快照。需要恢复状态的调用方应独立应用 delta，并在块结束和最终回复时校准。正文和思考按连续输出区间建块，切换类型或收到工具数据时先结束当前正文/思考块；再次输出正文或思考会新建块。工具块按响应位置优先、调用编号回查归集，编号缺失先留空，后续再补，同一调用的后续参数继续写原工具块，整流收尾时只结束一次。

正常终止为 `stop`、`length` 或 `toolUse`；请求、协议、断流、尾部失败或超时为 `error`，明确取消为 `aborted`。准备失败可以直接产生 error；生成失败保留部分内容。最终结果 Promise 正常返回失败消息，不以拒绝 Promise 替代 error 事件。有效结束原因与正常读完整个 SDK 流必须同时成立，终止后不再发送片段。`usage` 仅保留服务商报告的字段，不补零；错误说明不包含原始异常或服务商错误正文。

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

四工具真实模型案例单独运行，不包含在普通 `npm test` 中：先构建后端，再运行 `npm --prefix packages/server run test:tools:live`。使用现有 Credentials 只读 `~/.agent-learning/auth.json`；缺少配置时明确跳过，配置损坏或远端失败时判未通过。每个案例都传入全部四种声明，只检查返回调用，不执行文件或命令。
