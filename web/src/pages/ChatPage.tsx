import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelDiscovery } from '@agent-learning/model'
import type { SubmitMessageAccepted, SubmitMessageRequest } from '@agent-learning/server/protocol'
import { SettingsDialog } from '../components/SettingsDialog'
import { MessageInput } from '../components/MessageInput'
import { MessageList } from '../components/MessageList'
import { getModels as queryModels, submitMessage as postMessage, subscribe as subscribeToChat } from '../chat/client'
import { initialState, mergeSubmissions, settleSubmission, type Subscribe, type Subscription } from '../chat/state'
import type { LocalSubmission } from '../types'

type Props = { subscribe?: Subscribe; getModels?: () => Promise<ModelDiscovery>; submitMessage?: (input: SubmitMessageRequest) => Promise<SubmitMessageAccepted> }

export function ChatPage({ subscribe = subscribeToChat, getModels = queryModels, submitMessage = postMessage }: Props) {
  const [state, setState] = useState(initialState)
  const stateRef = useRef(state)
  const [submissions, setSubmissions] = useState<LocalSubmission[]>([])
  const submissionsRef = useRef(submissions)
  const subscription = useRef<Subscription | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const mounted = useRef(false)
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null)
  const discoveryRef = useRef(discovery)
  const [modelId, setModelId] = useState('')
  const modelIdRef = useRef(modelId)
  const [modelError, setModelError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const updateSubmissions = useCallback((next: LocalSubmission[]) => {
    const merged = mergeSubmissions(stateRef.current.snapshot?.messages ?? [], next)
    const unresolved = merged.filter((item): item is LocalSubmission => 'state' in item)
    submissionsRef.current = unresolved
    setSubmissions(unresolved)
  }, [])
  const invalidateModels = useCallback(() => { requestVersion.current++ }, [])
  const receiveModels = useCallback((result: ModelDiscovery | null) => {
    discoveryRef.current = result
    setDiscovery(result)
    const selected = result?.models.some(model => model.id === modelIdRef.current) ? modelIdRef.current : result?.models[0]?.id ?? ''
    modelIdRef.current = selected
    setModelId(selected)
  }, [])
  const refreshModels = useCallback(async () => {
    const version = ++requestVersion.current
    try {
      const result = await getModels()
      if (version !== requestVersion.current) return
      receiveModels(result)
      setModelError(null)
    } catch (error) {
      if (version !== requestVersion.current) return
      receiveModels(null)
      setModelError(error instanceof Error ? error.message : '模型查询失败，请重试')
    }
  }, [getModels, receiveModels])
  const applyModels = useCallback((result: ModelDiscovery) => {
    invalidateModels()
    receiveModels(result)
    setModelError(null)
    void refreshModels()
  }, [invalidateModels, receiveModels, refreshModels])
  useEffect(() => {
    mounted.current = true
    void refreshModels()
    let previousConnection = initialState.connection
    const stop = subscribe(next => {
      if (next.connection === 'ready' && previousConnection !== 'ready') void refreshModels()
      previousConnection = next.connection
      stateRef.current = next
      updateSubmissions(submissionsRef.current)
      setState(next)
    }, () => { void refreshModels() })
    subscription.current = stop
    return () => {
      mounted.current = false
      invalidateModels()
      stop()
      subscription.current = null
      for (const timer of timers.current) clearTimeout(timer)
      timers.current.clear()
    }
  }, [subscribe, refreshModels, invalidateModels, updateSubmissions])

  const canSubmit = () => stateRef.current.connection === 'ready' && stateRef.current.snapshot !== null && stateRef.current.snapshot.running === null
    && discoveryRef.current?.deepseek.state === 'configured' && discoveryRef.current.models.some(model => model.id === modelIdRef.current)
    && !submissionsRef.current.some(local => local.state !== 'failed')

  const send = (text: string) => {
    if (!text.trim() || !canSubmit()) return false
    const input: SubmitMessageRequest = { clientMessageId: crypto.randomUUID(), modelId: modelIdRef.current, text }
    const local: LocalSubmission = { ...input, state: 'pending', afterMessageId: stateRef.current.snapshot?.messages.at(-1)?.id }
    // 同步写门禁，React 渲染前的第二次发送手势也会被拦住。
    const previous = submissionsRef.current
    submissionsRef.current = [...previous, local]
    let request: Promise<SubmitMessageAccepted>
    try { request = submitMessage(input) }
    catch { submissionsRef.current = previous; return false }
    updateSubmissions(submissionsRef.current)
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      if (!mounted.current || !submissionsRef.current.some(item => item.clientMessageId === input.clientMessageId && item.state !== 'failed')) return
      updateSubmissions(settleSubmission(submissionsRef.current, input.clientMessageId, { state: 'unconfirmed', errorMessage: '十秒内未确认接收，正在重新同步' }))
      subscription.current?.requestSnapshot?.()
    }, 10_000)
    timers.current.add(timer)
    void request.then(accepted => {
      if (!mounted.current) return
      updateSubmissions(settleSubmission(submissionsRef.current, input.clientMessageId, { accepted, state: 'pending', errorMessage: undefined }))
    }, error => {
      if (!mounted.current) return
      const rejected = typeof error?.status === 'number' && error.status >= 400 && error.status < 500
      const message = error instanceof Error ? error.message : '提交异常，未确认接收'
      const local = submissionsRef.current.find(item => item.clientMessageId === input.clientMessageId)
      if (!local || local.accepted) return
      updateSubmissions(settleSubmission(submissionsRef.current, input.clientMessageId, { state: rejected ? 'failed' : 'unconfirmed', errorMessage: message }))
      if (!rejected) subscription.current?.requestSnapshot?.()
    }).finally(() => { clearTimeout(timer); timers.current.delete(timer) })
    return true
  }

  const messages = mergeSubmissions(state.snapshot?.messages ?? [], submissions)
  const waiting = submissions.some(local => local.state !== 'failed')
  const status = state.error ?? (state.slow ? '连接较慢，正在等待对话恢复…' : {
    connecting: '正在连接…', awaitingSnapshot: '正在恢复对话…',
    ready: state.snapshot?.running ? '正在生成回答…' : waiting ? '正在确认消息接收…' : '对话已同步',
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
        <MessageList messages={messages} activeContent={state.snapshot?.activeContent} />
        <div className="composer-stack">
          <div className="model-toolbar">
            <label htmlFor="chat-model">模型</label>
            <select id="chat-model" value={modelId} onChange={event => { modelIdRef.current = event.target.value; setModelId(event.target.value) }} disabled={!discovery?.models.length}>
              {discovery?.models.length ? discovery.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)
                : <option value="">{modelError ? '模型查询失败' : discovery ? '无可用模型' : '正在查询模型…'}</option>}
            </select>
          </div>
          {(modelError || discovery?.deepseek.state === 'error') && <p className="model-error configuration-error" role="alert">{modelError ?? (discovery?.deepseek.state === 'error' ? discovery.deepseek.message : '')}</p>}
          <MessageInput onSend={send} sendDisabled={!canSubmit()} />
        </div>
      </main>
      </div>
      </div>
    </div>
  )
}
