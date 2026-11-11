import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpenIcon, FolderPlusIcon, PlusIcon } from 'lucide-react'
import type { ModelDiscovery } from '@agent-learning/model'
import type { AbortRequest, AbortResult, SessionSummary, StartSessionAccepted, StartSessionRequest, SubmitMessageAccepted, SubmitMessageRequest, WorkspaceView } from '@agent-learning/server/protocol'
import { SettingsButton, SettingsDialog } from '../components/SettingsDialog'
import { MessageInput } from '../components/MessageInput'
import { ContextMeter } from '../components/ContextMeter'
import { CompactionRecords } from '../components/CompactionRecords'
import { MessageList } from '../components/MessageList'
import { getModels as queryModels, getWorkspaces as queryWorkspaces, pickWorkspace as chooseWorkspace, getSessions as querySessions, startSession as postFirstMessage, getWebSettings, abortMessage as postAbort, submitMessage as postMessage, subscribe as subscribeToChat } from '../chat/client'
import { Button } from '../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Sidebar, SidebarDismiss, SidebarProvider, SidebarTrigger } from '../components/ui/sidebar'
import { initialState, mergeSubmissions, settleSubmission, type Subscribe, type Subscription } from '../chat/state'
import type { LocalSubmission } from '../types'
import { newSessionDraft, readFirstSend, recentSessionKey, recentWorkspaceKey, useDrafts, writeFirstSend } from '../chat/drafts'

type Props = {
  subscribe?: Subscribe
  getModels?: () => Promise<ModelDiscovery>
  getSessions?: () => Promise<SessionSummary[]>
  startSession?: (input: StartSessionRequest) => Promise<StartSessionAccepted>
  pickWorkspace?: typeof chooseWorkspace
  getWorkspaces?: () => Promise<WorkspaceView>
  submitMessage?: (input: SubmitMessageRequest) => Promise<SubmitMessageAccepted>
  abortMessage?: (input: AbortRequest) => Promise<AbortResult>
}

type FirstSend = { input: StartSessionRequest; revision: number; sending: boolean }

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
      setError(error instanceof Error ? error.message : '读取配置失败，请重试')
    }
  }, [apply, load])
  return { view, error, apply, refresh, invalidate, setView }
}

