import { expect, it } from 'vitest'
import { Type } from 'typebox'
import { AgentSession } from '../src/agent-session.js'
import { SessionStore } from '../src/session-store.js'
import type { AssistantMessage, ModelContext, ModelEvent } from '@agent-learning/model'

function preparedRun(text: string) {
  const store = SessionStore.open(':memory:')
  const summary = { id: 'session', workspaceId: 'workspace', name: '测试', createdAt: new Date().toISOString() }
  store.save(summary.id, { summary })
  const plan = store.schedules.create({
    id: 'plan', sessionId: summary.id, creationRunId: 'create-run', workspaceId: summary.workspaceId,
    prompt: text, schedule: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Shanghai',
    sessionMode: 'reuse', status: 'enabled', nextRunAt: 100,
  })
  const claim = store.schedules.claim(plan, 200, 100)!
  const selection = { modelId: 'deepseek-flash', provider: 'deepseek', reasoningEffort: 'high' } as const
  const submission = { ...claim.submission!, modelSelection: selection, permissionMode: 'normal' } as const
  expect(store.schedules.prepare(claim.id, submission)).toBe(true)
  return { store, summary, plan, claim, submission, input: { ...selection, clientMessageId: claim.id, text } }
}

it('accepts the frozen scheduled instruction once and denies injected schedule management calls', async () => {
  const { store, summary, plan, claim, submission, input } = preparedRun('/compact')

  let manage = 0
  const contexts: ModelContext[] = []
  const session = new AgentSession({
    resolveDirectory: async () => process.cwd(), persistence: { store, summary },
    tools: () => [{ name: 'read', description: '读取', parameters: Type.Object({}), execute: () => '未调用' }],
    manageSchedule: () => { manage++; return {} },
    stream: (_model, context) => {
      contexts.push(context)
      const message: AssistantMessage = {
        role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1,
        ...(contexts.length === 1
          ? { stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'cronjob_manage', id: 'forged', arguments: { action: 'delete' } }] }
          : { stopReason: 'stop', content: [{ type: 'text', text: '完成' }] }),
      }
      const event: ModelEvent = { type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message }
      return { result: async () => message, async *[Symbol.asyncIterator]() { yield event } }
    },
  })
  try {
    const shutdown = new AbortController()
    const receipt = await session.submitScheduled(input, shutdown.signal)
    shutdown.abort()
    expect(receipt.kind).toBe('message')
    expect(store.schedules.runs(plan.id)[0]).toMatchObject({
      id: claim.id, status: 'accepted', sessionId: summary.id, submission,
    })
    await expect(session.submitScheduled(input)).resolves.toEqual(receipt)
    await expect(session.submit(input)).rejects.toMatchObject({ code: 'busy' })
    await expect.poll(() => contexts.length).toBe(2)
    await expect.poll(() => store.schedules.runs(plan.id)[0]?.runStatus).toBe('completed')
    expect(contexts[0]?.tools?.some(tool => tool.name === 'cronjob_manage') ?? false).toBe(false)
    expect(contexts[1]?.messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'forged', isError: true })
    expect(manage).toBe(0)
  } finally {
    await session.close()
    store.close()
  }
})

it.each(['session_start', 'before_agent_start'] as const)('stopping the scheduler aborts %s before saving the scheduled message', async hook => {
  const { store, summary, plan, claim, input } = preparedRun('汇总项目变化')
  const shutdown = new AbortController()
  let hookSignal: AbortSignal | undefined
  let modelCalls = 0
  const session = new AgentSession({
    resolveDirectory: async () => process.cwd(), persistence: { store, summary },
    stream: () => { modelCalls++; throw new Error('模型不应调用') },
    extensions: [{ path: 'test', entry(api) {
      api.on(hook, async (_event, { signal }) => {
        hookSignal = signal
        if (signal && !signal.aborted) {
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        }
      })
    } }],
  })
  const accepting = session.submitScheduled(input, shutdown.signal)
  void accepting.catch(() => undefined)
  try {
    await expect.poll(() => Boolean(hookSignal)).toBe(true)
    shutdown.abort()
    await expect.poll(() => hookSignal?.aborted).toBe(true)
    await expect(accepting).rejects.toMatchObject({ code: 'closed' })
    expect(store.loadSession(summary.id)?.messages).toEqual([])
    expect(store.schedules.runs(plan.id)[0]).toMatchObject({ id: claim.id, status: 'submitting' })
    expect(modelCalls).toBe(0)
  } finally {
    await session.close()
    store.close()
  }
})
