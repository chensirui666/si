# content

## 用处

压缩成功后，把较早对话的摘要放在保留原文之前，交给模型继续当前任务。

## 位置

[`buildModelHistory`](../../../packages/coding-agent/src/compaction.ts#L25-L36) 把这条 `UserMessage.content` 放在 `ModelContext.messages` 的最前面。[`AgentSession.context`](../../../packages/coding-agent/src/agent-session.ts#L91-L93) 用这份消息历史发起普通任务请求。

```ts
const message: UserMessage = {
  role: 'user', // 以用户消息的格式带回摘要。
  timestamp: latest.finishedAt, // 本次压缩完成时间。
  content: '…', // 下方的续接模板，summary 包含摘要正文和可选的文件操作清单。
}
```

## 原文

```text
此处之前的对话历史已压缩为以下摘要：

<summary>
${summary}
</summary>
```
