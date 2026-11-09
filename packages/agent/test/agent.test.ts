import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { Agent } from '../src/index.js'
import type { ExecutableTool } from '../src/index.js'
import type { AssistantMessage, ModelContext, ModelEvent, ModelEventStream, ToolCall } from '@agent-learning/model'

describe('Agent 初始订阅', () => {
  it('首先提供真实空快照', async () => {
    const controller = new AbortController()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: 'snapshot',
        snapshot: { seq: 0, messages: [], running: null, activeContent: [], compactions: [], contextUsage: null },
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
      snapshot: { seq: 0, messages: [], running: null, activeContent: [], compactions: [], contextUsage: null },
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
    expect(receipt).toEqual({ kind: 'message', clientMessageId: 'local-1', userMessageId: current.messages[0]?.id, acceptedSeq: 1 })
    expect(current.messages[0]?.message).toMatchObject({ role: 'user', content: '  你好\n第二行  ' })
    expect(current.running?.runId).toBe(receipt.userMessageId)
    expect(calls).toBe(1)
    queue.push({ type: 'done', reason: 'stop', message: { ...assistant(), stopReason: 'stop' } })
    await until(async () => (await snapshot(agent)).running === null)
  })

  it.each([{ ...input, text: ' \n ' }, { ...input, modelId: 'unknown' }, { ...input, clientMessageId: '' }])('无效提交不改变正式状态', async value => {
    const agent = new Agent({ stream: () => { throw new Error('must not call') } })
    await expect(agent.submit(value)).rejects.toMatchObject({ status: 400 })
    expect(await snapshot(agent)).toEqual({ seq: 0, messages: [], running: null, activeContent: [], compactions: [], contextUsage: null })
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
    expect((await subscriber.next()).value).toMatchObject({ type: 'update', update: { seq: 7, change: { type: 'task', running: null } } })
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

  it.each([false, true])('等待模型流清理再解除发送门禁，清理错误不覆盖已完成回复（清理抛错：%s）', async rejectCleanup => {
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
    await expect(agent.submit(input)).rejects.toMatchObject({ status: 409 })
    release()
    await until(async () => (await snapshot(agent)).running === null)
    const next = await agent.submit(input)
    const beforeClose = await snapshot(agent)
    const closing = agent.close()
    const cancelled = secondSignal!.aborted
    if (!cancelled) second.push({ type: 'error', reason: 'aborted', error: { ...assistant(), stopReason: 'aborted' } })
    await closing
    expect(cancelled).toBe(true)
    expect(beforeClose.running?.runId).toBe(next.userMessageId)
    expect(beforeClose.messages[1]?.message).toMatchObject({ stopReason: 'stop' })
    expect(beforeClose.seq).toBe(4)
  })
})

const toolCall = (id: string, overrides: Partial<ToolCall> = {}): ToolCall => ({
  type: 'toolCall', id, name: 'read', arguments: { path: id }, ...overrides,
})

function withTools(execute: ExecutableTool['execute'], executionMode?: ExecutableTool['executionMode']) {
  const first = controlled(), answer = controlled()
  const queues = [first, answer]
  const contexts: ModelContext[] = []
  const tool = { executionMode, name: 'read', description: '读取', parameters: Type.Object({ path: Type.String() }), execute }
  const agent = new Agent({ tools: [tool], stream: (_model, context) => {
    contexts.push(context)
    return queues.shift()!.output
  } })
  return { agent, first, answer, contexts }
}

const workspaceInput = { ...input, cwd: '/workspace-with-spaces /project' }

describe('Agent 一批工具与最终回答', () => {
  it('完整首轮结束后才执行，回填并保持忙碌直到最终回答结束', async () => {
    const executions: string[] = []
    let release!: () => void
    const waitForRelease = new Promise<void>(resolve => { release = resolve })
    const { agent, first, answer, contexts } = withTools(async (args, { cwd, signal }) => {
      expect(cwd).toBe(workspaceInput.cwd)
      expect(signal.aborted).toBe(false)
      executions.push(String(args.path))
      await waitForRelease
      return '文件内容'
    })
    await agent.submit(workspaceInput)
    const partial = assistant()
    const call = toolCall('read-1')
    first.push({ type: 'start', partial })
    first.push({ type: 'toolcall_start', contentIndex: 1, partial })
    first.push({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":', partial })
    await until(async () => (await snapshot(agent)).seq === 4)
    expect(executions).toEqual([])
    first.push({ type: 'toolcall_end', contentIndex: 1, toolCall: call, partial })
    await until(async () => (await snapshot(agent)).seq === 5)
    expect(executions).toEqual([])
    expect(contexts[0].tools?.map(({ name }) => name)).toEqual(['read'])
    expect(contexts[0].systemPrompt).toContain(workspaceInput.cwd)
    const request = { ...partial, stopReason: 'toolUse' as const, content: [{ type: 'thinking' as const, thinking: '先读取' }, call] }
    first.push({ type: 'done', reason: 'toolUse', message: request })
    await until(async () => (await snapshot(agent)).running?.phase === 'tools')
    const working = await snapshot(agent)
    const firstId = working.messages[1].id
    expect(working.running).toMatchObject({ phase: 'tools', activeTools: [{ assistantMessageId: firstId, contentIndex: 1 }] })
    expect(executions).toEqual(['read-1'])
    expect(contexts).toHaveLength(1)
    release()

    await until(async () => contexts.length === 2)
    const answering = await snapshot(agent)
    expect(answering.running).toMatchObject({ phase: 'model', activeTools: [] })
    expect(answering.running?.assistantMessageId).not.toBe(firstId)
    expect(answering.messages[2]).toMatchObject({
      toolCall: { assistantMessageId: firstId, contentIndex: 1 },
      message: { role: 'toolResult', toolCallId: 'read-1', content: [{ text: '文件内容' }], isError: false },
    })
    expect((await snapshot(agent)).messages[2]).toEqual(answering.messages[2])
    expect(contexts[1].tools).toEqual(contexts[0].tools)
    expect(contexts[1].messages).toEqual(answering.messages.map(entry => entry.message))
    expect(executions).toEqual(['read-1'])
    await expect(agent.submit(workspaceInput)).rejects.toMatchObject({ status: 409 })

    answer.push({ type: 'done', reason: 'stop', message: { ...assistant(), stopReason: 'stop', content: [{ type: 'text', text: '已读取' }] } })
    await until(async () => (await snapshot(agent)).running === null)
    const complete = await snapshot(agent)
    expect(complete.messages.map(({ message }) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    expect(complete.messages[3].id).toBe(answering.running?.assistantMessageId)
  })

  it('逐项保存原编号，参数、工具名和执行错误都保留结果并继续', async () => {
    const executed: string[] = []
    const { agent, first, answer, contexts } = withTools(async args => {
      const path = String(args.path)
      executed.push(path)
      if (path === 'fails') throw new Error('已有部分结果')
      return path
    })
    await agent.submit(workspaceInput)
    const calls = [
      toolCall('first'),
      toolCall('invalid', { argumentsError: '工具参数不是有效的 JSON 对象' }),
      toolCall('unknown', { name: 'missing' }),
      toolCall('fails'),
      toolCall('last'),
    ]
    first.push({ type: 'done', reason: 'toolUse', message: { ...assistant(), stopReason: 'toolUse', content: calls } })
    await until(async () => contexts.length === 2)
    const current = await snapshot(agent)
    expect(executed).toEqual(['first', 'fails', 'last'])
    expect(current.messages.slice(2).map(entry => entry.toolCall)).toEqual(calls.map((_, contentIndex) => ({
      assistantMessageId: current.messages[1].id, contentIndex,
    })))
    expect(contexts[1].messages.slice(2)).toMatchObject([
      { toolCallId: 'first', isError: false },
      { toolCallId: 'invalid', isError: true },
      { toolCallId: 'unknown', isError: true },
      { toolCallId: 'fails', isError: true, content: [{ text: '已有部分结果' }] },
      { toolCallId: 'last', isError: false },
    ])
    answer.push({ type: 'error', reason: 'error', error: { ...assistant(), stopReason: 'error', errorMessage: '最终回答失败' } })
    await until(async () => (await snapshot(agent)).running === null)
    expect((await snapshot(agent)).messages).toHaveLength(8)
    expect(executed).toEqual(['first', 'fails', 'last'])
  })

  it('关闭期间保留工具已有部分结果并停止后续调用', async () => {
    const executed: string[] = []
    const { agent, first, contexts } = withTools(async (args, { signal }) => {
      executed.push(String(args.path))
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('取消前已有部分结果')
    }, 'sequential')
    await agent.submit(workspaceInput)
    first.push({ type: 'done', reason: 'toolUse', message: {
      ...assistant(), stopReason: 'toolUse', content: [toolCall('first'), toolCall('later')],
    } })
    await until(async () => executed.length === 1)
    await agent.close()
    expect(executed).toEqual(['first'])
    expect(contexts).toHaveLength(1)
    const current = await snapshot(agent)
    expect(current.running).toBeNull()
    expect(current.messages[1].message).toMatchObject({ role: 'assistant', stopReason: 'toolUse' })
    expect(current.messages[3].message).toMatchObject({ role: 'assistant', stopReason: 'aborted' })
    expect(current.messages[2].message).toMatchObject({
      role: 'toolResult', toolCallId: 'first', isError: true, content: [{ text: '取消前已有部分结果' }],
    })
  })

  it.each([
    { reason: 'toolUse' as const, invalidId: '' },
    { reason: 'toolUse' as const, invalidId: 'first' },
    { reason: 'aborted' as const, invalidId: 'second' },
    { reason: 'error' as const, invalidId: 'second' },
  ])('拒绝 $reason 的异常工具批次，下一轮不回填未执行调用 $invalidId', async ({ reason, invalidId }) => {
    const executed: string[] = []
    const { agent, first, answer, contexts } = withTools(async args => {
      executed.push(String(args.path))
      return '不应执行'
    })
    await agent.submit(workspaceInput)
    const message = { ...assistant(), stopReason: reason, content: [toolCall('first'), toolCall(invalidId)] }
    first.push(reason === 'aborted' || reason === 'error'
      ? { type: 'error', reason, error: { ...message, errorMessage: '未完成' } }
      : { type: 'done', reason, message })
    await until(async () => (await snapshot(agent)).running === null)
    expect(executed).toEqual([])
    expect(contexts).toHaveLength(1)
    expect((await snapshot(agent)).messages[1]?.message).toMatchObject({
      role: 'assistant', content: message.content, errorMessage: expect.any(String),
    })
    await agent.submit(workspaceInput)
    expect(contexts[1].messages.map(item => item.role)).toEqual(['user', 'user'])
    answer.push({ type: 'done', reason: 'stop', message: { ...assistant(), stopReason: 'stop' } })
    await until(async () => (await snapshot(agent)).running === null)
  })
})

describe('Agent 主动中止', () => {
  it.each(['aborted', 'stop'] as const)('重复中止等待同次模型清理，保留 %s 实际终态并允许继续', async reason => {
    let release!: () => void
    const cleanup = new Promise<void>(resolve => { release = resolve })
    let cleaning = false
    let signal!: AbortSignal
    let calls = 0
    const agent = new Agent({ stream: (_model, _context, options) => {
      signal = options!.signal!
      const output = controlled()
      calls++
      if (calls > 1) {
        signal.addEventListener('abort', () => output.push({ type: 'error', reason: 'aborted', error: { ...assistant(), stopReason: 'aborted' } }), { once: true })
        return output.output
      }
      return { result: output.output.result, async *[Symbol.asyncIterator]() {
        const partial = { ...assistant(), content: [{ type: 'text' as const, text: '保留部分文字' }] }
        yield { type: 'start' as const, partial }
        if (reason === 'aborted' && !signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        try {
          if (reason === 'stop') yield { type: 'done' as const, reason, message: { ...partial, stopReason: reason } }
          else yield { type: 'error' as const, reason, error: { ...partial, stopReason: reason } }
        } finally { cleaning = true; await cleanup }
      } }
    } })
    const accepted = await agent.submit(input)
    let ended = false
    const aborting = agent.abort(accepted.userMessageId).then(value => { ended = true; return value })
    const again = agent.abort(accepted.userMessageId)
    await until(async () => cleaning)
    expect(signal.aborted).toBe(true)
    expect(ended).toBe(false)
    await expect(agent.submit(input)).rejects.toMatchObject({ status: 409 })
    release()
    expect(await aborting).toBe(true)
    expect(await again).toBe(true)
    const current = await snapshot(agent)
    expect(current.running).toBeNull()
    expect(current.messages.slice(1).map(entry => entry.message)).toMatchObject([
      { stopReason: reason, content: [{ text: '保留部分文字' }] },
    ])
    await agent.submit(input)
    expect(await agent.abort(accepted.userMessageId)).toBe(false)
    expect(signal.aborted).toBe(false)
    await agent.close()
  })

  it.each([2, 3])('在第 %i 项工具中止，保留完整历史、实际结果且不启动回答', async count => {
    const executed: string[] = []
    let release!: () => void
    const finishing = new Promise<void>(resolve => { release = resolve })
    let cancelled = false
    const { agent, first, answer, contexts } = withTools(async (args, { signal }) => {
      executed.push(String(args.path))
      if (executed.length < count) return '已完成'
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
      await finishing
      throw new Error('取消前已有部分结果')
    }, 'sequential')
    const accepted = await agent.submit(workspaceInput)
    const complete = { ...assistant(), stopReason: 'toolUse' as const, content: [toolCall('first'), toolCall('second'), toolCall('third')] }
    first.push({ type: 'done', reason: 'toolUse', message: complete })
    await until(async () => executed.length === count)
    const aborting = agent.abort(accepted.userMessageId)
    await until(async () => cancelled)
    expect((await snapshot(agent)).running).not.toBeNull()
    release()
    expect(await aborting).toBe(true)
    const current = await snapshot(agent)
    expect(current.messages[1].message).toEqual(complete)
    expect(current.messages.filter(entry => entry.message.role === 'toolResult')).toHaveLength(count)
    expect(current.messages.at(-1)?.message).toMatchObject({ stopReason: 'aborted' })
    expect(contexts).toHaveLength(1)
    expect(executed).toEqual(['first', 'second', 'third'].slice(0, count))
    await agent.submit(workspaceInput)
    expect(contexts[1].messages.map(message => message.role)).toEqual(['user', 'assistant', ...Array(count).fill('toolResult'), 'user'])
    answer.push({ type: 'done', reason: 'stop', message: { ...assistant(), stopReason: 'stop' } })
    await until(async () => (await snapshot(agent)).running === null)
    expect(await agent.abort(accepted.userMessageId)).toBe(false)
  })
})


describe('Feature6 连续决策与同批调度', () => {
  function loop(execute: ExecutableTool['execute'], executionMode?: ExecutableTool['executionMode']) {
    const queues = [controlled(), controlled(), controlled(), controlled()]
    const contexts: ModelContext[] = []
    const agent = new Agent({ tools: [{ name: 'read', description: '读取', parameters: Type.Object({ path: Type.String() }), executionMode, execute }],
      stream: (_model, context) => { contexts.push(context); return queues[contexts.length - 1].output } })
    const done = (index: number, calls: ToolCall[] = [], reason: 'stop' | 'length' | 'toolUse' = calls.length ? 'toolUse' : 'stop') => {
      queues[index].push({ type: 'done', reason, message: { ...assistant(), stopReason: reason, content: calls.length ? calls : [{ type: 'text', text: '青禾' }] } })
    }
    return { agent, queues, contexts, done }
  }

  it('A1/A5.3 连续两轮读取，跨轮相同编号正确回填，每轮都可调用工具', async () => {
    const paths: string[] = []
    const { agent, contexts, done } = loop(async args => { paths.push(String(args.path)); return args.path === 'index.txt' ? '下一条线索在 note.txt' : '项目名称：青禾' })
    const receipt = await agent.submit(workspaceInput)
    done(0, [toolCall('read-1', { arguments: { path: 'index.txt' } })])
    await until(async () => contexts.length === 2)
    expect(contexts[1].messages.at(-1)).toMatchObject({ role: 'toolResult', content: [{ text: '下一条线索在 note.txt' }] })
    done(1, [toolCall('read-1', { arguments: { path: 'note.txt' } })])
    await until(async () => contexts.length === 3)
    expect(paths).toEqual(['index.txt', 'note.txt'])
    expect(contexts.every(context => context.tools?.length === 1)).toBe(true)
    expect(contexts[2].messages.at(-1)).toMatchObject({ content: [{ text: '项目名称：青禾' }] })
    await expect(agent.submit(workspaceInput)).rejects.toMatchObject({ status: 409 })
    expect((await snapshot(agent)).running?.runId).toBe(receipt.userMessageId)
    done(2)
    await until(async () => (await snapshot(agent)).running === null)
    const messages = (await snapshot(agent)).messages
    expect(messages.filter(entry => entry.message.role === 'user')).toHaveLength(1)
    expect(new Set(messages.filter(entry => entry.message.role === 'assistant').map(entry => entry.id)).size).toBe(3)
    expect(messages.filter(entry => entry.toolCall).map(entry => entry.toolCall?.assistantMessageId)).toEqual([messages[1].id, messages[3].id])
  })

  it('A2 同批并行，B 先完成立即保存，再按 A/B 原序交给模型', async () => {
    const waits = [Promise.withResolvers<string>(), Promise.withResolvers<string>()]
    const started: number[] = []
    const { agent, contexts, done } = loop(async args => { const i = Number(args.path); started.push(i); return waits[i].promise })
    const controller = new AbortController()
    const subscription = agent.subscribe(controller.signal)
    await subscription.next()
    await agent.submit(workspaceInput)
    done(0, [toolCall('0'), toolCall('1')])
    await until(async () => started.length === 2)
    expect((await snapshot(agent)).running?.activeTools).toHaveLength(2)
    waits[1].resolve('状态：测试中')
    await until(async () => (await snapshot(agent)).messages.length === 3)
    expect(contexts).toHaveLength(1)
    expect((await snapshot(agent)).messages[2].message).toMatchObject({ content: [{ text: '状态：测试中' }] })
    expect((await snapshot(agent)).running?.activeTools).toHaveLength(1)
    waits[0].resolve('项目名称：青禾')
    await until(async () => contexts.length === 2)
    expect(contexts[1].messages.slice(2)).toMatchObject([{ toolCallId: '0' }, { toolCallId: '1' }])
    const positions: number[] = []
    while (positions.length < 2) {
      const event = (await subscription.next()).value
      if (event?.type === 'update' && event.update.change.type === 'task' && event.update.change.message) positions.push(event.update.change.messageIndex!)
    }
    expect(positions).toEqual([2, 2])
    controller.abort()
    done(1)
    await until(async () => (await snapshot(agent)).running === null)
  })

  it('A3 sequential 声明使同批其余调用等待', async () => {
    const wait = Promise.withResolvers<string>()
    const paths: string[] = []
    const { agent, contexts, done } = loop(async args => { paths.push(String(args.path)); return args.path === '0' ? wait.promise : '后读' }, 'sequential')
    await agent.submit(workspaceInput)
    done(0, [toolCall('0'), toolCall('1')])
    await until(async () => paths.length === 1)
    expect(paths).toEqual(['0'])
    wait.resolve('先写')
    await until(async () => contexts.length === 2)
    expect(paths).toEqual(['0', '1'])
    done(1)
    await until(async () => (await snapshot(agent)).running === null)
  })

  it('A3 仅 write 声明 sequential，整批 read 仍须等待 write', async () => {
    const wait = Promise.withResolvers<string>()
    const started: string[] = []
    const queues = [controlled(), controlled()]
    let requests = 0
    const agent = new Agent({ tools: [
      { name: 'write', description: '写', parameters: Type.Object({}), executionMode: 'sequential', execute: async () => { started.push('write'); return wait.promise } },
      { name: 'read', description: '读', parameters: Type.Object({}), execute: async () => { started.push('read'); return '项目名称：青禾' } },
    ], stream: () => queues[requests++].output })
    await agent.submit(workspaceInput)
    queues[0].push({ type: 'done', reason: 'toolUse', message: { ...assistant(), stopReason: 'toolUse', content: [toolCall('write', { name: 'write', arguments: {} }), toolCall('read', { arguments: {} })] } })
    await until(async () => started.length === 1)
    expect(started).toEqual(['write'])
    wait.resolve('写入成功')
    await until(async () => requests === 2)
    expect(started).toEqual(['write', 'read'])
    queues[1].push({ type: 'done', reason: 'stop', message: { ...assistant(), stopReason: 'stop' } })
    await until(async () => (await snapshot(agent)).running === null)
  })

  it('A4 截断整批零执行，回填失败后允许完整新调用', async () => {
    const paths: string[] = []
    const { agent, contexts, done } = loop(async args => { paths.push(String(args.path)); return '项目名称：青禾' })
    await agent.submit(workspaceInput)
    done(0, [toolCall('0'), toolCall('1')], 'length')
    await until(async () => contexts.length === 2)
    expect(paths).toEqual([])
    expect(contexts[1].messages.slice(2)).toMatchObject([
      { toolCallId: '0', isError: true, content: [{ text: expect.stringContaining('截断') }] },
      { toolCallId: '1', isError: true, content: [{ text: expect.stringContaining('截断') }] },
    ])
    done(1, [toolCall('retry')])
    await until(async () => contexts.length === 3)
    expect(paths).toEqual(['retry'])
    done(2)
    await until(async () => (await snapshot(agent)).running === null)
  })

  it('A4.1 纯文字截断保留内容并结束，不自动重试', async () => {
    const { agent, contexts, done } = loop(async () => { throw new Error('不应执行') })
    await agent.submit(workspaceInput)
    done(0, [], 'length')
    await until(async () => (await snapshot(agent)).running === null)
    expect(contexts).toHaveLength(1)
    expect((await snapshot(agent)).messages[1].message).toMatchObject({ stopReason: 'length', content: [{ text: '青禾' }] })
  })

  it('A5.2 toolUse 没有调用明确结束', async () => {
    const { agent, contexts, done } = loop(async () => { throw new Error('不应执行') })
    await agent.submit(workspaceInput)
    done(0, [], 'toolUse')
    await until(async () => (await snapshot(agent)).running === null)
    expect(contexts).toHaveLength(1)
    expect((await snapshot(agent)).messages[1].message).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('可处理') })
  })

  it.each(['abort', 'close'] as const)('A6/A6.1 %s 等所有并行操作收尾，保留先前成功与普通错误', async mode => {
    const waits = [Promise.withResolvers<string>(), Promise.withResolvers<string>()]
    const started: string[] = []
    const { agent, contexts, done } = loop(async args => {
      const path = String(args.path); started.push(path)
      if (path === 'ok') return '已有成功'
      if (path === 'error') throw new Error('普通失败')
      return waits[Number(path)].promise
    })
    const receipt = await agent.submit(workspaceInput)
    done(0, [toolCall('ok'), toolCall('error'), toolCall('0'), toolCall('1')])
    await until(async () => started.length === 4 && (await snapshot(agent)).messages.length === 4)
    let ended = false
    const ending = (mode === 'abort' ? agent.abort(receipt.userMessageId) : agent.close()).then(() => { ended = true })
    waits[0].reject(Object.assign(new Error('甲已有输出'), { code: 'interrupted' }))
    await until(async () => (await snapshot(agent)).messages.length === 5)
    expect(ended).toBe(false)
    await expect(agent.submit(workspaceInput)).rejects.toMatchObject({ status: mode === 'abort' ? 409 : 503 })
    expect(contexts).toHaveLength(1)
    waits[1].reject(Object.assign(new Error('乙已有输出'), { code: 'interrupted' }))
    await ending
    const results = (await snapshot(agent)).messages.filter(entry => entry.toolCall)
    expect(results.map(entry => entry.toolErrorCode)).toEqual([undefined, undefined, 'interrupted', 'interrupted'])
    expect(results.map(entry => entry.message)).toMatchObject([{ isError: false }, { isError: true, content: [{ text: '普通失败' }] }, { content: [{ text: '甲已有输出' }] }, { content: [{ text: '乙已有输出' }] }])
    expect((await snapshot(agent)).running).toBeNull()
    if (mode === 'abort') { await agent.submit(workspaceInput); done(1); await until(async () => (await snapshot(agent)).running === null) }
    else await expect(agent.submit(workspaceInput)).rejects.toMatchObject({ status: 503 })
  })
})
