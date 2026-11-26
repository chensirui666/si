import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionStore, type StoredRun } from '../src/session-store.js'
import type { SessionSummary } from '../src/sessions.js'
import type { Delegation } from '../src/subagent-types.js'
import type { ConversationMessage } from '../src/types.js'

const summary: SessionSummary = { id: 'parent', workspaceId: 'workspace', name: '主会话', createdAt: '2026-11-26T00:00:00Z' }

function startRun(sessionId: string, id: string, text: string) {
  const run: StoredRun = {
    id, sessionId, clientMessageId: `send-${id}`, modelId: 'deepseek-flash', text,
    kind: 'task', status: 'running', startedAt: 1, acceptedSeq: 1,
  }
  const user: ConversationMessage = { id, clientMessageId: run.clientMessageId, message: { role: 'user', content: text, timestamp: 1 } }
  return { run, messages: [user] }
}

function caller(store: SessionStore, root = summary, callIds = ['delegate']) {
  const first = startRun(root.id, 'parent-run', '委派')
  const assistant: ConversationMessage = {
    id: 'assistant', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
      timestamp: 2, stopReason: 'toolUse', content: callIds.map(id => ({ type: 'toolCall', id, name: 'subagent', arguments: {} })) },
  }
  store.save(root.id, { summary: root, run: first.run, messages: [...first.messages, assistant] })
}

function delegation(id = 'delegate', contentIndex = 0, root = summary.id): Delegation {
  return {
    id, callerSessionId: root, rootSessionId: root, background: true, mode: 'parallel',
    call: { assistantMessageId: 'assistant', runId: 'parent-run', contentIndex, toolCallId: id },
    items: [{ status: 'not-started', name: 'reviewer' }, { status: 'not-started' }, { status: 'not-started' }],
  }
}

function child(id: string): SessionSummary {
  return {
    ...summary, id, name: '子会话',
    subagent: { parentSessionId: summary.id, cwd: '/work/child', allowedTools: ['read'],
      role: { name: 'reviewer', source: 'project', workspaceId: summary.workspaceId, systemPrompt: 'Review changes.', tools: ['read'] } },
  }
}

it('rolls back a child first acceptance when its delegation item cannot be linked', () => {
  const store = SessionStore.open(':memory:')
  try {
    caller(store)
    store.createDelegation(delegation())
    const agent = child('child-a')
    const first = startRun(agent.id, 'child-run', '检查测试')
    const item = { status: 'running', sessionId: agent.id, runId: first.run.id } as const
    expect(() => store.save(agent.id, { summary: agent, ...first, delegatedItem: { id: 'delegate', index: 9, item } })).toThrow(/未保存/)
    expect(store.loadSession(agent.id)).toBeUndefined()
    expect(store.listDelegations(summary.id)[0]?.items[0]).toEqual({ status: 'not-started', name: 'reviewer' })
    store.save(agent.id, { summary: agent, ...first, delegatedItem: { id: 'delegate', index: 0, item } })
    expect(store.listSessions()).toEqual([summary])
    expect(store.listSubagents(summary.id)).toEqual([agent])
    expect(store.loadSession(agent.id)?.summary).toEqual(agent)
    expect(store.readReferenceSource(agent.id)).toBeUndefined()
    expect(store.readSubagentRun(agent.id)).toEqual(first.run)
    expect(store.readSubagentRun(agent.id, first.run.id)).toEqual(first.run)
    expect(store.readSubagentRun(agent.id, 'missing')).toBeUndefined()
    expect(store.listDelegations(summary.id)[0]?.items[0]).toEqual({ ...item, name: 'reviewer' })

    expect(() => store.createDelegation({ ...delegation('wrong-tool-id', 0) })).toThrow(/未保存/)
    expect(() => store.save(agent.id, { run: { ...first.run, status: 'completed' },
      delegatedItem: { id: 'delegate', index: 0, item: { status: 'completed', runId: 'missing', output: '已完成' } } })).toThrow(/未保存/)
    expect(store.loadSession(agent.id)?.runs[0]?.status).toBe('running')
    expect(store.listDelegations(summary.id)[0]?.items[0]?.status).toBe('running')
  } finally { store.close() }
})

