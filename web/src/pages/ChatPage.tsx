import { useTranslation } from 'react-i18next'
import { errorNotice, NoticeText, noticeSummary, type Notice } from '../i18n/messages'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDownIcon, FolderOpenIcon, FolderPlusIcon, PlusIcon } from 'lucide-react'
import type { ModelDiscovery, ModelSelection } from '@agent-learning/model'
import type { AbortRequest, AbortResult, ExtensionNotice, PermissionMode, SessionSummary, StartSessionResult, StartSessionRequest, SubmitMessageResult, SubmitMessageRequest, WorkspaceView } from '@agent-learning/server/protocol'
import { SettingsButton, SettingsDialog } from '../components/SettingsDialog'
import { MessageInput } from '../components/MessageInput'
import { PermissionPicker } from '../components/PermissionPicker'
import { ModelPicker } from '../components/ModelPicker'
import { ContextMeter } from '../components/ContextMeter'
import { CompactionRecords } from '../components/CompactionRecords'
import { MessageList } from '../components/MessageList'
import { getModels as queryModels, getWorkspaces as queryWorkspaces, pickWorkspace as chooseWorkspace, getSessions as querySessions, startSession as postFirstMessage, saveModelSelection, getDefaultPermission as queryDefaultPermission, saveDefaultPermission, saveSessionPermission, getWebSettings, abortMessage as postAbort, submitMessage as postMessage, subscribe as subscribeToChat } from '../chat/client'
import { Button } from '../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Sidebar, SidebarDismiss, SidebarProvider, SidebarTrigger } from '../components/ui/sidebar'
import { initialState, mergeSubmissions, settleSubmission, type Subscribe, type Subscription } from '../chat/state'
import type { LocalSubmission } from '../types'
import { newSessionDraft, readDraftPermission, readExtensionDraft, writeExtensionDraft, writeDraftPermission, readFirstSend, recentSessionKey, recentWorkspaceKey, useDrafts, writeFirstSend } from '../chat/drafts'

type Props = {
  subscribe?: Subscribe
  getDefaultPermission?: typeof queryDefaultPermission
  getModels?: () => Promise<ModelDiscovery>
  getSessions?: () => Promise<SessionSummary[]>
  startSession?: (input: StartSessionRequest) => Promise<StartSessionResult>
  pickWorkspace?: typeof chooseWorkspace
  getWorkspaces?: () => Promise<WorkspaceView>
  submitMessage?: (input: SubmitMessageRequest) => Promise<SubmitMessageResult>
  abortMessage?: (input: AbortRequest) => Promise<AbortResult>
}

type FirstSend = { input: StartSessionRequest; revision: number; sending: boolean }

type AbortState = { runId: string; status: 'pending' | 'unconfirmed'; error?: Notice }

function useServerView<T>(load: () => Promise<T>, failure: Notice['key']) {
  const [view, setView] = useState<T | null>(null)
  const [error, setError] = useState<Notice | null>(null)
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
      return value
    } catch (error) {
      if (request !== version.current) return
      setError(errorNotice(failure, error))
    }
  }, [apply, failure, load])
  return { view, error, apply, refresh, invalidate, setView }
}

