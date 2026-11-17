import type { ModelDiscovery } from '@agent-learning/model'
import { isPermissionMode } from '@agent-learning/server/protocol'
import type { WorkspaceSkills, PermissionMode, PermissionSettings, SessionPermission, SaveModelSelectionRequest, AbortRequest, AbortResult, ClientFrame, InterfaceLanguage, SessionList, SessionSummary, StartSessionResult, StartSessionRequest, SubmitMessageAccepted, SubmitMessageRequest, SubmitMessageResult, WebSettingsView, WorkspacePick, WorkspaceView } from '@agent-learning/server/protocol'
import { RequestError } from '../i18n/messages'
import type { CopyKey } from '../i18n/en'
import { applyFrame, extensionNotice, initialState, isSkillSource, modelSelection, reasoningEffort, type ChatState, type Subscribe } from './state'

export const subscribe: Subscribe = (onState, onModelsChanged, onWorkspacesChanged, onWebSettingsChanged, onSessionsChanged, onPermissionSettingsChanged, onExtensionNotice) => {
  let state: ChatState = initialState
  let stopped = false
  let socket: WebSocket | null = null
  let subscriptionId = ''
  let removeSocketListeners = () => {}
  let retryCount = 0
  let slowTimer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function publish(next: ChatState) { state = next; onState(state) }
  function clearPreparation() { clearTimeout(slowTimer); clearTimeout(deadline) }
  function releaseSocket() {
    clearPreparation()
    removeSocketListeners()
    const previous = socket
    socket = null
    if (!previous) return
    if (previous.readyState === 1 && subscriptionId) {
      try { previous.send(JSON.stringify({ type: 'unsubscribe', subscriptionId } satisfies ClientFrame)) } catch { /* Closing releases the server subscription too. */ }
    }
    subscriptionId = ''
    previous.close()
  }
  function fail(key?: CopyKey) {
    const running = state.snapshot?.running
    const notice = key ?? (running?.kind === 'task' && running.retry ? 'chat.disconnected' : 'chat.connectionFailed')
    releaseSocket()
    if (stopped) return
    publish({ ...state, connection: 'disconnected', slow: false, error: null, connectionNotice: notice })
    if (!navigator.onLine) return
    const upper = Math.min(500 * 2 ** retryCount, 10_000)
    retryCount = Math.min(retryCount + 1, 5)
    retryTimer = setTimeout(connect, upper * (0.5 + Math.random() * 0.5))
  }
  function prepare() {
    clearPreparation()
    slowTimer = setTimeout(() => {
      if (!stopped && socket) publish({ ...state, slow: true })
    }, 3000)
    deadline = setTimeout(() => fail('chat.connectionTimeout'), 15_000)
  }
  function requestSnapshot() {
    const sessionId = state.sessionId
    if (!sessionId) return
    subscriptionId = crypto.randomUUID()
    publish({ ...state, connection: 'awaitingSnapshot', error: null })
    try { socket!.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId } satisfies ClientFrame)) } catch { fail() }
  }
  function connect() {
    clearTimeout(retryTimer)
    if (stopped || !navigator.onLine || socket) return
    publish({ ...state, connection: 'connecting', slow: false, error: null, connectionNotice: undefined })
    try {
      const url = new URL('/api/events', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url.href)
    } catch { fail(); return }
    const current = socket
    const open = () => {
      if (stopped || socket !== current) return
      if (state.sessionId) requestSnapshot()
      else {
        clearPreparation()
        retryCount = 0
        publish({ ...state, connection: 'ready', slow: false, error: null, connectionNotice: undefined })
      }
    }
    const message = (event: MessageEvent) => {
      if (stopped || socket !== current) return
      let frame: unknown
      try { frame = JSON.parse(event.data) } catch { return }
      if (record(frame)) {
        if (frame.type === 'models_changed') { onModelsChanged?.(); return }
        if (frame.type === 'workspaces_changed') { onWorkspacesChanged?.(); return }
        if (frame.type === 'sessions_changed') { onSessionsChanged?.(); return }
        if (frame.type === 'permission_settings_changed') { onPermissionSettingsChanged?.(); return }
        if (frame.type === 'web_settings_changed') { onWebSettingsChanged?.(); return }
      }
      const result = applyFrame(state, frame, subscriptionId)
      if (result.resubscribe) { prepare(); requestSnapshot(); return }
      if (result.state === state) return
      if (result.state.connection === 'ready') { clearPreparation(); retryCount = 0 }
      publish(result.state)
      if (result.notice && result.state.sessionId) onExtensionNotice?.(result.notice, result.state.sessionId)
    }
    const failure = () => { if (!stopped && socket === current) fail() }
    current.addEventListener('open', open)
    current.addEventListener('message', message)
    current.addEventListener('error', failure)
    current.addEventListener('close', failure)
    removeSocketListeners = () => {
      current.removeEventListener('open', open)
      current.removeEventListener('message', message)
      current.removeEventListener('error', failure)
      current.removeEventListener('close', failure)
    }
    prepare()
  }
  const offline = () => {
    clearTimeout(retryTimer)
    releaseSocket()
    if (!stopped) publish({ ...state, connection: 'disconnected', slow: false, error: null, connectionNotice: 'chat.offline' })
  }
  const online = () => { if (!stopped) connect() }
  window.addEventListener('offline', offline)
  window.addEventListener('online', online)
  if (navigator.onLine) connect()
  else offline()
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(retryTimer)
    window.removeEventListener('offline', offline)
    window.removeEventListener('online', online)
    releaseSocket()
  }
  return Object.assign(stop, {
    requestSnapshot: () => {
      if (stopped || socket?.readyState !== 1 || !state.sessionId) return
      prepare()
      requestSnapshot()
    },
    setSession: (sessionId: string | null) => {
      if (stopped || state.sessionId === sessionId) return
      state = { ...state, sessionId, snapshot: null, slow: false, error: null, connectionNotice: undefined }
      if (socket?.readyState !== 1) {
        publish(state)
        return
      }
      if (sessionId) {
        prepare()
        requestSnapshot()
      } else {
        clearPreparation()
        const previous = subscriptionId
        subscriptionId = ''
        if (previous) {
          try { socket.send(JSON.stringify({ type: 'unsubscribe', subscriptionId: previous } satisfies ClientFrame)) }
          catch { fail(); return }
        }
        publish({ ...state, connection: 'ready' })
      }
    },
  })
}


