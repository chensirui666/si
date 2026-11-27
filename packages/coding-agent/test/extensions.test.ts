import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import type { AssistantMessage, ModelContext } from '@agent-learning/model'
import { SessionStore } from '../src/session-store.js'
import { AgentSession } from '../src/agent-session.js'
import type { ExtensionEvents } from '../src/extensions/runtime.js'
import { loadExtensions } from '../src/extensions/loader.js'
import { ExtensionRuntime, type ExtensionContext } from '../src/extensions/runtime.js'

vi.mock('node:fs/promises', { spy: true })

it('loads personal entries in discovery order, honors package order and ignores duplicates and failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'si-extensions-'))
  try {
    await mkdir(join(root, 'pack'))
    await writeFile(join(root, 'pack', 'package.json'), JSON.stringify({ pi: { extensions: ['b.ts', 'a.js'] } }))
    const module = (name: string) => `export default si => si.on('session_start', (_event, ctx) => ctx.ui.notify('${name}'))`
    await writeFile(join(root, 'pack', 'b.ts'), module('b'))
    await writeFile(join(root, 'pack', 'a.js'), module('a'))
    await writeFile(join(root, 'first.ts'), module('standalone'))
    await writeFile(join(root, 'pack', 'index.ts'), 'throw new Error("not selected")')
    await writeFile(join(root, 'bad.ts'), 'export default 1')
    await writeFile(join(root, '.ignore'), 'ignored.ts\n')
    await writeFile(join(root, 'ignored.ts'), 'throw new Error("ignored")')
    await symlink(join(root, 'pack', 'b.ts'), join(root, 'duplicate.ts'))
    const report = vi.fn()
    const children = await readdir(root, { withFileTypes: true })
    vi.mocked(readdir).mockImplementationOnce(() => Promise.resolve([
      children.find(entry => entry.name === 'pack')!,
      ...children.filter(entry => entry.name !== 'pack'),
    ]) as never)
    const loaded = await loadExtensions(root, report)
    expect(loaded.map(item => item.path.split('/').at(-1))).toEqual(['b.ts', 'a.js', 'first.ts'])
    const notify = vi.fn()
    const ctx: ExtensionContext = { sessionId: 'order', cwd: root, hasUI: true, ui: { notify } }
    const runtime = new ExtensionRuntime(loaded, report)
    await runtime.initialize(ctx, [])
    await runtime.emit('session_start', { reason: 'new' }, ctx)
    expect(notify.mock.calls).toEqual([['b'], ['a'], ['standalone']])
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0]?.[0]).toContain('bad.ts')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('isolates entry state and rolls back failed registrations', async () => {
  const seen: string[] = []
  const report = vi.fn()
  const entries: ConstructorParameters<typeof ExtensionRuntime>[0] = [
    { path: 'bad', entry: si => { si.on('input', () => { throw new Error('leaked') }); throw new Error('registration') } },
    { path: 'good', entry: si => {
      let count = 0
      si.on('input', (event, ctx) => { seen.push(ctx.sessionId + ':' + ++count); return { action: 'transform', text: event.text + count } })
    } },
  ]
  for (const id of ['a', 'b']) {
    const ctx: ExtensionContext = { sessionId: id, cwd: '/tmp', hasUI: false, ui: { notify() {} } }
    const runtime = new ExtensionRuntime(entries, report)
    await runtime.initialize(ctx, [])
    const result = await runtime.input('hi', ctx)
    expect(result).toEqual({ text: 'hi1', handled: false })
    expect(await runtime.input('hi', ctx)).toEqual({ text: 'hi2', handled: false })
  }
  expect(seen).toEqual(['a:1', 'a:2', 'b:1', 'b:2'])
  expect(report).toHaveBeenCalledTimes(2)
})

