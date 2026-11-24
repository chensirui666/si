import type { ModelDiscovery } from '@agent-learning/model'
import { isPermissionMode } from '@agent-learning/server/protocol'
import type { BashJobsView, StopBashJobResult, WorkspaceSkills, PermissionMode, PermissionSettings, SessionPermission, SaveModelSelectionRequest, AbortRequest, AbortResult, ClientFrame, InterfaceLanguage, McpOAuthStartView, McpServerView, SaveMcpServerRequest, SessionList, SessionSummary, StartSessionResult, StartSessionRequest, SubmitMessageAccepted, SubmitMessageRequest, SubmitMessageResult, WebSettingsView, WorkspacePick, WorkspaceView } from '@agent-learning/server/protocol'
import type { QuestionAnswer, QuestionReply, QuestionWaitSettings, QueueAction, QueueResult } from '@agent-learning/server/protocol'
import type { DeleteMemoryEntryView, MemorySettingsView, ProjectMemoriesView, ProjectMemoryView, SchedulePatch, ScheduleView, UserMemoryView } from '@agent-learning/server/protocol'
import { RequestError } from '../i18n/messages'
import type { CopyKey } from '../i18n/en'
import { applyFrame, messageAttachment, extensionNotice, initialState, isSkillSource, modelSelection, reasoningEffort, type ChatState, type Subscribe } from './state'

export const subscribe: Subscribe = (onState, onModelsChanged, onWorkspacesChanged, onWebSettingsChanged, onSessionsChanged, onPermissionSettingsChanged, onExtensionNotice, onMcpSettingsChanged) => {
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
        if (frame.type === 'mcp_settings_changed') { onMcpSettingsChanged?.(); return }
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
    && (value.hasScheduledTask === undefined || typeof value.hasScheduledTask === 'boolean')
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
  try { if (response.status !== 204) value = await response.json() } catch { throw new RequestError({ key: 'request.invalid', label }) }
  if (!response.ok) {
    const detail = record(value) && typeof value.error === 'string' ? value.error : undefined
    throw new RequestError({ key: 'request.failed', label, status: response.status, detail: apiKey ? detail?.split(apiKey).join('•••') : detail })
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

const memorySettingsPath = '/api/settings/memory'
const userMemoryPath = '/api/memory/user'
const projectMemoriesPath = '/api/memory/projects'
const validRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isMemorySettings = (value: unknown): value is MemorySettingsView =>
  record(value) && typeof value.memoryEnabled === 'boolean'
const isUserMemory = (value: unknown): value is UserMemoryView =>
  record(value) && typeof value.markdown === 'string' && validRevision(value.revision)
function isProjectMemory(value: unknown): value is ProjectMemoryView {
  return record(value) && typeof value.projectId === 'string' && typeof value.name === 'string'
    && typeof value.path === 'string' && typeof value.directoryPath === 'string' && typeof value.markdown === 'string'
    && validRevision(value.count) && validRevision(value.bytes) && Array.isArray(value.entries) && value.count === value.entries.length
    && value.entries.every(entry => record(entry) && typeof entry.entryId === 'string' && validRevision(entry.revision)
      && typeof entry.title === 'string' && typeof entry.summary === 'string' && typeof entry.path === 'string' && typeof entry.line === 'string')
}

export const getMemorySettings = () => requestView(memorySettingsPath, 'memory.title', isMemorySettings, { signal: AbortSignal.timeout(5000) })
export const saveMemorySettings = (memoryEnabled: boolean) => requestView(memorySettingsPath, 'memory.title', isMemorySettings, {
  ...putJson({ memoryEnabled }), signal: AbortSignal.timeout(5000),
})
export const getUserMemory = () => requestView(userMemoryPath, 'memory.user', isUserMemory, { signal: AbortSignal.timeout(5000) })
export const saveUserMemory = (markdown: string, expectedRevision: number) => requestView(userMemoryPath, 'memory.user', isUserMemory, {
  ...putJson({ markdown, expectedRevision }), signal: AbortSignal.timeout(5000),
})
export const getProjectMemories = () => requestView(projectMemoriesPath, 'memory.projects',
  (value): value is ProjectMemoriesView => record(value) && Array.isArray(value.projects) && value.projects.every(isProjectMemory),
  { signal: AbortSignal.timeout(5000) })
export const deleteProjectMemoryEntry = (projectId: string, entryId: string, expectedRevision: number) =>
  requestView(`${projectMemoriesPath}/${encodeURIComponent(projectId)}/entries/${encodeURIComponent(entryId)}`, 'memory.projects',
    (value): value is DeleteMemoryEntryView => record(value) && (value.project === null || isProjectMemory(value.project)),
    { ...putJson({ expectedRevision }), method: 'DELETE', signal: AbortSignal.timeout(5000) })

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

const schedulesPath = '/api/schedules'
const schedulePath = (id: string) => `${schedulesPath}/${encodeURIComponent(id)}`
const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(new Date(value).getTime())

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return Boolean(new Intl.DateTimeFormat('en', { timeZone: value })) }
  catch { return false }
}

