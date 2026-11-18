import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AssistantMessage, ModelContext, ModelEventStream, ToolCall } from '@agent-learning/model'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentSession } from '../src/agent-session.js'
import { SessionAttachments } from '../src/session-attachments.js'
import { SessionStore } from '../src/session-store.js'
import { ToolRuntime } from '../src/tool-runtime.js'
import { createTools } from '../src/tools.js'

const summary = { id: 'plan-session', workspaceId: 'workspace', name: '新会话', createdAt: new Date().toISOString() }
const message = { clientMessageId: 'request-1', modelId: 'deepseek-flash', text: '请安排工作' }
const steps = ['检查服务启动日志', '修复设置并验证启动']
const planText = 'Plan:\n1. ' + steps.join('\n2. ')
const reply = (text: string, stopReason: 'stop' | 'length' = 'stop'): AssistantMessage => ({
  role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', stopReason,
  content: [{ type: 'text', text }], timestamp: 1,
})
function done(output: AssistantMessage): ModelEventStream {
  return {
    async result() { return output },
    async *[Symbol.asyncIterator]() { yield { type: 'done', reason: output.stopReason as 'stop' | 'length' | 'toolUse', message: output } },
  }
}
function call(id: string, name: string, args: ToolCall['arguments']): ToolCall {
  return { type: 'toolCall', id, name, arguments: args }
}
const toolReply = (...content: ToolCall[]): AssistantMessage => ({ ...reply(''), stopReason: 'toolUse', content })

let cwd: string
let runtime: ToolRuntime
let store: SessionStore | undefined
const sessions: AgentSession[] = []
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'si-planning-'))
  runtime = new ToolRuntime()
})
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
  store?.close()
  store = undefined
  await runtime.close()
  await rm(cwd, { recursive: true, force: true })
})

function createSession(options: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const session = new AgentSession({ resolveDirectory: async () => cwd, skillHome: cwd,
    tools: dir => createTools(runtime, { web_search: async () => '', web_fetch: async () => '' }, dir), ...options })
  sessions.push(session)
  return session
}

async function snapshot(session: AgentSession) {
  const controller = new AbortController()
  try {
    const event = (await session.subscribe(controller.signal).next()).value
    if (event?.type !== 'snapshot') throw new Error('缺少会话快照')
    return event.snapshot
  } finally { controller.abort() }
}
async function settle(session: AgentSession) {
  return vi.waitFor(async () => {
    const view = await snapshot(session)
    expect(view.running).toBeNull()
    return view
  }, { interval: 5 })
}
async function enterPlan(session: AgentSession) {
  const input = { ...message, clientMessageId: 'plan-command', text: '/plan' }
  await expect(session.submit(input)).resolves.toEqual({ kind: 'handled', clientMessageId: input.clientMessageId, notices: [] })
  await expect(session.submit(input)).resolves.toMatchObject({ kind: 'handled' })
  expect(await snapshot(session)).toMatchObject({ plan: { state: 'planning' }, messages: [], running: null })
}

