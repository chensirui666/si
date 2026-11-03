import type { ClientFrame } from '@agent-learning/server/protocol'
import { applyFrame, initialState, type ChatState, type Subscribe } from './state'

export const subscribe: Subscribe = onState => {
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
  return () => {
    if (stopped) return
    stopped = true
    clearTimeout(retryTimer)
    window.removeEventListener('offline', offline)
    window.removeEventListener('online', online)
    releaseSocket()
  }
}
