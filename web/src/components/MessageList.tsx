import type { ActiveContent, ConversationMessage, RunningState } from '@agent-learning/server/protocol'
import type { LocalSubmission } from '../types'
import { AssistantMessage, type AssistantEntry } from './AssistantMessage'

type MessageRow =
  | { type: 'user'; id: string; text: string; local?: LocalSubmission }
  | { type: 'assistant'; id: string; userId: string; messages: AssistantEntry[] }

export function MessageList({ messages, activeContent = [], running = null }: {
  messages: readonly (ConversationMessage | LocalSubmission)[]
  activeContent?: readonly ActiveContent[]
  running?: RunningState
}) {
  const rows: MessageRow[] = []
  const toolResults = new Map<string, Map<number, ConversationMessage>>()
  let userId = ''
  for (const item of messages) {
    if ('state' in item) {
      if (item.kind === 'compaction') continue
      rows.push({ type: 'user', id: item.clientMessageId, text: item.text, local: item })
      continue
    }
    const { id, message, toolCall } = item
    if (message.role === 'user') {
      userId = id
      rows.push({ type: 'user', id, text: typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('') })
    } else if (message.role === 'assistant') {
      const previous = rows.at(-1)
      if (previous?.type === 'assistant') previous.messages.push({ id, message })
      else rows.push({ type: 'assistant', id, userId, messages: [{ id, message }] })
    } else if (message.role === 'toolResult' && toolCall) {
      const results = toolResults.get(toolCall.assistantMessageId) ?? new Map()
      results.set(toolCall.contentIndex, item)
      toolResults.set(toolCall.assistantMessageId, results)
    }
  }

  return (
    <div className="message-list-frame">
      <section className="message-list" role="region" aria-label="消息列表" tabIndex={0}>
        <ol className="message-items">
          {rows.map(row => <li className={`message-item${row.type === 'assistant' ? ' message-item-assistant' : ''}`} key={row.id} data-message-id={row.id}>
            {row.type === 'assistant'
              ? <AssistantMessage messages={row.messages} activeContent={activeContent} toolResults={toolResults}
                running={running?.kind === 'task' && (row.userId === running.runId || row.messages.some(entry => entry.id === running.assistantMessageId)) ? running : null} />
              : <>
                <div className="message-text">{row.text}<br /></div>
                {row.local && <div className="submission-status" data-state={row.local.state}>
                  <span>{row.local.accepted ? '已接收，正在同步' : row.local.state === 'pending' ? '正在发送…' : row.local.state === 'failed' ? '发送失败' : '未确认接收'}</span>
                  {row.local.errorMessage && <p>{row.local.errorMessage}</p>}
                </div>}
              </>}
          </li>)}
        </ol>
      </section>
    </div>
  )
}
