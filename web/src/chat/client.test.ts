import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteApiKey, getModels, saveApiKey, subscribe } from './client'
import type { ChatState } from './state'

class Socket extends EventTarget {
  static instances: Socket[] = []
  readyState = 0
  sent: { type: string; subscriptionId: string }[] = []
  constructor(readonly url: string) { super(); Socket.instances.push(this) }
  send(text: string) { this.sent.push(JSON.parse(text)) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  error() { this.dispatchEvent(new Event('error')) }
  get id() { return this.sent.at(-1)!.subscriptionId }
}

const empty = { seq: 0, messages: [], running: null, activeContent: [] }
let online = true
let states: ChatState[]
let stop: (() => void) | undefined
const current = () => states.at(-1)!
const socket = () => Socket.instances.at(-1)!
const snapshot = (ws = socket(), seq = 0) => ws.frame({ type: 'snapshot', subscriptionId: ws.id, snapshot: { ...empty, seq } })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  online = true
  states = []
  Socket.instances = []
})
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function start() { stop = subscribe(state => { states.push(state) }) }

describe('browser subscription', () => {
  it('握手后仍等待当前编号的有效快照，旧编号和不完整快照不能使页面就绪', () => {
    start()
    expect(current().connection).toBe('connecting')
    expect(socket().url).toBe('ws://localhost:3000/api/events')
    socket().open()
    expect(current().connection).toBe('awaitingSnapshot')
    socket().frame({ type: 'snapshot', subscriptionId: 'old', snapshot: empty })
    socket().frame({ type: 'snapshot', subscriptionId: socket().id, snapshot: { seq: 0 } })
    expect(current().connection).toBe('awaitingSnapshot')
    snapshot()
    expect(current()).toMatchObject({ connection: 'ready', snapshot: empty, slow: false, error: null })
    vi.advanceTimersByTime(30_000)
    expect(Socket.instances).toHaveLength(1)
  })

  it('忽略重复序号，跳号后换订阅编号并隔离旧帧', () => {
    start(); socket().open(); snapshot()
    const ws = socket()
    const old = ws.id
    const accepted = { type: 'accepted', user: { id: 'user-1', message: { role: 'user', content: 'hello', timestamp: 1 } }, running: { userMessageId: 'user-1', assistantMessageId: 'assistant-1' } }
    ws.frame({ type: 'update', subscriptionId: old, update: { seq: 1, change: accepted } })
    ws.frame({ type: 'update', subscriptionId: old, update: { seq: 1, change: accepted } })
    expect(current().snapshot?.messages).toHaveLength(1)
    expect(current().snapshot?.seq).toBe(1)
    ws.frame({ type: 'update', subscriptionId: old, update: { seq: 3, change: accepted } })
    expect(ws.id).not.toBe(old)
    expect(current().connection).toBe('awaitingSnapshot')
    ws.frame({ type: 'snapshot', subscriptionId: old, snapshot: empty })
    expect(current().connection).toBe('awaitingSnapshot')
    snapshot(ws, 3)
    expect(current().connection).toBe('ready')
    expect(current().snapshot?.seq).toBe(3)
  })

  it('3 秒提示慢连接，15 秒截止并在半基数等待后重新连接', () => {
    start()
    vi.advanceTimersByTime(2999)
    expect(current().slow).toBe(false)
    vi.advanceTimersByTime(1)
    expect(current().slow).toBe(true)
    vi.advanceTimersByTime(12_000)
    expect(current().connection).toBe('disconnected')
    expect(socket().readyState).toBe(3)
    vi.advanceTimersByTime(249)
    expect(Socket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(Socket.instances).toHaveLength(2)
    expect(current()).toMatchObject({ connection: 'connecting', slow: false })
  })

  it('慢握手完成后继续显示慢提示，15 秒截止不从握手重新计时', () => {
    start()
    vi.advanceTimersByTime(4000)
    socket().open()
    expect(current()).toMatchObject({ connection: 'awaitingSnapshot', slow: true })
    vi.advanceTimersByTime(11_000)
    expect(current().connection).toBe('disconnected')
  })

  it('失败退避翻倍、在 10 秒封顶，并在快照就绪后重置', () => {
    vi.mocked(Math.random).mockReturnValue(1)
    start()
    for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
      const count = Socket.instances.length
      socket().error()
      vi.advanceTimersByTime(delay - 1)
      expect(Socket.instances).toHaveLength(count)
      vi.advanceTimersByTime(1)
      expect(Socket.instances).toHaveLength(count + 1)
    }
    socket().open(); snapshot(); socket().close()
    const count = Socket.instances.length
    vi.advanceTimersByTime(500)
    expect(Socket.instances).toHaveLength(count + 1)
  })

  it('离线取消尝试和等待，上线立即重连；旧连接的晚到事件不改变新状态', () => {
    start()
    const old = socket()
    online = false; window.dispatchEvent(new Event('offline'))
    expect(current().connection).toBe('disconnected')
    vi.advanceTimersByTime(60_000)
    expect(Socket.instances).toHaveLength(1)
    online = true; window.dispatchEvent(new Event('online'))
    expect(Socket.instances).toHaveLength(2)
    const next = socket()
    next.open(); snapshot(next)
    old.open(); old.error(); old.close()
    old.frame({ type: 'snapshot', subscriptionId: next.id, snapshot: { ...empty, seq: 9 } })
    expect(current().snapshot?.seq).toBe(0)
    expect(current().connection).toBe('ready')
  })

  it('取消会发送所属 unsubscribe、清理计时与监听，重复挂载各自独立', () => {
    start(); socket().open(); snapshot()
    const old = socket()
    const id = old.id
    const count = states.length
    stop!(); stop!(); stop = undefined
    expect(old.sent.at(-1)).toEqual({ type: 'unsubscribe', subscriptionId: id })
    old.error(); window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(30_000)
    expect(states).toHaveLength(count)
    expect(Socket.instances).toHaveLength(1)
    start(); socket().open(); snapshot()
    expect(current().connection).toBe('ready')
    expect(socket().id).not.toBe(id)
  })

  it('不把无法区分原因的 WS 异常报告为授权 401', () => {
    start(); socket().error()
    expect(current().error).toContain('连接异常')
    expect(current().error).not.toMatch(/401|授权失效|模型/)
  })

  it('初始离线不创建连接，畸形 JSON 不中断后续有效快照', () => {
    online = false; start()
    expect(Socket.instances).toHaveLength(0)
    online = true; window.dispatchEvent(new Event('online')); socket().open()
    socket().dispatchEvent(new MessageEvent('message', { data: '{' }))
    expect(current().connection).toBe('awaitingSnapshot')
    snapshot()
    expect(current().connection).toBe('ready')
  })
})


