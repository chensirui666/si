# Agent

`@agent-learning/agent` 执行通用的模型和工具循环。调用方交给 `Agent.run({ model, context, tools, signal })` 一份模型输入和可执行工具。Agent 等本轮回复完整结束，再执行工具并把结果交给下一轮模型，直到模型回答、报错或收到中止。调用方可以通过 `prepareContext` 在每次请求前更新实际输入。

`agent.subscribe(listener)` 发布模型流、工具开始与工具结果，并返回解除监听的函数。工具可以在执行中用 `recordDetails(value)` 记录调用方需要的事实。详情随对应工具结果返回，模型只收到工具文本。已开始的工具收尾后，执行才结束。运行返回模型的终态或执行失败。超限错误交给调用方处理，调用方可以用 `agent.continue(input)` 提供已准备好的上下文继续。

会话的原始聊天、压缩、任务编号和工作目录由 `@agent-learning/coding-agent` 的 `AgentSession` 管理。网页和 HTTP 通过服务端使用这层会话能力。

在仓库根目录运行 `npm run build:packages` 生成包产物，再用 `npm --prefix packages/agent test` 检查独立执行。会话及编程工具测试可用 `npm --prefix packages/coding-agent test` 运行。
