import { useCallback } from 'react'
import type { ConversationSnapshot } from '@agent-learning/agent'
import type { ChatState, Subscribe } from '../chat/state'
import { ChatPage } from '../pages/ChatPage'

const getModels = async () => ({ models: [], deepseek: { state: 'missing' as const } })
const getConfiguredModels = async () => ({ models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions' }], deepseek: { state: 'configured' as const } })

const getEmptyWorkspaces = async () => ({ workspaces: [], boundWorkspaceId: null })
const getConfiguredWorkspaces = async () => ({ workspaces: [{ id: 'workspace-1', path: '/tmp/workspace', name: 'workspace', available: true }], boundWorkspaceId: 'workspace-1' })

// 只供组件测试；实际后端与服务商链路由 E2E 验证。
export function ChatPageHarness({ messages = [], modelConfigured = false, useWorkspaceApi = false }: { messages?: string[]; modelConfigured?: boolean; useWorkspaceApi?: boolean }) {
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
  return <ChatPage subscribe={subscribe} getModels={modelConfigured ? getConfiguredModels : getModels} getWorkspaces={useWorkspaceApi ? undefined : modelConfigured ? getConfiguredWorkspaces : getEmptyWorkspaces} />
}
