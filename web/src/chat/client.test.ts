import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribe } from './client'
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