it('transforms and handles input, observes the loop, rewrites the actual call and continues before idle', async () => {
  const calls: string[] = []
  const seen: string[] = []
  const inputs: ModelContext[] = []
  let settled = false
  const checkpoints: unknown[] = []
  const deltas: unknown[] = []
  const report = vi.fn()
  const store = SessionStore.open(':memory:')
  const summary = { id: 'session', workspaceId: 'workspace', name: 'Session', createdAt: new Date().toISOString() }
  const events: (keyof ExtensionEvents)[] = ['session_start', 'agent_start', 'turn_start', 'message_start', 'message_update',
    'tool_execution_start', 'tool_execution_end', 'agent_end', 'agent_settled', 'session_shutdown']
  const session = new AgentSession({
    resolveDirectory: async () => '/tmp', skillHome: '/tmp', reportExtensionError: report,
    persistence: { store, summary, first: () => summary },
    tools: () => [{ name: 'edit', description: 'Edit', parameters: Type.Object({ path: Type.String() }),
      async execute(args) { calls.push(String(args.path)); return 'original result' } }],
    extensions: [{ path: 'test', entry(si) {
      for (const event of events) si.on(event, () => { seen.push(event) })
      si.on('message_update', ({ message, assistantMessageEvent }) => {
        if (assistantMessageEvent.type === 'text_delta') deltas.push([assistantMessageEvent.delta, message.content[0]])
      })
      si.on('input', ({ text }, ctx) => {
        if (text === 'ping') { ctx.ui.notify('pong'); return { action: 'handled' } }
        return { action: 'transform', text: 'transformed' }
      })
      si.on('before_agent_start', () => ({ systemPrompt: 'overridden', message: { content: 'initial extra', customType: 'test', display: false } }))
      si.on('context', event => {
        seen.push('context')
        event.messages.push({ role: 'user', content: 'only this request', timestamp: 0 })
      })
      si.on('context', event => { event.messages.splice(0); throw new Error('failed snapshot') })
      si.on('context', () => ({ messages: [{ role: 'user', content: 'x'.repeat(4_200_000), timestamp: 0 }] }))
      si.on('tool_call', event => { event.input.path = 'actual.txt' })
      si.on('tool_result', () => ({ content: [{ type: 'text', text: 'changed result' }], isError: true }))
      si.on('agent_before_settle', () => {
        checkpoints.push(store.loadSession(summary.id)?.messages.map(entry => entry.message))
        if (settled) return
        settled = true
        return { continue: true, entries: [{ type: 'custom_message', content: 'one more turn', customType: 'test', display: false }] }
      })
    } }],
    stream(model, context) {
      seen.push('request')
      inputs.push(context)
      const answer: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 0,
        stopReason: inputs.length === 1 ? 'toolUse' : 'stop',
        content: inputs.length === 1 ? [{ type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'original.txt' } }] : [{ type: 'text', text: 'done' }] }
      return { async result() { return answer }, async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: { ...answer, content: [] } }
        if (answer.stopReason === 'stop') {
          const partial = (text: string): AssistantMessage => ({ ...answer, stopReason: 'pending', content: [{ type: 'text', text }] })
          yield { type: 'text_start', partial: partial(''), contentIndex: 0 }
          yield { type: 'text_delta', partial: partial('do'), contentIndex: 0, delta: 'do' }
          yield { type: 'text_delta', partial: partial('done'), contentIndex: 0, delta: 'ne' }
        }
        yield { type: 'done', reason: answer.stopReason as 'stop' | 'toolUse', message: answer }
      } }
    },
  })
  const messages = session.subscribe(new AbortController().signal)
  await messages.next()
  expect(await session.submit({ clientMessageId: 'first', text: 'ping', modelId: 'deepseek-flash' }))
    .toEqual({ kind: 'handled', clientMessageId: 'first', notices: [{ message: 'pong', level: 'info' }] })
  expect(inputs).toHaveLength(0)
  expect(await session.submit({ clientMessageId: 'second', text: 'original', modelId: 'deepseek-flash' })).toMatchObject({ kind: 'message' })
  for await (const event of messages) {
    if (event.type === 'update' && event.update.change.type === 'task' && event.update.change.running === null) break
  }
  await session.close()
  const history = store.loadSession(summary.id)!
  store.close()
  expect(history.runs).toMatchObject([{ status: 'completed', text: 'original', finalText: 'transformed' }])
  expect(history.messages.find(entry => entry.message.role === 'toolResult')?.toolCall?.actualArguments).toEqual({ path: 'actual.txt' })
  expect(checkpoints).toHaveLength(2)
  expect(checkpoints[0]).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'toolResult', toolCallId: 'edit-1' }),
    expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
  ]))
  expect(report).toHaveBeenCalledTimes(6)
  expect(calls).toEqual(['actual.txt'])
  expect(inputs).toHaveLength(3)
  expect(inputs[0]).toMatchObject({ systemPrompt: 'overridden', messages: [
    { content: 'transformed' }, { content: 'initial extra' }, { content: 'only this request' },
  ] })
  expect(inputs[1].messages.find(message => message.role === 'toolResult')).toMatchObject({
    isError: true, toolCallId: 'edit-1', content: [{ text: 'changed result' }, { text: expect.stringContaining('actual.txt') }],
  })
  expect(inputs[2].messages.map(message => message.content)).toContain('one more turn')
  expect(deltas).toEqual([['do', { type: 'text', text: 'do' }], ['ne', { type: 'text', text: 'done' }],
    ['do', { type: 'text', text: 'do' }], ['ne', { type: 'text', text: 'done' }]])
  expect(seen.filter(name => name === 'message_start')).toHaveLength(5)
  expect(seen.filter(name => ['agent_start', 'turn_start', 'context', 'request', 'agent_end'].includes(name))).toEqual([
    'agent_start', 'turn_start', 'context', 'request', 'turn_start', 'context', 'request', 'agent_end',
    'agent_start', 'turn_start', 'context', 'request', 'agent_end',
  ])
  expect(seen.filter(name => name === 'agent_end')).toHaveLength(2)
  expect(seen.at(-2)).toBe('agent_settled')
  expect(seen.at(-1)).toBe('session_shutdown')
})

