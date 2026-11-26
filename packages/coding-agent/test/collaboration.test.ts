import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import type { AssistantMessage, ModelContext, ModelEventStream, ToolCall } from '@agent-learning/model'
import { AgentSession } from '../src/agent-session.js'
import type { ConversationSnapshot } from '../src/types.js'
import { SessionStore, SessionWriteError } from '../src/session-store.js'

const text = (value: string): AssistantMessage => ({
  role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
  content: [{ type: 'text', text: value }], stopReason: 'stop', timestamp: Date.now(),
})
const input = (id: string, value = id) => ({ clientMessageId: id, modelId: 'deepseek-flash', text: value })

type Options = Omit<ConstructorParameters<typeof AgentSession>[0], 'resolveDirectory' | 'skillHome' | 'persistence' | 'stream'>
async function fixture(options: Options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'si-collaboration-'))
  const store = SessionStore.open(join(cwd, 'session.sqlite'))
  const summary = { id: 'chat', workspaceId: 'work', name: 'chat', createdAt: new Date().toISOString() }
  store.save(summary.id, { summary })
  const requests: ModelContext[] = []
  const replies: Array<(reply: AssistantMessage) => void> = []
  const create = (restored = false) => new AgentSession({
    ...options,
    resolveDirectory: async () => cwd, skillHome: cwd, persistence: { store, summary, ...(restored && { history: store.loadSession(summary.id) }) },
    stream: (_model, context, streamOptions): ModelEventStream => {
      requests.push(context)
      const signal = streamOptions?.signal
      const result = new Promise<AssistantMessage>(resolve => {
        const abort = () => resolve({ ...text('cancelled'), stopReason: 'aborted' })
        signal?.addEventListener('abort', abort, { once: true })
        replies.push(reply => { signal?.removeEventListener('abort', abort); resolve(reply) })
      })
      return {
        result: () => result,
        async *[Symbol.asyncIterator]() {
          const message = await result
          if (message.stopReason === 'aborted' || message.stopReason === 'error') {
            yield { type: 'error', reason: message.stopReason, error: message }
          } else yield { type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }
        },
      }
    },
  })
  const session = create()
  return { session, store, summary, cwd, requests, replies, create, close: async () => {
    for (const resolve of replies) resolve(text('cleanup'))
    await session.close()
    store.close()
    await rm(cwd, { recursive: true, force: true })
  } }
}

it('preserves the original receipt on edit and delete and starts the live queue in order', async () => {
  const { session, store, summary, requests, replies, close } = await fixture()
  try {
    await session.submit(input('a'))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(await session.submit(input('b'))).toMatchObject({ kind: 'queued', clientMessageId: 'b' })
    await session.submit(input('c'))
    await session.submit(input('d'))
    await session.updateQueue('b', { action: 'edit', text: 'edited\nsecond line' })
    await session.updateQueue('c', { action: 'delete' })
    await session.submit(input('b'))
    await session.submit(input('c'))
    replies[0](text('done A'))
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(requests[1].messages.at(-1)?.content).toBe('edited\nsecond line')
    replies[1](text('done B'))
    await vi.waitFor(() => expect(replies).toHaveLength(3))
    expect(requests[2].messages.at(-1)?.content).toBe('d')
    replies[2](text('done D'))
    await vi.waitFor(() => expect(store.loadSession(summary.id)?.runs.map(run => run.status)).toEqual(['completed', 'completed', 'completed']))
  } finally { await close() }
})

it('persists a steer after a plain reply and continues the same run', async () => {
  const { session, store, summary, requests, replies, close } = await fixture()
  try {
    await session.submit(input('a'))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(await session.submit({ ...input('s'), mode: 'steer' })).toMatchObject({ kind: 'steering' })
    replies[0](text('partial'))
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(requests[1].messages.slice(-2).map(message => message.role)).toEqual(['assistant', 'user'])
    expect(requests[1].messages.at(-1)?.content).toBe('s')
    const history = store.loadSession(summary.id)!
    expect(history.runs).toHaveLength(1)
    expect(history.messages.at(-1)).toMatchObject({ clientMessageId: 's', steering: true, runId: history.runs[0].id })
    replies[1](text('done'))
    await vi.waitFor(() => expect(store.loadSession(summary.id)?.runs[0]?.status).toBe('completed'))
  } finally { await close() }
})