const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const credentialStatus = (value: unknown) => record(value) && (value.state === 'missing' || value.state === 'configured'
  || (value.state === 'error' && typeof value.message === 'string'))

function modelDiscovery(value: unknown): value is ModelDiscovery {
  if (!record(value) || !Array.isArray(value.models) || !Array.isArray(value.providers)) return false
  return value.models.every(model => record(model) && ['id', 'name', 'provider', 'api'].every(key => typeof model[key] === 'string')
    && ['contextWindow', 'maxTokens'].every(key => typeof model[key] === 'number' && Number.isSafeInteger(model[key]) && (model[key] as number) > 0)
    && (model.reasoningEfforts === undefined ? model.defaultReasoningEffort === undefined
      : Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.every(reasoningEffort) && model.reasoningEfforts.some(level => level === model.defaultReasoningEffort)))
    && value.providers.every(provider => record(provider) && typeof provider.id === 'string' && typeof provider.name === 'string' && credentialStatus(provider.status))
    && (value.defaultSelection === undefined || modelSelection(value.defaultSelection))
}

function workspaceView(value: unknown): value is WorkspaceView {
  return record(value) && Array.isArray(value.workspaces) && value.workspaces.every(workspace => record(workspace) && typeof workspace.id === 'string'
      && typeof workspace.name === 'string' && typeof workspace.path === 'string' && typeof workspace.available === 'boolean')
}

function workspacePick(value: unknown): value is WorkspacePick {
  return record(value) && (value.cancelled === true || (value.cancelled === false && typeof value.created === 'boolean'
    && workspaceView(value.view) && value.view.workspaces.some(workspace => workspace.id === value.workspaceId)))
}

function sessionSummary(value: unknown): value is SessionSummary {
  return record(value) && typeof value.id === 'string' && !!value.id.trim()
    && typeof value.workspaceId === 'string' && !!value.workspaceId.trim()
    && typeof value.name === 'string' && !!value.name.trim()
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
}

function sessionList(value: unknown): value is SessionList {
  return record(value) && Array.isArray(value.sessions) && value.sessions.every(sessionSummary)
    && new Set(value.sessions.map(item => item.id)).size === value.sessions.length
}

function webSettings(value: unknown): value is WebSettingsView {
  return record(value) && typeof value.searchProvider === 'string' && typeof value.fetchProvider === 'string'
    && Array.isArray(value.providers) && value.providers.every(provider => record(provider) && typeof provider.id === 'string'
      && typeof provider.name === 'string' && Array.isArray(provider.capabilities) && provider.capabilities.every(item => item === 'search' || item === 'fetch')
      && credentialStatus(provider.status))
}

