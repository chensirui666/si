import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import type { AssistantMessage, ModelContext, ModelEvent, ModelEventStream } from '@agent-learning/model'

describe('Agent 初始订阅', () => {
  it('首先提供真实空快照', async () => {
    const controller = new AbortController()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: 'snapshot',
        snapshot: { seq: 0, messages: [], running: null, activeContent: [] },
      },
    })

    controller.abort()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it('修改快照不会改变 Agent 或其他订阅的状态', async () => {
    const agent = new Agent()
    const controller = new AbortController()
    const first = agent.subscribe(controller.signal)[Symbol.asyncIterator]()
    const firstEvent = (await first.next()).value
    expect(firstEvent?.type).toBe('snapshot')
    if (firstEvent?.type !== 'snapshot') throw new Error('缺少初始快照')

    firstEvent.snapshot.seq = 9
    firstEvent.snapshot.messages.push({
      id: 'only-in-returned-copy',
      message: { role: 'user', content: '改副本', timestamp: 0 },
    })
    firstEvent.snapshot.activeContent.push({
      messageId: 'only-in-returned-copy', contentIndex: 0, type: 'text',
    })

    const second = agent.subscribe(controller.signal)[Symbol.asyncIterator]()
    expect((await second.next()).value).toEqual({
      type: 'snapshot',
      snapshot: { seq: 0, messages: [], running: null, activeContent: [] },
    })
    controller.abort()
  })

  it('取消一个订阅不会结束另一个订阅', async () => {
    const agent = new Agent()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = agent.subscribe(firstController.signal)[Symbol.asyncIterator]()
    const second = agent.subscribe(secondController.signal)[Symbol.asyncIterator]()
    await first.next()
    await second.next()

    const firstPending = first.next()
    let secondEnded = false
    const secondPending = second.next().then((result) => {
      secondEnded = true
      return result
    })
    firstController.abort()

    expect(await firstPending).toEqual({ done: true, value: undefined })
    expect(secondEnded).toBe(false)
    secondController.abort()
    expect(await secondPending).toEqual({ done: true, value: undefined })
  })

  it('预取消信号不产生快照或遗留监听', async () => {
    const controller = new AbortController()
    controller.abort()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('等待更新时取消会结束所有等待并移除监听', async () => {
    const controller = new AbortController()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const firstPending = iterator.next()
    const secondPending = iterator.next()

    controller.abort()

    expect(await firstPending).toEqual({ done: true, value: undefined })
    expect(await secondPending).toEqual({ done: true, value: undefined })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each(['读取前', '收到快照后', '等待更新中'])('%s return 会立刻释放订阅', async (stage) => {
    const controller = new AbortController()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()
    if (stage !== '读取前') await iterator.next()
    const pending = stage === '等待更新中' ? iterator.next() : undefined

    expect(await iterator.return?.()).toEqual({ done: true, value: undefined })
    if (pending) expect(await pending).toEqual({ done: true, value: undefined })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})

function controlled() {
  const events: ModelEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  let finish!: (message: AssistantMessage) => void
  const result = new Promise<AssistantMessage>(resolve => { finish = resolve })
  const output: ModelEventStream = {
    result: () => result,
    async *[Symbol.asyncIterator]() {
      while (!ended || events.length) {
        if (events.length) yield events.shift()!
        else await new Promise<void>(resolve => { wake = resolve })
      }
    },
  }
  return { output, push(event: ModelEvent) {
    events.push(event)
    if (event.type === 'done' || event.type === 'error') {
      ended = true
      finish(event.type === 'done' ? event.message : event.error)
    }
    wake?.(); wake = undefined
  } }
}
const assistant = (): AssistantMessage => ({ role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', content: [], stopReason: 'pending', timestamp: 1 })
const input = { clientMessageId: 'local-1', modelId: 'deepseek-flash', text: '  你好\n第二行  ' }
async function snapshot(agent: Agent) {
  const controller = new AbortController()
  const event = (await agent.subscribe(controller.signal).next()).value
  controller.abort()
  if (event?.type !== 'snapshot') throw new Error('missing snapshot')
  return event.snapshot
}
async function until(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)) }
  throw new Error('Agent did not consume expected event')
}

describe('Agent 提交与运行', () => {
  it('原子接收原文、回执和忙碌状态，拒绝并发且不调用第二次模型', async () => {
    const queue = controlled()
    let calls = 0
    const agent = new Agent({ stream: () => { calls++; return queue.output } })
    const first = agent.submit(input)
    const second = agent.submit({ ...input, clientMessageId: 'local-2' })
    await expect(second).rejects.toMatchObject({ status: 409 })
    const receipt = await first
    const current = await snapshot(agent)
    expect(receipt).toEqual({ clientMessageId: 'local-1', userMessageId: current.messages[0]?.id, acceptedSeq: 1 })
    expect(current.messages[0]?.message).toMatchObject({ role: 'user', content: '  你好\n第二行  ' })
    expect(current.running?.userMessageId).toBe(receipt.userMessageId)
    expect(calls).toBe(1)
    queue.push({ type: 'done', reason: 'stop', message: { ...assistant(), stopReason: 'stop' } })
    await until(async () => (await snapshot(agent)).running === null)
  })

  it.each([{ ...input, text: ' \n ' }, { ...input, modelId: 'unknown' }, { ...input, clientMessageId: '' }])('无效提交不改变正式状态', async value => {
    const agent = new Agent({ stream: () => { throw new Error('must not call') } })
    await expect(agent.submit(value)).rejects.toMatchObject({ status: 400 })
    expect(await snapshot(agent)).toEqual({ seq: 0, messages: [], running: null, activeContent: [] })
  })

  it('事件独立累积，不读取已领先的 shared partial；切点后更新连续且副本独立', async () => {
    const queue = controlled()
    const agent = new Agent({ stream: () => queue.output })
    await agent.submit(input)
    const partial = assistant()
    partial.content = [{ type: 'text', text: 'AB' }]
    queue.push({ type: 'start', partial })
    queue.push({ type: 'text_start', contentIndex: 0, partial })
    queue.push({ type: 'text_delta', contentIndex: 0, delta: 'A', partial })
    await until(async () => (await snapshot(agent)).seq === 4)
    const controller = new AbortController()
    const subscriber = agent.subscribe(controller.signal)
    const first = (await subscriber.next()).value
    expect(first).toMatchObject({ type: 'snapshot', snapshot: { seq: 4, messages: [{}, { message: { content: [{ type: 'text', text: 'A' }] } }] } })
    queue.push({ type: 'text_delta', contentIndex: 0, delta: 'B', partial })
    const delta = (await subscriber.next()).value
    expect(delta).toMatchObject({ type: 'update', update: { seq: 5, change: { event: { type: 'text_delta', delta: 'B' } } } })
    expect(first).toMatchObject({ snapshot: { seq: 4, messages: [{}, { message: { content: [{ text: 'A' }] } }] } })
    const final = { ...partial, content: [{ type: 'text' as const, text: '最终校准' }], stopReason: 'stop' as const }
    queue.push({ type: 'done', reason: 'stop', message: final })
    const last = (await subscriber.next()).value
    expect(last).toMatchObject({ type: 'update', update: { seq: 6, change: { event: { type: 'done' } } } })
    const current = await snapshot(agent)
    expect(current.running).toBeNull()
    expect(current.activeContent).toEqual([])
    expect(current.messages[1]?.message).toEqual(final)
    final.content[0]!.text = '外部修改'
    expect((await snapshot(agent)).messages[1]?.message).toMatchObject({ content: [{ text: '最终校准' }] })
    controller.abort()
  })

  it('工具参数中途快照只保留已消费原文，取消订阅不取消模型', async () => {
    const queue = controlled()
    let signal: AbortSignal | undefined
    const agent = new Agent({ stream: (_model, _context, options) => { signal = options?.signal; return queue.output } })
    await agent.submit(input)
    const partial = assistant()
    queue.push({ type: 'start', partial })
    queue.push({ type: 'toolcall_start', contentIndex: 0, partial })
    queue.push({ type: 'toolcall_delta', contentIndex: 0, delta: '{"x":', partial })
    await until(async () => (await snapshot(agent)).seq === 4)
    const current = await snapshot(agent)
    expect(current.activeContent).toEqual([{ messageId: current.running!.assistantMessageId, contentIndex: 0, type: 'toolCall', argumentsText: '{"x":' }])
    expect(signal?.aborted).toBe(false)
    const toolCall = { type: 'toolCall' as const, id: 'call', name: 'read', arguments: { x: 1 } }
    queue.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial })
    await until(async () => (await snapshot(agent)).seq === 5)
    expect((await snapshot(agent)).activeContent).toEqual([])
    queue.push({ type: 'done', reason: 'toolUse', message: { ...partial, content: [toolCall], stopReason: 'toolUse' } })
    await until(async () => (await snapshot(agent)).running === null)
  })

  it('保留失败回复但从下一轮历史排除；相同临时编号和文字仍接受新调用', async () => {
    const first = controlled(), second = controlled(), third = controlled()
    const queues = [first, second, third]
    const contexts: ModelContext[] = []
    const agent = new Agent({ stream: (_model, context) => { contexts.push(context); return queues.shift()!.output } })
    await agent.submit(input)
    first.push({ type: 'error', reason: 'error', error: { ...assistant(), content: [{ type: 'text', text: '半截' }], stopReason: 'error', errorMessage: '失败' } })
    await until(async () => (await snapshot(agent)).running === null)
    expect((await snapshot(agent)).messages).toHaveLength(2)
    await agent.submit(input)
    expect(contexts[1]?.messages.map(message => message.role)).toEqual(['user', 'user'])
    second.push({ type: 'done', reason: 'stop', message: { ...assistant(), content: [{ type: 'text', text: '成功' }], stopReason: 'stop' } })
    await until(async () => (await snapshot(agent)).running === null)
    await agent.submit(input)
    expect(contexts[2]?.messages.map(message => message.role)).toEqual(['user', 'user', 'assistant', 'user'])
    third.push({ type: 'done', reason: 'length', message: { ...assistant(), stopReason: 'length' } })
    await until(async () => (await snapshot(agent)).running === null)
  })

  it('准备请求抛错或流意外结束也产生脱敏失败回复并释放忙碌', async () => {
    for (const stream of [() => { throw new Error('secret-provider-message') }, () => ({ async *[Symbol.asyncIterator]() {}, result: () => Promise.reject(new Error('unused')) })]) {
      const agent = new Agent({ stream })
      await agent.submit(input)
      await until(async () => (await snapshot(agent)).running === null)
      const current = await snapshot(agent)
      expect(current.messages[1]?.message).toMatchObject({ role: 'assistant', stopReason: 'error' })
      expect(JSON.stringify(current)).not.toContain('secret-provider-message')
    }
  })

  it('关闭 Agent 主动取消当前生成并等候收尾，之后不再接收', async () => {
    const queue = controlled()
    const agent = new Agent({ stream: (_model, _context, options) => {
      options!.signal!.addEventListener('abort', () => queue.push({ type: 'error', reason: 'aborted', error: { ...assistant(), stopReason: 'aborted' } }), { once: true })
      return queue.output
    } })
    await agent.submit(input)
    await agent.close()
    expect((await snapshot(agent)).running).toBeNull()
    expect((await snapshot(agent)).messages[1]?.message).toMatchObject({ stopReason: 'aborted' })
    await expect(agent.submit(input)).rejects.toThrow()
  })

  it.each([false, true])('上一轮延迟清理不会覆盖下一轮运行或取消信号（清理抛错：%s）', async rejectCleanup => {
    const first = controlled(), second = controlled()
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let firstCleaning = false, calls = 0
    let secondSignal: AbortSignal | undefined
    const agent = new Agent({ stream: (_model, _context, options) => {
      if (calls++ === 0) return {
        result: first.output.result,
        [Symbol.asyncIterator]() {
          const iterator = first.output[Symbol.asyncIterator]()
          return {
            next: () => iterator.next(),
            async return() { firstCleaning = true; await released; if (rejectCleanup) throw new Error('cleanup rejected'); return { done: true as const, value: undefined } },
          }
        },
      }
      secondSignal = options?.signal
      secondSignal!.addEventListener('abort', () => second.push({ type: 'error', reason: 'aborted', error: { ...assistant(), stopReason: 'aborted' } }), { once: true })
      return second.output
    } })
    await agent.submit(input)
    first.push({ type: 'done', reason: 'stop', message: { ...assistant(), stopReason: 'stop' } })
    await until(async () => firstCleaning)
    const next = await agent.submit(input)
    release()
    await new Promise(resolve => setImmediate(resolve))
    const beforeClose = await snapshot(agent)
    const closing = agent.close()
    const cancelled = secondSignal!.aborted
    if (!cancelled) second.push({ type: 'error', reason: 'aborted', error: { ...assistant(), stopReason: 'aborted' } })
    await closing
    expect(cancelled).toBe(true)
    expect(beforeClose.running?.userMessageId).toBe(next.userMessageId)
    expect(beforeClose.messages[1]?.message).toMatchObject({ stopReason: 'stop' })
    expect(beforeClose.seq).toBe(3)
  })
})