export function ChatPage({ subscribe = subscribeToChat, getModels = queryModels, getWorkspaces = queryWorkspaces, getSessions = querySessions, startSession = postFirstMessage, pickWorkspace: pickDirectory = chooseWorkspace, submitMessage = postMessage, abortMessage = postAbort }: Props) {
  const [state, setState] = useState(initialState)
  const { sessionId } = state
  const stateRef = useRef(state)
  const [allSubmissions, setSubmissions] = useState<LocalSubmission[]>([])
  const submissionsRef = useRef(allSubmissions)
  const subscription = useRef<Subscription | null>(null)
  const [aborts, setAborts] = useState(new Map<string, AbortState>())
  const abortRef = useRef(aborts)
  const updateAbort = useCallback((sessionId: string, next: AbortState | null) => {
    const current = new Map(abortRef.current)
    if (next) current.set(sessionId, next)
    else current.delete(sessionId)
    abortRef.current = current
    setAborts(current)
  }, [])
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
  const { view: sessions, error: listError, refresh: refreshSessions, invalidate: invalidateSessions, setView: setSessions } = useServerView(getSessions)
  const selected = useRef<string | null>(null)
  const initialized = useRef(false)
  const navigation = useRef(0)
  const opening = useRef(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null)
  const firstSend = useRef<FirstSend | null>(null)
  const [firstPhase, setFirstPhase] = useState<'sending' | 'unconfirmed' | null>(null)
  const [firstError, setFirstError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<{ sessionId: string | null; text: string } | null>(null)
  useEffect(() => {
    if (!saveNotice) return
    const timer = setTimeout(() => setSaveNotice(null), 3000)
    return () => clearTimeout(timer)
  }, [saveNotice])
  const [pickError, setPickError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const sidebarButton = useRef<HTMLButtonElement>(null)
  const { draft, storageUnavailable, load: loadDraft, save: saveDraft, restore: restoreDraft, read: readStorage, write: writeStorage, revision: draftRevision, clearSent: clearSentDraft } = useDrafts()
  const session = sessions?.find(item => item.id === sessionId)
  const workspace = workspaces?.workspaces.find(item => item.id === session?.workspaceId)
  const pendingInput = firstSend.current?.input
  const draftWorkspace = workspaces?.workspaces.find(item => item.id === (pendingInput?.workspaceId ?? draftWorkspaceId))
  const isNew = sessionId === null
  const submissions = allSubmissions.filter(item => item.sessionId === sessionId)

  const openSession = useCallback((id: string | null, userAction = false) => {
    initialized.current = true
    if (userAction) navigation.current++
    setSessionError(null)
    if (selected.current === id) {
      if (id && userAction && stateRef.current.error) subscription.current?.requestSnapshot?.()
      return
    }
    selected.current = id
    opening.current = id !== null
    loadDraft(id ?? newSessionDraft)
    stateRef.current = { ...stateRef.current, sessionId: id, snapshot: null }
    setState(stateRef.current)
    subscription.current?.setSession(id)
  }, [loadDraft])

  useEffect(() => {
    setDraftWorkspaceId(readStorage(recentWorkspaceKey) ?? null)
    if (selected.current === null) loadDraft(newSessionDraft)
    const pending = readFirstSend()
    if (pending) {
      firstSend.current = { input: pending, revision: draftRevision(newSessionDraft), sending: false }
      setFirstPhase('unconfirmed')
    }
  }, [draftRevision, loadDraft, readStorage])

  const saveCurrentDraft = useCallback((text: string) => {
    if (sessionId === selected.current) saveDraft(sessionId ?? newSessionDraft, text)
  }, [sessionId, saveDraft])

  function chooseDraftWorkspace(id: string) {
    navigation.current++
    setDraftWorkspaceId(id)
    writeStorage(recentWorkspaceKey, id)
    setFirstError(null)
  }

  function openNewSession(workspaceId?: string) {
    openSession(null, true)
    if (workspaceId) chooseDraftWorkspace(workspaceId)
  }

  const finishFirstSend = useCallback((session: SessionSummary) => {
    const pending = firstSend.current
    if (!pending || pending.input.clientMessageId !== session.id || pending.input.workspaceId !== session.workspaceId) return
    firstSend.current = null
    writeFirstSend(null)
    setFirstPhase(null)
    setFirstError(null)
    clearSentDraft(newSessionDraft, pending.input.text, pending.revision)
    if (selected.current === null) openSession(session.id)
  }, [clearSentDraft, openSession])

  function attemptFirstSend(pending: FirstSend) {
    if (pending.sending || stateRef.current.connection !== 'ready') return
    const retrying = firstPhase === 'unconfirmed'
    pending.sending = true
    setFirstPhase('sending')
    setFirstError(null)
    void Promise.resolve().then(() => startSession(pending.input)).then(({ session: created }) => {
      if (!mounted.current || firstSend.current !== pending) return
      invalidateSessions()
      setSessions(previous => previous?.some(item => item.id === created.id) ? previous : [...previous ?? [], created])
      finishFirstSend(created)
      void refreshSessions()
    }, error => {
      if (!mounted.current || firstSend.current !== pending) return
      pending.sending = false
      const status = error?.status
      const authorizationRejected = status === 401 || status === 403
      const saveRejected = error?.code === 'save_rejected'
      const rejected = saveRejected || typeof status === 'number' && status >= 400 && status < 500
      if (rejected && !(retrying && authorizationRejected)) {
        firstSend.current = null
        writeFirstSend(null)
        setFirstPhase(null)
        const text = error instanceof Error ? error.message : '首条消息被拒绝，请重试。'
        if (saveRejected) setSaveNotice({ sessionId: null, text })
        else setFirstError(text)
        void refreshWorkspaces()
      } else {
        setFirstPhase('unconfirmed')
        if (authorizationRejected && error instanceof Error) setFirstError(error.message)
        void refreshSessions()
      }
    })
  }

  async function pickWorkspace() {
    if (pickingRef.current || !workspaces) return
    const request = navigation.current
    pickingRef.current = true
    setPicking(true)
    setPickError(null)
    try {
      const result = await pickDirectory()
      if (!mounted.current || result.cancelled) return
      applyWorkspaces(result.view)
      void refreshWorkspaces()
      if (selected.current === null && !firstSend.current && request === navigation.current) chooseDraftWorkspace(result.workspaceId)
    } catch (error) {
      if (mounted.current) setPickError(error instanceof Error ? error.message : '选择工作区失败，请重试')
    } finally {
      pickingRef.current = false
      if (mounted.current) setPicking(false)
    }
  }

  const updateSubmissions = useCallback((next: LocalSubmission[]) => {
    const { sessionId, snapshot } = stateRef.current
    const current = next.filter(item => item.sessionId === sessionId)
    const merged = mergeSubmissions(snapshot?.messages ?? [], current, snapshot?.compactions)
    const unresolved = [...next.filter(item => item.sessionId !== sessionId), ...merged.filter((item): item is LocalSubmission => 'state' in item)]
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
    void refreshSessions()
    let needsRefresh = true
    const stop = subscribe(next => {
      if (next.sessionId !== selected.current) return
      if (next.connection === 'disconnected' || next.connection === 'connecting') needsRefresh = true
      if (next.connection === 'ready' && needsRefresh) {
        needsRefresh = false
        void refreshModels()
        void refreshWorkspaces()
        void refreshWebSettings()
        void refreshSessions()
      }
      if (next.connection === 'ready' && next.sessionId) {
        if (next.snapshot) {
          const pendingAbort = abortRef.current.get(next.sessionId)
          if (pendingAbort && next.snapshot.running?.runId !== pendingAbort.runId) updateAbort(next.sessionId, null)
          if (opening.current) {
            opening.current = false
            writeStorage(recentSessionKey, next.sessionId)
          }
        } else if (next.error) {
          setSessionError(next.error)
          void refreshSessions()
        }
      }
      stateRef.current = next
      updateSubmissions(submissionsRef.current)
      setState(next)
    }, refreshModels, refreshWorkspaces, refreshWebSettings, refreshSessions)
    subscription.current = stop
    stop.setSession(selected.current)
    return () => {
      mounted.current = false
      invalidateModels()
      invalidateWorkspaces()
      invalidateWebSettings()
      invalidateSessions()
      stop()
      subscription.current = null
      for (const timer of timers.current) clearTimeout(timer)
      timers.current.clear()
    }
  }, [subscribe, refreshModels, refreshWorkspaces, refreshWebSettings, refreshSessions, invalidateModels, invalidateWorkspaces, invalidateWebSettings, invalidateSessions, updateSubmissions, updateAbort, writeStorage])

  useEffect(() => {
    if (!sessions) return
    if (!initialized.current) {
      initialized.current = true
      const recent = readStorage(recentSessionKey)
      if (!recent) return
      if (sessions.some(item => item.id === recent)) {
        openSession(recent)
        return
      }
    } else if (!selected.current || sessions.some(item => item.id === selected.current)) return
    openSession(null)
    setSessionError('之前打开的会话已不可用，请选择或新建会话。')
  }, [sessions, openSession, readStorage])

  useEffect(() => {
    const sent = sessions?.find(item => item.id === firstSend.current?.input.clientMessageId)
    if (sent) finishFirstSend(sent)
  }, [sessions, finishFirstSend])

  const hasModel = () => discoveryRef.current?.deepseek.state === 'configured'
    && discoveryRef.current.models.some(model => model.id === modelIdRef.current)
  const canStart = () => selected.current === null && draftWorkspace?.available && !workspaceError && !pickingRef.current
    && stateRef.current.connection === 'ready' && hasModel() && !firstSend.current
  const canSubmit = () => !!sessionId && sessionId === selected.current && workspace?.available && !workspaceError && stateRef.current.sessionId === sessionId && stateRef.current.connection === 'ready' && stateRef.current.snapshot !== null && stateRef.current.snapshot.running === null
    && hasModel()
    && !submissionsRef.current.some(local => local.sessionId === sessionId && local.state !== 'failed')

  const send = (text: string) => {
    if (!text.trim()) return false
    if (sessionId === null) {
      if (!canStart() || !draftWorkspace) return false
      if (text.trim() === '/compact') {
        setFirstError('请先发送消息，有聊天记录后再压缩。')
        return false
      }
      const pending = firstSend.current = {
        input: { workspaceId: draftWorkspace.id, clientMessageId: crypto.randomUUID(), modelId: modelIdRef.current, text },
        revision: draftRevision(newSessionDraft), sending: false,
      }
      writeFirstSend(pending.input)
      attemptFirstSend(pending)
      // Keep the text until the server accepts the first message.
      return false
    }
    if (!canSubmit()) return false
    const input: SubmitMessageRequest = { clientMessageId: crypto.randomUUID(), modelId: modelIdRef.current, sessionId, text }
    const clearedRevision = draftRevision(sessionId) + 1
    const syncTarget = () => {
      if (selected.current === sessionId) subscription.current?.requestSnapshot?.()
    }
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
      syncTarget()
    }, 10_000)
    timers.current.add(timer)
    void request.then(accepted => {
      if (!mounted.current) return
      updateSubmissions(settleSubmission(submissionsRef.current, input.clientMessageId, { accepted, state: 'pending', errorMessage: undefined }))
    }, error => {
      if (!mounted.current) return
      const saveRejected = error?.code === 'save_rejected'
      const rejected = saveRejected || typeof error?.status === 'number' && error.status >= 400 && error.status < 500
      const message = error instanceof Error ? error.message : '提交异常，未确认接收'
      const local = submissionsRef.current.find(item => item.clientMessageId === input.clientMessageId)
      if (!local || local.accepted) return
      if (saveRejected) {
        updateSubmissions(submissionsRef.current.filter(item => item.clientMessageId !== input.clientMessageId))
        setSaveNotice({ sessionId, text: message })
      } else updateSubmissions(settleSubmission(submissionsRef.current, input.clientMessageId, { state: rejected ? 'failed' : 'unconfirmed', errorMessage: message }))
      if (rejected) {
        restoreDraft(sessionId, text, clearedRevision, selected.current === sessionId)
        void refreshWorkspaces()
        if (error.status === 404) void refreshSessions()
      } else syncTarget()
    }).finally(() => { clearTimeout(timer); timers.current.delete(timer) })
    return true
  }

  const messages = mergeSubmissions(state.snapshot?.messages ?? [], submissions.filter(local => local.kind === 'message'))
  const waiting = submissions.some(local => local.state !== 'failed')
  const target = state.snapshot?.running?.runId
  const abortState = sessionId ? aborts.get(sessionId) : undefined
  const activeAbort = abortState?.runId === target ? abortState : null
  const abortDisabled = !target || (activeAbort?.status === 'unconfirmed' && state.connection !== 'ready')
  const action = target || waiting ? activeAbort?.status === 'pending' ? 'aborting' : 'abort' : 'send'
  const abort = async (runId: string | undefined) => {
    if (!sessionId || !runId || stateRef.current.sessionId !== sessionId || stateRef.current.snapshot?.running?.runId !== runId) return
    const previous = abortRef.current.get(sessionId)
    if (previous?.runId === runId && previous.status === 'pending') return
    updateAbort(sessionId, { runId, status: 'pending' })
    try {
      await abortMessage({ sessionId, runId })
    } catch (error) {
      if (!mounted.current || abortRef.current.get(sessionId)?.runId !== runId) return
      updateAbort(sessionId, { runId, status: 'unconfirmed', error: error instanceof Error ? error.message : '中止请求失败' })
    }
    if (mounted.current && selected.current === sessionId && abortRef.current.get(sessionId)?.runId === runId) subscription.current?.requestSnapshot?.()
  }
  const status = state.error ?? (state.slow ? '连接较慢，正在等待对话恢复…' : {
    connecting: '正在连接…', awaitingSnapshot: '正在恢复对话…',
    ready: !sessionId ? firstPhase === 'sending' ? '正在发送第一条消息…' : '新会话' : state.snapshot?.running?.phase === 'compaction' ? '正在压缩对话…' : state.snapshot?.running?.phase === 'tools' ? '正在执行工具…' : state.snapshot?.running ? '正在生成回答…' : waiting ? '正在确认消息接收…' : '对话已同步',
    disconnected: '连接已断开，正在重试…',
  }[state.connection])

  const selectedModel = isNew ? pendingInput?.modelId ?? modelId : modelId
  const modelSelect = <Select value={discovery?.models.length ? selectedModel : ''}
    onValueChange={value => { modelIdRef.current = value; setModelId(value) }}
    disabled={!discovery?.models.length || (isNew && firstPhase !== null)}>
    <SelectTrigger aria-label="模型" className="composer-model">
      <SelectValue placeholder={modelError ? '模型查询失败' : discovery ? '无可用模型' : '正在查询模型…'} />
    </SelectTrigger>
    <SelectContent align="end">{discovery?.models.map(model => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent>
  </Select>

  return (
    <SidebarProvider>
      <SidebarTrigger ref={sidebarButton} />
      <Sidebar>
        <div className="sidebar-title">SI</div>
        <SidebarDismiss>
          <Button className="sidebar-new-session" variant="outline" aria-label="新会话" onClick={() => openNewSession()}>
            <PlusIcon aria-hidden="true" />
            <span>新会话</span>
          </Button>
        </SidebarDismiss>
        <nav className="sidebar-workspaces" aria-label="工作区">
          <div className="sidebar-workspaces-heading">
            <span>工作区</span>
            <Button variant="ghost" size="icon-sm" aria-label="添加工作区" title="添加工作区" disabled={picking || !workspaces} onClick={() => { void pickWorkspace() }}>
              <FolderPlusIcon aria-hidden="true" />
            </Button>
          </div>
          {workspaces?.workspaces.map(group => <div className="sidebar-workspace" key={group.id} role="group" aria-label={group.name}>
            <div className="workspace-row" data-bound={group.id === workspace?.id}>
              <FolderOpenIcon aria-hidden="true" /><span title={group.path}>{group.name}</span>
              <SidebarDismiss>
                <Button className="workspace-add-session" variant="ghost" size="icon-sm" aria-label="新建会话" title={group.available ? '新建会话' : '工作区目录不可用'} disabled={!group.available || firstPhase !== null} onClick={() => openNewSession(group.id)}>
                  <PlusIcon aria-hidden="true" />
                </Button>
              </SidebarDismiss>
            </div>
            {isNew && group.id === draftWorkspace?.id && <SidebarDismiss>
              <Button className="workspace-conversation" variant="secondary" aria-label="未发送的新会话" aria-current="page" onClick={() => openNewSession()}>新会话</Button>
            </SidebarDismiss>}
            {sessions?.filter(item => item.workspaceId === group.id).map(item => <SidebarDismiss key={item.id}>
              <Button className="workspace-conversation" variant={item.id === sessionId ? 'secondary' : 'ghost'} aria-current={item.id === sessionId ? 'page' : undefined} onClick={() => openSession(item.id, true)}>
                <span title={item.name}>{item.name}</span>
              </Button>
            </SidebarDismiss>)}
          </div>)}
        </nav>
        <SidebarDismiss>
          <SettingsButton ref={settingsButton} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)} />
        </SidebarDismiss>
      </Sidebar>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onCloseAutoFocus={event => {
        event.preventDefault()
        const trigger = settingsButton.current
        if (trigger && !trigger.closest('[hidden]')) trigger.focus()
        else sidebarButton.current?.focus()
      }} discovery={discovery} onChange={applyModels} webSettings={webSettings} webSettingsError={webSettingsError} onWebSettingsChange={result => {
        if (!mounted.current) return
        applyWebSettings(result)
        void refreshWebSettings()
      }} />
      <div className="chat-workspace">
      <div className="chat-page" data-new-session={isNew || undefined} data-connection={state.connection} data-session-id={sessionId ?? undefined}>
      {saveNotice?.sessionId === sessionId && <p className="save-notice" role="alert">{saveNotice.text}</p>}
      {!isNew && <header className="chat-header">
        <h1>聊天</h1>
        <p className="connection-status" role="status">{status}</p>
      </header>}
      <main className="chat-main">
        {!isNew && <MessageList key={sessionId} messages={messages} activeContent={state.snapshot?.activeContent} running={state.snapshot?.running} runs={state.snapshot?.runs} saveFailures={state.snapshot?.saveFailures} />}
        <div className="composer-stack">
          {isNew && <>
            <h1 className="new-session-title">SI</h1>
            <div className="new-session-workspace">
              <FolderOpenIcon aria-hidden="true" />
              <Select value={draftWorkspace?.id ?? ''} disabled={picking || !workspaces || firstPhase !== null} onValueChange={value => {
                if (value === 'add-workspace') void pickWorkspace()
                else chooseDraftWorkspace(value)
              }}>
                <SelectTrigger aria-label="工作区"><SelectValue placeholder="选择工作区" /></SelectTrigger>
                <SelectContent>
                  {workspaces?.workspaces.map(item => <SelectItem key={item.id} value={item.id} disabled={!item.available}>{item.name}</SelectItem>)}
                  <SelectItem value="add-workspace">添加工作区…</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>}
          {isNew && <p className={state.connection === 'ready' && firstPhase !== 'sending' ? 'sr-only' : 'connection-status new-session-status'} role="status">{status}</p>}
          {(workspaceError || pickError) && <p className="configuration-error" role="alert">{workspaceError ?? pickError}</p>}
          {(sessionError || listError) && <p className="configuration-error" role="alert">{sessionError ?? listError}</p>}
          {listError && <Button variant="ghost" className="self-start" onClick={() => { void refreshSessions() }}>重新读取会话</Button>}
          {isNew && firstError && <p className="configuration-error" role="alert">{firstError}</p>}
          {isNew && firstPhase === 'unconfirmed' && <div className="new-session-retry">
            <p className="configuration-error" role="alert">首条消息未确认接收，草稿已保留。</p>
            <Button variant="outline" disabled={state.connection !== 'ready'} onClick={() => { if (firstSend.current) attemptFirstSend(firstSend.current) }}>重试首次发送</Button>
          </div>}
          {(isNew ? draftWorkspace && !draftWorkspace.available : workspace && !workspace.available) && <p className="model-error configuration-error" role="alert">工作区目录不可用</p>}
          {(modelError || discovery?.deepseek.state === 'error') && <p className="model-error configuration-error" role="alert">{modelError ?? (discovery?.deepseek.state === 'error' ? discovery.deepseek.message : '')}</p>}
          {activeAbort?.status === 'unconfirmed' && <p className="configuration-error" role="alert">中止未确认：{activeAbort.error}，正在核对后台状态。</p>}
          {storageUnavailable && <p className="configuration-error" role="alert">浏览器存储不可用，草稿可在本页保留，重新打开后无法恢复。</p>}
          <CompactionRecords saveFailures={state.snapshot?.saveFailures} records={state.snapshot?.compactions ?? []} messages={state.snapshot?.messages ?? []} pending={submissions.filter(local => local.kind === 'compaction')} />
          <MessageInput key={sessionId ?? newSessionDraft} draft={draft} onDraftChange={saveCurrentDraft} contextMeter={<ContextMeter usage={state.snapshot?.contextUsage} />} footerControl={modelSelect} commandsEnabled={!isNew} onSend={send} sendDisabled={isNew ? !canStart() : !canSubmit()} action={action} abortDisabled={abortDisabled} onAbort={() => { void abort(target) }} />
        </div>
      </main>
      </div>
      </div>
    </SidebarProvider>
  )
}
