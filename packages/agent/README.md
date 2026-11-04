# Agent

Agent 保存唯一当前对话的状态。新实例是真实空对话：没有消息、没有生成、更新序号为 0。

`new Agent().subscribe(signal)` 返回进程内异步序列：先给出独立的完整快照，再等待后续变化。
随后提供连续序号的更新。先登记观察者再复制当前状态，切点后的更新进入所属队列。
每个订阅使用自己的 `AbortSignal`；取消、提前退出迭代或调用迭代器 `return()` 都会释放所属监听和等待，不改变 Agent 或其他订阅。

`submit({clientMessageId,modelId,text})` 在没有异步空隙的一次接收中检查输入和忙碌、追加正式 user、保存运行状态并发布 accepted，返回正式编号与 acceptedSeq。随后后台调用 Model；已接收不保证模型调用成功。原文保留空格与换行，不做提交去重；忙碌返回 409，无效输入返回 400。

上下文保留用户消息及成功 assistant，排除 error/aborted 的整条 assistant。Agent 逐项消费 Model 事件，自行累积 text、thinking、toolCall；不读取可能已领先的 shared partial 内容。活动工具块保留已消费参数原文；块终值和最终回复负责校准。失败仍保留部分内容并恢复空闲；Model 意外抛错或无终止事件也安全收尾。

`close()` 停止接收、取消当前生成并等候收尾；仅取消订阅不停止生成。聊天和序号只在内存中，重启清空。构造参数 `{stream}` 可注入同签名的单次调用函数，Server 用它装配共享 Credentials；不引入第二份历史。

公开入口为 `@agent-learning/agent`，包含 `Agent`、`AgentSubmitError` 和状态、订阅类型。
Agent 不处理 HTTP、WebSocket、Cookie 或网络订阅编号；Server 负责封装网络消息。
Model 消息类型从 `@agent-learning/model` 的公开入口引用。

在仓库根目录安装 workspace 依赖后：

- `npm --prefix packages/model run build`：先输出模型类型。
- `npm --prefix packages/agent run build`：检查并输出 `dist/`。
- `npm --prefix packages/agent test`：验证接收、并发、历史、快照切点、独立消费、半截参数、订阅清理与运行关闭。