it('recovers completed, interrupted and not-started items with the original pending report ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-delegation-'))
  const path = join(directory, 'sessions.sqlite')
  let store: SessionStore | undefined
  try {
    store = SessionStore.open(path)
    caller(store)
    const work = delegation()
    store.createDelegation(work)
    for (const [index, agent] of [child('finished-child'), child('interrupted-child')].entries()) {
      const first = startRun(agent.id, `run-${index}`, `任务 ${index}`)
      store.save(agent.id, { summary: agent, ...first, delegatedItem: { id: work.id, index,
        item: { status: 'running', sessionId: agent.id, runId: first.run.id } } })
      if (index === 0) {
        store.save(agent.id, { run: { ...first.run, status: 'completed', finishedAt: 3 },
          delegatedItem: { id: work.id, index, item: { status: 'completed', output: '发现登录缺少测试' } } })
      }
    }
    store.close()
    store = undefined
    store = SessionStore.open(path)
    expect(store.listSubagents(summary.id).map(agent => agent.id)).toEqual(['finished-child', 'interrupted-child'])
    const [restored] = store.recoverDelegations()
    expect(restored).toMatchObject({ id: work.id, finished: true, report: 'pending', call: work.call, items: [
      { sessionId: 'finished-child', runId: 'run-0', status: 'completed', output: '发现登录缺少测试' },
      { sessionId: 'interrupted-child', runId: 'run-1', status: 'interrupted' },
      { status: 'not-started' },
    ] })
    expect(store.loadSession('finished-child')?.runs[0]?.status).toBe('completed')
    expect(store.setDelegationReport(work.id, 'delivered')).toBe(true)
    expect(store.setDelegationReport(work.id, 'delivered')).toBe(false)
    expect(store.recoverDelegations()).toEqual([])
    expect(store.listDelegations(summary.id)[0]?.report).toBe('delivered')
  } finally {
    store?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('suppresses pending and in-flight reports only for the stopped conversation', () => {
  const store = SessionStore.open(':memory:')
  try {
    caller(store, summary, ['pending', 'in-flight', 'delivered'])
    const other = { ...summary, id: 'other' }
    caller(store, other, ['other'])
    for (const work of [delegation('pending'), delegation('in-flight', 1), delegation('delivered', 2), delegation('other', 0, other.id)]) {
      store.createDelegation(work)
      if (work.id !== 'in-flight') expect(store.finishDelegation(work.id).report).toBe('pending')
    }
    store.setDelegationReport('delivered', 'delivered')
    store.suppressDelegationReports(summary.id)
    expect(store.finishDelegation('in-flight').report).toBe('suppressed')
    expect(store.recoverDelegations().map(work => work.id)).toEqual(['other'])
    expect(store.listDelegations(summary.id).map(work => work.report)).toEqual(['suppressed', 'suppressed', 'delivered'])
  } finally { store.close() }
})

it('rebuilds a single-task report when the run finished before the delegation was finalized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-delegation-single-'))
  const path = join(directory, 'sessions.sqlite')
  let store: SessionStore | undefined
  try {
    store = SessionStore.open(path)
    caller(store)
    const work = { ...delegation(), mode: 'single' as const, items: [{ status: 'not-started' as const }] }
    store.createDelegation(work)
    const agent = child('finished-child')
    const first = startRun(agent.id, 'child-run', '检查登录')
    store.save(agent.id, { summary: agent, ...first, delegatedItem: { id: work.id, index: 0,
      item: { status: 'running', sessionId: agent.id, runId: first.run.id } } })
    store.save(agent.id, { run: { ...first.run, status: 'completed', finishedAt: 3 },
      delegatedItem: { id: work.id, index: 0, item: { status: 'completed', output: '找到两个测试' } } })
    expect(store.listDelegations(summary.id)[0]?.report).toBeUndefined()
    store.close()
    store = undefined
    store = SessionStore.open(path)
    expect(store.recoverDelegations()).toEqual([{
      ...work, finished: true, report: 'pending',
      items: [{ status: 'completed', sessionId: agent.id, runId: first.run.id, output: '找到两个测试' }],
    }])
  } finally {
    store?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