async function getSnapshot(session: AgentSession): Promise<ConversationSnapshot> {
  const controller = new AbortController()
  try {
    const { value } = await session.subscribe(controller.signal).next()
    if (value?.type === 'snapshot') return value.snapshot
    throw new Error('Missing snapshot')
  } finally { controller.abort() }
}

const questionSet = [
  { id: 'api', question: 'Which interfaces?', options: [{ label: 'A' }, { label: 'B' }], multi_select: true },
  { id: 'docs', question: 'What should the docs say?' },
  { id: 'release', question: 'Which release?' },
]
const answers = [{ id: 'api', selected: ['A', 'B'], custom: 'C' }, { id: 'docs', selected: [], custom: 'migration' }, { id: 'release', selected: [] }]
const skip = questionSet.map(({ id }) => ({ id, selected: [] }))

const call = (id: string, name: string, args: ToolCall['arguments'] = {}): ToolCall =>
  ({ type: 'toolCall', id, name, arguments: args })
const ask = (timeout?: number) => call('ask-1', 'ask_user_question', { questions: questionSet, ...(timeout !== undefined && { timeout }) })
const tools = (...content: ToolCall[]): AssistantMessage => ({ ...text(''), content, stopReason: 'toolUse' })

async function question(session: AgentSession, status: 'waiting' | 'timed-out' | 'aborted' = 'waiting') {
  return vi.waitFor(async () => {
    const batch = (await getSnapshot(session)).interaction?.questions.find(item => item.status === status)
    expect(batch).toBeDefined()
    return batch!
  })
}

it.each(['write-failed', 'unconfirmed'] as const)('05 retains the queue head and pauses on %s at start', async reason => {
  const { session, store, summary, requests, replies, close } = await fixture()
  try {
    await session.submit(input('a'))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    await session.submit(input('b'))
    await session.submit(input('c'))
    const original = store.save.bind(store)
    const save = vi.spyOn(store, 'save').mockImplementation((id, data) => {
      if (data.run?.clientMessageId === 'b' && data.run.status === 'running') throw new SessionWriteError(reason)
      return original(id, data)
    })
    replies[0](text('done'))
    await vi.waitFor(async () => expect((await getSnapshot(session)).interaction?.queue.paused).toBeTruthy())
    expect((await getSnapshot(session)).interaction?.queue.items.map(item => item.clientMessageId)).toEqual(['b', 'c'])
    expect(store.loadSession(summary.id)?.runs.map(run => run.clientMessageId)).toEqual(['a'])
    expect(requests).toHaveLength(1)
    if (reason === 'unconfirmed') return
    save.mockRestore()
    await session.submit(input('d'))
    for (const [index, value] of ['b', 'c', 'd'].entries()) {
      await vi.waitFor(() => expect(replies).toHaveLength(index + 2))
      expect(requests[index + 1].messages.at(-1)?.content).toBe(value)
      replies[index + 1](text('done'))
    }
  } finally { await close() }
})