it('限制工具声明和实际执行，认可 git status 与 git diff', async () => {
  execFileSync('git', ['init', '-q', cwd])
  await writeFile(join(cwd, '.gitattributes'), 'note.txt filter=fixture\n')
  await writeFile(join(cwd, 'note.txt'), '初始正文\n')
  execFileSync('git', ['-C', cwd, 'add', 'note.txt'])
  await writeFile(join(cwd, 'note.txt'), '当前正文\n')
  execFileSync('git', ['-C', cwd, 'config', 'filter.fixture.clean', 'false'])
  execFileSync('git', ['-C', cwd, 'config', 'filter.fixture.required', 'true'])
  const contexts: ModelContext[] = []
  const session = createSession({ stream: (_model, context) => {
    contexts.push(context)
    if (contexts.length > 1) return done(reply(planText))
    return done(toolReply(
      call('read', 'read', { path: 'note.txt' }),
      call('status', 'bash', { command: 'git status --short' }),
      call('diff', 'bash', { command: 'git diff' }),
      call('write', 'write', { path: 'note.txt', content: '非法改动' }),
      call('edit', 'edit', { path: 'note.txt', edits: [{ oldText: '当前正文', newText: '非法改动' }] }),
      call('redirect', 'bash', { command: 'git status > note.txt' }),
      call('ext-diff', 'bash', { command: 'git diff --ext-diff' }),
      call('rewrite', 'bash', { command: 'git status' }),
      call('custom', 'custom-tool', {}),
    ))
  }, extensions: [{ path: 'fixture', entry(api) {
    api.on('before_agent_start', () => ({ systemPrompt: '扩展自定义提示' }))
    api.on('tool_call', event => {
      if (event.toolCallId === 'rewrite') event.input.command = 'git status > note.txt'
    })
    api.registerTool({ name: 'custom-tool', description: '扩展写入', parameters: {}, async execute() {
      await writeFile(join(cwd, 'note.txt'), '非法扩展写入')
      return 'wrote'
    } })
  } }] })
  await enterPlan(session)
  expect(contexts).toHaveLength(0)
  await session.submit(message)
  const state = await settle(session)
  expect(contexts[0]?.systemPrompt).toMatch(/扩展自定义提示[\s\S]*Plan:/)
  expect(contexts[0]?.tools?.map(tool => tool.name)).toContain('bash')
  expect(contexts[0]?.tools?.map(tool => tool.name)).not.toContain('write')
  expect(contexts[0]?.tools?.map(tool => tool.name)).not.toContain('custom-tool')
  const results = state.messages.flatMap(({ message: item, toolErrorCode }) => item.role === 'toolResult' ? [{ item, toolErrorCode }] : [])
  expect(results.map(({ item, toolErrorCode }) => [item.toolCallId, toolErrorCode ?? item.isError])).toEqual([
    ['read', false], ['status', false], ['diff', false], ['write', 'permission_denied'], ['edit', 'permission_denied'],
    ['redirect', 'permission_denied'], ['ext-diff', 'permission_denied'], ['rewrite', 'permission_denied'], ['custom', 'permission_denied'],
  ])
  expect(JSON.stringify(results[2])).toContain('+当前正文')
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('当前正文\n')
  expect(state.plan).toMatchObject({ state: 'review', steps })
})

it('只在完整可见计划结束后待审，讨论后新计划得到新 ID', async () => {
  const hiddenPlan = { ...reply('你希望使用哪个版本？'), content: [
    { type: 'thinking' as const, thinking: planText }, { type: 'text' as const, text: '你希望使用哪个版本？' },
  ] }
  const replies = [hiddenPlan, reply(planText, 'length'), reply(planText), reply(planText)]
  const session = createSession({ stream: () => done(replies.shift()!) })
  await enterPlan(session)
  await session.submit(message)
  expect((await settle(session)).plan).toEqual({ state: 'planning' })
  await session.submit({ ...message, clientMessageId: 'request-2' })
  expect((await settle(session)).plan).toEqual({ state: 'planning' })
  await session.submit({ ...message, clientMessageId: 'request-3' })
  const first = (await settle(session)).plan
  expect(first).toMatchObject({ state: 'review', steps })
  if (first?.state !== 'review') throw new Error('缺少待审计划')
  await expect(session.reviewPlan(first.assistantMessageId, 'discuss')).resolves.toEqual({ plan: { state: 'planning' } })
  await session.submit({ ...message, clientMessageId: 'request-4' })
  const next = (await settle(session)).plan
  expect(next).toMatchObject({ state: 'review', steps })
  expect(next).not.toEqual(first)
  await expect(session.reviewPlan(first.assistantMessageId, 'approve')).rejects.toMatchObject({ code: 'invalid' })
})

