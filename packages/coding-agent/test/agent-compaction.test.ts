import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { AgentSession } from '../src/agent-session.js'
import type { ExecutableTool } from '@agent-learning/agent'
import type { ConversationSnapshot } from '../src/types.js'
import { createTools } from '../src/tools.js'
import { ToolRuntime } from '../src/tool-runtime.js'
import type { AssistantMessage, ModelContext, ModelEventStream } from '@agent-learning/model'

const tool: ExecutableTool = { name: 'read', description: '读取', parameters: Type.Object({}), execute: async () => '实际结果' }
const directory = '/tmp/project'
const input = { clientMessageId: 'draft', modelId: 'deepseek-flash', text: 'u'.repeat(1600) }
function createSession({ tools, ...options }: Omit<ConstructorParameters<typeof AgentSession>[0], 'resolveDirectory' | 'tools'>
  & { tools?: ExecutableTool[] }) {
  return new AgentSession({ ...options, resolveDirectory: async () => directory, tools: () => tools ?? [] })
}
const reply = (text = 'a'.repeat(1600), extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1,
  content: [{ type: 'text', text }], stopReason: 'stop', ...extra,
})
function output(message: AssistantMessage): ModelEventStream {
  return { result: async () => message, async *[Symbol.asyncIterator]() {
    if (message.stopReason === 'error' || message.stopReason === 'aborted') yield { type: 'error', reason: message.stopReason, error: message }
    else yield { type: 'done', reason: message.stopReason as 'stop', message }
  } }
}
async function state(agent: AgentSession): Promise<ConversationSnapshot> {
  const controller = new AbortController(), subscription = agent.subscribe(controller.signal)
  const event = (await subscription.next()).value
  controller.abort()
  if (event?.type !== 'snapshot') throw new Error('missing snapshot')
  return event.snapshot
}
async function idle(agent: AgentSession) {
  for (let i = 0; i < 100; i++) { if (!(await state(agent)).running) return; await new Promise(resolve => setImmediate(resolve)) }
  throw new Error('still running')
}
function setup(summary = reply('目标：继续任务；事实：项目青禾。', { usage: { input: 900, output: 30 } }), triggerTokens = 5000) {
  const contexts: ModelContext[] = []
  const agent = createSession({ compaction: { triggerTokens, keepRecentTokens: 100 }, tools: [tool], stream: (_model, context) => {
    contexts.push(structuredClone(context))
    return output(context.tools ? reply() : summary)
  } })
  return { agent, contexts }
}
async function seed(agent: AgentSession) {
  await agent.submit(input); await idle(agent)
  await agent.submit({ ...input, clientMessageId: 'draft2' }); await idle(agent)
}

