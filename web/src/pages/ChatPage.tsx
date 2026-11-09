import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelDiscovery } from '@agent-learning/model'
import type { AbortRequest, AbortResult, SubmitMessageAccepted, SubmitMessageRequest, WorkspaceView } from '@agent-learning/server/protocol'
import { SettingsDialog } from '../components/SettingsDialog'
import { MessageInput } from '../components/MessageInput'
import { ContextMeter } from '../components/ContextMeter'
import { CompactionRecords } from '../components/CompactionRecords'
import { MessageList } from '../components/MessageList'
import { getModels as queryModels, getWorkspaces as queryWorkspaces, pickWorkspace as chooseWorkspace, getWebSettings, abortMessage as postAbort, submitMessage as postMessage, subscribe as subscribeToChat } from '../chat/client'
import { Button } from '../components/ui/button'
import { initialState, mergeSubmissions, settleSubmission, type Subscribe, type Subscription } from '../chat/state'
import type { LocalSubmission } from '../types'

type Props = {
  subscribe?: Subscribe
  getModels?: () => Promise<ModelDiscovery>
  getWorkspaces?: () => Promise<WorkspaceView>
  submitMessage?: (input: SubmitMessageRequest) => Promise<SubmitMessageAccepted>
  abortMessage?: (input: AbortRequest) => Promise<AbortResult>
}

type AbortState = { runId: string; status: 'pending' | 'unconfirmed'; error?: string }

function useServerView<T>(load: () => Promise<T>) {
  const [view, setView] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const version = useRef(0)
  const invalidate = useCallback(() => { version.current++ }, [])
  const apply = useCallback((value: T) => {
    invalidate()
    setView(value)
    setError(null)
  }, [invalidate])
  const refresh = useCallback(async () => {
    const request = ++version.current
    try {
      const value = await load()
      if (request === version.current) apply(value)
    } catch (error) {
      if (request !== version.current) return
      setView(null)
      setError(error instanceof Error ? error.message : '读取配置失败，请重试')
    }
  }, [apply, load])
  return { view, error, apply, refresh, invalidate }
}

function FolderIcon({ add = false }: { add?: boolean }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={add ? 'M10 5H3v11h14v-5M15 3v6m-3-3h6' : 'M2 15V5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v1M2 15l2-6h14l-2 7H3a1 1 0 0 1-1-1Z'} />
  </svg>
}