describe('model configuration client', () => {
  const missing = { models: [], deepseek: { state: 'missing' } }
  it('同源查询、保存和删除，仅保存发送本次输入', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => missing })
    vi.stubGlobal('fetch', fetch)
    await expect(getModels()).resolves.toEqual(missing)
    await expect(saveApiKey('new-private-key')).resolves.toEqual(missing)
    await expect(deleteApiKey()).resolves.toEqual(missing)
    expect(fetch.mock.calls).toEqual([
      ['/api/models', { credentials: 'same-origin', cache: 'no-store' }],
      ['/api/providers/deepseek', { credentials: 'same-origin', cache: 'no-store', method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'new-private-key' }) }],
      ['/api/providers/deepseek', { credentials: 'same-origin', cache: 'no-store', method: 'DELETE' }],
    ])
  })
  it('请求错误不携带 Key，畸形响应不伪装为本地配置', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('new-private-key')))
    await expect(saveApiKey('new-private-key')).rejects.toThrow('网络请求失败')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }))
    await expect(getModels()).rejects.toThrow('模型配置响应无效')
  })
  it('配置通知独立于对话编号，旧连接通知不触发刷新', () => {
    const changed = vi.fn()
    stop = subscribe(state => states.push(state), changed)
    socket().open(); snapshot()
    const ws = socket()
    const id = ws.id
    ws.frame({ type: 'models_changed' })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(current().snapshot?.seq).toBe(0)
    expect(ws.id).toBe(id)
    ws.close()
    ws.frame({ type: 'models_changed' })
    expect(changed).toHaveBeenCalledTimes(1)
  })
})


it.each([
  [401, '授权已失效，请重新打开启动链接'],
  [403, '访问来源不可信，请从启动链接进入'],
])('HTTP %s 即使是纯文本也给出明确错误', async (status, message) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => { throw new Error('not JSON') } }))
  await expect(getModels()).rejects.toThrow(message)
})

it('提交保留完整原文，只发送一次请求并校验 202 回执', async () => {
  const accepted = { clientMessageId: 'local', userMessageId: 'user', acceptedSeq: 1 }
  const fetch = vi.fn().mockResolvedValue({ status: 202, ok: true, json: async () => accepted })
  vi.stubGlobal('fetch', fetch)
  const { submitMessage } = await import('./client')
  const input = { clientMessageId: 'local', modelId: 'deepseek-flash', text: '  原文\n\n' }
  await expect(submitMessage(input)).resolves.toEqual(accepted)
  expect(fetch.mock.calls).toEqual([['/api/messages', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }]])
  fetch.mockResolvedValue({ status: 202, ok: true, json: async () => ({ ...accepted, clientMessageId: 'wrong' }) })
  await expect(submitMessage(input)).rejects.toThrow('提交回执无效')
})

it('明确拒绝带状态码，网络失败保持接收状态未知且没有自动重发', async () => {
  const fetch = vi.fn().mockResolvedValue({ status: 409, ok: false, json: async () => ({ error: '正在生成' }) })
  vi.stubGlobal('fetch', fetch)
  const { submitMessage } = await import('./client')
  const input = { clientMessageId: 'local', modelId: 'deepseek-flash', text: 'hello' }
  await expect(submitMessage(input)).rejects.toMatchObject({ status: 409, message: '正在生成' })
  fetch.mockRejectedValue(new Error('network'))
  await expect(submitMessage(input)).rejects.toMatchObject({ message: '网络请求失败，未确认接收' })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('主动重取快照保留清理函数接口，换编号并设置准备超时', () => {
  const subscription = subscribe(state => states.push(state))
  stop = subscription
  socket().open(); snapshot()
  const old = socket().id
  subscription.requestSnapshot?.()
  expect(socket().id).not.toBe(old)
  expect(current().connection).toBe('awaitingSnapshot')
  vi.advanceTimersByTime(15_000)
  expect(current().connection).toBe('disconnected')
})

it.each([413, 415])('HTTP %s 是明确拒绝而非接收未知', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status, ok: false, json: async () => ({ error: status === 413 ? '消息过长' : '需要 JSON 请求' }) }))
  const { submitMessage } = await import('./client')
  await expect(submitMessage({ clientMessageId: 'local', modelId: 'deepseek-flash', text: 'a'.repeat(70_000) })).rejects.toMatchObject({ status })
})