it.each(['failed', 'aborted'] as const)('04/14 preserves work and input order when a run is %s', async state => {
  const completed: string[] = []
  const { session, store, summary, cwd, requests, replies, close } = await fixture({ tools: directory => [{
    name: 'record', description: 'Record work', parameters: Type.Object({}),
    async execute() { await appendFile(join(directory, 'done.txt'), 'once\n'); completed.push('done'); return 'once' },
  }] })
  try {
    const received = await session.submit(input('a'))
    if (received.kind !== 'message') throw new Error('expected a started run')
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    replies[0](tools(call('work', 'record')))
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    await session.submit(input('b'))
    await session.submit(input('c'))
    await session.submit({ ...input('s1'), mode: 'steer' })
    await session.submit({ ...input('s2'), mode: 'steer' })
    if (state === 'aborted') await session.abort(received.userMessageId)
    else replies[1]({ ...text('failed'), stopReason: 'error' })
    await vi.waitFor(async () => expect((await getSnapshot(session)).interaction?.queue.paused).toBeTruthy())
    expect(requests).toHaveLength(2)
    expect(store.loadSession(summary.id)?.runs[0].status).toBe(state)
    expect(store.loadSession(summary.id)?.messages.filter(entry => entry.message.role === 'toolResult')).toHaveLength(1)
    await session.submit(input('d'))
    for (const [index, value] of ['b', 'c', 'd'].entries()) {
      await vi.waitFor(() => expect(replies).toHaveLength(index + 3))
      const request = requests[index + 2]
      expect(request.messages.at(-1)?.content).toBe(value)
      if (index === 0) expect(request.messages.slice(-3).map(message => message.content)).toEqual(['s1', 's2', 'b'])
      replies[index + 2](text('done'))
    }
    expect(completed).toEqual(['done'])
    expect(await readFile(join(cwd, 'done.txt'), 'utf8')).toBe('once\n')
  } finally { await close() }
})

it('09 and 11 delivers all acknowledged steers with the whole finished tool batch', async () => {
  let release!: () => void
  const gated = new Promise<void>(resolve => { release = resolve })
  const executed: string[] = []
  const { session, requests, replies, close } = await fixture({ tools: () => [{
    name: 'record', description: 'Record work', parameters: Type.Object({}), executionMode: 'sequential',
    async execute(_args, { toolCallId }) {
      executed.push(toolCallId)
      if (toolCallId === 'second') await gated
      return toolCallId
    },
  }] })
  try {
    await session.submit(input('a'))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    replies[0](tools(call('first', 'record'), call('second', 'record')))
    await vi.waitFor(() => expect(executed).toEqual(['first', 'second']))
    await session.submit(input('q'))
    await session.submit({ ...input('s'), mode: 'steer' })
    expect(session.updateQueue('q', { action: 'steer' })).toEqual({ status: 'steering' })
    expect((await getSnapshot(session)).interaction?.steering.map(item => item.text)).toEqual(['s', 'q'])
    expect(requests).toHaveLength(1)
    release()
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(requests[1].messages.slice(-4).map(message => message.role === 'toolResult' ? message.toolCallId : message.content))
      .toEqual(['first', 'second', 's', 'q'])
    replies[1](text('done'))
    await vi.waitFor(async () => expect((await getSnapshot(session)).running).toBeNull())
    expect(session.updateQueue('q', { action: 'steer' })).toEqual({ status: 'delivered' })
  } finally { release(); await close() }
})

it('15/16 starts an idle direct steer or gives a paused queue head priority', async () => {
  const { session, requests, replies, close } = await fixture()
  try {
    const first = await session.submit({ ...input('a'), mode: 'steer' })
    expect(first.kind).toBe('message')
    if (first.kind !== 'message') return
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(requests[0].messages.at(-1)?.content).toBe('a')
    await session.submit(input('b'))
    await session.abort(first.userMessageId)
    expect(session.updateQueue('b', { action: 'steer' })).toEqual({ status: 'queued' })
    expect(await session.submit({ ...input('s'), mode: 'steer' })).toMatchObject({ kind: 'steering' })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(requests[1].messages.slice(-2).map(message => message.content)).toEqual(['s', 'b'])
    replies[1](text('done'))
  } finally { await close() }
})

