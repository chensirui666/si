import { useCallback, useState } from 'react'
import type { ConversationSnapshot, SessionSummary } from '@agent-learning/server/protocol'
import type { ChatState, Subscribe } from '../chat/state'
import { recentSessionKey } from '../chat/drafts'
import { ChatPage } from '../pages/ChatPage'

const getModels = async () => ({ models: [], deepseek: { state: 'missing' as const } })
const getConfiguredModels = async () => ({ models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions', contextWindow: 1_048_576, maxTokens: 65_536 }], deepseek: { state: 'configured' as const } })

const workspace = { id: 'workspace-1', path: '/tmp/workspace', name: 'workspace', available: true }
const getEmptyWorkspaces = async () => ({ workspaces: [] })
const getConfiguredWorkspaces = async () => ({ workspaces: [workspace] })
const primarySession = { id: 'session-a', workspaceId: workspace.id, name: '会话 1', createdAt: '2026-11-09T08:00:00Z' }
const primarySessions = [primarySession]

// 只供组件测试；实际后端与服务商链路由 E2E 验证。
export function ChatPageHarness({ messages = [], modelConfigured = false, useWorkspaceApi = false, sessions = primarySessions }: {
  messages?: string[]; modelConfigured?: boolean; useWorkspaceApi?: boolean; sessions?: SessionSummary[]
}) {
  useState(() => {
    if (!useWorkspaceApi && sessions === primarySessions && !localStorage.getItem(recentSessionKey)) {
      localStorage.setItem(recentSessionKey, primarySession.id)
    }
  })
  const getSessions = useCallback(async () => sessions, [sessions])
  const subscribe: Subscribe = useCallback(onState => {
    let sessionId: string | null = null
    const snapshot: ConversationSnapshot = {
      seq: 0,
      messages: messages.map((content, index) => ({ id: `history-${index}`, message: { role: 'user', content, timestamp: index } })),
      running: null,
      compactions: [], contextUsage: null, activeContent: [],
    }
    const setSession = (id: string | null) => {
      sessionId = id
      onState({ sessionId, connection: 'ready', snapshot: id ? snapshot : null, slow: false, error: null })
    }
    const update = (event: Event) => {
      const next = (event as CustomEvent<ChatState>).detail
      onState({ ...next, sessionId: next.sessionId ?? sessionId })
    }
    window.addEventListener('chat-test-state', update)
    return Object.assign(() => window.removeEventListener('chat-test-state', update), { setSession })
  }, [messages])
  return <ChatPage subscribe={subscribe} getModels={modelConfigured ? getConfiguredModels : getModels}
    getWorkspaces={useWorkspaceApi ? undefined : modelConfigured ? getConfiguredWorkspaces : getEmptyWorkspaces}
    getSessions={useWorkspaceApi ? undefined : getSessions} />
}
