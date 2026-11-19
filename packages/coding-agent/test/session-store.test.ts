import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { AgentSession } from '../src/agent-session.js'
import { SessionStore } from '../src/session-store.js'
import { buildModelHistory } from '../src/compaction.js'
import type { ConversationMessage } from '../src/types.js'

const summary = { id: 'session', workspaceId: 'workspace', name: '会话 1', createdAt: new Date().toISOString() }
const run = {
  id: 'user', sessionId: summary.id, clientMessageId: 'send', modelId: 'deepseek-flash',
  text: '原文', kind: 'task', status: 'running', startedAt: 1, acceptedSeq: 1,
} as const
const user = { id: run.id, clientMessageId: run.clientMessageId, message: { role: 'user', content: run.text, timestamp: 1 } } as const

it('stores image reads as text and restores legacy image rows without replaying their bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-image-'))
  const path = join(directory, 'sessions.sqlite')
  let store: SessionStore | undefined = SessionStore.open(path)
  const assistant: ConversationMessage = {
    id: 'call', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
      timestamp: 2, stopReason: 'toolUse', content: [
        { type: 'toolCall', name: 'read', id: 'read-1', arguments: { path: 'shot.png' } },
        { type: 'toolCall', name: 'read', id: 'read-2', arguments: { path: 'note.txt' } },
      ] },
  }
  const note = { type: 'text', text: '已读取图片：/work/shot.png' } as const
  const image = { type: 'image', mimeType: 'image/png', data: 'AABBCCDD' } as const
  const result: ConversationMessage = {
    id: 'result', toolCall: { assistantMessageId: 'call', contentIndex: 0 }, fileOperation: { kind: 'read', path: '/work/shot.png' },
    message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [note, image], isError: false, timestamp: 3 },
  }
  const textResult: ConversationMessage = {
    id: 'text-result', toolCall: { assistantMessageId: 'call', contentIndex: 1 },
    message: { role: 'toolResult', toolCallId: 'read-2', toolName: 'read', content: [{ type: 'text', text: '普通文本' }], isError: false, timestamp: 4 },
  }
  try {
    store.save(summary.id, { summary, run, messages: [user, assistant, result, textResult] })
    store.close()
    store = undefined
    const expected = { ...result, imageOmitted: true, message: { ...result.message, content: [note] } }
    const database = new DatabaseSync(path)
    try {
      const stored = String(database.prepare('SELECT data FROM messages WHERE id = ?').get(result.id)?.data)
      expect(JSON.parse(stored)).toEqual(expected)
      expect(stored).not.toContain(image.data)
      expect(result.message.content).toEqual([note, image])
      database.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify(result), result.id)
    } finally { database.close() }
    store = SessionStore.open(path)
    const restored = store.loadSession(summary.id)!.messages
    expect(restored).toEqual([user, assistant, expected, textResult])
    const history = buildModelHistory(restored, undefined, true)
    expect(history.at(-2)).toMatchObject({ role: 'toolResult', toolCallId: 'read-1', content: [
      note, { type: 'text', text: expect.stringMatching(/图片.*重新.*read/) },
    ] })
    expect(history.at(-1)).toEqual(textResult.message)
    expect(JSON.stringify(history)).not.toContain(image.data)
  } finally {
    store?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('首发一起提交；任何一条写入失败就回滚会话登记', () => {
  const store = SessionStore.open(':memory:')
  try {
    expect(() => store.save(summary.id, { summary, run, messages: [user, user] })).toThrow(/未保存/)
    expect(store.listSessions()).toEqual([])
    expect(store.loadSession(summary.id)).toBeUndefined()
    store.save(summary.id, { summary, run, messages: [user] })
    expect(store.loadSession(summary.id)).toEqual({ summary, runs: [run], messages: [user], compactions: [], permissionMode: 'normal' })
  } finally { store.close() }
})

it('完整 MCP 目录撤下缺失工具，加载记录按会话隔离并可重启恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-mcp-'))
  const path = join(directory, 'sessions.sqlite')
  const active = { serverId: 'github', credentialRef: 'config', remoteToolName: 'issue_read' }
  const removed = { ...active, remoteToolName: 'issue_write' }
  const otherConfig = { ...removed, credentialRef: 'other' }
  const assistant: ConversationMessage = {
    id: 'mcp-search',
    message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
      timestamp: 2, stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'tool_search', id: 'search', arguments: { query: 'issue' } }] },
  }
  const result: ConversationMessage = {
    id: 'mcp-search-result', toolCall: { assistantMessageId: assistant.id, contentIndex: 0 },
    message: { role: 'toolResult', toolCallId: 'search', toolName: 'tool_search', isError: false, timestamp: 3,
      content: [{ type: 'text', text: 'Found issue tools' }] },
  }
  let store = SessionStore.open(path)
  try {
    store.save(summary.id, { summary, run, messages: [user, assistant] })
    expect(store.listMcpToolLoads(summary.id)).toEqual([])
    const exec = DatabaseSync.prototype.exec
    const failCommit = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'COMMIT') throw new Error('synthetic commit rejection')
      exec.call(this, sql)
    })
    try { expect(() => store.save(summary.id, { runId: run.id, messages: [result], mcpToolLoads: [active] })).toThrow(/未保存/) }
    finally { failCommit.mockRestore() }
    expect(store.loadSession(summary.id)?.messages).toEqual([user, assistant])
    expect(store.listMcpToolLoads(summary.id)).toEqual([])

    store.save(summary.id, { runId: run.id, messages: [result], mcpToolLoads: [active, active, removed, otherConfig] })
    const otherSession = { ...summary, id: 'another' }
    store.save(otherSession.id, { summary: otherSession })
    expect(store.listMcpToolLoads(otherSession.id)).toEqual([])
    store.close()
    store = SessionStore.open(path)
    expect(store.listMcpToolLoads(summary.id)).toEqual([active, removed, otherConfig])
    store.reconcileMcpToolLoads({ serverId: active.serverId, credentialRef: active.credentialRef, remoteToolNames: ['issue_read'] })
    store.reconcileMcpToolLoads({ serverId: active.serverId, credentialRef: active.credentialRef, remoteToolNames: ['issue_read', 'issue_write'] })
    expect(store.listMcpToolLoads(summary.id)).toEqual([active, otherConfig])
    expect(store.loadSession(summary.id)?.messages).toEqual([user, assistant, result])
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('同一 SQLite 库只由一个连接接管，关闭后可恢复原会话', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-'))
  const path = join(directory, 'sessions.sqlite')
  try {
    const first = SessionStore.open(path)
    try {
      first.save(summary.id, { summary })
      expect(() => SessionStore.open(path)).toThrow('会话库已被占用')
    } finally { first.close() }
    const second = SessionStore.open(path)
    try { expect(second.listSessions()).toEqual([summary]) }
    finally { second.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('27 读取会话各表时维持同一事务，第二连接无法在中途改写任务或消息', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-snapshot-'))
  const path = join(directory, 'sessions.sqlite')
  try {
    const store = SessionStore.open(path)
    const other = new DatabaseSync(path)
    try {
      store.save(summary.id, { summary, run, messages: [user] })
      const prepare = DatabaseSync.prototype.prepare
      const readSteps: string[] = []
      const observe = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
        if (this !== other && sql.startsWith('SELECT')) {
          expect(this.isTransaction).toBe(true)
          readSteps.push(sql)
          if (sql.includes('FROM messages')) expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked/)
        }
        return prepare.call(this, sql)
      })
      try {
        expect(store.loadSession(summary.id)).toEqual({ summary, runs: [run], messages: [user], compactions: [], permissionMode: 'normal' })
        expect(readSteps).toHaveLength(8)
        expect(readSteps.at(-2)).toContain('FROM session_plan_state')
        expect(readSteps.at(-1)).toContain('FROM session_plan_commands')
      } finally { observe.mockRestore() }
    } finally { other.close(); store.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('28 消息归属或压缩范围损坏时拒绝整份历史，会话摘要仍可列出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-corrupt-'))
  const path = join(directory, 'sessions.sqlite')
  try {
    const store = SessionStore.open(path)
    store.save(summary.id, { summary, run, messages: [user] })
    store.close()
    const edit = new DatabaseSync(path)
    try {
      edit.prepare("UPDATE messages SET data = json_set(data, '$.message.content', '不匹配的记录') WHERE id = ?").run(user.id)
    } finally { edit.close() }
    const next = SessionStore.open(path)
    try {
      expect(next.listSessions()).toEqual([summary])
      expect(() => next.loadSession(summary.id)).toThrow('无法读取完整会话历史')
    } finally { next.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('提交状态不明时保留待核对状态，重启后读取实际已提交的记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-unconfirmed-'))
  const path = join(directory, 'sessions.sqlite')
  try {
    const store = SessionStore.open(path)
    const exec = DatabaseSync.prototype.exec
    const interrupted = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      exec.call(this, sql)
      if (sql === 'COMMIT') throw new Error('提交结果未交付')
    })
    try {
      expect(() => store.save(summary.id, { summary, run, messages: [user] })).toThrow(/保存状态未确认/)
      expect(() => store.loadSession(summary.id)).toThrow(/无法读取完整会话历史/)
    } finally { interrupted.mockRestore(); store.close() }
    const reopened = SessionStore.open(path)
    try { expect(reopened.loadSession(summary.id)?.messages).toEqual([user]) }
    finally { reopened.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('Feature 1 旧库只含任务时，从原任务恢复 DeepSeek High', async () => {
  const store = SessionStore.open(':memory:')
  try {
    store.save(summary.id, { summary, run, messages: [user] })
    const history = store.loadSession(summary.id)!
    expect(history.modelSelection).toBeUndefined()
    const agent = new AgentSession({ resolveDirectory: async () => '/tmp', persistence: { summary, store, history } })
    const controller = new AbortController()
    try {
      expect((await agent.subscribe(controller.signal).next()).value).toMatchObject({
        snapshot: { messages: [user], modelSelection: { provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'high' } },
      })
    } finally { controller.abort(); await agent.close() }
  } finally { store.close() }
})

it('Feature 1 保存会话选择与默认值，失败时同时回滚', () => {
  const store = SessionStore.open(':memory:')
  const first = { provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'high' } as const
  const next = { provider: 'moonshotai-cn', modelId: 'kimi-k2.6', reasoningEffort: 'off' } as const
  try {
    store.save(summary.id, { summary })
    store.saveModelSelection(first, summary.id)
    expect(store.getDefaultSelection()).toEqual(first)
    expect(store.loadSession(summary.id)?.modelSelection).toEqual(first)
    const exec = DatabaseSync.prototype.exec
    const reject = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'COMMIT') throw new Error('注入事务失败')
      exec.call(this, sql)
    })
    try { expect(() => store.saveModelSelection(next, summary.id)).toThrow(/未保存/) }
    finally { reject.mockRestore() }
    expect(store.getDefaultSelection()).toEqual(first)
    expect(store.loadSession(summary.id)?.modelSelection).toEqual(first)
    store.saveModelSelection(next, summary.id)
    expect(store.getDefaultSelection()).toEqual(next)
    expect(store.loadSession(summary.id)?.modelSelection).toEqual(next)
  } finally { store.close() }
})
