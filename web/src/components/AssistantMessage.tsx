import type { ActiveContent } from '@agent-learning/agent'
import type { AssistantMessage as Message } from '@agent-learning/model'
import { MarkdownText } from './markdown/MarkdownText'

export function AssistantMessage({ message, activeContent = [] }: { message: Message; activeContent?: readonly ActiveContent[] }) {
  const ending = message.stopReason === 'length' ? '达到长度限制，回答可能不完整'
    : message.stopReason === 'toolUse' ? '模型请求了工具调用，本阶段不执行工具'
    : message.stopReason === 'aborted' ? message.errorMessage ?? '回答已中止'
    : message.stopReason === 'error' ? message.errorMessage ?? '回答生成失败' : null
  return <div className="assistant-message">
    {message.content.map((block, index) => {
      const active = activeContent.find(item => item.contentIndex === index)
      if (block.type === 'text') return block.text ? <MarkdownText key={index} text={block.text} streaming={active?.type === 'text'} /> : null
      if (block.type === 'thinking') return block.thinking ? <details className="thinking-block" key={index}><summary>{active?.type === 'thinking' ? '思考中' : '思考过程'}</summary><MarkdownText text={block.thinking} streaming={active?.type === 'thinking'} /></details> : null
      return <div className="tool-block" key={index}>
        <div>工具请求{block.name && <>：<strong>{block.name}</strong></>}</div>
        <pre>{active?.type === 'toolCall' ? active.argumentsText : JSON.stringify(block.arguments, null, 2)}</pre>
        {block.argumentsError && <p className="message-error">{block.argumentsError}</p>}
      </div>
    })}
    {ending && <p className="message-ending" role={message.stopReason === 'error' || message.stopReason === 'aborted' ? 'alert' : undefined}>{ending}</p>}
  </div>
}