it.each([{ reply: answers, which: 'answer' }, { reply: skip, which: 'skip' }])('18/19 persists one whole $which and continues the sequential batch', async ({ reply }) => {
  const executed: string[] = []
  const { session, store, summary, requests, replies, close } = await fixture({
    questionWait: async () => ({ timeout: 120 }),
    tools: () => [{ name: 'record', description: 'Record work', parameters: Type.Object({}),
      async execute(_args, { toolCallId }) { executed.push(toolCallId); return 'original' } }],
  })
  try {
    await session.submit(input('a'))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    replies[0](tools(call('before', 'record'), ask(), call('after', 'record')))
    const batch = await question(session)
    expect(executed).toEqual(['before'])
    expect(requests).toHaveLength(1)
    await expect(session.replyToQuestion(batch.id, 'invalid', [{ id: 'bogus', selected: [] }])).rejects.toMatchObject({ code: 'invalid' })
    const result = await Promise.all([session.replyToQuestion(batch.id, 'r', reply), session.replyToQuestion(batch.id, 'r', reply)])
    expect(result).toEqual([{ kind: 'answered', replyId: 'r' }, { kind: 'answered', replyId: 'r' }])
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(executed).toEqual(['before', 'after'])
    const effects = requests[1].messages.filter(message => message.role === 'toolResult')
    expect(effects.map(item => item.toolCallId)).toEqual(['before', 'ask-1', 'after'])
    expect(effects[1].content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(JSON.stringify(reply)) })
    expect(store.loadSession(summary.id)?.questions).toMatchObject([{ status: 'answered', answers: reply }])
    replies[1](text('done'))
  } finally { await close() }
})

it.each([{ defaultTimeout: -1, timeout: undefined }, { defaultTimeout: 120, timeout: -1 }] as const)(
  '21/26/27 can keep waiting in read-only mode with default $defaultTimeout and call $timeout', async ({ defaultTimeout, timeout }) => {
  const execute = vi.fn(async () => 'not allowed')
  const { session, requests, replies, close } = await fixture({ permissionMode: 'read-only', questionWait: async () => ({ timeout: defaultTimeout }),
    tools: () => [{ name: 'write', description: 'Write file', parameters: Type.Object({}), execute }] })
  try {
    await session.submit(input('a'))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(requests[0].tools?.map(tool => tool.name)).toContain('ask_user_question')
    expect(requests[0].tools?.map(tool => tool.name)).not.toContain('write')
    replies[0](tools(ask(timeout), call('denied', 'write')))
    const batch = await question(session)
    expect(batch.deadlineAt).toBeUndefined()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000)
    try {
      expect((await getSnapshot(session)).interaction?.questions[0].status).toBe('waiting')
      await session.replyToQuestion(batch.id, 'r', answers)
    } finally { clock.mockRestore() }
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(execute).not.toHaveBeenCalled()
    expect(requests[1].messages.at(-1)).toMatchObject({ isError: true, toolCallId: 'denied' })
    replies[1](text('done'))
  } finally { await close() }
})

it.each(['skip', 'abort-then-late', 'restore'] as const)('20/23/24/27 handles %s after an explicit timeout overriding the unlimited default', async finish => {
  const { session, store, summary, requests, replies, create, close } = await fixture({ questionWait: async () => ({ timeout: -1 }) })
  let restored: AgentSession | undefined
  try {
    const receipt = await session.submit(input('a'))
    if (receipt.kind !== 'message') throw new Error('expected task')
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    replies[0](tools(ask(1)))
    const waiting = await question(session)
    expect(waiting.deadlineAt).toBeDefined()
    await question(session, 'timed-out')
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2))
    const recorded = requests[1].messages.find(message => message.role === 'toolResult' && message.toolCallId === 'ask-1')
    expect(recorded?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"pending":true') })
    if (finish === 'skip') {
      expect(await session.replyToQuestion(waiting.id, 'r', skip)).toEqual({ kind: 'closed', replyId: 'r' })
      expect(requests).toHaveLength(2)
      expect(store.loadSession(summary.id)?.questions).toMatchObject([{ status: 'closed' }])
      replies[1](text('done'))
      return
    }
    if (finish === 'abort-then-late') await session.abort(receipt.userMessageId)
    if (finish === 'restore') {
      replies[1](text('done'))
      await vi.waitFor(async () => expect((await getSnapshot(session)).running).toBeNull())
      await session.close()
      restored = create(true)
    }
    const target = restored ?? session
    expect(await target.replyToQuestion(waiting.id, 'r', answers)).toEqual({ kind: 'late', replyId: 'r' })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2].messages.filter(message => message.role === 'user' &&
      String(message.content).includes('"kind":"answer_to_pending_question"'))).toHaveLength(1)
    expect(store.loadSession(summary.id)?.questions).toMatchObject([{ status: 'answered', replyKind: 'late' }])
    replies[2](text('done'))
  } finally { await restored?.close(); await close() }
}, 8_000)

