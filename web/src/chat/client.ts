import type { ModelDiscovery } from '@agent-learning/model'
import type { ClientFrame, SubmitMessageAccepted, SubmitMessageRequest } from '@agent-learning/server/protocol'
import { applyFrame, initialState, type ChatState, type Subscribe } from './state'

export const subscribe: Subscribe = (onState, onModelsChanged) => {
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
    subscriptionId = crypto.randomUUID()
    publish({ ...state, connection: 'awaitingSnapshot', error: null })
    try { socket!.send(JSON.stringify({ type: 'subscribe', subscriptionId } satisfies ClientFrame)) } catch { fail() }
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
    const open = () => { if (!stopped && socket === current) requestSnapshot() }
    const message = (event: MessageEvent) => {
      if (stopped || socket !== current) return
      let frame: unknown
      try { frame = JSON.parse(event.data) } catch { return }
      if (typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'models_changed') {
        onModelsChanged?.()
        return
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
  return Object.assign(stop, { requestSnapshot: () => {
    if (stopped || socket?.readyState !== 1) return
    prepare()
    requestSnapshot()
  } })
}


const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function modelDiscovery(value: unknown): value is ModelDiscovery {
  if (!record(value) || !Array.isArray(value.models) || !record(value.deepseek)) return false
  return value.models.every(model => record(model) && ['id', 'name', 'provider', 'api'].every(key => typeof model[key] === 'string'))
    && (value.deepseek.state === 'missing' || value.deepseek.state === 'configured'
      || (value.deepseek.state === 'error' && typeof value.deepseek.message === 'string'))
}

async function requestModels(path: string, options: RequestInit = {}, apiKey = ''): Promise<ModelDiscovery> {
  let response: Response
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options }) }
  catch { throw new Error('网络请求失败，请检查连接后重试') }
  if (response.status === 401) throw new Error('授权已失效，请重新打开启动链接')
  if (response.status === 403) throw new Error('访问来源不可信，请从启动链接进入')
  let value: unknown
  try { value = await response.json() } catch { throw new Error('模型配置响应无效，请重试') }
  if (!response.ok) {
    const message = record(value) && typeof value.error === 'string' ? value.error : '模型配置请求失败，请重试'
    throw new Error(apiKey ? message.split(apiKey).join('•••') : message)
  }
  if (!modelDiscovery(value)) throw new Error('模型配置响应无效，请重试')
  return value
}

export const getModels = () => requestModels('/api/models')
export const saveApiKey = (apiKey: string) => requestModels('/api/providers/deepseek', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }),
}, apiKey)
export const deleteApiKey = () => requestModels('/api/providers/deepseek', { method: 'DELETE' })

export async function submitMessage(input: SubmitMessageRequest): Promise<SubmitMessageAccepted> {
  let response: Response
  try { response = await fetch('/api/messages', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }
  catch { throw new Error('网络请求失败，未确认接收') }
  const rejected = response.status >= 400 && response.status < 500
  let value: unknown
  try { value = await response.json() } catch { value = null }
  if (rejected) {
    const message = response.status === 401 ? '授权已失效，请重新打开启动链接' : response.status === 403 ? '访问来源不可信，请从启动链接进入'
      : record(value) && typeof value.error === 'string' ? value.error : response.status === 409 ? '正在生成，请等待回答结束' : `消息提交被拒绝（HTTP ${response.status}）`
    throw Object.assign(new Error(message), { status: response.status })
  }
  if (response.status !== 202 || !record(value) || value.clientMessageId !== input.clientMessageId || typeof value.userMessageId !== 'string'
    || !Number.isSafeInteger(value.acceptedSeq) || (value.acceptedSeq as number) < 0) throw new Error('提交回执无效，未确认接收')
  return value as SubmitMessageAccepted
}
