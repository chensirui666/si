import { useTranslation } from 'react-i18next'
import { errorNotice, NoticeText, noticeSummary, type Notice } from '../i18n/messages'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { AlarmClockIcon, CalendarClockIcon, ChevronDownIcon, FolderOpenIcon, FolderPlusIcon, HouseIcon, PlusIcon, XIcon } from 'lucide-react'
import type { ModelDiscovery, ModelSelection } from '@agent-learning/model'
import type { AbortRequest, AbortResult, ExtensionNotice, PermissionMode, ScheduleView, SessionSummary, StartSessionResult, StartSessionRequest, SubmitMessageResult, SubmitMessageRequest, WorkspaceView } from '@agent-learning/server/protocol'
import { SettingsButton, SettingsDialog } from '../components/SettingsDialog'
import { MessageInput } from '../components/MessageInput'
import { ChatFileDrop } from '../components/ChatFileDrop'
import { DraftAttachments } from '../components/MessageAttachments'
import { PlanReview } from '../components/PlanReview'
import { useAttachmentDrafts } from '../chat/attachment-drafts'
import { PermissionPicker } from '../components/PermissionPicker'
import { ModelPicker } from '../components/ModelPicker'
import { ContextMeter } from '../components/ContextMeter'
import { CompactionRecords } from '../components/CompactionRecords'
import { MessageList } from '../components/MessageList'
import { BackgroundTasks } from '../components/BackgroundTasks'
import { NewChatParticles } from '../components/NewChatParticles'
import { ScheduleActionDialog, ScheduleCreateDialog, ScheduledTasks, ScheduledTaskSidebar, useScheduleCatalog, type ScheduleDialogRequest } from '../components/ScheduledTasks'
import { getModels as queryModels, getWorkspaces as queryWorkspaces, pickWorkspace as chooseWorkspace, getSessions as querySessions, startSession as postFirstMessage, saveModelSelection, getDefaultPermission as queryDefaultPermission, saveDefaultPermission, saveSessionPermission, getWebSettings, getMcpServers, abortMessage as postAbort, submitMessage as postMessage, subscribe as subscribeToChat, createSession } from '../chat/client'
import { Button } from '../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Sidebar, SidebarDismiss, SidebarProvider, SidebarTrigger, useSidebar } from '../components/ui/sidebar'
import { initialState, mergeSubmissions, settleSubmission, type Subscribe, type Subscription } from '../chat/state'
import type { LocalSubmission } from '../types'
import { newSessionDraft, readDraftPermission, readExtensionDraft, writeExtensionDraft, writeDraftPermission, readFirstSend, recentSessionKey, recentWorkspaceKey, useDrafts, writeFirstSend, readPlanDraft, writePlanDraft, readSourceSends, writeSourceSends, type StoredSourceSend } from '../chat/drafts'

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

type FirstSend = { input: StartSessionRequest; source?: 'schedule'; revision: number; sending: boolean }
type SentDraft = {
  key: string; text: string; revision?: number; attachmentIds?: string[]; referenceSessionIds?: string[]
}
type SourceSend = SentDraft & StoredSourceSend & { pending: boolean; quote?: string }

type AbortState = { runId: string; status: 'pending' | 'unconfirmed'; error?: Notice }

type SidebarSection = 'home' | 'scheduled'

