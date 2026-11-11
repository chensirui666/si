import type { ModelDiscovery } from '@agent-learning/model'
import type { AbortRequest, AbortResult, ClientFrame, SessionList, SessionSummary, StartSessionAccepted, StartSessionRequest, SubmitMessageAccepted, SubmitMessageRequest, WebSettingsView, WorkspacePick, WorkspaceView } from '@agent-learning/server/protocol'
import { applyFrame, initialState, type ChatState, type Subscribe } from './state'

export const subscribe: Subscribe = (onState, onModelsChanged, onWorkspacesChanged, onWebSettingsChanged, onSessionsChanged) => {
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
  function fail(error = '连接异常，请重新打开启动链接后重试') {
    releaseSocket()
    if (stopped) return
    publish({ ...state, connection: 'disconnected', slow: false, error })
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
    deadline = setTimeout(() => fail('连接超时，正在重试；如持续异常，请重新打开启动链接'), 15_000)
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
    publish({ ...state, connection: 'connecting', slow: false, error: null })
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
        publish({ ...state, connection: 'ready', slow: false, error: null })
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
        if (frame.type === 'web_settings_changed') { onWebSettingsChanged?.(); return }
      }
      const result = applyFrame(state, frame, subscriptionId)
      if (result.resubscribe) { prepare(); requestSnapshot(); return }
      if (result.state === state) return
      if (result.state.connection === 'ready') { clearPreparation(); retryCount = 0 }
      publish(result.state)
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
    if (!stopped) publish({ ...state, connection: 'disconnected', slow: false, error: '网络已离线，联网后自动恢复' })
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
      state = { ...state, sessionId, snapshot: null, slow: false, error: null }
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
  if (!record(value) || !Array.isArray(value.models) || !record(value.deepseek)) return false
  return value.models.every(model => record(model) && ['id', 'name', 'provider', 'api'].every(key => typeof model[key] === 'string')
    && ['contextWindow', 'maxTokens'].every(key => typeof model[key] === 'number' && Number.isSafeInteger(model[key]) && (model[key] as number) > 0))
    && credentialStatus(value.deepseek)
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

async function requestView<T>(path: string, label: string, validate: (value: unknown) => value is T, options: RequestInit = {}, apiKey = ''): Promise<T> {
  let response: Response
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options }) }
  catch { throw new Error('网络请求失败，请检查连接后重试') }
  if (response.status === 401) throw new Error('授权已失效，请重新打开启动链接')
  if (response.status === 403) throw new Error('访问来源不可信，请从启动链接进入')
  let value: unknown
  try { value = await response.json() } catch { throw new Error(`${label}响应无效，请重试`) }
  if (!response.ok) {
    const message = record(value) && typeof value.error === 'string' ? value.error : `${label}请求失败，请重试`
    throw new Error(apiKey ? message.split(apiKey).join('•••') : message)
  }
  if (!validate(value)) throw new Error(`${label}响应无效，请重试`)
  return value
}

const putJson = (value: unknown): RequestInit => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

export const getModels = () => requestView('/api/models', '模型配置', modelDiscovery)
export const saveApiKey = (apiKey: string) => requestView('/api/providers/deepseek', '模型配置', modelDiscovery, putJson({ apiKey }), apiKey)
export const deleteApiKey = () => requestView('/api/providers/deepseek', '模型配置', modelDiscovery, { method: 'DELETE' })

export const getWorkspaces = () => requestView('/api/workspaces', '工作区', workspaceView)
export const pickWorkspace = () => requestView('/api/workspaces/pick', '工作区选择', workspacePick, { method: 'POST' })

export const getSessions = async () => (await requestView('/api/sessions', '会话列表', sessionList)).sessions

export const getWebSettings = () => requestView('/api/web/settings', '网页工具设置', webSettings)
export const saveWebSettings = (selection: Pick<WebSettingsView, 'searchProvider' | 'fetchProvider'>) =>
  requestView('/api/web/settings', '网页工具设置', webSettings, putJson(selection))
