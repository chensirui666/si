import { useCallback } from 'react'
import type { ConversationSnapshot } from '@agent-learning/agent'
import type { ChatState, Subscribe } from '../chat/state'
import { ChatPage } from '../pages/ChatPage'

// 只供组件测试：真实服务阶段一始终提供空对话。
export function ChatPageHarness({ messages = [] }: { messages?: string[] }) {
  const subscribe: Subscribe = useCallback(onState => {
    const snapshot: ConversationSnapshot = {
      seq: 0,
      messages: messages.map((content, index) => ({ id: `history-${index}`, message: { role: 'user', content, timestamp: index } })),
      running: null,
      activeContent: [],
    }
    onState({ connection: 'ready', snapshot, slow: false, error: null })
    const update = (event: Event) => onState((event as CustomEvent<ChatState>).detail)
    window.addEventListener('chat-test-state', update)
    return () => window.removeEventListener('chat-test-state', update)
  }, [messages])
  return <ChatPage subscribe={subscribe} />
}
