# Agent

Agent 保存唯一当前对话的状态。阶段一的新实例是真实空对话：没有消息、没有生成、更新序号为 0。

`new Agent().subscribe(signal)` 返回进程内异步序列：先给出独立的完整快照，再等待后续变化。
阶段一尚无消息提交或模型调用，所以快照之后保持等待，直到取消订阅。
每个订阅使用自己的 `AbortSignal`；取消、提前退出迭代或调用迭代器 `return()` 都会释放所属监听和等待，不改变 Agent 或其他订阅。

公开入口为 `@agent-learning/agent`，包含 `Agent` 和状态、订阅类型。
Agent 不处理 HTTP、WebSocket、Cookie 或网络订阅编号；Server 负责封装网络消息。
Model 消息类型从 `@agent-learning/model` 的公开入口引用。

在仓库根目录安装 workspace 依赖后：

- `npm --prefix packages/model run build`：先输出模型类型。
- `npm --prefix packages/agent run build`：检查并输出 `dist/`。
- `npm --prefix packages/agent test`：验证空快照、副本独立、多订阅及取消清理。
