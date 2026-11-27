import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import type { AssistantMessage, ModelContext, ModelEventStream } from '@agent-learning/model'
import { AgentSession } from '../src/agent-session.js'
import { createCodeModeTool } from '../src/codemode.js'
import type { McpToolBinding } from '../src/mcp/manager.js'
import { SessionStore } from '../src/session-store.js'
import { ToolRuntime } from '../src/tool-runtime.js'
import { createTools, type CodingTool } from '../src/tools.js'

const base: AssistantMessage = {
  role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1,
  stopReason: 'stop', content: [{ type: 'text', text: 'done' }],
}
function output(message: AssistantMessage): ModelEventStream {
  return { result: async () => message, async *[Symbol.asyncIterator]() {
    yield { type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }
  } }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup(code: string, options: {
  timeoutMs?: number
  added?: CodingTool[]
  failCheckpoint?: 'INSERT' | 'UPDATE'
  session?: Partial<ConstructorParameters<typeof AgentSession>[0]>
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'si-codemode-test-'))
  const database = join(cwd, 'db.sqlite')
  let store = SessionStore.open(database)
  let closed = false
  const closeStore = () => { if (!closed) { store.close(); closed = true } }
  const runtime = new ToolRuntime()
  const summary = { id: 'codemode-session', workspaceId: 'workspace', name: 'Fixture', createdAt: new Date().toISOString() }
  store.save(summary.id, { summary })
  if (options.failCheckpoint) {
    closeStore()
    const db = new DatabaseSync(database)
    try { db.exec(`CREATE TRIGGER fail_fixture BEFORE ${options.failCheckpoint} ON nested_tool_calls BEGIN SELECT RAISE(FAIL, 'fixture'); END;`) }
    finally { db.close() }
    store = SessionStore.open(database)
    closed = false
  }
  const requests: ModelContext[] = []
  const tools = () => [...createTools(runtime, { web_search: async () => '', web_fetch: async () => '' }, cwd, summary.id), ...options.added ?? []]
  const session = new AgentSession({
    resolveDirectory: async () => cwd, skillHome: cwd, persistence: { store, summary }, tools,
    stream: (_model, context) => {
      requests.push(context)
      return output(requests.length === 1 ? { ...base, stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'program', name: 'codemode', arguments: { code, ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }) } },
      ] } : base)
    }, ...options.session,
  })
  cleanup.push(async () => {
    await session.close()
    await runtime.close()
    closeStore()
    await rm(cwd, { recursive: true, force: true })
  })
  const start = (text = 'run the fixture') => session.submit({ clientMessageId: text, modelId: 'deepseek-flash', text })
  const idle = async () => {
    await vi.waitFor(() => expect(session.activeRunId).toBeUndefined(), { timeout: 4000 })
    return store.loadSession(summary.id)!
  }
  return { cwd, database, store, runtime, summary, session, requests, start, idle, tools, closeStore }
}

function gate(name: string, execute: CodingTool['execute']): CodingTool {
  return { name, parameters: Type.Object({}), description: name, execute }
}

function fakeMcp() {
  const binding: McpToolBinding = {
    name: 'mcp__tracker__lookup_ticket', serverId: 'tracker', credentialRef: 'fixture', revision: 1,
    tool: { name: 'lookup_ticket', description: 'Read a ticket by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }
  let enabled = true
  const sent = vi.fn((_args: Record<string, unknown>) => {})
  return {
    binding, sent, disable: () => { enabled = false },
    source: {
      isCurrentTool: () => enabled, listToolsForAgent: () => enabled ? [binding] : [],
      listDiscoveryServers: () => [{ id: 'tracker', name: 'Tracker' }],
      subscribeToolCatalog: () => () => {}, waitForToolDiscovery: async () => {},
      async callTool(_binding: McpToolBinding, args: Record<string, unknown>, _signal: AbortSignal, checkPermission: () => void) {
        checkPermission()
        sent(args)
        return { content: [{ type: 'text' as const, text: 'Ticket T-42 active' }] }
      },
    },
  }
}

it('02 exposes only allowed script bindings and no MCP tools in read-only mode', async () => {
  const { source } = fakeMcp()
  const fixture = await setup(`
    const paths = await tools.find({pattern:"*.md"});
    return { names: ALL_TOOLS.map(t => t.name), read: await tools.read({path:paths.trim()}), remote: await searchTools("ticket") };
  `, { session: { mcp: source, permissionMode: 'read-only' } })
  await writeFile(join(fixture.cwd, 'guide.md'), 'Read me')
  await fixture.start()
  const history = await fixture.idle()
  const outer = history.messages.find(entry => entry.message.role === 'toolResult')?.message
  expect(outer).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('Read me') }] })
  if (outer?.role !== 'toolResult' || outer.content[0]?.type !== 'text') throw new Error('missing Code Mode result')
  expect(JSON.parse(outer.content[0].text)).toMatchObject({ names: ['read', 'find', 'grep', 'ls'], remote: [] })
})