function isSchedule(value: unknown): value is ScheduleView {
  if (!record(value) || !record(value.schedule)) return false
  const rule = value.schedule
  return typeof value.id === 'string' && typeof value.sessionId === 'string' && typeof value.workspaceId === 'string'
    && typeof value.prompt === 'string' && isTimeZone(value.timezone)
    && (value.status === 'enabled' || value.status === 'paused') && (value.sessionMode === 'reuse' || value.sessionMode === 'new')
    && (value.nextRunAt === null || isTimestamp(value.nextRunAt))
    && typeof rule.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rule.time)
    && (rule.kind === 'daily' || rule.kind === 'weekdays' || (rule.kind === 'weekly' && Array.isArray(rule.weekdays)
      && rule.weekdays.length > 0 && rule.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7)))
}

export async function getSchedules(signal: AbortSignal) {
  return (await requestView(schedulesPath, 'schedule.title',
    (value): value is { schedules: ScheduleView[] } => record(value) && Array.isArray(value.schedules) && value.schedules.every(isSchedule),
    { signal })).schedules
}

export async function updateSchedule(id: string, patch: SchedulePatch) {
  return (await requestView(schedulePath(id), 'schedule.title',
    (value): value is { schedule: ScheduleView } => record(value) && isSchedule(value.schedule) && value.schedule.id === id,
    { ...putJson(patch), method: 'PATCH', signal: AbortSignal.timeout(10_000) })).schedule
}

export const deleteSchedule = (id: string) => requestView(schedulePath(id), 'schedule.title',
  (value): value is undefined => value === undefined, { method: 'DELETE', signal: AbortSignal.timeout(10_000) })

const jobsPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/jobs`

export const getBashJobs = async (sessionId: string, signal: AbortSignal) => (await requestView(jobsPath(sessionId), 'background.title',
  (value): value is BashJobsView => record(value) && value.sessionId === sessionId && Array.isArray(value.jobs)
    && value.jobs.every(job => record(job) && typeof job.jobId === 'string' && !!job.jobId && typeof job.command === 'string' && job.status === 'running')
    && new Set(value.jobs.map(job => job.jobId)).size === value.jobs.length,
  { signal })).jobs

export const stopBashJob = (sessionId: string, jobId: string) => requestView(`${jobsPath(sessionId)}/${encodeURIComponent(jobId)}/stop`, 'background.stop',
  (value): value is StopBashJobResult => record(value) && value.sessionId === sessionId && record(value.job) && value.job.jobId === jobId
    && typeof value.job.command === 'string' && (value.job.status === 'exited' || value.job.status === 'stopped' || value.job.status === 'failed')
    && (value.job.exitCode === null || Number.isInteger(value.job.exitCode))
    && (value.job.signal === null || typeof value.job.signal === 'string')
    && (value.job.reason === undefined || typeof value.job.reason === 'string'),
  { method: 'POST', signal: AbortSignal.timeout(10_000) })

export const getWebSettings = () => requestView('/api/web/settings', 'request.web', webSettings)
export const saveWebSettings = (selection: Pick<WebSettingsView, 'searchProvider' | 'fetchProvider'>) =>
  requestView('/api/web/settings', 'request.web', webSettings, putJson(selection))
export const saveWebApiKey = (providerId: string, apiKey: string) =>
  requestView(`/api/web/providers/${encodeURIComponent(providerId)}`, 'request.web', webSettings, putJson({ apiKey }), apiKey)
export const deleteWebApiKey = (providerId: string) =>
  requestView(`/api/web/providers/${encodeURIComponent(providerId)}`, 'request.web', webSettings, { method: 'DELETE' })

const mcpPath = '/api/mcp/servers'
const mcpServerPath = (id: string) => `${mcpPath}/${encodeURIComponent(id)}`
const mcpStatuses = [
  'not_connected', 'connecting', 'connected', 'connection_failed', 'authorization_required', 'authorizing', 'disconnected', 'recovering', 'disabled',
] satisfies McpServerView['status'][]

function mcpServer(value: unknown): value is McpServerView {
  return record(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.url === 'string'
    && typeof value.enabled === 'boolean' && typeof value.hasCredential === 'boolean'
    && (value.authMode === 'token' || value.authMode === 'oauth')
    && (value.clientId === undefined || typeof value.clientId === 'string')
    && (value.error === undefined || typeof value.error === 'string')
    && (value.attemptId === undefined || typeof value.attemptId === 'string')
    && mcpStatuses.some(status => status === value.status)
    && Array.isArray(value.tools) && value.tools.every(tool => record(tool) && typeof tool.name === 'string'
      && (tool.description === undefined || typeof tool.description === 'string'))
}

function mcpOAuthStart(value: unknown): value is McpOAuthStartView {
  if (!record(value) || typeof value.attemptId !== 'string' || typeof value.authorizationUrl !== 'string') return false
  try {
    const url = new URL(value.authorizationUrl)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch { return false }
}

const requestMcp = <T>(path: string, validate: (value: unknown) => value is T, options?: RequestInit, secret?: string) =>
  requestView(path, 'settings.mcp', validate, { signal: AbortSignal.timeout(30_000), ...options }, secret)

export const getMcpServers = async () => (await requestMcp(mcpPath, (value): value is { servers: McpServerView[] } =>
  record(value) && Array.isArray(value.servers) && value.servers.every(mcpServer))).servers

export const saveMcpServer = (input: SaveMcpServerRequest, id?: string) =>
  requestMcp(id ? mcpServerPath(id) : mcpPath, mcpServer, { ...putJson(input), method: id ? 'PUT' : 'POST' }, input.token ?? input.clientSecret)

export const enableMcpServer = (id: string, enabled: boolean) =>
  requestMcp(`${mcpServerPath(id)}/enabled`, mcpServer, putJson({ enabled }))

export const deleteMcpServer = (id: string) => requestMcp(mcpServerPath(id),
  (value): value is { removed: true; error?: string } => record(value) && value.removed === true
    && (value.error === undefined || typeof value.error === 'string'), { method: 'DELETE' })

export const startMcpOAuth = (id: string) =>
  requestMcp(`${mcpServerPath(id)}/oauth`, mcpOAuthStart, { method: 'POST' })

export const cancelMcpOAuth = (id: string, attemptId: string) =>
  requestMcp(`${mcpServerPath(id)}/oauth/${encodeURIComponent(attemptId)}`, (value): value is undefined => value === undefined, { method: 'DELETE' })

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
  const awaitsReceipt = input.attachmentIds?.length || input.referenceSessionIds?.length || ['/plan', '/plan off'].includes(input.text.trim())
  const value = await postSubmission('/api/messages', input, awaitsReceipt ? AbortSignal.timeout(10_000) : undefined)
  const handled = input.text.trim() !== '/compact' && handledSubmission(value, input.clientMessageId, 'sessionId', input.sessionId)
  if (handled) return { ...handled, sessionId: input.sessionId }
  const isCompaction = input.text.trim() === '/compact'
  if (!isCompaction && record(value) && (value.kind === 'queued' || value.kind === 'steering')
    && value.sessionId === input.sessionId && value.clientMessageId === input.clientMessageId
    && typeof value.acceptedSeq === 'number' && Number.isSafeInteger(value.acceptedSeq) && value.acceptedSeq >= 0) {
    return { kind: value.kind, sessionId: input.sessionId, clientMessageId: input.clientMessageId, acceptedSeq: value.acceptedSeq }
  }
  if (!acceptedSubmission(value, input.sessionId, input.clientMessageId, isCompaction ? 'compaction' : 'message')) {
    throw new RequestError({ key: 'request.sendInvalid' })
  }
  return value
}

export function updateQueuedMessage(sessionId: string, messageId: string, action: QueueAction) {
  const statuses: QueueResult['status'][] = ['queued', 'steering', 'started', 'deleted', 'delivered', 'missing', 'unavailable']
  return requestView(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(messageId)}`, 'queue.label',
    (value): value is QueueResult => record(value) && statuses.some(status => status === value.status),
    { ...(action.action === 'delete' ? { method: 'DELETE' } : { ...putJson(action), method: 'PATCH' }), signal: AbortSignal.timeout(10_000) })
}

