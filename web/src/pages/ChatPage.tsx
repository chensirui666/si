import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelDiscovery } from '@agent-learning/model'
import { SettingsDialog } from '../components/SettingsDialog'
import { MessageInput } from '../components/MessageInput'
import { MessageList } from '../components/MessageList'
import { getModels as queryModels, subscribe as subscribeToChat } from '../chat/client'
import { initialState, type Subscribe } from '../chat/state'
import type { UserMessage } from '../types'

export function ChatPage({ subscribe = subscribeToChat, getModels = queryModels }: { subscribe?: Subscribe; getModels?: () => Promise<ModelDiscovery> }) {
  const [state, setState] = useState(initialState)
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const invalidateModels = useCallback(() => { requestVersion.current++ }, [])
  const refreshModels = useCallback(async () => {
    const version = ++requestVersion.current
    try {
      const result = await getModels()
      if (version !== requestVersion.current) return
      setDiscovery(result)
      setModelError(null)
    } catch (error) {
      if (version !== requestVersion.current) return
      setDiscovery(null)
      setModelError(error instanceof Error ? error.message : '模型查询失败，请重试')
    }
  }, [getModels])
  const applyModels = useCallback((result: ModelDiscovery) => {
    invalidateModels()
    setDiscovery(result)
    setModelError(null)
    void refreshModels()
  }, [invalidateModels, refreshModels])
  useEffect(() => {
    void refreshModels()
    let previousConnection = initialState.connection
    const stop = subscribe(next => {
      if (next.connection === 'ready' && previousConnection !== 'ready') void refreshModels()
      previousConnection = next.connection
      setState(next)
    }, () => { void refreshModels() })
    return () => { invalidateModels(); stop() }
  }, [subscribe, refreshModels, invalidateModels])
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
    <div className="chat-layout">
      <aside className="chat-sidebar" aria-label="侧栏">
        <div className="sidebar-title">Agent</div>
        <span className="sidebar-current">聊天</span>
        <SettingsDialog discovery={discovery} onChange={applyModels} />
      </aside>
      <div className="chat-workspace">
      <div className="chat-page" data-connection={state.connection}>
      <header className="chat-header">
        <h1>聊天</h1>
        <p className="connection-status" role="status">{status}</p>
      </header>
      <main className="chat-main">
        <MessageList messages={messages} />
        <div className="composer-stack">
          <div className="model-toolbar">
            <label htmlFor="chat-model">模型</label>
            <select id="chat-model" disabled={!discovery?.models.length}>
              {discovery?.models.length ? discovery.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)
                : <option>{modelError ? '模型查询失败' : discovery ? '无可用模型' : '正在查询模型…'}</option>}
            </select>
          </div>
          {(modelError || discovery?.deepseek.state === 'error') && <p className="model-error configuration-error" role="alert">{modelError ?? (discovery?.deepseek.state === 'error' ? discovery.deepseek.message : '')}</p>}
          <MessageInput onSend={() => false} sendDisabled />
        </div>
      </main>
      </div>
      </div>
    </div>
  )
}