it.each(['permission', 'stop', 'throw', 'invalid', 'block'] as const)('preserves the result pair and skips edit on %s', async mode => {
  const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>()
  const execute = vi.fn(async () => 'executed')
  const observed: string[] = []
  const report = vi.fn()
  const afterGate = vi.fn(), rewrite = vi.fn()
  let final: ExtensionEvents['tool_execution_end'] | undefined
  let returnedToModel: ModelContext | undefined
  let settled: boolean | undefined
  const settling = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const agent = new AgentSession({
    resolveDirectory: async () => '/tmp', skillHome: '/tmp', reportExtensionError: report,
    tools: () => [{ name: 'edit', description: 'edit', parameters: Type.Object({ path: Type.String() }), execute }],
    extensions: [{ path: 'test-extension', entry(si) {
      si.on('tool_execution_start', event => { observed.push(event.toolCallId); expect(event.args).toEqual({ path: 'sample.txt' }) })
      si.on('tool_call', async (_event, ctx) => {
        observed.push('call')
        entered.resolve(ctx.signal!)
        await release.promise
        if (mode === 'throw') throw new Error('broken callback')
        if (mode === 'invalid') return { block: 1 as unknown as boolean }
        if (mode === 'block') return { block: true, reason: 'protected' }
      })
      si.on('tool_call', afterGate)
      si.on('tool_result', rewrite)
      si.on('tool_execution_end', event => { final = event; observed.push('end') })
      si.on('agent_before_settle', () => { observed.push('before_settle') })
      si.on('agent_settled', async event => {
        settled = event.aborted
        observed.push('settled')
        settling.resolve()
        if (mode === 'stop') await finish.promise
      })
      si.on('session_shutdown', () => { observed.push('shutdown') })
    } }],
    stream(model, context) {
      const tool = context.messages.at(-1)?.role === 'user'
      if (!tool) returnedToModel = context
      const answer: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 0,
        stopReason: tool ? 'toolUse' : 'stop',
        content: tool ? [{ type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'sample.txt' } }] : [{ type: 'text', text: 'done' }] }
      return { async result() { return answer }, async *[Symbol.asyncIterator]() {
        yield { type: 'done', reason: answer.stopReason as 'stop' | 'toolUse', message: answer }
      } }
    },
  })
  try {
    const subscription = agent.subscribe(new AbortController().signal)
    await subscription.next()
    const result = await agent.submit({ clientMessageId: 'start', text: 'edit', modelId: 'deepseek-flash' })
    if (result.kind !== 'message') throw new Error('expected message')
    const signal = await entered.promise
    let stopped = false
    let stop: Promise<unknown> | undefined
    if (mode === 'permission') agent.selectPermissionMode('read-only')
    if (mode === 'stop') {
      stop = agent.abort(result.userMessageId).then(() => { stopped = true })
      expect(signal.aborted).toBe(true)
      await Promise.resolve()
      expect(stopped).toBe(false)
    }
    release.resolve()
    let repeated: Promise<boolean> | undefined
    if (mode === 'stop') {
      await settling.promise
      let returned = false
      repeated = agent.abort(result.userMessageId).then(done => { returned = true; return done })
      await Promise.resolve()
      expect(returned).toBe(false)
      finish.resolve()
    }
    for await (const event of subscription) {
      if (event.type === 'update' && event.update.change.type === 'task' && event.update.change.running === null) break
    }
    await stop
    if (repeated) expect(await repeated).toBe(true)
    expect(stopped).toBe(mode === 'stop')
    expect(settled).toBe(mode === 'stop')
    expect(observed.slice(0, 3)).toEqual(['edit-1', 'call', 'end'])
    expect(observed.includes('before_settle')).toBe(mode !== 'stop')
    expect(observed.at(-1)).toBe('settled')
    expect(execute).not.toHaveBeenCalled()
    expect(rewrite).not.toHaveBeenCalled()
    expect(afterGate).toHaveBeenCalledTimes(mode === 'permission' ? 1 : 0)
    expect(final).toMatchObject({ toolCallId: 'edit-1', toolName: 'edit', isError: true })
    if (mode !== 'stop') expect(returnedToModel?.messages.at(-1)).toEqual(final!.result)
    if (mode === 'block') expect(final!.result.content).toEqual([{ type: 'text', text: 'protected' }])
    if (mode === 'throw' || mode === 'invalid') expect(report).toHaveBeenCalledWith(
      expect.stringMatching(/test-extension tool_call 会话 .* 任务 .* 工具调用 edit-1/), expect.any(Error))
  } finally {
    release.resolve()
    finish.resolve()
    await agent.close()
  }
  expect(observed.at(-1)).toBe('shutdown')
})