export function ChatPage({ subscribe = subscribeToChat, getModels = queryModels, getWorkspaces = queryWorkspaces, submitMessage = postMessage, abortMessage = postAbort }: Props) {
  const [state, setState] = useState(initialState)
  const stateRef = useRef(state)
  const [submissions, setSubmissions] = useState<LocalSubmission[]>([])
  const submissionsRef = useRef(submissions)
  const subscription = useRef<Subscription | null>(null)
  const [abortState, setAbortState] = useState<AbortState | null>(null)
  const abortRef = useRef(abortState)
  const updateAbort = (next: AbortState | null) => { abortRef.current = next; setAbortState(next) }
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const mounted = useRef(false)
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null)
  const discoveryRef = useRef(discovery)
  const [modelId, setModelId] = useState('')
  const modelIdRef = useRef(modelId)
  const [modelError, setModelError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const { view: workspaces, error: workspaceError, apply: applyWorkspaces, refresh: refreshWorkspaces, invalidate: invalidateWorkspaces } = useServerView(getWorkspaces)
  const { view: webSettings, error: webSettingsError, apply: applyWebSettings, refresh: refreshWebSettings, invalidate: invalidateWebSettings } = useServerView(getWebSettings)
  // undefined marks the first load, when an existing binding opens its conversation.
  const [openedWorkspaceId, setOpenedWorkspaceId] = useState<string | null>()
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const boundWorkspace = workspaces?.workspaces.find(workspace => workspace.id === workspaces.boundWorkspaceId)
  const selectedWorkspaceId = openedWorkspaceId === undefined ? workspaces?.boundWorkspaceId : openedWorkspaceId
  const opened = !!boundWorkspace && selectedWorkspaceId === boundWorkspace.id

  useEffect(() => {
    if (workspaces) setOpenedWorkspaceId(previous => previous === undefined ? workspaces.boundWorkspaceId : previous)
  }, [workspaces])

  async function pickWorkspace() {
    if (pickingRef.current || !workspaces || workspaces.workspaces.length) return
    pickingRef.current = true
    setPicking(true)
    setPickError(null)
    try {
      const result = await chooseWorkspace()
      if (!mounted.current || result.cancelled) return
      setOpenedWorkspaceId(null)
      applyWorkspaces(result.view)
      void refreshWorkspaces()
    } catch (error) {
      if (mounted.current) setPickError(error instanceof Error ? error.message : '选择工作区失败，请重试')
    } finally {
      pickingRef.current = false
      if (mounted.current) setPicking(false)
    }
  }

  const updateSubmissions = useCallback((next: LocalSubmission[]) => {
    const merged = mergeSubmissions(stateRef.current.snapshot?.messages ?? [], next, stateRef.current.snapshot?.compactions)
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
    void refreshWorkspaces()
    void refreshWebSettings()
    let previousConnection = initialState.connection
    const stop = subscribe(next => {
      if (next.connection === 'ready' && previousConnection !== 'ready') {
        void refreshModels()
        void refreshWorkspaces()
        void refreshWebSettings()
      }
      previousConnection = next.connection
      stateRef.current = next
      if (next.connection === 'ready' && next.snapshot && abortRef.current
        && next.snapshot.running?.runId !== abortRef.current.runId) updateAbort(null)
      updateSubmissions(submissionsRef.current)
      setState(next)
    }, refreshModels, refreshWorkspaces, refreshWebSettings)
    subscription.current = stop
    return () => {
      mounted.current = false
      invalidateModels()
      invalidateWorkspaces()
      invalidateWebSettings()
      stop()
      subscription.current = null
      for (const timer of timers.current) clearTimeout(timer)
      timers.current.clear()
    }
  }, [subscribe, refreshModels, refreshWorkspaces, refreshWebSettings, invalidateModels, invalidateWorkspaces, invalidateWebSettings, updateSubmissions])

  const canSubmit = () => opened && boundWorkspace.available && stateRef.current.connection === 'ready' && stateRef.current.snapshot !== null && stateRef.current.snapshot.running === null
    && discoveryRef.current?.deepseek.state === 'configured' && discoveryRef.current.models.some(model => model.id === modelIdRef.current)
    && !submissionsRef.current.some(local => local.state !== 'failed')

  const send = (text: string, restoreDraft: () => void) => {
    if (!text.trim() || !boundWorkspace || !canSubmit()) return false
    const input: SubmitMessageRequest = { clientMessageId: crypto.randomUUID(), modelId: modelIdRef.current, workspaceId: boundWorkspace.id, text }
    const local: LocalSubmission = { ...input, kind: text.trim() === '/compact' ? 'compaction' : 'message', state: 'pending', afterMessageId: stateRef.current.snapshot?.messages.at(-1)?.id }
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
      if (rejected) {
        restoreDraft()
        void refreshWorkspaces()
      } else subscription.current?.requestSnapshot?.()
    }).finally(() => { clearTimeout(timer); timers.current.delete(timer) })
    return true
  }

  const messages = mergeSubmissions(state.snapshot?.messages ?? [], submissions.filter(local => local.kind === 'message'))
  const waiting = submissions.some(local => local.state !== 'failed')
  const target = state.snapshot?.running?.runId
  const activeAbort = abortState?.runId === target ? abortState : null
  const abortDisabled = !target || (activeAbort?.status === 'unconfirmed' && state.connection !== 'ready')
  const action = target || waiting ? activeAbort?.status === 'pending' ? 'aborting' : 'abort' : 'send'
  const abort = async (runId: string | undefined) => {
    if (!runId || stateRef.current.snapshot?.running?.runId !== runId
      || abortRef.current?.runId === runId && abortRef.current.status === 'pending') return
    updateAbort({ runId, status: 'pending' })
    try {
      await abortMessage({ runId })
      if (!mounted.current || abortRef.current?.runId !== runId) return
      subscription.current?.requestSnapshot?.()
    } catch (error) {
      if (!mounted.current || abortRef.current?.runId !== runId) return
      updateAbort({ runId, status: 'unconfirmed', error: error instanceof Error ? error.message : '中止请求失败' })
      subscription.current?.requestSnapshot?.()
    }
  }
  const status = state.error ?? (state.slow ? '连接较慢，正在等待对话恢复…' : {
    connecting: '正在连接…', awaitingSnapshot: '正在恢复对话…',
    ready: state.snapshot?.running?.phase === 'compaction' ? '正在压缩对话…' : state.snapshot?.running?.phase === 'tools' ? '正在执行工具…' : state.snapshot?.running ? '正在生成回答…' : waiting ? '正在确认消息接收…' : '对话已同步',
    disconnected: '连接已断开，正在重试…',
  }[state.connection])

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar" aria-label="侧栏">
        <div className="sidebar-title">Agent</div>
        <nav className="sidebar-workspaces" aria-label="工作区">
          <div className="sidebar-workspaces-heading">
            <span>工作区</span>
            <Button variant="ghost" size="icon-sm" aria-label="添加工作区" title="添加工作区" disabled={picking || !workspaces || workspaces.workspaces.length > 0} onClick={() => { void pickWorkspace() }}>
              <FolderIcon add />
            </Button>
          </div>
          {workspaces?.workspaces.map(workspace => <div className="sidebar-workspace" key={workspace.id}>
            <div className="workspace-row" data-bound={workspace.id === boundWorkspace?.id} title={workspace.path}><FolderIcon /><span>{workspace.name}</span></div>
            {workspace.id === boundWorkspace?.id && <Button className="workspace-conversation" variant={opened ? 'secondary' : 'ghost'} aria-current={opened ? 'page' : undefined} onClick={() => setOpenedWorkspaceId(workspace.id)}>当前对话</Button>}
          </div>)}
          {(workspaceError || pickError) && <p className="configuration-error" role="alert">{workspaceError ?? pickError}</p>}
        </nav>
        <SettingsDialog discovery={discovery} onChange={applyModels} webSettings={webSettings} webSettingsError={webSettingsError} onWebSettingsChange={result => {
          if (!mounted.current) return
          applyWebSettings(result)
          void refreshWebSettings()
        }} />
      </aside>
      <div className="chat-workspace">
      <div className="chat-page" data-connection={state.connection}>
      <header className="chat-header">
        <h1>聊天</h1>
        <p className="connection-status" role="status">{status}</p>
      </header>
      <main className="chat-main">
        <MessageList messages={messages} activeContent={state.snapshot?.activeContent} running={state.snapshot?.running} />
        <div className="composer-stack">
          <div className="model-toolbar">
            <label htmlFor="chat-model">模型</label>
            <select id="chat-model" value={modelId} onChange={event => { modelIdRef.current = event.target.value; setModelId(event.target.value) }} disabled={!discovery?.models.length}>
              {discovery?.models.length ? discovery.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)
                : <option value="">{modelError ? '模型查询失败' : discovery ? '无可用模型' : '正在查询模型…'}</option>}
            </select>
            <span className="workspace-path" title={boundWorkspace?.path}>
              {boundWorkspace && <FolderIcon />}
              {boundWorkspace ? <>
                <span className="workspace-path-full">{boundWorkspace.path}</span>
                <span className="workspace-path-name">{boundWorkspace.name}</span>
              </> : <span>{workspaces ? '请先添加工作区' : workspaceError ? '工作区读取失败' : '正在读取工作区…'}</span>}
            </span>
          </div>
          {boundWorkspace && !boundWorkspace.available && <p className="model-error configuration-error" role="alert">工作区目录不可用</p>}
          {(modelError || discovery?.deepseek.state === 'error') && <p className="model-error configuration-error" role="alert">{modelError ?? (discovery?.deepseek.state === 'error' ? discovery.deepseek.message : '')}</p>}
          {activeAbort?.status === 'unconfirmed' && <p className="configuration-error" role="alert">中止未确认：{activeAbort.error}，正在核对后台状态。</p>}
          <CompactionRecords records={state.snapshot?.compactions ?? []} messages={state.snapshot?.messages ?? []} pending={submissions.filter(local => local.kind === 'compaction')} />
          <MessageInput contextMeter={<ContextMeter usage={state.snapshot?.contextUsage} />} onSend={send} sendDisabled={!canSubmit()} action={action} abortDisabled={abortDisabled} onAbort={() => { void abort(target) }} />
        </div>
      </main>
      </div>
      </div>
    </div>
  )
}