it('22 racing replies at the deadline yield one timeout result and one late input after the tool batch', async () => {
  const following = Promise.withResolvers<void>()
  const began = Promise.withResolvers<void>()
  const { session, store, summary, requests, replies, close } = await fixture({
    questionWait: async () => ({ timeout: 120 }),
    tools: () => [{ name: 'following', description: 'Hold after timeout', parameters: Type.Object({}),
      async execute() { began.resolve(); await following.promise; return 'following done' } }],
  })
  try {
    await session.submit(input('a'))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    replies[0](tools(ask(), call('following-1', 'following')))
    const batch = await question(session)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(batch.deadlineAt! - 1)
    try {
      await expect(session.replyToQuestion(batch.id, 'incomplete', [answers[0]])).rejects.toMatchObject({ code: 'invalid' })
      clock.mockReturnValue(batch.deadlineAt!)
      await expect(Promise.all([session.replyToQuestion(batch.id, 'r', answers), session.replyToQuestion(batch.id, 'r', answers)]))
        .resolves.toEqual([{ kind: 'late', replyId: 'r' }, { kind: 'late', replyId: 'r' }])
    } finally { clock.mockRestore() }
    await began.promise
    expect(requests).toHaveLength(1)
    const saved = store.loadSession(summary.id)!.messages.filter(entry => entry.message.role === 'toolResult')
    expect(saved).toEqual([expect.objectContaining({ message: expect.objectContaining({ toolCallId: 'ask-1',
      content: [{ type: 'text', text: expect.stringContaining('"pending":true') }] }) })])
    following.resolve()
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].messages.slice(-3).map(message => message.role === 'toolResult' ? message.toolCallId : message.content))
      .toEqual(['ask-1', 'following-1', expect.stringContaining('"kind":"answer_to_pending_question"')])
    const payload = requests[1].messages.at(-1)?.content
    expect(JSON.parse(String(payload))).toMatchObject({ callId: 'ask-1', questions: questionSet, answers })
    replies[1](text('done'))
  } finally { following.resolve(); await close() }
})

it('25 aborts an outstanding question with the same call ID and no subsequent tool effects', async () => {
  const executed: string[] = []
  const { session, store, summary, replies, requests, close } = await fixture({ questionWait: async () => ({ timeout: -1 }),
    tools: () => [{
      name: 'record', description: 'Record work', parameters: Type.Object({}),
      async execute(_args, { toolCallId }) { executed.push(toolCallId); return 'done' },
    }],
  })
  try {
    const receipt = await session.submit(input('a'))
    if (receipt.kind !== 'message') throw new Error('expected task')
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    replies[0](tools(call('before', 'record'), ask(), call('after', 'record')))
    const batch = await question(session)
    await session.abort(receipt.userMessageId)
    await question(session, 'aborted')
    await expect(session.replyToQuestion(batch.id, 'r', answers)).rejects.toMatchObject({ code: 'busy' })
    expect(executed).toEqual(['before'])
    expect(requests).toHaveLength(1)
    expect(store.loadSession(summary.id)?.messages.find(entry =>
      entry.message.role === 'toolResult' && entry.message.toolCallId === 'ask-1')).toMatchObject({ message: { isError: true } })
  } finally { await close() }
})

