# Agent

Agent 保存唯一当前对话的状态。新实例是真实空对话：没有消息、没有生成、更新序号为 0。

`new Agent().subscribe(signal)` 返回进程内异步序列：先给出独立的完整快照，再等待后续变化。
随后提供连续序号的更新。先登记观察者再复制当前状态，切点后的更新进入所属队列。
每个订阅使用自己的 `AbortSignal`；取消、提前退出迭代或调用迭代器 `return()` 都会释放所属监听和等待，不改变 Agent 或其他订阅。

`submit({clientMessageId,modelId,text,cwd})` 在没有异步空隙的一次接收中检查输入和忙碌、追加正式 user、保存运行状态并发布 accepted，返回正式编号与 acceptedSeq。随后后台调用 Model；已接收不保证模型调用成功。原文保留空格与换行，不做提交去重；忙碌返回 409，无效输入返回 400。

每轮请求都带固定工作目录、同一模型和已注册工具声明。Agent 等完整结束并检查整批调用编号，再执行工具；同批默认并行，任一 `ExecutableTool.executionMode` 为 sequential 则整批串行。未知工具、无效参数和执行失败保存为对应错误结果，其他工具继续。全部结果收齐后再次请求模型，直至正常回复不再包含调用；不预设第二次就是最终回答，也不隐藏后续工具或设置固定轮数。

带工具调用的 length 回复不执行本批，为每条调用回填截断未执行原因后继续；纯文字 length 保留文字并结束。缺失或同批重复编号整批拒绝，不同轮允许重复编号。Agent 独立累积 Model 的流式内容，不读取可能已领先的 shared partial；终值负责校准。失败回复仍保留，但模型历史排除失败助手消息及其结果，Model 继续保护调用与结果配对。

`RunningState` 仅区分 model、tools，`activeTools` 列表记录已启动操作；模型新一轮尚未出现助手消息也是合法状态。逐项完成立即保存并通知，按原调用顺序插入历史：task 更新中结果 `message` 与从 0 计数的 `messageIndex` 同时存在或同时省略。结果外层 `toolErrorCode: interrupted` 只表示工具明确报告的中止，不进入 ModelMessage；不能根据整任务后来取消而推断单项原因。整批并行使用 allSettled 等待全部已启动操作，清理结束后才恢复空闲。

`abort(userMessageId)` 只中止编号对应的当前运行并等候收尾，匹配返回 true，已结束或其他编号返回 false；重复请求等待同次任务。不会永久关闭 Agent，确认空闲后可继续 submit。工具阶段中止保留完整工具调用及真实结果，另追加中止说明；后续模型输入仍包含有效工具历史。当前写入可能已经发生，中止不会回滚。

`close()` 永久停止接收、取消当前生成并按相同规则等候收尾；仅取消订阅不停止生成。聊天和序号只在内存中，重启清空。构造参数 `{stream, tools}` 可注入单次调用函数与可执行工具，Server 用它装配共享 Credentials 和工具执行器。执行器收到固定工作目录和取消信号。

公开入口为 `@agent-learning/agent`，包含 `Agent`、`AgentSubmitError` 和状态、订阅类型。
Agent 不处理 HTTP、WebSocket、Cookie 或网络订阅编号；Server 负责封装网络消息。
Model 消息类型从 `@agent-learning/model` 的公开入口引用。

在仓库根目录安装 workspace 依赖后：

- `npm --prefix packages/model run build`：先输出模型类型。
- `npm --prefix packages/agent run build`：检查并输出 `dist/`。
- `npm --prefix packages/agent test`：验证接收、并发、历史、快照切点、独立消费、半截参数、订阅清理与运行关闭。