it('registers a tool for the next round and preserves the original tool on collision', async () => {
  const declarations: string[][] = [], execute = vi.fn(async args => 'actual:' + args.note)
  const observed: string[] = []
  const runtime = new AgentSession({
    resolveDirectory: async () => '/tmp', skillHome: '/tmp',
    tools: () => [{ name: 'read', description: 'read', parameters: Type.Object({}), async execute() { return 'base' } }],
    extensions: [{ path: 'tools', entry(si) {
      si.on('tool_result', event => {
        if (event.toolName !== 'read') return
        const next = { name: 'custom', description: 'custom', parameters: Type.Object({ note: Type.String() }), execute }
        expect(() => si.registerTool({ ...next, name: 'read' })).toThrow('工具名已被使用')
        si.registerTool(next)
      })
      si.on('tool_execution_end', event => {
        if (event.toolName === 'custom') observed.push(event.result.toolCallId, ...event.result.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      })
    } }],
    stream(model, context) {
      declarations.push(context.tools?.map(item => item.name) ?? [])
      const name = declarations.length === 1 ? 'read' : declarations.length === 2 ? 'custom' : undefined
      const answer: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 0,
        stopReason: name ? 'toolUse' : 'stop', content: name
          ? [{ type: 'toolCall', id: name + '-id', name, arguments: name === 'custom' ? { note: 'next' } : {} }]
          : [{ type: 'text', text: 'done' }] }
      return { async result() { return answer }, async *[Symbol.asyncIterator]() {
        yield { type: 'done', reason: answer.stopReason as 'stop' | 'toolUse', message: answer }
      } }
    },
  })
  const events = runtime.subscribe(new AbortController().signal)
  await events.next()
  await runtime.submit({ clientMessageId: 'start', text: 'test', modelId: 'deepseek-flash' })
  for await (const event of events) {
    if (event.type === 'update' && event.update.change.type === 'task' && event.update.change.running === null) break
  }
  await runtime.close()
  expect(declarations).toEqual([['read', 'codemode'], ['read', 'codemode', 'custom'], ['read', 'codemode', 'custom']])
  expect(execute).toHaveBeenCalledWith({ note: 'next' }, expect.any(Object))
  expect(observed).toEqual(['custom-id', 'actual:next'])
})