describe('AgentSession compaction', () => {
  it('manual command has its own receipt, preserves raw history and system/tools, and reuses the summary', async () => {
    const { agent, contexts } = setup()
    await seed(agent)
    const before = await state(agent), normal = contexts[0]
    const receipt = await agent.submit({ ...input, text: ' /compact ' })
    expect(receipt.kind).toBe('compaction')
    if (receipt.kind !== 'compaction') throw new Error('not a compaction')
    await idle(agent)
    const after = await state(agent)
    expect(after.messages).toEqual(before.messages)
    expect(after.compactions).toHaveLength(1)
    expect(after.compactions[0]).toMatchObject({ id: receipt.compactionId, trigger: 'manual', status: 'success', summaryUsage: { input: 900 } })
    const record = after.compactions[0]
    if (record.status !== 'success') throw new Error('not successful')
    expect(record.estimatedAfter).toBeLessThan(record.estimatedBefore)
    expect(after.contextUsage!.tokens!).toBeLessThan(before.contextUsage!.tokens!)
    await agent.submit({ ...input, text: '继续' }); await idle(agent)
    expect(contexts.at(-1)!.systemPrompt).toBe(normal.systemPrompt)
    expect(contexts.at(-1)!.tools).toEqual(normal.tools)
    expect(JSON.stringify(contexts.at(-1)!.messages)).toContain('项目青禾')
    expect(JSON.stringify(contexts.at(-1)!.messages)).not.toContain('u'.repeat(1600))
  })

  it('compressing A leaves B’s history, context statistics and later model input independent', async () => {
    const { agent: a, contexts: aContexts } = setup()
    const bContexts: ModelContext[] = []
    const b = createSession({ tools: [tool], stream: (_model, context) => {
      bContexts.push(context)
      return output(reply('白榆', { usage: { input: 91 } }))
    } })
    await seed(a)
    await b.submit({ ...input, text: '请记住项目白榆' }); await idle(b)
    const beforeB = await state(b)
    const beforeA = await state(a)
    await a.submit({ ...input, text: '/compact' }); await idle(a)
    expect(await state(b)).toEqual(beforeB)
    expect(await state(a)).toMatchObject({ messages: beforeA.messages, compactions: [{ status: 'success' }] })
    await a.submit({ ...input, text: '继续' }); await idle(a)
    await b.submit({ ...input, text: '我的项目是？' }); await idle(b)
    expect(JSON.stringify(aContexts.at(-1)!.messages)).toContain('项目青禾')
    expect(JSON.stringify(bContexts.at(-1)!.messages)).toContain('项目白榆')
    expect(JSON.stringify(bContexts.at(-1)!.messages)).not.toContain('项目青禾')
  })

  it('keeps a real write in the session and its next summary when stopped after the write', async () => {
    const project = await mkdtemp(join(tmpdir(), 'agent-session-write-'))
    const runtime = new ToolRuntime()
    const written = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let runId: string
    let stopped: Promise<boolean> | undefined
    const path = join(project, 'note.txt')
    const agent = new AgentSession({
      resolveDirectory: async () => project,
      compaction: { triggerTokens: 10000, keepRecentTokens: 100 },
      tools: cwd => {
        const write = createTools(runtime, { web_search: async () => '', web_fetch: async () => '' }, cwd).find(tool => tool.name === 'write')!
        return [{
          ...write,
          async execute(args, context) {
            try {
              return await write.execute(args, {
                ...context,
                recordDetails(detail) {
                  context.recordDetails(detail)
                  stopped = agent.abort(runId)
                  written.resolve()
                },
              })
            } finally { await release.promise }
          },
        }]
      },
      stream: (_model, context) => {
        if (!context.tools) return output(reply('写入 note.txt 已完成。'))
        if (context.messages.at(-1)?.content !== '写入 note.txt') return output(reply())
        return output(reply('', { stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'write-note', name: 'write', arguments: { path: 'note.txt', content: '已保存' } },
        ] }))
      },
    })
    try {
      const receipt = await agent.submit({ ...input, text: '写入 note.txt' })
      if (receipt.kind !== 'message') throw new Error('wrong receipt')
      runId = receipt.userMessageId
      await written.promise
      expect(await readFile(path, 'utf8')).toBe('已保存')
      expect((await state(agent)).running?.runId).toBe(runId)
      release.resolve()
      expect(await stopped).toBe(true)
      expect((await state(agent)).messages.find(entry => entry.message.role === 'toolResult')).toMatchObject({
        toolErrorCode: 'interrupted', fileOperation: { kind: 'modified', path }, message: { toolCallId: 'write-note', isError: true },
      })
      await seed(agent)
      await agent.submit({ ...input, text: '/compact' }); await idle(agent)
      expect((await state(agent)).compactions.at(-1)).toMatchObject({
        status: 'success', fileOperations: { readFiles: [], modifiedFiles: [path] },
      })
    } finally {
      release.resolve()
      await agent.close()
      await runtime.close()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('keeps confirmed file operations across compactions even when a completed write reports interruption', async () => {
    const contexts: ModelContext[] = []
    const call = (name: string, path: string, id = `${name}-${path}`) => ({ type: 'toolCall' as const, id, name, arguments: { path } })
    const tools: ExecutableTool[] = ['read', 'write', 'edit', 'bash'].map(name => ({
      ...tool, name, async execute({ path }, { recordDetails }) {
        if (path === 'missing.ts') throw new Error('文件不存在')
        if (name !== 'bash') recordDetails({
          kind: name === 'read' ? 'read' : 'modified', path: `${directory}/${path === './guide.ts' ? 'guide.ts' : path}`,
        })
        if (name === 'write') throw Object.assign(new Error('写完后取消'), { code: 'interrupted' })
        return ''
      },
    }))
    const agent = createSession({ tools, compaction: { triggerTokens: 10_000, keepRecentTokens: 100 }, stream: (_model, context) => {
      contexts.push(structuredClone(context))
      if (!context.tools) return output(reply('继续未完成的工作。'))
      const last = context.messages.at(-1)
      if (last?.role === 'user' && last.content === input.text) return output(reply('', {
        stopReason: 'toolUse', content: [call('read', 'guide.ts'), call('read', './guide.ts'), call('read', 'changed.ts'),
          call('read', 'missing.ts'), call('write', 'changed.ts'), call('bash', 'shell.ts')],
      }))
      if (last?.role === 'user' && last.content === '继续检查') return output(reply('', {
        stopReason: 'toolUse', content: [call('edit', 'guide.ts'), call('read', 'later.ts')],
      }))
      return output(reply())
    } })
    await agent.submit(input); await idle(agent)
    const recorded = (await state(agent)).messages.filter(entry => entry.message.role === 'toolResult')
    expect(recorded.find(entry => entry.message.role === 'toolResult' && entry.message.toolName === 'write')).toMatchObject({
      toolErrorCode: 'interrupted', message: { isError: true }, fileOperation: { kind: 'modified', path: '/tmp/project/changed.ts' },
    })
    await agent.submit({ ...input, text: '/compact' }); await idle(agent)
    expect((await state(agent)).compactions[0]).toMatchObject({
      status: 'success', summary: '继续未完成的工作。',
      fileOperations: { readFiles: ['/tmp/project/guide.ts'], modifiedFiles: ['/tmp/project/changed.ts'] },
    })

    const resumed = contexts.length
    await agent.submit({ ...input, text: '继续检查' }); await idle(agent)
    expect(contexts[resumed].messages[0].content).toEqual(expect.stringContaining('/tmp/project/changed.ts'))
    await agent.submit({ ...input, text: '/compact' }); await idle(agent)
    const second = (await state(agent)).compactions[1]
    expect(second).toMatchObject({ status: 'success', fileOperations: {
      readFiles: ['/tmp/project/later.ts'], modifiedFiles: ['/tmp/project/changed.ts', '/tmp/project/guide.ts'],
    } })
    expect(JSON.stringify(contexts.at(-1)!.messages)).not.toContain('/tmp/project/changed.ts')

    await agent.submit({ ...input, text: '续做' }); await idle(agent)
    const summaryMessage = contexts.at(-1)!.messages[0].content
    for (const path of ['later.ts', 'changed.ts', 'guide.ts']) expect(summaryMessage).toEqual(expect.stringContaining(`/tmp/project/${path}`))
    for (const path of ['missing.ts', 'shell.ts']) expect(summaryMessage).not.toEqual(expect.stringContaining(path))
  })

  it('no candidate and repeated compact without new content skip without an extra model call', async () => {
    const { agent, contexts } = setup()
    await agent.submit({ ...input, text: '/compact' }); await idle(agent)
    expect(contexts).toHaveLength(0)
    expect((await state(agent)).compactions[0]).toMatchObject({ status: 'skipped' })
    await seed(agent)
    await agent.submit({ ...input, text: '/compact' }); await idle(agent)
    const calls = contexts.length
    await agent.submit({ ...input, text: '/compact' }); await idle(agent)
    expect(contexts).toHaveLength(calls)
    expect((await state(agent)).compactions.at(-1)).toMatchObject({ status: 'skipped' })
  })

  it.each([
    ['truncated', reply('半段', { stopReason: 'length' })],
    ['empty', reply('  ')],
    ['tool call', reply('摘要', { content: [{ type: 'toolCall', id: 'bad', name: 'read', arguments: {} }] })],
    ['not shorter', reply('s'.repeat(20000))],
    ['error', reply('', { stopReason: 'error', errorMessage: '安全错误' })],
  ] as const)('invalid summary (%s) never replaces effective context', async (_name, summary) => {
    const { agent, contexts } = setup(summary)
    await seed(agent)
    const before = (await state(agent)).messages
    await agent.submit({ ...input, text: '/compact' }); await idle(agent)
    expect((await state(agent)).messages).toEqual(before)
    expect((await state(agent)).compactions.at(-1)).toMatchObject({ status: 'failed' })
    await agent.submit({ ...input, text: '继续' }); await idle(agent)
    expect(JSON.stringify(contexts.at(-1)!.messages)).toContain('u'.repeat(1600))
  })

  it('automatic compression runs before the next request and failure may continue if it still fits', async () => {
    for (const fail of [false, true]) {
      const { agent, contexts } = setup(fail ? reply('', { stopReason: 'error' }) : undefined, 1700)
      await seed(agent)
      const count = contexts.length
      await agent.submit({ ...input, text: '继续' }); await idle(agent)
      expect(contexts.slice(count).map(context => Boolean(context.tools))).toEqual([false, true])
      expect((await state(agent)).compactions.at(-1)).toMatchObject({ trigger: 'auto', status: fail ? 'failed' : 'success' })
    }
  })

  it('abort waits for A’s summary cleanup and preserves A’s context while B keeps running', async () => {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let compress = false
    const agent = createSession({ tools: [tool], compaction: { triggerTokens: 5000, keepRecentTokens: 100 }, stream: (_m, context, options) => {
      if (!compress || context.tools) return output(reply())
      return { result: () => new Promise(() => {}), async *[Symbol.asyncIterator]() {
        started.resolve()
        if (!options!.signal!.aborted) await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }))
        try { yield { type: 'error', reason: 'aborted', error: reply('', { stopReason: 'aborted' }) } }
        finally { await release.promise }
      } }
    } })
    await seed(agent); compress = true
    const releaseB = Promise.withResolvers<void>()
    let signalB: AbortSignal | undefined
    const b = createSession({ stream: (_model, _context, options) => {
      signalB = options?.signal
      return { result: () => new Promise(() => {}), async *[Symbol.asyncIterator]() {
        await releaseB.promise
        yield { type: 'done', reason: 'stop', message: reply('白榆完成') }
      } }
    } })
    const receiptB = await b.submit({ ...input, text: '白榆' })
    if (receiptB.kind !== 'message') throw new Error('wrong receipt')
    const before = (await state(agent)).messages
    const receipt = await agent.submit({ ...input, text: '/compact' })
    if (receipt.kind !== 'compaction') throw new Error('wrong receipt')
    await started.promise
    await expect(agent.submit({ ...input, text: '/compact' })).rejects.toMatchObject({ code: 'busy' })
    expect(await agent.abort('old-run')).toBe(false)
    const stopping = agent.abort(receipt.compactionId)
    await new Promise(resolve => setImmediate(resolve))
    expect((await state(agent)).running).not.toBeNull()
    release.resolve(); expect(await stopping).toBe(true)
    expect((await state(agent)).messages).toEqual(before)
    expect((await state(agent)).compactions.at(-1)).toMatchObject({ status: 'aborted' })
    expect((await state(agent)).running).toBeNull()
    expect(signalB?.aborted).toBe(false)
    expect((await state(b)).running?.runId).toBe(receiptB.userMessageId)
    releaseB.resolve()
    await idle(b)
    expect((await state(b)).messages.at(-1)?.message).toMatchObject({ stopReason: 'stop', content: [{ text: '白榆完成' }] })
  })

  it('explicit overflow compresses and retries once; ordinary errors never recover', async () => {
    for (const overflow of [false, true]) {
      let mode: 'seed' | 'fail' = 'seed', calls = 0
      const agent = createSession({ tools: [tool], compaction: { triggerTokens: 5000, keepRecentTokens: 100 }, stream: (_m, context) => {
        if (mode === 'seed') return output(reply())
        calls++
        return output(context.tools ? reply('', { stopReason: 'error', ...(overflow && { errorCode: 'context_overflow' }) }) : reply('项目青禾'))
      } })
      await seed(agent); mode = 'fail'
      await agent.submit({ ...input, text: '继续' }); await idle(agent)
      expect(calls).toBe(overflow ? 3 : 1)
      expect((await state(agent)).compactions).toHaveLength(overflow ? 1 : 0)
    }
  })

  it('first reported followup input references the summary used, never summary usage or missing input', async () => {
    let usage: AssistantMessage['usage'] = undefined
    const agent = createSession({ tools: [tool], compaction: { triggerTokens: 5000, keepRecentTokens: 100 }, stream: (_m, context) => output(context.tools ? reply(undefined, { usage }) : reply('项目青禾', { usage: { input: 700 } })) })
    await seed(agent)
    await agent.submit({ ...input, text: '/compact' }); await idle(agent)
    await agent.submit({ ...input, text: '继续' }); await idle(agent)
    expect((await state(agent)).compactions[0]).not.toHaveProperty('followupMessageId')
    usage = { input: 450 }
    await agent.submit({ ...input, text: '继续2' }); await idle(agent)
    const snapshot = await state(agent), record = snapshot.compactions[0]
    if (record.status !== 'success') throw new Error('not successful')
    expect(snapshot.messages.find(entry => entry.id === record.followupMessageId)?.message).toMatchObject({ usage: { input: 450 } })
    const first = record.followupMessageId
    usage = { input: 900 }
    await agent.submit({ ...input, text: '继续3' }); await idle(agent)
    expect((await state(agent)).compactions[0]).toMatchObject({ followupMessageId: first })
    await agent.submit({ ...input, text: '/compact' }); await idle(agent)
    expect((await state(agent)).compactions[1]).toMatchObject({ status: 'success' })
    usage = { input: 200 }
    await agent.submit({ ...input, text: '继续第二份摘要' }); await idle(agent)
    const updated = await state(agent), second = updated.compactions[1]
    expect(updated.compactions[0]).toMatchObject({ followupMessageId: first })
    if (second.status !== 'success') throw new Error('not successful')
    expect(second.followupMessageId).not.toBe(first)
    expect(updated.messages.find(entry => entry.id === second.followupMessageId)?.message).toMatchObject({ usage: { input: 200 } })
  })

  it.each([
    { triggerTokens: 0, keepRecentTokens: 1 }, { triggerTokens: 10, keepRecentTokens: 10 },
    { triggerTokens: 10.5, keepRecentTokens: 1 }, { triggerTokens: 10, keepRecentTokens: -1 },
  ])('rejects invalid trusted budgets %o', budget => {
    expect(() => createSession({ compaction: budget })).toThrow()
  })

  it('waits for the entire tool batch before automatically compressing and never replays completed tools', async () => {
    const firstDone = Promise.withResolvers<void>(), secondStarted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let executions = 0, normalCalls = 0, summaries = 0
    const agent = createSession({ compaction: { triggerTokens: 800, keepRecentTokens: 100 }, tools: [{ ...tool, execute: async () => {
      executions++
      if (executions === 1) firstDone.resolve()
      else { secondStarted.resolve(); await release.promise }
      return '真实结果'.repeat(600)
    } }], stream: (_m, context) => {
      if (!context.tools) { summaries++; return output(reply('原任务：读取两份文件；均已完成。')) }
      normalCalls++
      return output(normalCalls === 1 ? reply('', { stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'one', name: 'read', arguments: {} }, { type: 'toolCall', id: 'two', name: 'read', arguments: {} },
      ] }) : reply('完成'))
    } })
    await agent.submit({ ...input, text: '原任务：读取两份文件。' })
    await Promise.all([firstDone.promise, secondStarted.promise])
    expect(summaries).toBe(0)
    expect(normalCalls).toBe(1)
    release.resolve(); await idle(agent)
    // The most recent call batch is indivisible and is kept whole; the older user request can be summarized.
    expect(executions).toBe(2)
    expect(normalCalls).toBe(2)
    expect(summaries).toBe(1)
    expect((await state(agent)).messages.filter(entry => entry.message.role === 'toolResult')).toHaveLength(2)
  })

  it('overflow with no candidate or failed summary ends the request without retry', async () => {
    for (const seedHistory of [false, true]) {
      let failing = false, normalCalls = 0, summaries = 0
      const agent = createSession({ tools: [tool], compaction: { triggerTokens: 5000, keepRecentTokens: 100 }, stream: (_m, context) => {
        if (!failing) return output(reply())
        if (!context.tools) { summaries++; return output(reply('', { stopReason: 'error' })) }
        normalCalls++; return output(reply('', { stopReason: 'error', errorCode: 'context_overflow' }))
      } })
      if (seedHistory) await seed(agent)
      failing = true
      await agent.submit({ ...input, text: '继续' }); await idle(agent)
      expect(normalCalls).toBe(1)
      expect(summaries).toBe(seedHistory ? 1 : 0)
      expect((await state(agent)).compactions.at(-1)).toMatchObject({ status: seedHistory ? 'failed' : 'skipped' })
    }
  })

  it('a successful recovered reply resets the one-retry allowance for the next tool round', async () => {
    let failing = false, normalCalls = 0, summaries = 0, executions = 0
    const normalInputs: ModelContext[] = []
    const agent = createSession({ tools: [{ ...tool, execute: async () => { executions++; return '实际完成'.repeat(200) } }], compaction: { triggerTokens: 10000, keepRecentTokens: 100 }, stream: (_m, context) => {
      if (!failing) return output(reply())
      if (!context.tools) { summaries++; return output(reply('项目青禾；继续完成任务。')) }
      normalCalls++
      normalInputs.push(context)
      if (normalCalls === 1 || normalCalls === 3) return output(reply('', { stopReason: 'error', errorCode: 'context_overflow' }))
      if (normalCalls === 2) return output(reply('', { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'real', name: 'read', arguments: {} }] }))
      return output(reply('完成'))
    } })
    await seed(agent); failing = true
    const controller = new AbortController()
    const events = agent.subscribe(controller.signal)
    await events.next()
    const receipt = await agent.submit({ ...input, text: '继续原任务' })
    if (receipt.kind !== 'message') throw new Error('wrong receipt')
    const phases: string[] = []
    for await (const event of events) {
      if (event.type !== 'update') continue
      const { change } = event.update
      if (change.type === 'model') continue
      if (!change.running) break
      expect(change.running.runId).toBe(receipt.userMessageId)
      phases.push(change.running.phase)
    }
    controller.abort()
    expect(phases).toContain('compaction')
    expect(phases.at(-1)).toBe('model')
    expect(normalInputs[3].messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'real', content: [{ text: '实际完成'.repeat(200) }] })
    expect(normalCalls).toBe(4)
    expect(summaries).toBe(2)
    expect(executions).toBe(1)
    expect((await state(agent)).compactions.filter(record => record.status === 'success')).toHaveLength(2)
  })

  it('a giant indivisible input stops before calling a provider', async () => {
    const { agent, contexts } = setup()
    await agent.submit({ ...input, text: 'x'.repeat(4_200_000) }); await idle(agent)
    expect(contexts).toHaveLength(0)
    expect((await state(agent)).compactions.at(-1)).toMatchObject({ status: 'skipped' })
    expect((await state(agent)).messages.at(-1)?.message).toMatchObject({ stopReason: 'error' })
  })

  it('reported input corrects the next capacity gate; compaction invalidates that old gate sample', async () => {
    let useActual = false, tasks = 0
    const agent = createSession({ tools: [tool], compaction: { triggerTokens: 5000, keepRecentTokens: 100 }, stream: (_m, context) => {
      if (!context.tools) return output(reply('项目青禾'))
      tasks++
      return output(reply(undefined, useActual ? { usage: { input: 983_000 } } : {}))
    } })
    await seed(agent); useActual = true
    await agent.submit({ ...input, text: '建立实际样本' }); await idle(agent)
    useActual = false
    await agent.submit({ ...input, text: '继续' }); await idle(agent)
    expect(tasks).toBe(4)
    expect((await state(agent)).compactions.at(-1)).toMatchObject({ status: 'success' })
    expect((await state(agent)).messages.at(-1)?.message).toMatchObject({ stopReason: 'stop' })
  })

  it('aborted summaries retain already reported provider usage without committing a candidate', async () => {
    let signal: AbortSignal | undefined, compressing = false
    const ready = Promise.withResolvers<void>(), terminal = Promise.withResolvers<void>()
    const agent = createSession({ tools: [tool], compaction: { triggerTokens: 5000, keepRecentTokens: 100 }, stream: (_m, context, options) => {
      if (!compressing || context.tools) return output(reply())
      signal = options!.signal
      return { result: () => new Promise(() => {}), async *[Symbol.asyncIterator]() {
        ready.resolve(); await terminal.promise
        yield { type: 'error', reason: 'aborted', error: reply('', { stopReason: 'aborted', usage: { input: 850, output: 5 } }) }
      } }
    } })
    await seed(agent); compressing = true
    const receipt = await agent.submit({ ...input, text: '/compact' })
    if (receipt.kind !== 'compaction') throw new Error('wrong receipt')
    await ready.promise
    const stopping = agent.abort(receipt.compactionId)
    expect(signal!.aborted).toBe(true)
    terminal.resolve(); await stopping
    expect((await state(agent)).compactions.at(-1)).toMatchObject({ status: 'aborted', summaryUsage: { input: 850, output: 5 } })
  })

  it.each([false, true])('an oversized retained message stops the task and preserves the original context (summary fails: %s)', async failure => {
    const { agent, contexts } = setup(failure ? reply('', { stopReason: 'error' }) : undefined)
    await seed(agent)
    const before = (await state(agent)).messages
    const count = contexts.length
    await agent.submit({ ...input, text: 'x'.repeat(4_000_000) }); await idle(agent)
    expect(contexts.slice(count).map(context => Boolean(context.tools))).toEqual([false])
    const snapshot = await state(agent)
    expect(snapshot.compactions.at(-1)).toMatchObject({ trigger: 'auto', status: 'failed' })
    expect(snapshot.messages.slice(0, before.length)).toEqual(before)
    expect(snapshot.messages.at(-1)?.message).toMatchObject({ stopReason: 'error' })
    expect(snapshot.compactions.filter(record => record.status === 'success')).toEqual([])
  })
})