export function replyToQuestions(sessionId: string, batchId: string, replyId: string, answers: QuestionAnswer[]) {
  return requestView(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(batchId)}/reply`, 'question.submit',
    (value): value is QuestionReply =>
      record(value) && (value.kind === 'answered' || value.kind === 'late' || value.kind === 'closed') && value.replyId === replyId,
    { ...putJson({ replyId, answers }), method: 'POST', signal: AbortSignal.timeout(10_000) })
}

const isQuestionWait = (value: unknown): value is QuestionWaitSettings => record(value) && (value.timeout === 120 || value.timeout === -1)

export function getQuestionWait() {
  return requestView('/api/settings/question-wait', 'question.setting', isQuestionWait)
}

export function saveQuestionWait(timeout: QuestionWaitSettings['timeout']) {
  return requestView('/api/settings/question-wait', 'question.setting', isQuestionWait,
    { ...putJson({ timeout }), signal: AbortSignal.timeout(10_000) })
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

export type { MessageAttachment as Attachment } from '@agent-learning/server/protocol'
export type AttachmentScope = { sessionId: string } | { workspaceId: string; draftSessionId: string }
export const attachmentPath = (id: string) => `/api/attachments/${encodeURIComponent(id)}`

export function uploadAttachment(scope: AttachmentScope, file: File, signal: AbortSignal) {
  return requestView(`/api/attachments?${new URLSearchParams(scope)}`, 'attachment.uploadFailed',
    messageAttachment,
    { method: 'POST', headers: { 'X-Attachment-Name': encodeURIComponent(file.name) }, body: file, signal })
}

export function createSession(workspaceId: string, permissionMode: PermissionMode) {
  return requestView('/api/sessions', 'chat.create', sessionSummary, {
    ...putJson({ workspaceId, permissionMode }), method: 'POST', signal: AbortSignal.timeout(10_000),
  })
}

export type PlanReviewAction = 'approve' | 'discuss'
export async function reviewPlan(sessionId: string, planId: string, action: PlanReviewAction) {
  let response: Response
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plan/review`, {
      ...putJson({ planId, action }), method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new RequestError({ key: 'request.network' })
  }
  if (response.ok) return
  const value: unknown = await response.json().catch(() => null)
  throw new RequestError({ key: 'plan.reviewFailed', detail: record(value) && typeof value.error === 'string' ? value.error : undefined })
}
