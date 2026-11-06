# Agent

Agent 保存唯一当前对话的状态。新实例是真实空对话：没有消息、没有生成、更新序号为 0。

`new Agent().subscribe(signal)` 返回进程内异步序列：先给出独立的完整快照，再等待后续变化。
随后提供连续序号的更新。先登记观察者再复制当前状态，切点后的更新进入所属队列。
每个订阅使用自己的 `AbortSignal`；取消、提前退出迭代或调用迭代器 `return()` 都会释放所属监听和等待，不改变 Agent 或其他订阅。

`submit({clientMessageId,modelId,text,cwd})` 在没有异步空隙的一次接收中检查输入和忙碌、追加正式 user、保存运行状态并发布 accepted，返回正式编号与 acceptedSeq。随后后台调用 Model；已接收不保证模型调用成功。原文保留空格与换行，不做提交去重；忙碌返回 409，无效输入返回 400。

首轮请求带工作目录和已注册工具声明。Agent 等完整结束并检查整批调用编号，再逐个执行工具，保存各自的结果。未知工具、无效参数和执行失败会保存为错误结果，后续工具仍可继续。结果齐全后请求一次最终回答，最终请求省略工具声明。首轮没有工具时直接结束。Agent 逐项消费 Model 事件，自行累积 text、thinking、toolCall；不读取可能已领先的 shared partial 内容。活动工具块保留已消费参数原文；块终值和最终回复负责校准。运行状态依次记录模型、工具、回答三个阶段，通过任务更新发布，完成整次任务后恢复空闲。页面保留失败消息和已产生的结果，模型历史排除失败助手消息及其未配齐的结果。

`close()` 停止接收、取消当前生成并等候收尾；仅取消订阅不停止生成。聊天和序号只在内存中，重启清空。构造参数 `{stream, tools}` 可注入单次调用函数与可执行工具，Server 用它装配共享 Credentials 和工具执行器。执行器收到固定工作目录和取消信号。

公开入口为 `@agent-learning/agent`，包含 `Agent`、`AgentSubmitError` 和状态、订阅类型。
Agent 不处理 HTTP、WebSocket、Cookie 或网络订阅编号；Server 负责封装网络消息。
Model 消息类型从 `@agent-learning/model` 的公开入口引用。

在仓库根目录安装 workspace 依赖后：

- `npm --prefix packages/model run build`：先输出模型类型。
- `npm --prefix packages/agent run build`：检查并输出 `dist/`。
- `npm --prefix packages/agent test`：验证接收、并发、历史、快照切点、独立消费、半截参数、订阅清理与运行关闭。