it('03 checks plan Git arguments for every internal Bash call', async () => {
  const fixture = await setup(`
    text(await tools.bash({command:"git status --short"}));
    try { await tools.bash({command:"git add sample.txt"}); } catch (error) { text(error.message); }
  `)
  execFileSync('git', ['init', '-q'], { cwd: fixture.cwd })
  await writeFile(join(fixture.cwd, 'sample.txt'), 'example')
  await fixture.start('/plan')
  await fixture.start()
  expect((await fixture.idle()).nestedToolCalls).toMatchObject([
    { name: 'bash', status: 'succeeded', resultPreview: expect.stringContaining('?? sample.txt') },
    { name: 'bash', status: 'not-executed', resultPreview: expect.stringContaining('计划模式') },
  ])
  expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: fixture.cwd, encoding: 'utf8' })).toBe('')
})

it('04 applies permission changes before starting a later write', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const { session, cwd, start, idle } = await setup(`
    await tools.wait_for_read({});
    try { await tools.write({path:"notes.txt", content:"wrong"}); } catch (error) { return error.message; }
  `, { added: [gate('wait_for_read', async () => { entered.resolve(); await release.promise; return 'read' })] })
  await writeFile(join(cwd, 'notes.txt'), 'original')
  await start()
  await entered.promise
  try { session.selectPermissionMode('read-only') } finally { release.resolve() }
  expect((await idle()).nestedToolCalls).toMatchObject([
    { name: 'wait_for_read', status: 'succeeded' },
    { name: 'write', status: 'not-executed', resultPreview: expect.stringContaining('只读') },
  ])
  expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('original')
})

it('05 runs the protection hook for internal edits and keeps the same child ID', async () => {
  const ids: string[] = []
  const fixture = await setup('try { await tools.edit({path:".env", edits:[{oldText:"old",newText:"new"}]}); } catch (error) { return error.message; }',
    { session: { extensions: [{ path: 'protected-paths', entry(api) {
      api.on('tool_call', event => {
        if (event.toolName !== 'edit' || event.input.path !== '.env') return
        ids.push(event.toolCallId)
        return { block: true, reason: 'protected path' }
      })
    } }] } })
  await writeFile(join(fixture.cwd, '.env'), 'old')
  await fixture.start()
  expect((await fixture.idle()).nestedToolCalls).toMatchObject([{ id: ids[0], status: 'not-executed', resultPreview: 'protected path' }])
  expect(await readFile(join(fixture.cwd, '.env'), 'utf8')).toBe('old')
})

it('07 keeps successful reads when a parallel read fails', async () => {
  const fixture = await setup(`
    const rows = await Promise.allSettled([tools.read({path:"active.txt"}), tools.read({path:"missing.txt"})]);
    return rows.map(row => row.status === "fulfilled" ? row.value : row.reason.message);
  `)
  await writeFile(join(fixture.cwd, 'active.txt'), 'available')
  await fixture.start()
  const history = await fixture.idle()
  expect(history.nestedToolCalls).toMatchObject([
    { status: 'succeeded', resultPreview: 'available' },
    { status: 'failed', resultPreview: expect.stringContaining('missing.txt') },
  ])
  expect(fixture.requests[1]?.messages.at(-1)).toMatchObject({
    isError: false, content: [{ text: expect.stringMatching(/available.*missing\.txt/) }],
  })
})

it('09 rejects a timeout outside the schema before any tool runs', async () => {
  const execute = vi.fn(async () => 'should not run')
  const fixture = await setup('return await tools.witness({});', { timeoutMs: 600_001, added: [gate('witness', execute)] })
  await fixture.start()
  expect((await fixture.idle()).nestedToolCalls).toBeUndefined()
  expect(execute).not.toHaveBeenCalled()
  expect(fixture.requests[1]?.messages.at(-1)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('600000') }] })
  expect(createCodeModeTool().parameters.properties.timeoutMs.description).toContain('300000')
})