it('observes saved model and reasoning changes exactly once', async () => {
  const store = SessionStore.open(':memory:')
  const summary = { id: 'session', workspaceId: 'workspace', name: 'Session', createdAt: new Date().toISOString() }
  store.save(summary.id, { summary })
  const modelChanged = vi.fn(), levelChanged = vi.fn()
  const agent = new AgentSession({
    resolveDirectory: async () => '/tmp', persistence: { store, summary },
    extensions: [{ path: 'test', entry(si) {
      si.on('model_select', (event, ctx) => { modelChanged(event, ctx.model?.id, store.loadSession(summary.id)?.modelSelection) })
      si.on('thinking_level_select', event => { levelChanged(event, store.loadSession(summary.id)?.modelSelection) })
    } }],
  })
  try {
    const initial = { provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'high' as const }
    const next = { ...initial, modelId: 'deepseek-v4-pro' }
    const differentLevel = { ...next, reasoningEffort: 'off' as const }
    await agent.selectModel(initial)
    modelChanged.mockClear()
    levelChanged.mockClear()
    await agent.selectModel(next)
    await agent.selectModel(next)
    await agent.selectModel(differentLevel)
    await agent.selectModel(differentLevel)
    expect(modelChanged).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      source: 'set', previousModel: expect.objectContaining({ id: 'deepseek-flash' }),
      model: expect.objectContaining({ id: 'deepseek-v4-pro' }),
    }), 'deepseek-v4-pro', next)
    expect(levelChanged).toHaveBeenCalledExactlyOnceWith({ type: 'thinking_level_select', previousLevel: 'high', level: 'off' }, differentLevel)
  } finally {
    await agent.close()
    store.close()
  }
})

it('rejects an unconfirmed submission if the selection changes during input', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const stream = vi.fn(() => { throw new Error('unexpected request') })
  const initial = { provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'high' as const }
  const agent = new AgentSession({
    resolveDirectory: async () => '/tmp', skillHome: '/tmp', stream,
    extensions: [{ path: 'test', entry(si) {
      si.on('input', async () => { entered.resolve(); await release.promise })
    } }],
  })
  try {
    await agent.selectModel(initial)
    const submission = agent.submit({ ...initial, text: 'original', clientMessageId: 'id' })
    await entered.promise
    await agent.selectModel({ ...initial, modelId: 'deepseek-v4-pro' })
    release.resolve()
    await expect(submission).rejects.toMatchObject({ code: 'model_selection_changed' })
    expect(stream).not.toHaveBeenCalled()
  } finally {
    release.resolve()
    await agent.close()
  }
})