export function ChatPage({ subscribe = subscribeToChat, getDefaultPermission = queryDefaultPermission, getModels = queryModels, getWorkspaces = queryWorkspaces, getSessions = querySessions, startSession = postFirstMessage, pickWorkspace: pickDirectory = chooseWorkspace, submitMessage = postMessage, abortMessage = postAbort }: Props) {
  const { t } = useTranslation()
  const [state, setState] = useState(initialState)
  const { sessionId } = state
  const chatScroll = useRef<HTMLElement>(null)
  const [showToBottom, setShowToBottom] = useState(false)
  const updateToBottom = useCallback(() => {
    const scroll = chatScroll.current
    setShowToBottom(Boolean(scroll && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 2))
  }, [])
  useLayoutEffect(() => {
    if (chatScroll.current) chatScroll.current.scrollTop = 0
    setShowToBottom(false)
  }, [sessionId])
  useEffect(() => {
    const scroll = chatScroll.current
    if (!scroll || sessionId === null) return
    updateToBottom()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateToBottom)
    observer.observe(scroll)
    for (const child of scroll.children) observer.observe(child)
    return () => observer.disconnect()
  }, [sessionId, updateToBottom])

  function scrollToBottom() {
    const scroll = chatScroll.current
    if (!scroll) return
    scroll.querySelector<HTMLElement>('.message-list')?.focus({ preventScroll: true })
    scroll.scrollTop = scroll.scrollHeight
    updateToBottom()
  }
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
  const [selectionBusy, setSelectionBusy] = useState(false)
  const savingSelection = useRef(false)
  const [selectionError, setSelectionError] = useState<{ sessionId: string | null; message: Notice }>()
  const [modelError, setModelError] = useState<Notice | null>(null)
  const requestVersion = useRef(0)
  const { view: workspaces, error: workspaceError, apply: applyWorkspaces, refresh: refreshWorkspaces, invalidate: invalidateWorkspaces } = useServerView(getWorkspaces, 'chat.workspaceReadFailed')
  const { view: webSettings, error: webSettingsError, apply: applyWebSettings, refresh: refreshWebSettings, invalidate: invalidateWebSettings } = useServerView(getWebSettings, 'chat.webSettingsReadFailed')
  const { view: sessions, error: listError, refresh: refreshSessions, invalidate: invalidateSessions, setView: setSessions } = useServerView(getSessions, 'chat.sessionReadFailed')
  const { view: defaultPermission, error: permissionReadError, refresh: refreshPermission, invalidate: invalidatePermission, setView: setDefaultPermissionView } =
    useServerView(getDefaultPermission, 'permission.readFailed')
  const [draftPermission, setDraftPermission] = useState(readDraftPermission)
  const [permissionError, setPermissionError] = useState<{ sessionId: string; notice: Notice }>()
  const savingSessionPermission = useRef(false)
  const [sessionPermissionBusy, setSessionPermissionBusy] = useState(false)
  const savingDefaultPermission = useRef(false)
  const [defaultPermissionBusy, setDefaultPermissionBusy] = useState(false)
  const [defaultPermissionError, setDefaultPermissionError] = useState<Notice>()
  const selected = useRef<string | null>(null)
  const initialized = useRef(false)
  const navigation = useRef(0)
  const opening = useRef(false)
  const [sessionError, setSessionError] = useState<Notice | null>(null)
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null)
  const firstSend = useRef<FirstSend | null>(null)
  const extensionDrafts = useRef(new Map<string, string>())
  const [extensionNotices, setExtensionNotices] = useState<{ sessionId: string | null; notices: ExtensionNotice[] }>()
  const showExtensionNotices = useCallback((id: string | null, notices: ExtensionNotice[]) => {
    if (notices.length && selected.current === id) setExtensionNotices({ sessionId: id, notices })
  }, [])
  useEffect(() => {
    if (!extensionNotices) return
    const timer = setTimeout(() => setExtensionNotices(undefined), 5000)
    return () => clearTimeout(timer)
  }, [extensionNotices])
  const [firstPhase, setFirstPhase] = useState<'sending' | 'unconfirmed' | null>(null)
  const [firstError, setFirstError] = useState<Notice | null>(null)
  const [saveNotice, setSaveNotice] = useState<{ sessionId: string | null; text: Notice } | null>(null)
  useEffect(() => {
    if (!saveNotice) return
    const timer = setTimeout(() => setSaveNotice(null), 3000)
    return () => clearTimeout(timer)
  }, [saveNotice])
  const [pickError, setPickError] = useState<Notice | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const sidebarButton = useRef<HTMLButtonElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const [quotes, setQuotes] = useState<Record<string, string | symbol | undefined>>({})
  const pendingQuote = sessionId === null ? undefined : quotes[sessionId]
  const quote = typeof pendingQuote === 'string' ? pendingQuote : undefined
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
    setPermissionError(undefined)
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
    if (!draftPermission && !firstSend.current) {
      setDefaultPermissionView(null)
      void refreshPermission()
    }
    openSession(null, true)
    if (workspaceId) chooseDraftWorkspace(workspaceId)
  }

  const finishFirstSend = useCallback((session: SessionSummary) => {
    const pending = firstSend.current
    if (!pending || (pending.input.draftSessionId ?? pending.input.clientMessageId) !== session.id || pending.input.workspaceId !== session.workspaceId) return
    firstSend.current = null
    writeFirstSend(null)
    extensionDrafts.current.delete(session.workspaceId)
    writeExtensionDraft(session.workspaceId)
    writeDraftPermission(null)
    setDraftPermission(null)
    setDefaultPermissionView(null)
    void refreshPermission()
    setFirstPhase(null)
    setFirstError(null)
    clearSentDraft(newSessionDraft, pending.input.text, pending.revision)
    if (selected.current === null) openSession(session.id)
  }, [clearSentDraft, openSession, refreshPermission, setDefaultPermissionView])

  function attemptFirstSend(pending: FirstSend) {
    if (pending.sending || stateRef.current.connection !== 'ready') return
    const retrying = firstPhase === 'unconfirmed'
    pending.sending = true
    setFirstPhase('sending')
    setFirstError(null)
    void Promise.resolve().then(() => startSession(pending.input)).then(result => {
      if (!mounted.current || firstSend.current !== pending) return
      if ('kind' in result) {
        const { workspaceId, text } = pending.input
        extensionDrafts.current.set(workspaceId, result.draftSessionId)
        writeExtensionDraft(workspaceId, result.draftSessionId)
        firstSend.current = null
        writeFirstSend(null)
        setFirstPhase(null)
        if (clearSentDraft(newSessionDraft, text, pending.revision) && selected.current === null) loadDraft(newSessionDraft)
        showExtensionNotices(null, result.notices)
        return
      }
      const created = result.session
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
        const text = errorNotice(saveRejected ? 'request.saveFailed' : 'chat.firstRejected', error)
        if (saveRejected) setSaveNotice({ sessionId: null, text })
        else setFirstError(text)
        if (error?.code === 'model_selection_changed') {
          receiveModels(null)
          void refreshModels()
        }
        void refreshWorkspaces()
        if (pending.input.draftSessionId) void refreshSessions()
      } else {
        setFirstPhase('unconfirmed')
        if (authorizationRejected && error instanceof Error) setFirstError(errorNotice('chat.firstRejected', error))
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
      if (mounted.current) setPickError(errorNotice('chat.workspacePickFailed', error))
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
      setModelError(errorNotice('model.loadFailed', error))
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
    void refreshPermission()
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
        void refreshPermission()
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
          setSessionError({ key: 'chat.sessionReadFailed', detail: next.error })
          void refreshSessions()
        }
      }
      stateRef.current = next
      updateSubmissions(submissionsRef.current)
      setState(next)
    }, refreshModels, refreshWorkspaces, refreshWebSettings, refreshSessions, refreshPermission,
    (notice, id) => showExtensionNotices(id, [notice]))
    subscription.current = stop
    stop.setSession(selected.current)
    return () => {
      mounted.current = false
      invalidateModels()
      invalidateWorkspaces()
      invalidateWebSettings()
      invalidateSessions()
      invalidatePermission()
      stop()
      subscription.current = null
      for (const timer of timers.current) clearTimeout(timer)
      timers.current.clear()
    }
  }, [subscribe, refreshModels, refreshWorkspaces, refreshWebSettings, refreshSessions, invalidateModels, invalidateWorkspaces, invalidateWebSettings, invalidateSessions, refreshPermission, invalidatePermission, updateSubmissions, updateAbort, writeStorage, showExtensionNotices])

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
    setSessionError({ key: 'chat.sessionUnavailable' })
  }, [sessions, openSession, readStorage])

  useEffect(() => {
    const pending = firstSend.current?.input
    if (!pending || pending.draftSessionId && pending.draftSessionId !== pending.clientMessageId) return
    const sent = sessions?.find(item => item.id === pending.clientMessageId)
    if (sent) finishFirstSend(sent)
  }, [sessions, finishFirstSend])

  useEffect(() => {
    if (selected.current === null && sessions && draftPermission === null && !firstSend.current && defaultPermission && !permissionReadError) {
      writeDraftPermission(defaultPermission)
      setDraftPermission(defaultPermission)
    }
  }, [sessions, isNew, draftPermission, defaultPermission, permissionReadError])

  function changeDraftPermission(mode: PermissionMode) {
    if (firstSend.current || selected.current !== null) return
    writeDraftPermission(mode)
    setDraftPermission(mode)
  }

  async function changeSessionPermission(id: string, mode: PermissionMode) {
    if (savingSessionPermission.current || selected.current !== id || stateRef.current.connection !== 'ready') return
    savingSessionPermission.current = true
    setSessionPermissionBusy(true)
    setPermissionError(undefined)
    try {
      await saveSessionPermission(id, mode)
    } catch (error) {
      if (mounted.current && selected.current === id) {
        setPermissionError({ sessionId: id, notice: errorNotice('permission.saveFailed', error) })
        subscription.current?.requestSnapshot?.()
      }
    } finally {
      savingSessionPermission.current = false
      if (mounted.current) setSessionPermissionBusy(false)
    }
  }

  async function changeDefaultPermission(mode: PermissionMode) {
    if (savingDefaultPermission.current) return
    savingDefaultPermission.current = true
    setDefaultPermissionBusy(true)
    setDefaultPermissionError(undefined)
    try {
      await saveDefaultPermission(mode)
      await refreshPermission()
    } catch (error) {
      const confirmed = await refreshPermission()
      if (mounted.current && confirmed !== mode) setDefaultPermissionError(errorNotice('permission.saveFailed', error))
    } finally {
      savingDefaultPermission.current = false
      if (mounted.current) setDefaultPermissionBusy(false)
    }
  }

  const selection = state.snapshot?.modelSelection ?? discovery?.defaultSelection
  const selectedModel = discovery?.models.find(model => model.id === selection?.modelId && model.provider === selection.provider)
  const hasModel = () => !savingSelection.current && !!selection && discoveryRef.current?.models.some(model =>
    model.id === selection.modelId && model.provider === selection.provider
    && (model.reasoningEfforts ? model.reasoningEfforts.some(level => level === selection.reasoningEffort) : selection.reasoningEffort === undefined))

  async function selectModel(next: ModelSelection) {
    if (savingSelection.current || stateRef.current.connection !== 'ready' || selected.current !== sessionId
      || (sessionId ? !stateRef.current.snapshot : !!firstSend.current)) return
    if (next.provider === selection?.provider && next.modelId === selection.modelId && next.reasoningEffort === selection.reasoningEffort) return
    savingSelection.current = true
    setSelectionBusy(true)
    setSelectionError(undefined)
    try {
      await saveModelSelection({ ...next, ...(sessionId && { sessionId }) })
    } catch (error) {
      if (mounted.current) setSelectionError({ sessionId, message: errorNotice('model.selectionUnconfirmed', error) })
    } finally {
      if (mounted.current) {
        if (sessionId && selected.current === sessionId) subscription.current?.requestSnapshot?.()
        await refreshModels()
      }
      savingSelection.current = false
      if (mounted.current) setSelectionBusy(false)
    }
  }
  const canStart = () => selected.current === null && draftWorkspace?.available && !workspaceError && !pickingRef.current
    && stateRef.current.connection === 'ready' && hasModel() && draftPermission !== null && !firstSend.current
  const canSubmit = () => !!sessionId && sessionId === selected.current && workspace?.available && !workspaceError && stateRef.current.sessionId === sessionId && stateRef.current.connection === 'ready' && stateRef.current.snapshot !== null && stateRef.current.snapshot.running === null
    && hasModel() && !savingSessionPermission.current
    && !submissionsRef.current.some(local => local.sessionId === sessionId && local.state !== 'failed')

  const send = (text: string) => {
    if (!text.trim() || !selection) return false
    if (sessionId === null) {
      if (!canStart() || !draftWorkspace || !draftPermission) return false
      if (text.trim() === '/compact') {
        setFirstError({ key: 'chat.compactNeedsHistory' })
        return false
      }
      const existingDraft = extensionDrafts.current.get(draftWorkspace.id) ?? readExtensionDraft(draftWorkspace.id)
      const draftSessionId = sessions?.some(session => session.id === existingDraft) ? undefined : existingDraft
      if (existingDraft && !draftSessionId) {
        extensionDrafts.current.delete(draftWorkspace.id)
        writeExtensionDraft(draftWorkspace.id)
      }
      const pending = firstSend.current = {
        input: { workspaceId: draftWorkspace.id, clientMessageId: crypto.randomUUID(), ...selection, text, permissionMode: draftPermission, ...(draftSessionId && { draftSessionId }) },
        revision: draftRevision(newSessionDraft), sending: false,
      }
      writeFirstSend(pending.input)
      attemptFirstSend(pending)
      // Keep the text until the server accepts the first message.
      return false
    }
    if (!canSubmit()) return false
    setSelectionError(undefined)
    const quotedText = quote && quote.split(/\r\n|\n|\r/).map(line => `> ${line}`).join('\n')
    const input: SubmitMessageRequest = {
      clientMessageId: crypto.randomUUID(), ...selection, sessionId,
      text: quotedText ? `${quotedText}\n\n${text}` : text,
    }
    const clearedRevision = draftRevision(sessionId) + 1
    const syncTarget = () => {
      if (selected.current === sessionId) subscription.current?.requestSnapshot?.()
    }
    const local: LocalSubmission = { ...input, kind: input.text.trim() === '/compact' ? 'compaction' : 'message', state: 'pending', afterMessageId: stateRef.current.snapshot?.messages.at(-1)?.id }
    // 同步写门禁，React 渲染前的第二次发送手势也会被拦住。
    const previous = submissionsRef.current
    submissionsRef.current = [...previous, local]
    let request: Promise<SubmitMessageResult>
    try { request = submitMessage(input) }
    catch { submissionsRef.current = previous; return false }
    const quoteSent = quote ? Symbol() : undefined
    if (quoteSent) setQuotes(current => ({ ...current, [sessionId]: quoteSent }))
    updateSubmissions(submissionsRef.current)
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      if (!mounted.current || !submissionsRef.current.some(item => item.clientMessageId === input.clientMessageId && item.state !== 'failed')) return
      updateSubmissions(settleSubmission(submissionsRef.current, input.clientMessageId, { state: 'unconfirmed', errorMessage: { key: 'chat.receiptTimeout' } }))
      syncTarget()
    }, 10_000)
    timers.current.add(timer)
    void request.then(accepted => {
      if (!mounted.current) return
      if (accepted.kind === 'handled') {
        updateSubmissions(submissionsRef.current.filter(item => item.clientMessageId !== input.clientMessageId))
        showExtensionNotices(sessionId, accepted.notices)
        return
      }
      updateSubmissions(settleSubmission(submissionsRef.current, input.clientMessageId, { accepted, state: 'pending', errorMessage: undefined }))
    }, error => {
      if (!mounted.current) return
      const saveRejected = error?.code === 'save_rejected'
      const selectionChanged = error?.code === 'model_selection_changed'
      const rejected = saveRejected || selectionChanged || typeof error?.status === 'number' && error.status >= 400 && error.status < 500
      const message = errorNotice(saveRejected ? 'request.saveFailed' : selectionChanged ? 'model.selectionChanged' : rejected ? 'chat.sendFailed' : 'chat.notConfirmed', error)
      const local = submissionsRef.current.find(item => item.clientMessageId === input.clientMessageId)
      if (!local || local.accepted) return
      const restored = rejected && restoreDraft(sessionId, text, clearedRevision, selected.current === sessionId, selectionChanged)
      if (restored && quoteSent) setQuotes(current => current[sessionId] === quoteSent ? { ...current, [sessionId]: quote } : current)
      if (saveRejected || selectionChanged && restored) {
        updateSubmissions(submissionsRef.current.filter(item => item.clientMessageId !== input.clientMessageId))
      } else updateSubmissions(settleSubmission(submissionsRef.current, input.clientMessageId, { state: rejected ? 'failed' : 'unconfirmed', errorMessage: selectionChanged ? undefined : message }))
      if (selectionChanged) {
        setSelectionError({ sessionId, message })
        syncTarget()
      } else if (saveRejected) setSaveNotice({ sessionId, text: message })
      if (rejected) {
        void refreshWorkspaces()
        if (error.status === 404) void refreshSessions()
      } else syncTarget()
    }).finally(() => {
      clearTimeout(timer)
      timers.current.delete(timer)
      if (quoteSent && mounted.current) setQuotes(current => {
        if (current[sessionId] !== quoteSent) return current
        const next = { ...current }
        delete next[sessionId]
        return next
      })
    })
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
      updateAbort(sessionId, { runId, status: 'unconfirmed', error: errorNotice('request.abortFailed', error) })
    }
    if (mounted.current && selected.current === sessionId && abortRef.current.get(sessionId)?.runId === runId) subscription.current?.requestSnapshot?.()
  }
  const statusKey = state.connectionNotice ?? (state.slow ? 'chat.connectionSlow' : ({
    connecting: 'chat.connecting', awaitingSnapshot: 'chat.restoring', disconnected: 'chat.disconnected',
    ready: !sessionId ? firstPhase === 'sending' ? 'chat.firstSending' : 'chat.new'
      : state.snapshot?.running?.phase === 'compaction' ? 'chat.compacting'
      : state.snapshot?.running?.phase === 'tools' ? 'chat.runningTools'
      : state.snapshot?.running ? 'chat.generating' : waiting ? 'chat.waitingReceipt' : null,
  } as const)[state.connection])
  const status = state.error ? t('chat.sessionReadFailed') : statusKey ? t(statusKey) : ''

  const modelSelect = <ModelPicker discovery={discovery} selection={selection} model={selectedModel}
    disabled={!discovery?.models.length || selectionBusy || state.connection !== 'ready' || (isNew ? firstPhase !== null : !state.snapshot)}
    placeholder={t(modelError ? 'model.loadFailed' : selection ? 'model.reselect' : discovery ? 'model.none' : 'model.loading')}
    onSelect={next => { void selectModel(next) }} />
  const providerError = discovery?.providers.find(item => item.status.state === 'error')?.status
  const workspaceNotice = workspaceError ?? pickError
  const sessionNotice = sessionError ?? listError


  return (
    <SidebarProvider>
      <SidebarTrigger ref={sidebarButton} />
      <Sidebar>
        <div className="sidebar-title">SI</div>
        <SidebarDismiss>
          <Button className="sidebar-new-session" variant="outline" aria-label={t('chat.new')} onClick={() => openNewSession()}>
            <PlusIcon aria-hidden="true" />
            <span>{t('chat.new')}</span>
          </Button>
        </SidebarDismiss>
        <nav className="sidebar-workspaces" aria-label={t('chat.workspaces')}>
          <div className="sidebar-workspaces-heading">
            <span>{t('chat.workspace')}</span>
            <Button variant="ghost" size="icon-sm" aria-label={t('chat.addWorkspace')} title={t('chat.addWorkspace')} disabled={picking || !workspaces} onClick={() => { void pickWorkspace() }}>
              <FolderPlusIcon aria-hidden="true" />
            </Button>
          </div>
          {workspaces?.workspaces.map(group => <div className="sidebar-workspace" key={group.id} role="group" aria-label={group.name}>
            <div className="workspace-row" data-bound={group.id === workspace?.id}>
              <FolderOpenIcon aria-hidden="true" /><span title={group.path}>{group.name}</span>
              <SidebarDismiss>
                <Button className="workspace-add-session" variant="ghost" size="icon-sm" aria-label={t('chat.create')} title={t(group.available ? 'chat.create' : 'chat.workspaceUnavailable')} disabled={!group.available || firstPhase !== null} onClick={() => openNewSession(group.id)}>
                  <PlusIcon aria-hidden="true" />
                </Button>
              </SidebarDismiss>
            </div>
            {isNew && group.id === draftWorkspace?.id && <SidebarDismiss>
              <Button className="workspace-conversation" variant="secondary" aria-label={t('chat.unsent')} aria-current="page" onClick={() => openNewSession()}>{t('chat.new')}</Button>
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
      }} permissionSettings={{ mode: defaultPermission, busy: defaultPermissionBusy,
        readError: permissionReadError, saveError: defaultPermissionError,
        onSelect: changeDefaultPermission, onRetry: () => { setDefaultPermissionError(undefined); void refreshPermission() },
      }} discovery={discovery} onChange={applyModels} webSettings={webSettings} webSettingsError={webSettingsError} onWebSettingsChange={result => {
        if (!mounted.current) return
        applyWebSettings(result)
        void refreshWebSettings()
      }} />
      <div className="chat-workspace">
      <div className="chat-page" data-new-session={isNew || undefined} data-connection={state.connection} data-session-id={sessionId ?? undefined}>
      {extensionNotices?.sessionId === sessionId && <div className="save-notice" role="status">
        {extensionNotices.notices.map(({ message, level }, index) => <div key={index} data-level={level}>{message}</div>)}
      </div>}
      {saveNotice?.sessionId === sessionId && <p className="save-notice" role="alert"><NoticeText notice={saveNotice.text} /></p>}
      {!isNew && <header className="chat-header">
        <h1 title={session?.name}>{session?.name || t('chat.title')}</h1>
        <p className="connection-status" role="status">{status}</p>
      </header>}
      <div className="chat-main-frame">
      <main ref={chatScroll} className="chat-main" onScroll={updateToBottom}>
        {!isNew && <MessageList key={sessionId} messages={messages} showRetry={state.connection === 'ready'} activeContent={state.snapshot?.activeContent} running={state.snapshot?.running} runs={state.snapshot?.runs} saveFailures={state.snapshot?.saveFailures}
          onQuote={text => {
            setQuotes(current => ({ ...current, [sessionId]: text }))
            editor.current?.focus({ preventScroll: true })
          }} />}
        <div className="composer-stack">
          {!isNew && showToBottom && <Button type="button" className="chat-to-bottom" variant="outline" size="icon"
            aria-label={t('chat.toBottom')} title={t('chat.toBottom')} onClick={scrollToBottom}>
            <ChevronDownIcon aria-hidden="true" />
          </Button>}
          {isNew && <>
            <h1 className="new-session-title">SI</h1>
            <div className="new-session-workspace">
              <FolderOpenIcon aria-hidden="true" />
              <Select value={draftWorkspace?.id ?? ''} disabled={picking || !workspaces || firstPhase !== null} onValueChange={value => {
                if (value === 'add-workspace') void pickWorkspace()
                else chooseDraftWorkspace(value)
              }}>
                <SelectTrigger aria-label={t('chat.workspace')}><SelectValue placeholder={t('chat.chooseWorkspace')} /></SelectTrigger>
                <SelectContent>
                  {workspaces?.workspaces.map(item => <SelectItem key={item.id} value={item.id} disabled={!item.available}>{item.name}</SelectItem>)}
                  <SelectItem value="add-workspace">{t('chat.addWorkspaceOption')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>}
          {isNew && <p className={state.connection === 'ready' && firstPhase !== 'sending' ? 'sr-only' : 'connection-status new-session-status'} role="status">{status}</p>}
          {workspaceNotice && <p className="configuration-error" role="alert"><NoticeText notice={workspaceNotice} /></p>}
          {sessionNotice && <p className="configuration-error" role="alert"><NoticeText notice={sessionNotice} /></p>}
          {listError && <Button variant="ghost" className="self-start" onClick={() => { void refreshSessions() }}>{t('chat.reloadSessions')}</Button>}
          {isNew && firstError && <p className="configuration-error" role="alert"><NoticeText notice={firstError} /></p>}
          {isNew && firstPhase === 'unconfirmed' && <div className="new-session-retry">
            <p className="configuration-error" role="alert">{t('chat.firstUnconfirmed')}</p>
            <Button variant="outline" disabled={state.connection !== 'ready'} onClick={() => { if (firstSend.current) attemptFirstSend(firstSend.current) }}>{t('chat.retryFirst')}</Button>
          </div>}
          {(isNew ? draftWorkspace && !draftWorkspace.available : workspace && !workspace.available) && <p className="model-error configuration-error" role="alert">{t('chat.workspaceUnavailable')}</p>}
          {(modelError || providerError?.state === 'error') && <p className="model-error configuration-error" role="alert"><NoticeText notice={modelError ?? { key: 'settings.error', detail: providerError?.state === 'error' ? providerError.message : undefined }} /></p>}
          {selection && discovery && !hasModel() && !selectionBusy && <p className="model-error configuration-error" role="alert">{t('model.unavailable')}</p>}
          {selectionError?.sessionId === sessionId && <p className="model-error configuration-error" role="alert"><NoticeText notice={selectionError.message} /></p>}
          {activeAbort?.status === 'unconfirmed' && <p className="configuration-error" role="alert">{activeAbort.error ? t('chat.abortUnconfirmedDetail', { detail: noticeSummary(t, activeAbort.error) }) : t('chat.abortUnconfirmed')}{activeAbort.error?.detail && <> · <span>{activeAbort.error.detail}</span></>}</p>}
          {storageUnavailable && <p className="configuration-error" role="alert">{t('chat.draftStorageUnavailable')}</p>}
          <CompactionRecords saveFailures={state.snapshot?.saveFailures} records={state.snapshot?.compactions ?? []} messages={state.snapshot?.messages ?? []} pending={submissions.filter(local => local.kind === 'compaction')} />
          {isNew && !draftPermission && !pendingInput && permissionReadError && <p className="configuration-error" role="alert">
            <NoticeText notice={permissionReadError} /> <Button variant="ghost" onClick={() => { void refreshPermission() }}>{t('common.retry')}</Button>
          </p>}
          {permissionError?.sessionId === sessionId && <p className="configuration-error" role="alert"><NoticeText notice={permissionError.notice} /></p>}
          <MessageInput key={sessionId ?? newSessionDraft} editorRef={editor} draft={draft} onDraftChange={saveCurrentDraft}
            quote={quote} onRemoveQuote={sessionId === null ? undefined : () => setQuotes(current => {
              const next = { ...current }
              delete next[sessionId]
              return next
            })}
            contextMeter={<ContextMeter usage={state.snapshot?.contextUsage} />}
            footerControl={<>
              <PermissionPicker mode={isNew ? pendingInput?.permissionMode ?? draftPermission : state.snapshot?.permissionMode ?? null}
                disabled={state.connection !== 'ready' || (isNew ? firstPhase !== null : sessionPermissionBusy)}
                onSelect={mode => { if (sessionId) void changeSessionPermission(sessionId, mode); else changeDraftPermission(mode) }} />
              {modelSelect}
            </>}
            skillWorkspaceId={quote ? undefined : (isNew ? draftWorkspace?.id : workspace?.id)}
            commandsEnabled={!isNew && !quote} onSend={send} sendDisabled={isNew ? !canStart() : !canSubmit()}
            action={action} abortDisabled={abortDisabled} onAbort={() => { void abort(target) }} />
        </div>
      </main>
      </div>
      </div>
      </div>
    </SidebarProvider>
  )
}