function waitForAbort({ signal }: { signal: AbortSignal }) {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

it.each([false, true])('10/11 preserves completed actions and waits for cancellation, manual stop %s', async manual => {
  const entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const fixture = await setup(`
    text(await tools.read({path:"visible.txt"}));
    await tools.wait_until_aborted({});
  `, { timeoutMs: manual ? undefined : 400, added: [gate('wait_until_aborted', async (_args, context) => {
    entered.resolve()
    try { await waitForAbort(context); return '' }
    finally { aborted.resolve(); await release.promise }
  })] })
  await writeFile(join(fixture.cwd, 'visible.txt'), 'before stop')
  await fixture.start()
  await entered.promise
  const stopping = manual ? fixture.session.abort(fixture.session.activeRunId!) : undefined
  await aborted.promise
  expect(fixture.session.activeRunId).toBeDefined()
  release.resolve()
  await stopping
  expect((await fixture.idle()).nestedToolCalls).toMatchObject([{ status: 'succeeded' }, { status: 'stopped' }])
  expect(fixture.requests).toHaveLength(manual ? 1 : 2)
  const result = (await fixture.idle()).messages.find(entry => entry.message.role === 'toolResult')?.message
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'before stop' }, { type: 'text', text: expect.stringContaining(manual ? '已停止' : '超时') }] })
})

it('12 keeps an accepted background Bash job under the session after timeout', async () => {
  const fixture = await setup(`
    text(await tools.bash({command:"sleep 30",background:true}));
    await tools.wait_until_aborted({});
  `, { timeoutMs: 450, added: [gate('wait_until_aborted', (_args, context) => waitForAbort(context))] })
  await fixture.start()
  const history = await fixture.idle()
  expect(history.nestedToolCalls).toMatchObject([{ name: 'bash', status: 'succeeded' }, { status: 'stopped' }])
  const process = fixture.tools().find(tool => tool.name === 'process')!
  const context = { signal: new AbortController().signal, toolCallId: 'fixture', contentIndex: 0, recordDetails() {} }
  const listing = String(await process.execute({ action: 'list' }, context))
  const [job] = JSON.parse(listing) as { jobId: string }[]
  const id = job?.jobId
  expect(id, listing).toBeTruthy()
  await process.execute({ action: 'stop', jobId: id! }, context)
})

it.each([false, true])('13/14 restores honest state when SQLite rejects a checkpoint, failure after write %s', async afterWrite => {
  const fixture = await setup('await tools.write({path:"notes.txt", content:"new"}); return "done";',
    { failCheckpoint: afterWrite ? 'UPDATE' : 'INSERT' })
  await writeFile(join(fixture.cwd, 'notes.txt'), 'original')
  await fixture.start()
  const history = await fixture.idle()
  expect(await readFile(join(fixture.cwd, 'notes.txt'), 'utf8')).toBe(afterWrite ? 'new' : 'original')
  expect(fixture.requests).toHaveLength(1)
  expect(history.nestedToolCalls).toEqual(afterWrite ? [expect.objectContaining({ status: 'unknown', argumentsPreview: expect.objectContaining({ path: 'notes.txt' }) })] : undefined)
  const snapshot = (await fixture.session.subscribe(AbortSignal.timeout(200)).next()).value
  expect(snapshot?.type === 'snapshot' && snapshot.snapshot.saveFailures?.at(-1)?.stage).toBe(afterWrite ? 'tool-result' : 'tool-call')
  if (afterWrite) {
    await fixture.session.close()
    fixture.closeStore()
    const reopened = SessionStore.open(fixture.database)
    cleanup.push(async () => reopened.close())
    const requests: ModelContext[] = []
    const restarted = new AgentSession({
      resolveDirectory: async () => fixture.cwd, skillHome: fixture.cwd, persistence: { store: reopened, summary: fixture.summary, history: reopened.loadSession(fixture.summary.id) },
      stream: (_model, context) => { requests.push(context); return output(base) },
    })
    cleanup.push(() => restarted.close())
    await restarted.submit({ clientMessageId: 'resumed', modelId: 'deepseek-flash', text: '继续' })
    await vi.waitFor(() => expect(restarted.activeRunId).toBeUndefined())
    expect(requests[0]?.messages).toContainEqual(expect.objectContaining({
      role: 'toolResult', toolCallId: 'program', isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/已保存的脚本子调用.*unknown.*notes\.txt/s) }],
    }))
  }
})

