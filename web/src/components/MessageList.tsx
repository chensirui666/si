import type { ActiveContent, ConversationMessage } from '@agent-learning/agent'
import type { LocalSubmission } from '../types'
import { AssistantMessage } from './AssistantMessage'

export function MessageList({ messages, activeContent = [] }: { messages: readonly (ConversationMessage | LocalSubmission)[]; activeContent?: readonly ActiveContent[] }) {
  return (
    <div className="message-list-frame">
      <section className="message-list" role="region" aria-label="消息列表" tabIndex={0}>
        <ol className="message-items">
          {messages.map(item => {
            if ('message' in item && item.message.role !== 'user' && item.message.role !== 'assistant') return null
            const local = 'state' in item ? item : null
            const id = 'id' in item ? item.id : item.clientMessageId
            const assistant = 'message' in item && item.message.role === 'assistant' ? item.message : null
            const text = local ? local.text : 'message' in item && item.message.role === 'user' ? typeof item.message.content === 'string' ? item.message.content : item.message.content.map(block => block.text).join('') : ''
            return <li className={`message-item${assistant ? ' message-item-assistant' : ''}`} key={id} data-message-id={id}>
              {assistant ? <AssistantMessage message={assistant} activeContent={activeContent.filter(block => block.messageId === id)} /> : <div className="message-text">{text}<br /></div>}
              {local && <div className="submission-status" data-state={local.state}>
                <span>{local.accepted ? '已接收，正在同步' : local.state === 'pending' ? '正在发送…' : local.state === 'failed' ? '发送失败' : '未确认接收'}</span>
                {local.errorMessage && <p>{local.errorMessage}</p>}
              </div>}
            </li>
          })}
        </ol>
      </section>
    </div>
  )
}