it('待审与执行保留编号步骤中的缩进续行', async () => {
  const multiline = ['查看启动日志\n   记录最近一次失败的错误码。', '修复参数并验证启动。']
  const proposal = `Plan:\n1. ${multiline[0]}\n2. ${multiline[1]}`
  const contexts: ModelContext[] = []
  const session = createSession({ stream: (_model, context) => {
    contexts.push(context)
    return done(reply(contexts.length === 1 ? proposal : '已经完成。'))
  } })
  await enterPlan(session)
  await session.submit(message)
  const plan = (await settle(session)).plan
  expect(plan).toMatchObject({ state: 'review', steps: multiline })
  if (plan?.state !== 'review') throw new Error('缺少待审计划')
  await session.reviewPlan(plan.assistantMessageId, 'approve')
  await settle(session)
  expect(contexts[1]?.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining(proposal) })
})

it('SQLite 重启恢复待审，失败确认回滚，重复确认只写一轮且沿用只读权限', async () => {
  const dbPath = join(cwd, 'sessions.sqlite')
  store = SessionStore.open(dbPath)
  store.save(summary.id, { summary, permissionMode: 'read-only' })
  const planner = createSession({ persistence: { summary, store }, permissionMode: 'read-only', stream: () => done(reply(planText)),
    extensions: [{ path: 'fixture', entry: api => { api.on('agent_before_settle', () => undefined) } }],
  })
  await enterPlan(planner)
  await planner.submit(message)
  const plan = (await settle(planner)).plan
  expect(plan).toMatchObject({ state: 'review', steps })
  if (plan?.state !== 'review') throw new Error('缺少待审计划')
  await planner.close()
  store.close()
  store = undefined
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TRIGGER test_block_approval BEFORE INSERT ON runs WHEN json_extract(NEW.data, '$.approvedPlanId') IS NOT NULL BEGIN SELECT raise(ABORT, 'fixture'); END")
  db.close()

  store = SessionStore.open(dbPath)
  const blocked = createSession({ persistence: { summary, store, history: store.loadSession(summary.id) } })
  expect((await snapshot(blocked)).plan).toEqual(plan)
  await expect(blocked.reviewPlan(plan.assistantMessageId, 'approve')).rejects.toMatchObject({ reason: 'write-failed' })
  expect((await snapshot(blocked)).plan).toEqual(plan)
  expect(store.loadSession(summary.id)?.plan).toEqual(plan)
  expect(store.loadSession(summary.id)?.runs).toHaveLength(1)
  await blocked.close()
  store.close()
  store = undefined
  const retryDb = new DatabaseSync(dbPath)
  retryDb.exec('DROP TRIGGER test_block_approval')
  retryDb.close()

  store = SessionStore.open(dbPath)
  const contexts: ModelContext[] = []
  const executor = createSession({ persistence: { summary, store, history: store.loadSession(summary.id) }, stream: (_model, context) => {
    contexts.push(context)
    return done(contexts.length === 1 ? toolReply(call('forbidden', 'write', { path: 'changed.txt', content: '副作用' })) : reply('完成'))
  } })
  const approve = () => executor.reviewPlan(plan.assistantMessageId, 'approve')
  const [first, retry] = await Promise.all([approve(), approve()])
  expect(first).toEqual(retry)
  const executed = await settle(executor)
  expect(executed.plan).toBeNull()
  expect(contexts[0]?.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining(planText) })
  expect(executed.messages.find(item => item.message.role === 'toolResult')?.toolErrorCode).toBe('permission_denied')
  await expect(readFile(join(cwd, 'changed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  const history = store.loadSession(summary.id)!
  expect(history.plan).toBeUndefined()
  expect(history.runs).toHaveLength(2)
  const restored = createSession({ persistence: { summary, store, history } })
  await expect(restored.reviewPlan(plan.assistantMessageId, 'approve')).resolves.toEqual(first)
})

const exit = { ...message, text: '/plan off', clientMessageId: 'exit-plan' }

it.each(['normal', 'read-only'] as const)('运行中退出不放宽当前请求的重试或工具批，下一轮恢复 %s 权限', async permissionMode => {
  const contexts: ModelContext[] = []
  const firstRequest = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const session = createSession({ permissionMode, stream: (_model, context) => {
    contexts.push(context)
    if (contexts.length === 1) {
      firstRequest.resolve()
      const error: AssistantMessage = { ...reply(''), stopReason: 'error', failure: { kind: 'rate-limit', retryAt: 0 } }
      return {
        async result() { return error },
        async *[Symbol.asyncIterator]() { await release.promise; yield { type: 'error', reason: 'error', error } },
      }
    }
    if (contexts.length === 2) return done(toolReply(
      call('old-write', 'write', { path: 'old.txt', content: 'forbidden' }),
      call('old-bash', 'bash', { command: 'echo forbidden > from-bash.txt' }),
    ))
    if (contexts.length === 3) return done(toolReply(call('next-write', 'write', { path: 'next.txt', content: 'next step' })))
    return done(reply(planText))
  } })
  await session.submit({ ...message, text: '/plan  请安排工作' })
  await firstRequest.promise
  try {
    await expect(session.submit(exit)).resolves.toMatchObject({ kind: 'handled' })
    expect(await snapshot(session)).toMatchObject({ plan: null, running: { kind: 'task' } })
  } finally { release.resolve() }
  const view = await settle(session)
  expect(view.plan).toBeNull()
  expect(view.messages.filter(entry => entry.message.role === 'user').map(entry => entry.message.content)).toEqual(['请安排工作'])
  expect(contexts).toHaveLength(4)
  expect(contexts[0]).toEqual(contexts[1])
  expect(contexts[1]!.systemPrompt).toContain('当前处于计划模式')
  expect(contexts[1]!.tools?.some(tool => tool.name === 'write')).toBe(false)
  expect(contexts[2]!.systemPrompt).toContain('用户已退出计划模式')
  expect(contexts[2]!.systemPrompt).not.toContain('当前处于计划模式')
  expect(contexts[2]!.tools?.some(tool => tool.name === 'write')).toBe(permissionMode === 'normal')
  const outcomes = view.messages.flatMap(entry => entry.message.role === 'toolResult' ? [[entry.message.toolCallId, entry.toolErrorCode ?? 'ok']] : [])
  expect(outcomes).toEqual([['old-write', 'permission_denied'], ['old-bash', 'permission_denied'],
    ['next-write', permissionMode === 'normal' ? 'ok' : 'permission_denied']])
  await expect(readFile(join(cwd, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(cwd, 'from-bash.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  if (permissionMode === 'normal') expect(await readFile(join(cwd, 'next.txt'), 'utf8')).toBe('next step')
  else await expect(readFile(join(cwd, 'next.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('退出待审不批准方案，状态和重复开关回执在重启后保持', async () => {
  store = SessionStore.open(join(cwd, 'plan.sqlite'))
  store.save(summary.id, { summary })
  const session = createSession({ persistence: { store, summary }, stream: () => done(reply(planText)) })
  await enterPlan(session)
  await session.submit(message)
  const plan = (await settle(session)).plan
  if (plan?.state !== 'review') throw new Error('缺少待审计划')
  await session.submit(exit)
  await expect(session.reviewPlan(plan.assistantMessageId, 'approve')).rejects.toMatchObject({ code: 'invalid' })
  const history = store.loadSession(summary.id)!
  expect(history.plan).toBeUndefined()
  expect(history.runs).toHaveLength(1)
  expect(history.messages.at(-1)?.message.content).toEqual(reply(planText).content)
  await session.close()
  const restored = createSession({ persistence: { store, summary, history } })
  await restored.submit({ ...message, text: '/plan', clientMessageId: 'plan-command' })
  expect((await snapshot(restored)).plan).toBeUndefined()
  await restored.submit({ ...message, text: '/plan', clientMessageId: 'enable-again' })
  await restored.submit(exit)
  expect((await snapshot(restored)).plan).toEqual({ state: 'planning' })
})

it('计划首条消息和会话状态一起落库，命令前缀不进入模型或标题，原请求可重放', async () => {
  store = SessionStore.open(join(cwd, 'plan.sqlite'))
  const freshSummary = { ...summary }
  const source = { ...summary, id: 'previous-session', name: '首页需求' }
  store.save(source.id, { summary: source })
  const attachments = new SessionAttachments(join(cwd, 'attachments'))
  const attachment = await attachments.upload({ workspaceId: summary.workspaceId, draftSessionId: summary.id },
    'notes.txt', Buffer.from('附件中的需求'))
  store.registerAttachment(attachment)
  const contexts: ModelContext[] = []
  const session = createSession({ attachments, persistence: { store, summary: freshSummary, first: () => ({ ...freshSummary }) },
    stream: (_model, context) => { contexts.push(context); return done(reply('先查看哪里？')) } })
  const input = { ...message, text: '/plan\n请安排工作', attachmentIds: [attachment.id], referenceSessionIds: [source.id] }
  await expect(session.submit({ ...input, attachmentIds: ['missing'] })).rejects.toMatchObject({ code: 'invalid' })
  expect(store.loadSession(summary.id)).toBeUndefined()
  const receipt = await session.submit(input)
  const view = await settle(session)
  expect(view.plan).toEqual({ state: 'planning' })
  const firstPrompt = JSON.stringify(contexts[0]?.messages.at(-1))
  expect(firstPrompt).toContain('请安排工作')
  expect(firstPrompt).toContain('notes.txt')
  expect(firstPrompt).toContain('首页需求')
  expect(firstPrompt).not.toContain('/plan')
  expect(store.sentAttachment(attachment.id)?.workspaceId).toBe(summary.workspaceId)
  const history = store.loadSession(summary.id)!
  expect(history.summary.name).toBe('请安排工作')
  expect(history.plan).toEqual(view.plan)
  expect(history.messages[0]?.message.content).toBe('请安排工作')
  const restored = createSession({ persistence: { summary, store, history } })
  await restored.submit(exit)
  await expect(restored.submit(input)).resolves.toEqual(receipt)
  expect((await snapshot(restored)).plan).toBeNull()
})

it('最终回复已落库但扩展仍在收尾时退出，收尾完成也不会重新显示评审', async () => {
  store = SessionStore.open(join(cwd, 'plan.sqlite'))
  store.save(summary.id, { summary })
  const settling = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const session = createSession({ persistence: { store, summary }, stream: () => done(reply(planText)),
    extensions: [{ path: 'fixture', entry: api => {
      api.on('agent_settled', async () => { settling.resolve(); await finish.promise })
    } }],
  })
  await session.submit({ ...message, text: '/plan 请列出步骤' })
  await settling.promise
  try {
    await session.submit({ ...exit, provider: 'removed-provider', modelId: 'removed-model' })
  } finally { finish.resolve() }
  expect((await settle(session)).plan).toBeNull()
  expect(store.loadSession(summary.id)?.plan).toBeUndefined()
})

it('异步 context 钩子期间退出会应用到尚未发出的模型请求，保留扩展整理的消息', async () => {
  const inHook = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const contexts: ModelContext[] = []
  const session = createSession({ extensions: [{ path: 'fixture', entry: api => {
    api.on('context', async event => {
      if (contexts.length) return
      inHook.resolve()
      await resume.promise
      return { messages: [...event.messages, { role: 'user', content: '扩展补充的需求', timestamp: 1 }] }
    })
  } }], stream: (_model, context) => {
    contexts.push(context)
    return done(contexts.length === 1 ? toolReply(call('write', 'write', { path: 'pending.txt', content: 'switched' })) : reply('完成'))
  } })
  await session.submit({ ...message, text: '/plan 请安排工作' })
  await inHook.promise
  try {
    expect(contexts).toHaveLength(0)
    await session.submit(exit)
  } finally { resume.resolve() }
  await settle(session)
  expect(contexts[0]?.messages.at(-1)?.content).toBe('扩展补充的需求')
  expect(contexts[0]?.systemPrompt).not.toContain('当前处于计划模式')
  expect(contexts[0]?.tools?.map(tool => tool.name)).toContain('write')
  expect(await readFile(join(cwd, 'pending.txt'), 'utf8')).toBe('switched')
})