export const saveWebApiKey = (providerId: string, apiKey: string) =>
  requestView(`/api/web/providers/${encodeURIComponent(providerId)}`, '网页工具设置', webSettings, putJson({ apiKey }), apiKey)
export const deleteWebApiKey = (providerId: string) =>
  requestView(`/api/web/providers/${encodeURIComponent(providerId)}`, '网页工具设置', webSettings, { method: 'DELETE' })

export async function abortMessage(input: AbortRequest): Promise<AbortResult> {
  let response: Response
  try { response = await fetch('/api/abort', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }
  catch { throw new Error('网络请求失败，未确认中止') }
  if (response.status === 401) throw new Error('授权已失效，请重新打开启动链接')
  if (response.status === 403) throw new Error('访问来源不可信，请从启动链接进入')
  let value: unknown
  try { value = await response.json() } catch { value = null }
  if (!response.ok) throw new Error(record(value) && typeof value.error === 'string' ? value.error : '中止请求失败，请重新同步后重试')
  if (response.status !== 200 || !record(value) || value.sessionId !== input.sessionId || value.runId !== input.runId || typeof value.handled !== 'boolean') {
    throw new Error('中止回执无效，未确认中止')
  }
  return value as AbortResult
}

async function postSubmission(path: string, input: SubmitMessageRequest | StartSessionRequest, signal?: AbortSignal) {
  let response: Response
  try { response = await fetch(path, { ...putJson(input), method: 'POST', credentials: 'same-origin', cache: 'no-store', ...(signal && { signal }) }) }
  catch { throw new Error('网络请求失败，未确认接收') }
  let value: unknown
  try { value = await response.json() } catch { value = null }
  const code = record(value) ? value.code : undefined
  if (code === 'save_rejected' || code === 'save_unconfirmed') {
    const message = record(value) && typeof value.error === 'string' ? value.error : '会话保存失败'
    throw Object.assign(new Error(message), { status: response.status, code })
  }
  if (response.status >= 400 && response.status < 500) {
    const message = response.status === 401 ? '授权已失效，请重新打开启动链接' : response.status === 403 ? '访问来源不可信，请从启动链接进入'
      : record(value) && typeof value.error === 'string' ? value.error : response.status === 409 ? '正在生成，请等待回答结束' : `消息提交被拒绝（HTTP ${response.status}）`
    throw Object.assign(new Error(message), { status: response.status })
  }
  if (response.status !== 202) throw new Error('提交回执无效，未确认接收')
  return value
}

function acceptedSubmission(value: unknown, sessionId: string, clientMessageId: string, kind: SubmitMessageAccepted['kind']): value is SubmitMessageAccepted {
  return record(value) && value.sessionId === sessionId && value.clientMessageId === clientMessageId
    && value.kind === kind && typeof value[kind === 'compaction' ? 'compactionId' : 'userMessageId'] === 'string'
    && !!value[kind === 'compaction' ? 'compactionId' : 'userMessageId']
    && Number.isSafeInteger(value.acceptedSeq) && (value.acceptedSeq as number) >= 0
}

export async function submitMessage(input: SubmitMessageRequest): Promise<SubmitMessageAccepted> {
  const value = await postSubmission('/api/messages', input)
  if (!acceptedSubmission(value, input.sessionId, input.clientMessageId, input.text.trim() === '/compact' ? 'compaction' : 'message')) {
    throw new Error('提交回执无效，未确认接收')
  }
  return value
}

export async function startSession(input: StartSessionRequest): Promise<StartSessionAccepted> {
  const value = await postSubmission('/api/sessions/start', input, AbortSignal.timeout(10_000))
  if (!record(value) || !sessionSummary(value.session) || value.session.id !== input.clientMessageId || value.session.workspaceId !== input.workspaceId
    || !acceptedSubmission(value.accepted, value.session.id, input.clientMessageId, 'message')) {
    throw new Error('首条消息回执无效，未确认接收')
  }
  return { session: value.session, accepted: value.accepted }
}
