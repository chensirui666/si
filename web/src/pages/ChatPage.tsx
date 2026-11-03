import { useEffect, useState } from 'react'
import { MessageInput } from '../components/MessageInput'
import { MessageList } from '../components/MessageList'
import { subscribe as subscribeToChat } from '../chat/client'
import { initialState, type Subscribe } from '../chat/state'
import type { UserMessage } from '../types'

export function ChatPage({ subscribe = subscribeToChat }: { subscribe?: Subscribe }) {
  const [state, setState] = useState(initialState)
  useEffect(() => subscribe(setState), [subscribe])
  const messages: UserMessage[] = (state.snapshot?.messages ?? []).flatMap(({ id, message }) => message.role === 'user'
    ? [{ id, role: 'user', text: typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('') }]
    : [])
  const status = state.error ?? (state.slow ? '连接较慢，正在等待对话恢复…' : {
    connecting: '正在连接…',
    awaitingSnapshot: '正在恢复对话…',
    ready: '对话已同步，发送暂未开放',
    disconnected: '连接已断开，正在重试…',
  }[state.connection])

  return (
    <div className="chat-page" data-connection={state.connection}>
      <header className="chat-header">
        <h1>聊天</h1>
        <p className="connection-status" role="status">{status}</p>
      </header>
      <main className="chat-main">
        <MessageList messages={messages} />
        <MessageInput onSend={() => false} sendDisabled />
      </main>
    </div>
  )
}