function SectionPicker({ section, onChange }: { section: SidebarSection; onChange(next: SidebarSection): void }) {
  const { t } = useTranslation()
  const { dismissOnMobile } = useSidebar()
  return <Select value={section} onValueChange={value => {
    onChange(value === 'scheduled' ? 'scheduled' : 'home')
    dismissOnMobile()
  }}>
    <SelectTrigger className="sidebar-section" aria-label={t('sidebar.section')}><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="home">
        <span className="sidebar-section-value">
          <span className="sidebar-section-icon" aria-hidden="true"><HouseIcon /></span><span>{t('sidebar.home')}</span>
        </span>
      </SelectItem>
      <SelectItem value="scheduled">
        <span className="sidebar-section-value">
          <span className="sidebar-section-icon" data-tone="gold" aria-hidden="true"><CalendarClockIcon /></span><span>{t('schedule.title')}</span>
        </span>
      </SelectItem>
    </SelectContent>
  </Select>
}

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
  const { t, i18n } = useTranslation()
  const [state, setState] = useState(initialState)
  const [section, setSection] = useState<SidebarSection>('home')
  const activeSection = useRef<SidebarSection>('home')
  const homeSessionId = useRef<string | null>(null)
  const [scheduleRevision, setScheduleRevision] = useState(0)
  const scheduleCatalog = useScheduleCatalog(scheduleRevision, section === 'scheduled')
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>()
  const selectedSchedule = scheduleCatalog.view?.find(schedule => schedule.id === selectedScheduleId)
  const [scheduleDialog, setScheduleDialog] = useState<ScheduleDialogRequest>()
  const [scheduleRun, setScheduleRun] = useState<{ schedule: ScheduleView; navigation: number }>()
  const [scheduleCreateTrigger, setScheduleCreateTrigger] = useState<HTMLButtonElement>()
  const scheduleCreateFocus = useRef<HTMLButtonElement>(null)
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
  const { view: mcpServers, error: mcpError, refresh: refreshMcpServers, invalidate: invalidateMcpServers } = useServerView(getMcpServers, 'mcp.readFailed')
  const { view: sessions, error: listError, refresh: refreshSessions, invalidate: invalidateSessions, setView: setSessions } = useServerView(getSessions, 'chat.sessionReadFailed')
  const refreshSessionDirectory = useCallback(() => {
    void refreshSessions()
    setScheduleRevision(value => value + 1)
  }, [refreshSessions])
  function refreshEditedSchedule(saved?: ScheduleView) {
    if (saved) scheduleCatalog.setView(current => current?.map(schedule => schedule.id === saved.id ? saved : schedule))
    refreshSessionDirectory()
  }
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
  useEffect(() => { if (settingsOpen) void refreshMcpServers() }, [settingsOpen, refreshMcpServers])
  const settingsButton = useRef<HTMLButtonElement>(null)
  const sidebarButton = useRef<HTMLButtonElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const [quotes, setQuotes] = useState<Record<string, string | symbol | undefined>>({})
  const attachmentDrafts = useAttachmentDrafts()
  const removeAttachments = attachmentDrafts.remove
  const uploadDraftIds = useRef(new Map<string, string>())
  const referenceDrafts = useRef(new Map<string, SessionSummary[]>())
  const [referenceView, setReferenceView] = useState(() => new Map(referenceDrafts.current))
  const sourceSends = useRef(new Map<string, SourceSend>())
  const [draftIssue, setDraftIssue] = useState<{ key: string; notice: Notice }>()
  const planCommand = useRef(false)
  const planDrafts = useRef(new Map<string, NonNullable<ReturnType<typeof readPlanDraft>>>())
  const [planBusy, setPlanBusy] = useState(false)
  const discuss = useRef<{ sessionId: string; planId: string } | undefined>(undefined)
  const pendingQuote = sessionId === null ? undefined : quotes[sessionId]
  const quote = typeof pendingQuote === 'string' ? pendingQuote : undefined
  const { draft, currentText, storageUnavailable, load: loadDraft, save: saveDraft, restore: restoreDraft, read: readStorage, write: writeStorage, revision: draftRevision, clearSent: clearSentDraft } = useDrafts()
  const session = sessions?.find(item => item.id === sessionId)
  const workspace = workspaces?.workspaces.find(item => item.id === session?.workspaceId)
  const pendingInput = firstSend.current?.input
  const draftWorkspace = workspaces?.workspaces.find(item => item.id === (pendingInput?.workspaceId ?? draftWorkspaceId))
  const isNew = sessionId === null
  const submissions = allSubmissions.filter(item => item.sessionId === sessionId)
  const draftId = sessionId ?? newSessionDraft
  const attachments = attachmentDrafts.items(draftId)
  const references = referenceView.get(draftId) ?? []
  const plan = state.snapshot?.plan
  const planId = plan?.state === 'review' ? plan.assistantMessageId : null
  const referenceWorkspace = isNew ? draftWorkspace?.id : workspace?.id
  const referenceSessions = sessions?.filter(item => item.id !== sessionId).sort((a, b) =>
    Number(b.workspaceId === referenceWorkspace) - Number(a.workspaceId === referenceWorkspace))

  const writeReferences = useCallback((key: string, next: SessionSummary[]) => {
    if (next.length) referenceDrafts.current.set(key, next)
    else referenceDrafts.current.delete(key)
    setReferenceView(new Map(referenceDrafts.current))
  }, [])

  const consumeSources = useCallback((sent: SentDraft) => {
    const { attachmentIds, referenceSessionIds } = sent
    if (attachmentIds?.length) removeAttachments(sent.key, item =>
      item.status === 'ready' && attachmentIds.includes(item.attachment.id))
    if (referenceSessionIds?.length) {
      const items = referenceDrafts.current.get(sent.key)
      if (items?.length) writeReferences(sent.key, items.filter(item => !referenceSessionIds.includes(item.id)))
    }
  }, [removeAttachments, writeReferences])

  const forgetSourceSend = useCallback((id: string) => {
    sourceSends.current.delete(id)
    writeSourceSends(sourceSends.current.values())
  }, [])

  const clearSourceText = useCallback((sent: SourceSend) => {
    if (!sent.edited && clearSentDraft(sent.key, sent.text, sent.revision ?? draftRevision(sent.key)) && selected.current === sent.key) loadDraft(sent.key)
  }, [clearSentDraft, draftRevision, loadDraft])

  const settleSourceDraft = useCallback((clientMessageId: string) => {
    const sent = sourceSends.current.get(clientMessageId)
    if (!sent) return
    forgetSourceSend(clientMessageId)
    consumeSources(sent)
    if (sent.quote) setQuotes(current => current[sent.key] === sent.quote ? { ...current, [sent.key]: undefined } : current)
    clearSourceText(sent)
  }, [clearSourceText, consumeSources, forgetSourceSend])

  function draftUploadScope(workspaceId: string) {
    let draftSessionId = uploadDraftIds.current.get(workspaceId)
    const extensionId = extensionDrafts.current.get(workspaceId) ?? readExtensionDraft(workspaceId)
    if (!draftSessionId && extensionId && !sessions?.some(item => item.id === extensionId)) draftSessionId = extensionId
    draftSessionId ??= crypto.randomUUID()
    uploadDraftIds.current.set(workspaceId, draftSessionId)
    return { workspaceId, draftSessionId }
  }

  const addFiles = (isNew ? draftWorkspace?.available && !firstSend.current : workspace?.available) ? (files: File[]) => {
    if (selected.current !== sessionId || isNew && firstSend.current) return
    const scope = sessionId ? { sessionId } : draftWorkspace && draftUploadScope(draftWorkspace.id)
    if (!scope) return
    const notice = attachmentDrafts.add(draftId, scope, files)
    setDraftIssue(notice ? { key: draftId, notice } : undefined)
  } : undefined

  function selectReference(item: SessionSummary) {
    const previous = referenceDrafts.current.get(draftId) ?? []
    if (previous.some(reference => reference.id === item.id)) return
    if (previous.length === 3) {
      setDraftIssue({ key: draftId, notice: { key: 'chat.referenceLimit' } })
      return
    }
    writeReferences(draftId, [...previous, item])
    setDraftIssue(undefined)
  }

  function syncConversation(id: string) {
    if (selected.current === id) subscription.current?.requestSnapshot?.()
  }

  useEffect(() => {
    const request = discuss.current
    if (request && state.connection === 'ready' && state.snapshot && request.sessionId === sessionId && request.planId !== planId) {
      discuss.current = undefined
      editor.current?.focus({ preventScroll: true })
    }
  }, [sessionId, planId, state.connection, state.snapshot])

  const openSession = useCallback((id: string | null, userSection?: SidebarSection) => {
    initialized.current = true
    if (userSection) {
      navigation.current++
      activeSection.current = userSection
      setSection(userSection)
    }
    if (activeSection.current === 'home') homeSessionId.current = id
    setSessionError(null)
    setPermissionError(undefined)
    if (selected.current === id) {
      if (id && userSection && stateRef.current.error) subscription.current?.requestSnapshot?.()
      return
    }
    selected.current = id
    opening.current = id !== null
    loadDraft(id ?? newSessionDraft)
    stateRef.current = { ...stateRef.current, sessionId: id, snapshot: null }
    setState(stateRef.current)
    subscription.current?.setSession(id)
  }, [loadDraft])

  function openScheduledSession(schedule: ScheduleView) {
    setSelectedScheduleId(schedule.id)
    openSession(schedule.sessionId, 'scheduled')
  }

  function switchSection(next: SidebarSection) {
    if (next === activeSection.current) return
    if (next === 'home') openSession(homeSessionId.current, 'home')
    else openSession(selectedSchedule?.sessionId ?? null, 'scheduled')
  }

  useEffect(() => {
    setDraftWorkspaceId(readStorage(recentWorkspaceKey) ?? null)
    if (selected.current === null) loadDraft(newSessionDraft)
    const pending = readFirstSend()
    if (pending) {
      const { source, ...input } = pending
      firstSend.current = { input, source, revision: draftRevision(newSessionDraft), sending: false }
      if (source === 'schedule') openSession(null)
      setFirstPhase('unconfirmed')
    }
  }, [draftRevision, loadDraft, openSession, readStorage])

  const saveCurrentDraft = useCallback((text: string) => {
    if (sessionId !== selected.current) return
    const key = sessionId ?? newSessionDraft
    if (sourceSends.current.size && currentText(key) !== text) {
      const sent = [...sourceSends.current.values()].find(item => item.key === key)
      if (sent && !sent.edited) {
        sent.edited = true
        writeSourceSends(sourceSends.current.values())
      }
    }
    saveDraft(key, text)
  }, [currentText, sessionId, saveDraft])

  function chooseDraftWorkspace(id: string) {
    navigation.current++
    if (draftWorkspace?.id !== id && attachmentDrafts.read(newSessionDraft).length) {
      attachmentDrafts.rebind(newSessionDraft, newSessionDraft, draftUploadScope(id))
    }
    setDraftWorkspaceId(id)
    writeStorage(recentWorkspaceKey, id)
    setFirstError(null)
  }

  function openNewSession(workspaceId?: string) {
    if (!draftPermission && !firstSend.current) {
      setDefaultPermissionView(null)
      void refreshPermission()
    }
    openSession(null, 'home')
    if (workspaceId) chooseDraftWorkspace(workspaceId)
  }

  const finishFirstSend = useCallback((session: SessionSummary) => {
    const pending = firstSend.current
    if (!pending || (pending.input.draftSessionId ?? pending.input.clientMessageId) !== session.id || pending.input.workspaceId !== session.workspaceId) return
    firstSend.current = null
    writeFirstSend(null)
    setFirstPhase(null)
    setFirstError(null)
    if (pending.source === 'schedule') {
      setScheduleCreateTrigger(undefined)
      if (scheduleCreateTrigger || selected.current === null) openSession(session.id, 'home')
      return
    }
    extensionDrafts.current.delete(session.workspaceId)
    uploadDraftIds.current.delete(session.workspaceId)
    writeExtensionDraft(session.workspaceId)
    consumeSources({ ...pending.input, key: newSessionDraft, revision: pending.revision })
    writeDraftPermission(null)
    setDraftPermission(null)
    setDefaultPermissionView(null)
    void refreshPermission()
    clearSentDraft(newSessionDraft, pending.input.text, pending.revision)
    if (homeSessionId.current === null) {
      if (activeSection.current === 'home') openSession(session.id)
      else homeSessionId.current = session.id
    }
  }, [clearSentDraft, consumeSources, openSession, refreshPermission, scheduleCreateTrigger, setDefaultPermissionView])

  function attemptFirstSend(pending: FirstSend) {
    if (pending.sending || stateRef.current.connection !== 'ready') return
    const retrying = firstPhase === 'unconfirmed'
    pending.sending = true
    setFirstPhase('sending')
    setFirstError(null)
    void Promise.resolve().then(() => startSession(pending.input)).then(result => {
      if (!mounted.current || firstSend.current !== pending) return
      if ('kind' in result) {
        if (pending.source === 'schedule') {
          firstSend.current = null
          writeFirstSend(null)
          setFirstPhase(null)
          setFirstError({ key: 'schedule.notSent' })
          return
        }
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
        if (saveRejected && pending.source !== 'schedule') setSaveNotice({ sessionId: null, text })
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

  async function pickWorkspace(updateDraft = true) {
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
      if (updateDraft && selected.current === null && !firstSend.current && request === navigation.current) chooseDraftWorkspace(result.workspaceId)
      return result.workspaceId
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
  useEffect(() => {
    const restored: LocalSubmission[] = []
    for (const saved of readSourceSends()) {
      const { input, afterMessageId } = saved
      if (sourceSends.current.has(input.clientMessageId)) continue
      sourceSends.current.set(input.clientMessageId, { ...saved, key: input.sessionId, pending: false,
        attachmentIds: input.attachmentIds, referenceSessionIds: input.referenceSessionIds })
      restored.push({ ...input, afterMessageId, state: 'unconfirmed', kind: 'message' })
    }
    if (restored.length) updateSubmissions([...submissionsRef.current, ...restored])
  }, [updateSubmissions])

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
        void refreshMcpServers()
        refreshSessionDirectory()
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
      if (sourceSends.current.size) {
        for (const message of next.snapshot?.messages ?? []) {
          if (message.clientMessageId) settleSourceDraft(message.clientMessageId)
        }
      }
      updateSubmissions(submissionsRef.current)
      setState(next)
    }, refreshModels, refreshWorkspaces, refreshWebSettings, refreshSessionDirectory, refreshPermission,
    (notice, id) => showExtensionNotices(id, [notice]), refreshMcpServers)
    subscription.current = stop
    stop.setSession(selected.current)
    return () => {
      mounted.current = false
      invalidateModels()
      invalidateWorkspaces()
      invalidateWebSettings()
      invalidateMcpServers()
      invalidateSessions()
      invalidatePermission()
      stop()
      subscription.current = null
      for (const timer of timers.current) clearTimeout(timer)
      timers.current.clear()
    }
  }, [subscribe, refreshModels, refreshWorkspaces, refreshWebSettings, refreshMcpServers, refreshSessions, refreshSessionDirectory, invalidateModels, invalidateWorkspaces, invalidateWebSettings, invalidateMcpServers, invalidateSessions, refreshPermission, invalidatePermission, updateSubmissions, updateAbort, writeStorage, showExtensionNotices, settleSourceDraft])

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
    if (!pending) return
    const id = pending.draftSessionId ?? pending.clientMessageId
    const sent = sessions?.find(item => item.id === id)
    if (!sent) return
    const snapshot = state.connection === 'ready' && state.sessionId === id ? state.snapshot : null
    const confirmed = snapshot?.messages.some(message =>
      message.message.role === 'user' && message.clientMessageId === pending.clientMessageId)
      || snapshot?.runs?.some(run => run.kind === 'task' && run.clientMessageId === pending.clientMessageId)
    // A shared draft ID can be promoted by another tab's first message.
    if (id === pending.clientMessageId || confirmed) finishFirstSend(sent)
  }, [finishFirstSend, sessions, state.connection, state.sessionId, state.snapshot])

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
  const hasModel = (choice = selection) => !savingSelection.current && !!choice && discoveryRef.current?.models.some(model =>
    model.id === choice.modelId && model.provider === choice.provider
    && (model.reasoningEfforts ? model.reasoningEfforts.some(level => level === choice.reasoningEffort) : choice.reasoningEffort === undefined))

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
    && stateRef.current.connection === 'ready' && hasModel() && draftPermission !== null && !firstSend.current && !planCommand.current
  const canSubmit = () => !!sessionId && sessionId === selected.current && workspace?.available && !workspaceError && stateRef.current.sessionId === sessionId && stateRef.current.connection === 'ready' && stateRef.current.snapshot !== null && stateRef.current.snapshot.running === null
    && hasModel() && !savingSessionPermission.current && !planCommand.current && planId === null
    && !submissionsRef.current.some(local => local.sessionId === sessionId && local.state !== 'failed')

  function queueFirstSend(input: StartSessionRequest, source?: FirstSend['source']) {
    const pending = firstSend.current = { input, source, revision: draftRevision(newSessionDraft), sending: false }
    writeFirstSend(input, source)
    attemptFirstSend(pending)
  }

  function openScheduleCreate(trigger: HTMLButtonElement) {
    if (firstSend.current) return
    setFirstError(null)
    scheduleCreateFocus.current = trigger
    setScheduleCreateTrigger(trigger)
    void refreshPermission()
  }

  function createScheduleConversation(workspaceId: string, text: string) {
    const choice = discoveryRef.current?.defaultSelection
    if (!choice || !hasModel(choice) || firstSend.current || planCommand.current || pickingRef.current
      || stateRef.current.connection !== 'ready' || defaultPermission !== 'normal'
      || workspaceError || !workspaces?.workspaces.some(item => item.id === workspaceId && item.available)) return
    queueFirstSend({ ...choice, workspaceId, clientMessageId: crypto.randomUUID(), text, permissionMode: defaultPermission }, 'schedule')
  }

  async function activatePlan(draftText: string) {
    if (!selection || !(sessionId === null ? canStart() : canSubmit())) return
    const originalId = sessionId
    const workspaceId = originalId ? workspace?.id : draftWorkspace?.id
    let saved = workspaceId ? planDrafts.current.get(workspaceId) ?? readPlanDraft(workspaceId) : undefined
    let targetId = sessionId ?? saved?.id
    const revision = draftRevision(draftId)
    const navigationVersion = navigation.current
    planCommand.current = true
    setPlanBusy(true)
    setDraftIssue(undefined)
    try {
      if (!originalId && workspaceId && draftPermission) {
        if (!targetId) {
          const created = await createSession(workspaceId, draftPermission)
          targetId = created.id
          saved = { id: targetId, permissionMode: draftPermission }
          planDrafts.current.set(workspaceId, saved)
          writePlanDraft(workspaceId, saved)
          if (!mounted.current) return
          invalidateSessions()
          setSessions(previous => previous?.some(item => item.id === created.id) ? previous : [...previous ?? [], created])
        } else if (saved?.permissionMode !== draftPermission) {
          await saveSessionPermission(targetId, draftPermission)
          saved = { id: targetId, permissionMode: draftPermission }
          planDrafts.current.set(workspaceId, saved)
          writePlanDraft(workspaceId, saved)
        }
        await saveModelSelection({ ...selection, sessionId: targetId })
      }
      if (!targetId) return
      await submitMessage({ ...selection, clientMessageId: crypto.randomUUID(), sessionId: targetId, text: '/plan' })
      if (workspaceId && saved?.id === targetId) {
        planDrafts.current.delete(workspaceId)
        writePlanDraft(workspaceId)
      }
      if (!mounted.current) return
      if (originalId) {
        if (clearSentDraft(draftId, draftText, revision) && selected.current === originalId) loadDraft(draftId)
        syncConversation(targetId)
      } else if (selected.current === null && navigation.current === navigationVersion) {
        if (!clearSentDraft(draftId, draftText, revision)) {
          saveDraft(targetId, currentText(draftId))
          saveDraft(draftId, '')
        }
        attachmentDrafts.rebind(draftId, targetId, { sessionId: targetId })
        writeReferences(targetId, referenceDrafts.current.get(draftId) ?? [])
        writeReferences(draftId, [])
        openSession(targetId)
      }
    } catch (error) {
      if (mounted.current) {
        setDraftIssue({ key: draftId, notice: errorNotice('plan.commandFailed', error) })
        if (targetId) syncConversation(targetId)
      }
    } finally {
      planCommand.current = false
      if (mounted.current) setPlanBusy(false)
    }
  }

  async function exitPlan(commandDraft?: string) {
    if (!sessionId || !selection || selected.current !== sessionId || planCommand.current || stateRef.current.connection !== 'ready') return
    const revision = draftRevision(sessionId)
    planCommand.current = true
    setPlanBusy(true)
    setDraftIssue(undefined)
    try {
      await submitMessage({ ...selection, sessionId, clientMessageId: crypto.randomUUID(), text: '/plan off' })
      if (mounted.current && commandDraft !== undefined && clearSentDraft(sessionId, commandDraft, revision) && selected.current === sessionId) loadDraft(sessionId)
    } catch (error) {
      if (mounted.current) setDraftIssue({ key: sessionId, notice: errorNotice('plan.commandFailed', error) })
    } finally {
      planCommand.current = false
      if (mounted.current) {
        setPlanBusy(false)
        syncConversation(sessionId)
      }
    }
  }

  async function sendSources(sent: SourceSend) {
    if (sent.pending) return
    const { input, key } = sent
    const id = input.clientMessageId
    const retry = submissionsRef.current.some(item => item.clientMessageId === id && item.state === 'unconfirmed')
    sent.pending = true
    updateSubmissions(settleSubmission(submissionsRef.current, id, { state: 'pending', errorMessage: undefined }))
    try {
      const result = await submitMessage(input)
      if (!mounted.current || !sourceSends.current.has(id)) return
      if (result.kind === 'handled') {
        forgetSourceSend(id)
        clearSourceText(sent)
        updateSubmissions(submissionsRef.current.filter(item => item.clientMessageId !== id))
        showExtensionNotices(key, result.notices)
      } else {
        settleSourceDraft(id)
        updateSubmissions(settleSubmission(submissionsRef.current, id, { accepted: result, state: 'pending' }))
      }
    } catch (cause) {
      if (!mounted.current || !sourceSends.current.has(id)) return
      const error = cause as { status?: number; code?: string } | null
      const selectionChanged = error?.code === 'model_selection_changed'
      const saveRejected = error?.code === 'save_rejected'
      const status = error?.status
      const rejected = saveRejected || selectionChanged || typeof status === 'number' && status >= 400 && status < 500
        && !(retry && (status === 401 || status === 403))
      if (rejected) {
        forgetSourceSend(id)
        updateSubmissions(submissionsRef.current.filter(item => item.clientMessageId !== id))
        setDraftIssue({ key, notice: errorNotice(saveRejected ? 'request.saveFailed' : selectionChanged ? 'model.selectionChanged' : 'chat.sendFailed', cause) })
        if (selectionChanged) void refreshModels()
        if (status === 404) void refreshSessions()
        void refreshWorkspaces()
      } else updateSubmissions(settleSubmission(submissionsRef.current, id, { state: 'unconfirmed', errorMessage: errorNotice('chat.notConfirmed', cause) }))
      syncConversation(key)
    } finally {
      sent.pending = false
    }
  }

  const send = (text: string, fromSchedule = false) => {
    const draftQuote = fromSchedule ? undefined : quote
    const control = text.trim() === '/compact' && !draftQuote
    const currentAttachments = control || fromSchedule ? [] : attachmentDrafts.read(draftId)
    if (currentAttachments.some(item => item.status !== 'ready') || !selection || !text.trim() && !currentAttachments.length) return false
    const attachmentIds = currentAttachments.flatMap(item => item.status === 'ready' ? [item.attachment.id] : [])
    const referenceSessionIds = control || fromSchedule ? [] : (referenceDrafts.current.get(draftId) ?? []).map(item => item.id)
    if (referenceSessionIds.length && !text.trim()) return false
    const sources = {
      ...(attachmentIds.length && { attachmentIds }),
      ...(referenceSessionIds.length && { referenceSessionIds }),
    }
    const keepDraft = attachmentIds.length > 0 || referenceSessionIds.length > 0
    setDraftIssue(undefined)
    if (sessionId === null) {
      if (fromSchedule) return false
      if (!canStart() || !draftWorkspace || !draftPermission) return false
      if (text.trim() === '/compact') {
        setFirstError({ key: 'chat.compactNeedsHistory' })
        return false
      }
      const existingDraft = extensionDrafts.current.get(draftWorkspace.id) ?? readExtensionDraft(draftWorkspace.id)
      let draftSessionId = sessions?.some(session => session.id === existingDraft) ? undefined : existingDraft
      if (attachmentIds.length) {
        const scope = draftUploadScope(draftWorkspace.id)
        if (sessions?.some(item => item.id === scope.draftSessionId)) {
          const next = { workspaceId: scope.workspaceId, draftSessionId: crypto.randomUUID() }
          uploadDraftIds.current.set(next.workspaceId, next.draftSessionId)
          attachmentDrafts.rebind(draftId, draftId, next)
          return false
        }
        draftSessionId = scope.draftSessionId
      }
      if (existingDraft && !draftSessionId) {
        extensionDrafts.current.delete(draftWorkspace.id)
        writeExtensionDraft(draftWorkspace.id)
      }
      queueFirstSend({ workspaceId: draftWorkspace.id, clientMessageId: crypto.randomUUID(), ...selection, text, permissionMode: draftPermission,
        ...sources, ...(draftSessionId && { draftSessionId }) })
      // Keep the text until the server accepts the first message.
      return false
    }
    if (!canSubmit()) return false
    setSelectionError(undefined)
    const quotedText = draftQuote && draftQuote.split(/\r\n|\n|\r/).map(line => `> ${line}`).join('\n')
    const body = text.trimStart()
    let requestText = text
    if (quotedText) {
      requestText = /^\/plan\s/u.test(body)
        ? `/plan ${quotedText}\n\n${body.slice(5).trimStart()}`
        : `${quotedText}\n\n${text}`
    }
    const input: SubmitMessageRequest = {
      clientMessageId: crypto.randomUUID(), ...selection, ...sources, sessionId, text: requestText,
    }
    const clearedRevision = draftRevision(sessionId) + 1
    const syncTarget = () => {
      if (selected.current === sessionId) subscription.current?.requestSnapshot?.()
    }
    const local: LocalSubmission = { ...input, kind: input.text.trim() === '/compact' ? 'compaction' : 'message', state: 'pending', afterMessageId: stateRef.current.snapshot?.messages.at(-1)?.id }
    // 同步写门禁，React 渲染前的第二次发送手势也会被拦住。
    const previous = submissionsRef.current
    submissionsRef.current = [...previous, local]
    if (keepDraft) {
      const sent = { key: sessionId, text, revision: draftRevision(sessionId), ...sources, input, pending: false, quote, afterMessageId: local.afterMessageId }
      sourceSends.current.set(input.clientMessageId, sent)
      writeSourceSends(sourceSends.current.values())
      void sendSources(sent)
      return false
    }
    let request: Promise<SubmitMessageResult>
    try { request = submitMessage(input) }
    catch { submissionsRef.current = previous; return false }
    const quoteSent = draftQuote ? Symbol() : undefined
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
      const restored = rejected && !fromSchedule && restoreDraft(sessionId, text, clearedRevision, selected.current === sessionId, selectionChanged)
      if (restored && quoteSent) setQuotes(current => current[sessionId] === quoteSent ? { ...current, [sessionId]: draftQuote } : current)
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

  const sendScheduledPrompt = useEffectEvent((schedule: ScheduleView) => {
    if (!send(schedule.prompt, true)) setDraftIssue({ key: schedule.sessionId, notice: { key: 'schedule.runUnavailable' } })
  })
  useEffect(() => {
    if (!scheduleRun) return
    const { schedule } = scheduleRun
    if (section !== 'scheduled' || scheduleRun.navigation !== navigation.current || selectedSchedule?.id !== schedule.id) {
      setScheduleRun(undefined)
      return
    }
    if (sessionId !== schedule.sessionId || (state.connection !== 'disconnected' && !state.error && !state.snapshot)) return
    setScheduleRun(undefined)
    sendScheduledPrompt(schedule)
  }, [scheduleRun, section, selectedSchedule?.id, sessionId, state])

  const retryingSource = submissions.find(item => item.state === 'unconfirmed' && sourceSends.current.has(item.clientMessageId))
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
  const scheduleCreateBlocker: Notice | undefined = workspaceError ?? permissionReadError
    ?? (state.connection !== 'ready' ? { key: 'schedule.connection' }
      : !discovery?.defaultSelection || !hasModel(discovery.defaultSelection) ? { key: 'schedule.modelRequired' }
      : defaultPermission === 'read-only' ? { key: 'schedule.normalRequired' }
      : defaultPermission === null || planBusy ? { key: 'schedule.loading' } : undefined)
  const scheduleCreateAction = { onCreate: openScheduleCreate, createDisabled: firstPhase !== null }


  return (
    <SidebarProvider>
      <SidebarTrigger ref={sidebarButton} />
      <Sidebar>
        <div className="sidebar-title">
          <img src="/si-mark.svg" width={22} height={22} alt="SI" />
        </div>
        <SectionPicker section={section} onChange={switchSection} />
        {section === 'scheduled' ? <ScheduledTaskSidebar schedules={scheduleCatalog.view} sessions={sessions} selectedId={selectedSchedule?.id}
          onSelect={openScheduledSession} onRun={schedule => {
            openScheduledSession(schedule)
            setScheduleRun({ schedule, navigation: navigation.current })
          }} onDialog={setScheduleDialog} onChanged={refreshEditedSchedule} {...scheduleCreateAction} /> : <>
        <SidebarDismiss>
          <Button className="sidebar-new-session" variant={isNew ? 'secondary' : 'ghost'} aria-label={t('chat.new')} aria-current={isNew ? 'page' : undefined} onClick={() => openNewSession()}>
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
          <div className="sidebar-workspace-list">
            {workspaces?.workspaces.map(group => <div className="sidebar-workspace" key={group.id} role="group" aria-label={group.name}>
              <div className="workspace-row" data-bound={group.id === workspace?.id}>
                <FolderOpenIcon aria-hidden="true" /><span title={group.path}>{group.name}</span>
                <SidebarDismiss>
                  <Button className="workspace-add-session" variant="ghost" size="icon-sm" aria-label={t('chat.create')} title={t(group.available ? 'chat.create' : 'chat.workspaceUnavailable')} disabled={!group.available || firstPhase !== null} onClick={() => openNewSession(group.id)}>
                    <PlusIcon aria-hidden="true" />
                  </Button>
                </SidebarDismiss>
              </div>
              <div className="workspace-conversations">
                {isNew && group.id === draftWorkspace?.id && <SidebarDismiss>
                  <Button className="workspace-conversation" variant="secondary" aria-label={t('chat.unsent')} aria-current="page" onClick={() => openNewSession()}>{t('chat.new')}</Button>
                </SidebarDismiss>}
                {sessions?.filter(item => item.workspaceId === group.id).map(item => {
                  const active = item.id === sessionId
                  const alarmDescription = item.hasScheduledTask ? `schedule-mark-${item.id}` : undefined
                  return <SidebarDismiss key={item.id}>
                    <Button className="workspace-conversation" variant={active ? 'secondary' : 'ghost'} data-session-id={item.id}
                      aria-current={active ? 'page' : undefined} aria-describedby={alarmDescription} onClick={() => openSession(item.id, 'home')}>
                      <span className="sidebar-session-title" title={item.name}>{item.name}</span>
                      {alarmDescription && <>
                        <AlarmClockIcon className="workspace-conversation-alarm" aria-hidden="true" />
                        <span id={alarmDescription} hidden>{t('schedule.sessionMark')}</span>
                      </>}
                    </Button>
                  </SidebarDismiss>
                })}
              </div>
            </div>)}
          </div>
        </nav>
        </>}
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
      }} mcpSettings={{ servers: mcpServers, error: mcpError, refresh: refreshMcpServers }} discovery={discovery} onChange={applyModels} webSettings={webSettings} webSettingsError={webSettingsError} onWebSettingsChange={result => {
        if (!mounted.current) return
        applyWebSettings(result)
        void refreshWebSettings()
      }} />
      {section === 'scheduled' && !selectedSchedule && <ScheduledTasks catalog={scheduleCatalog} {...scheduleCreateAction} />}
      {scheduleDialog && <ScheduleActionDialog request={scheduleDialog}
        workspace={workspaces?.workspaces.find(item => item.id === scheduleDialog.schedule.workspaceId)}
        onChanged={refreshEditedSchedule}
        onDeleted={id => {
          scheduleCatalog.setView(current => current?.filter(schedule => schedule.id !== id))
          setSelectedScheduleId(current => current === id ? undefined : current)
        }}
        onClose={() => setScheduleDialog(undefined)} restoreFocus={() => {
          const trigger = scheduleDialog.trigger
          if (trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus()
          else sidebarButton.current?.focus()
        }} />}
      {scheduleCreateTrigger && <ScheduleCreateDialog workspaces={workspaces} preferredWorkspaceId={workspace?.id ?? draftWorkspace?.id}
        picking={picking} blocker={scheduleCreateBlocker} error={firstError ?? pickError} phase={firstPhase}
        onPickWorkspace={() => pickWorkspace(false)} onSubmit={createScheduleConversation}
        onRetry={() => { if (firstSend.current?.source === 'schedule') attemptFirstSend(firstSend.current) }}
        onClose={() => {
          setScheduleCreateTrigger(undefined)
          if (firstPhase === 'unconfirmed') openSession(null, 'home')
        }} restoreFocus={() => {
          const trigger = scheduleCreateFocus.current
          if (trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus()
          else sidebarButton.current?.focus()
        }} />}
      <div className="chat-workspace" hidden={section === 'scheduled' && !selectedSchedule}>
      <div className="chat-page" data-new-session={isNew || undefined} data-connection={state.connection} data-session-id={sessionId ?? undefined}>
      {extensionNotices?.sessionId === sessionId && <div className="save-notice" role="status">
        {extensionNotices.notices.map(({ message, level }, index) => <div key={index} data-level={level}>{message}</div>)}
      </div>}
      {saveNotice?.sessionId === sessionId && <p className="save-notice" role="alert"><NoticeText notice={saveNotice.text} /></p>}
      {!isNew && <header className="chat-header">
        <h1 title={session?.name}>{session?.name || t('chat.title')}</h1>
        <div className="chat-header-controls">
          <p className="connection-status" role="status">{status}</p>
          {sessionId && <BackgroundTasks sessionId={sessionId} />}
        </div>
      </header>}
      <div className="chat-main-frame">
      {section === 'home' && isNew && <NewChatParticles />}
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
            <h1 className="new-session-title" lang={i18n.language}>{t('chat.welcome')}</h1>
            <div className="new-session-workspace">
              <Select value={draftWorkspace?.id ?? ''} disabled={picking || !workspaces || firstPhase !== null || planBusy} onValueChange={value => {
                if (value === 'add-workspace') void pickWorkspace()
                else chooseDraftWorkspace(value)
              }}>
                <SelectTrigger aria-label={t('chat.workspace')}>
                  <FolderOpenIcon className="new-session-folder" aria-hidden="true" />
                  <SelectValue placeholder={t('chat.chooseWorkspace')} />
                </SelectTrigger>
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
          {draftIssue?.key === draftId && <p className="configuration-error" role="alert"><NoticeText notice={draftIssue.notice} /></p>}
          {retryingSource && <Button variant="outline" className="self-start" disabled={state.connection !== 'ready'} onClick={() => {
            const sent = sourceSends.current.get(retryingSource.clientMessageId)
            if (sent) void sendSources(sent)
          }}>{t('chat.retrySend')}</Button>}
          <ChatFileDrop onAddFiles={settingsOpen ? undefined : addFiles} onDirectoryDrop={() => {
            setDraftIssue({ key: draftId, notice: { key: 'attachment.folderUnsupported' } })
          }} />
          {sessionId && plan?.state === 'review' && <PlanReview
            key={`${sessionId}:${plan.assistantMessageId}`} sessionId={sessionId} planId={plan.assistantMessageId} steps={plan.steps}
            disabled={state.connection !== 'ready'} onSync={() => syncConversation(sessionId)}
            onAction={action => { discuss.current = action === 'discuss' ? { sessionId, planId: plan.assistantMessageId } : undefined }} />}
          <MessageInput key={draftId} editorRef={editor} draft={draft} onDraftChange={saveCurrentDraft}
            attachments={<DraftAttachments items={attachments} remove={id => {
              removeAttachments(draftId, item => item.key === id)
              editor.current?.focus({ preventScroll: true })
            }} retry={id => {
              const scope = sessionId ? { sessionId } : draftWorkspace?.available ? draftUploadScope(draftWorkspace.id) : undefined
              if (scope && (!isNew || !firstSend.current)) attachmentDrafts.retry(draftId, scope, id)
            }} />}
            onAddFiles={addFiles}
            hasAttachments={attachments.length > 0} attachmentsPending={attachments.some(item => item.status !== 'ready')}
            referenceSessions={referenceSessions} onSelectReference={selectReference}
            referenceDraft={references.length > 0 && <div className="reference-list" role="group" aria-label={t('chat.selectedReferences')}>
              {references.map(ref => {
                const name = sessions?.find(item => item.id === ref.id)?.name ?? ref.name
                return <span className="reference-draft" key={ref.id}><span>{name}</span>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('chat.removeReference', { name })} onClick={() => {
                    writeReferences(draftId, (referenceDrafts.current.get(draftId) ?? []).filter(item => item.id !== ref.id))
                    setDraftIssue(undefined)
                    editor.current?.focus({ preventScroll: true })
                  }}><XIcon aria-hidden="true" /></Button>
                </span>
              })}
            </div>}
            quote={quote} onRemoveQuote={sessionId === null ? undefined : () => setQuotes(current => {
              const next = { ...current }
              delete next[sessionId]
              return next
            })}
            contextMeter={<ContextMeter usage={state.snapshot?.contextUsage} />}
            planActive={Boolean(plan)} onExitPlan={sessionId && selection && state.connection === 'ready' && !planBusy ? exitPlan : undefined}
            permissionControl={<PermissionPicker mode={isNew ? pendingInput?.permissionMode ?? draftPermission : state.snapshot?.permissionMode ?? null}
                disabled={state.connection !== 'ready' || (isNew ? firstPhase !== null : sessionPermissionBusy)}
                onSelect={mode => { if (sessionId) void changeSessionPermission(sessionId, mode); else changeDraftPermission(mode) }} />}
            footerControl={modelSelect}
            skillWorkspaceId={quote ? undefined : (isNew ? draftWorkspace?.id : workspace?.id)}
            commandsEnabled={!isNew && !quote} onPlan={text => { void activatePlan(text) }} onSend={text => send(text)} sendDisabled={isNew ? !canStart() : !canSubmit()}
            action={action} abortDisabled={abortDisabled} onAbort={() => { void abort(target) }} />
        </div>
      </main>
      </div>
      </div>
      </div>
    </SidebarProvider>
  )
}