async function requestView<T>(path: string, label: CopyKey, validate: (value: unknown) => value is T, options: RequestInit = {}, apiKey = ''): Promise<T> {
  let response: Response
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options }) }
  catch { throw new RequestError({ key: 'request.network' }) }
  if (response.status === 401) throw new RequestError({ key: 'request.unauthorized' })
  if (response.status === 403) throw new RequestError({ key: 'request.forbidden' })
  let value: unknown
  try { value = await response.json() } catch { throw new RequestError({ key: 'request.invalid', label }) }
  if (!response.ok) {
    const detail = record(value) && typeof value.error === 'string' ? value.error : undefined
    throw new RequestError({ key: 'request.failed', label, detail: apiKey ? detail?.split(apiKey).join('•••') : detail })
  }
  if (!validate(value)) throw new RequestError({ key: 'request.invalid', label })
  return value
}

export function getWorkspaceSkills(workspaceId: string, signal: AbortSignal) {
  return requestView(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`, 'chat.skills',
    (value): value is WorkspaceSkills => record(value) && typeof value.complete === 'boolean'
      && Array.isArray(value.skills) && value.skills.every(skill => record(skill)
        && typeof skill.name === 'string' && typeof skill.description === 'string'
        && isSkillSource(skill.source) && typeof skill.disableModelInvocation === 'boolean'),
    { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
}

const putJson = (value: unknown): RequestInit => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

const permissionPath = '/api/settings/permission'
const permissionSettings = (value: unknown): value is PermissionSettings =>
  record(value) && isPermissionMode(value.defaultPermissionMode)
const sessionPermission = (value: unknown): value is SessionPermission =>
  record(value) && isPermissionMode(value.permissionMode)

export async function getDefaultPermission() {
  const view = await requestView(permissionPath, 'permission.label', permissionSettings, { signal: AbortSignal.timeout(5000) })
  return view.defaultPermissionMode
}

export async function saveDefaultPermission(defaultPermissionMode: PermissionMode) {
  const view = await requestView(permissionPath, 'permission.label', permissionSettings, {
    ...putJson({ defaultPermissionMode }), signal: AbortSignal.timeout(5000),
  })
  if (view.defaultPermissionMode !== defaultPermissionMode) throw new Error('Unexpected default permission response')
}

export async function saveSessionPermission(sessionId: string, permissionMode: PermissionMode) {
  const view = await requestView(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, 'permission.label', sessionPermission, {
    ...putJson({ permissionMode }), signal: AbortSignal.timeout(5000),
  })
  if (view.permissionMode !== permissionMode) throw new Error('Unexpected session permission response')
}

const languagePath = '/api/settings/language'

async function languageFrom(response: Response): Promise<InterfaceLanguage> {
  if (response.status !== 200) {
    const error: unknown = await response.json().catch(() => undefined)
    throw new RequestError({ key: 'settings.language.readFailed', status: response.status,
      detail: record(error) && typeof error.error === 'string' ? error.error : undefined })
  }
  const value: unknown = await response.json()
  if (!record(value) || (value.language !== 'en' && value.language !== 'zh-CN')) throw new Error('Invalid language settings response')
  return value.language
}

export async function getLanguage() {
  return languageFrom(await fetch(languagePath, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(2500) }))
}

export async function saveLanguage(language: InterfaceLanguage) {
  const response = await fetch(languagePath, { ...putJson({ language }), credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (await languageFrom(response) !== language) throw new Error('Unexpected language settings response')
}

export const getModels = () => requestView('/api/models', 'request.models', modelDiscovery)
export const saveApiKey = (provider: string, apiKey: string) => requestView(`/api/providers/${encodeURIComponent(provider)}`, 'request.models', modelDiscovery, putJson({ apiKey }), apiKey)
export const deleteApiKey = (provider: string) => requestView(`/api/providers/${encodeURIComponent(provider)}`, 'request.models', modelDiscovery, { method: 'DELETE' })

export const saveModelSelection = (input: SaveModelSelectionRequest) =>
  requestView('/api/model-selection', 'request.selection', modelSelection, { ...putJson(input), signal: AbortSignal.timeout(10_000) })

export const getWorkspaces = () => requestView('/api/workspaces', 'request.workspaces', workspaceView)
export const pickWorkspace = () => requestView('/api/workspaces/pick', 'request.workspacePicker', workspacePick, { method: 'POST' })

export const getSessions = async () => (await requestView('/api/sessions', 'request.sessions', sessionList)).sessions

export const getWebSettings = () => requestView('/api/web/settings', 'request.web', webSettings)
export const saveWebSettings = (selection: Pick<WebSettingsView, 'searchProvider' | 'fetchProvider'>) =>
  requestView('/api/web/settings', 'request.web', webSettings, putJson(selection))
export const saveWebApiKey = (providerId: string, apiKey: string) =>
  requestView(`/api/web/providers/${encodeURIComponent(providerId)}`, 'request.web', webSettings, putJson({ apiKey }), apiKey)
export const deleteWebApiKey = (providerId: string) =>
  requestView(`/api/web/providers/${encodeURIComponent(providerId)}`, 'request.web', webSettings, { method: 'DELETE' })

export async function abortMessage(input: AbortRequest): Promise<AbortResult> {
  let response: Response
  try { response = await fetch('/api/abort', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }
  catch { throw new RequestError({ key: 'request.abortNetwork' }) }
  if (response.status === 401) throw new RequestError({ key: 'request.unauthorized' })
  if (response.status === 403) throw new RequestError({ key: 'request.forbidden' })
  let value: unknown
  try { value = await response.json() } catch { value = null }
  if (!response.ok) throw new RequestError({ key: 'request.abortFailed', detail: record(value) && typeof value.error === 'string' ? value.error : undefined })
  if (response.status !== 200 || !record(value) || value.sessionId !== input.sessionId || value.runId !== input.runId || typeof value.handled !== 'boolean') {
    throw new RequestError({ key: 'request.abortInvalid' })
  }
  return value as AbortResult
}

async function postSubmission(path: string, input: SubmitMessageRequest | StartSessionRequest, signal?: AbortSignal) {
  let response: Response
  try { response = await fetch(path, { ...putJson(input), method: 'POST', credentials: 'same-origin', cache: 'no-store', ...(signal && { signal }) }) }
  catch { throw new RequestError({ key: 'request.sendNetwork' }) }
  let value: unknown
  try { value = await response.json() } catch { value = null }
  const code = record(value) ? value.code : undefined
  if (code === 'save_rejected' || code === 'save_unconfirmed' || code === 'model_selection_changed') {
    const key = code === 'model_selection_changed' ? 'model.selectionChanged' : code === 'save_unconfirmed' ? 'save.unconfirmed' : 'request.saveFailed'
    const detail = record(value) && typeof value.error === 'string' ? value.error : undefined
    throw Object.assign(new RequestError({ key, detail }), { status: response.status, code })
  }
  if (response.status >= 400 && response.status < 500) {
    const { status } = response
    const key = status === 401 ? 'request.unauthorized' : status === 403 ? 'request.forbidden' : status === 409 ? 'request.busy' : 'request.sendRejected'
    const detail = status !== 401 && status !== 403 && record(value) && typeof value.error === 'string' ? value.error : undefined
    throw Object.assign(new RequestError({ key, detail, status }), { status })
  }
  if (response.status !== 202) throw new RequestError({ key: 'request.sendInvalid' })
  return value
}

function acceptedSubmission(value: unknown, sessionId: string, clientMessageId: string, kind: SubmitMessageAccepted['kind']): value is SubmitMessageAccepted {
  return record(value) && value.sessionId === sessionId && value.clientMessageId === clientMessageId
    && value.kind === kind && typeof value[kind === 'compaction' ? 'compactionId' : 'userMessageId'] === 'string'
    && !!value[kind === 'compaction' ? 'compactionId' : 'userMessageId']
    && Number.isSafeInteger(value.acceptedSeq) && (value.acceptedSeq as number) >= 0
}

function handledSubmission(value: unknown, id: string, key: 'sessionId' | 'draftSessionId', sessionId: string) {
  return record(value) && value.kind === 'handled' && value.clientMessageId === id && value[key] === sessionId
    && Array.isArray(value.notices) && value.notices.every(extensionNotice)
    ? { kind: 'handled' as const, clientMessageId: id, notices: value.notices } : undefined
}

export async function submitMessage(input: SubmitMessageRequest): Promise<SubmitMessageResult> {
  const value = await postSubmission('/api/messages', input)
  const handled = input.text.trim() !== '/compact' && handledSubmission(value, input.clientMessageId, 'sessionId', input.sessionId)
  if (handled) return { ...handled, sessionId: input.sessionId }
  if (!acceptedSubmission(value, input.sessionId, input.clientMessageId, input.text.trim() === '/compact' ? 'compaction' : 'message')) {
    throw new RequestError({ key: 'request.sendInvalid' })
  }
  return value
}

export async function startSession(input: StartSessionRequest): Promise<StartSessionResult> {
  const value = await postSubmission('/api/sessions/start', input, AbortSignal.timeout(10_000))
  const draftSessionId = input.draftSessionId ?? input.clientMessageId
  const handled = handledSubmission(value, input.clientMessageId, 'draftSessionId', draftSessionId)
  if (handled) return { ...handled, draftSessionId }
  if (!record(value) || !sessionSummary(value.session) || value.session.id !== draftSessionId || value.session.workspaceId !== input.workspaceId
    || !acceptedSubmission(value.accepted, value.session.id, input.clientMessageId, 'message')) {
    throw new RequestError({ key: 'request.firstInvalid' })
  }
  return { session: value.session, accepted: value.accepted }
}