it.each([false, true])('16/17 keeps MCP discovery local and rechecks availability, disabled %s', async disable => {
  const remote = fakeMcp()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const fixture = await setup(`
    const [{name}] = await searchTools("lookup ticket", {limit:1});
    const description = await describeTool(name);
    if (!description.inputSchema.required.includes("id")) throw Error("expected id parameter");
    await tools.wait_for_catalog({});
    try { return await tools[name]({id:"T-42"}); } catch (error) { return error.message; }
  `, { session: { mcp: remote.source }, added: [gate('wait_for_catalog', async () => {
    entered.resolve(); await release.promise; return 'ready'
  })] })
  await fixture.start()
  await entered.promise
  if (disable) remote.disable()
  release.resolve()
  const history = await fixture.idle()
  expect(history.nestedToolCalls?.at(-1)).toMatchObject({
    name: remote.binding.name, status: disable ? 'not-executed' : 'succeeded',
    resultPreview: expect.stringContaining(disable ? '当前不可用' : 'Ticket T-42'),
  })
  expect(remote.sent.mock.calls).toEqual(disable ? [] : [[{ id: 'T-42' }]])
  expect(fixture.requests.every(request => !request.tools?.some(tool => tool.name === remote.binding.name))).toBe(true)
  expect(fixture.store.listMcpToolLoads(fixture.summary.id)).toEqual([])
})

it('limits active sandbox workers, counts queue time, and reuses slots after stopping', async () => {
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const active = await Promise.all(entered.map(event => setup('await tools.hold({});', {
    added: [gate('hold', (_args, context) => { event.resolve(); return waitForAbort(context) })],
  })))
  await Promise.all(active.map(item => item.start()))
  await Promise.all(entered.map(item => item.promise))
  try {
    const queued = await setup('return "must not start";', { timeoutMs: 120 })
    await queued.start()
    await queued.idle()
    expect(queued.requests[1]?.messages.at(-1)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('超时') }] })
  } finally {
    await Promise.all(active.map(item => item.session.abort(item.session.activeRunId!)))
  }
  const reused = await setup('return "slot reused";', { timeoutMs: 1000 })
  await reused.start()
  await reused.idle()
  expect(reused.requests[1]?.messages.at(-1)).toMatchObject({ isError: false, content: [{ text: 'slot reused' }] })
})

it('records every checkpoint during a burst of concurrent calls', async () => {
  const fixture = await setup('return (await Promise.all(Array.from({length:40}, () => tools.ls({})))).length;')
  const writes: number[] = []
  const save = fixture.store.save.bind(fixture.store)
  vi.spyOn(fixture.store, 'save').mockImplementation((id, input) => {
    if (!input.nestedToolCall) return save(id, input)
    const started = performance.now()
    const result = save(id, input)
    writes.push(performance.now() - started)
    return result
  })
  await fixture.start()
  const history = await fixture.idle()
  expect(history.nestedToolCalls?.filter(call => call.status === 'succeeded')).toHaveLength(40)
  expect(writes).toHaveLength(80)
  expect(fixture.requests[1]?.messages.at(-1)).toMatchObject({ isError: false, content: [{ text: '40' }] })
  console.info(`Code Mode SQLite: ${writes.length} checkpoints, ${writes.reduce((sum, ms) => sum + ms, 0).toFixed(1)} ms total`)
})

it('a sequential binding waits for earlier calls and gates later calls', async () => {
  const steps: string[] = []
  const first = Promise.withResolvers<void>()
  const fixture = await setup(`
    await Promise.all([tools.earlier({}), tools.in_order({}), tools.later({})]);
  `, { added: [
    gate('earlier', async () => { steps.push('earlier started'); await first.promise; steps.push('earlier finished'); return '' }),
    { ...gate('in_order', async () => { steps.push('sequential'); return '' }), executionMode: 'sequential' },
    gate('later', async () => { steps.push('later'); return '' }),
  ] })
  await fixture.start()
  try {
    await vi.waitFor(() => expect(steps).toEqual(['earlier started']))
  } finally { first.resolve() }
  await fixture.idle()
  expect(steps).toEqual(['earlier started', 'earlier finished', 'sequential', 'later'])
})