it.each(['normal', 'planning', 'read-only'] as const)('26 accepts answers in %s and enforces existing write permissions', async mode => {
  const { session, cwd, requests, replies, close } = await fixture({
    ...(mode === 'read-only' && { permissionMode: 'read-only' as const }),
    questionWait: async () => ({ timeout: 120 }),
    tools: directory => [{
      name: 'write', description: 'Write test file', parameters: Type.Object({}),
      async execute() { await writeFile(join(directory, 'protected.txt'), 'new'); return 'changed' },
    }],
  })
  try {
    await writeFile(join(cwd, 'protected.txt'), 'original')
    if (mode === 'planning') await session.submit(input('plan-control', '/plan'))
    await session.submit(input('a'))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(requests[0].tools?.map(tool => tool.name)).toContain('ask_user_question')
    replies[0](tools(ask()))
    const batch = await question(session)
    await session.replyToQuestion(batch.id, 'r', answers)
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'ask-1', isError: false })
    replies[1](tools(call('write-1', 'write')))
    await vi.waitFor(() => expect(replies).toHaveLength(3))
    expect(requests[2].messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'write-1', isError: mode !== 'normal' })
    expect(await readFile(join(cwd, 'protected.txt'), 'utf8')).toBe(mode === 'normal' ? 'new' : 'original')
    replies[2](text('done'))
  } finally { await close() }
})

it('a new manual run clears the pause left by deleting the previous queue', async () => {
  const { session, requests, replies, close } = await fixture()
  try {
    const first = await session.submit(input('a'))
    if (first.kind !== 'message') throw new Error('expected started task')
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    await session.submit(input('b'))
    await session.abort(first.userMessageId)
    expect(session.updateQueue('b', { action: 'delete' })).toEqual({ status: 'deleted' })
    await session.submit(input('c'))
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    await session.submit(input('d'))
    replies[1](text('completed C'))
    await vi.waitFor(() => expect(replies).toHaveLength(3))
    expect(requests[2].messages.at(-1)?.content).toBe('d')
    replies[2](text('completed D'))
  } finally { await close() }
})

it('Feature 12 案例 34 重投同编号插话返回原轮回执且不进入新轮', async () => {
  const { session, store, summary, requests, replies, close } = await fixture()
  const source = { kind: 'steer' as const, sessionId: 'scout-id', name: 'scout' }
  try {
    const first = await session.submit(input('first'))
    expect(first.kind).toBe('message')
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    const original = session.receiveAgentInput('steer:old-call', source, 'scout 的发现 STEER-34')
    expect(original).toMatchObject({ status: 'accepted', runId: first.kind === 'message' && first.userMessageId })
    replies[0]!(text('首轮文字'))
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(requests[1]!.messages.filter(message => message.role === 'user' && message.content === 'scout 的发现 STEER-34')).toHaveLength(1)
    replies[1]!(text('首轮结束'))
    await vi.waitFor(() => expect(store.loadSession(summary.id)?.runs[0]?.status).toBe('completed'))
    const next = await session.submit(input('next'))
    expect(next.kind).toBe('message')
    await vi.waitFor(() => expect(replies).toHaveLength(3))
    expect(session.receiveAgentInput('steer:old-call', source, '重复投递，不能重复读')).toEqual(original)
    replies[2]!(text('新轮结束'))
    await vi.waitFor(() => expect(store.loadSession(summary.id)?.runs[1]?.status).toBe('completed'))
    const saved = store.loadSession(summary.id)
    expect(saved?.pending?.filter(item => item.input.clientMessageId === 'agent:steer:old-call')).toHaveLength(1)
    expect(saved?.messages.filter(message => message.agentSource?.sessionId === 'scout-id')).toHaveLength(1)
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[2]?.messages)).not.toContain('重复投递')
  } finally { await close() }
})
