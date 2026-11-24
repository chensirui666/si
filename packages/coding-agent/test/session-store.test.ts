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
        for (const table of ['session_plan_state', 'session_plan_commands', 'pending_submissions', 'user_questions']) {
          expect(readSteps.some(sql => sql.includes(`FROM ${table}`))).toBe(true)
        }
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

it('重开会话恢复待发顺序、编辑文本和删除项的原始提交', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-pending-'))
  const path = join(directory, 'sessions.sqlite')
  const first = {
    input: { clientMessageId: 'first', text: '原始第一条', modelId: run.modelId },
    text: '原始第一条', status: 'queued' as const, acceptedSeq: 5,
  }
  const second = {
    input: { clientMessageId: 'second', text: '原始第二条', modelId: run.modelId },
    text: '原始第二条', status: 'queued' as const, acceptedSeq: 6,
  }
  const edit = { ...first, text: '编辑后第一条' }
  const deleted = { ...second, status: 'deleted' as const }
  try {
    const store = SessionStore.open(path)
    try {
      store.save(summary.id, { summary, pending: [first, second] })
      const bypass = { ...run, clientMessageId: first.input.clientMessageId, text: first.text }
      expect(() => store.save(summary.id, { run: bypass, messages: [{ ...user, clientMessageId: bypass.clientMessageId }] })).toThrow(/未保存/)
      expect(() => store.save(summary.id, { pending: [{ ...edit, input: { ...edit.input, text: edit.text } }] })).toThrow(/未保存/)
      store.save(summary.id, { pending: [deleted, edit] })
    } finally { store.close() }
    const reopened = SessionStore.open(path)
    try { expect(reopened.loadSession(summary.id)?.pending).toEqual([edit, deleted]) }
    finally { reopened.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('待发附件归原提交保留，领取时与每条正式消息的绑定一起保存', () => {
  const store = SessionStore.open(':memory:')
  const scope = { sessionId: summary.id }
  const uploadedAt = Date.now()
  const attachment = { id: 'held', name: 'held.txt', mediaType: 'text/plain' as const, size: 1 }
  const other = { ...attachment, id: 'other' }
  const queued = {
    input: { clientMessageId: run.clientMessageId, text: run.text, modelId: run.modelId, attachmentIds: [other.id] },
    text: run.text, status: 'queued' as const, acceptedSeq: 1, attachments: [other],
  }
  const steering = {
    ...queued, input: { ...queued.input, clientMessageId: 'steer', attachmentIds: [attachment.id] },
    status: 'steering' as const, acceptedSeq: 2, attachments: [attachment],
  }
  const preceding: ConversationMessage = {
    ...user, id: 'steering-user', clientMessageId: 'steer', runId: run.id, steering: true, attachments: [attachment],
  }
  const primary = { ...user, attachments: [other] }
  const cutoff = uploadedAt + 1
  const dispatch = {
    run, messages: [preceding, primary],
    pending: [{ ...queued, status: 'started' as const }, { ...steering, status: 'delivered' as const }],
    attachments: [
      { ids: [attachment.id], scope, cutoff, pendingId: steering.input.clientMessageId, messageId: preceding.id },
      { ids: [other.id], scope, cutoff, pendingId: queued.input.clientMessageId, messageId: primary.id },
    ],
  }
  try {
    store.save(summary.id, { summary })
    store.registerAttachment({ ...attachment, scope, uploadedAt })
    store.registerAttachment({ ...other, scope, uploadedAt })
    store.save(summary.id, { pending: [queued, steering] })
    expect(store.expiredAttachments(cutoff)).toEqual([])
    expect(store.pendingAttachment(attachment.id, scope, uploadedAt - 1)).toBeUndefined()
    expect(store.pendingAttachment(attachment.id, scope, cutoff, steering.input.clientMessageId)).toEqual(attachment)
    expect(() => store.save(summary.id, { ...dispatch, attachments: [
      dispatch.attachments[0]!, { ...dispatch.attachments[1]!, pendingId: steering.input.clientMessageId },
    ] })).toThrow(/未保存/)
    expect(store.sentAttachment(attachment.id)).toBeUndefined()
    expect(store.loadSession(summary.id)).toMatchObject({ runs: [], messages: [], pending: [queued, steering] })
    store.save(summary.id, dispatch)
    expect(store.loadSession(summary.id)).toMatchObject({ runs: [run], messages: [preceding, primary], pending: dispatch.pending })
    expect(store.sentAttachment(attachment.id)).toEqual({ ...attachment, workspaceId: summary.workspaceId })
    expect(store.sentAttachment(other.id)).toEqual({ ...other, workspaceId: summary.workspaceId })
  } finally { store.close() }
})

it('拒绝用其他会话或其他待发项的附件，删除待发项后允许清理附件', () => {
  const store = SessionStore.open(':memory:')
  const scope = { sessionId: summary.id }
  const foreignScope = { sessionId: 'other-session' }
  const uploadedAt = Date.now()
  const attachment = { id: 'owned', name: 'owned.txt', mediaType: 'text/plain' as const, size: 1 }
  const foreign = { ...attachment, id: 'foreign' }
  const first = {
    input: { clientMessageId: 'first', text: '第一条', modelId: run.modelId, attachmentIds: [attachment.id] },
    text: '第一条', status: 'queued' as const, acceptedSeq: 2,
  }
  try {
    store.save(summary.id, { summary })
    store.registerAttachment({ ...attachment, scope, uploadedAt })
    store.registerAttachment({ ...foreign, scope: foreignScope, uploadedAt })
    expect(store.queuedAttachment(attachment.id)).toBeUndefined()
    expect(() => store.save(summary.id, { pending: [{ ...first, input: { ...first.input, attachmentIds: [foreign.id] } }] })).toThrow(/未保存/)
    store.save(summary.id, { pending: [first] })
    expect(store.queuedAttachment(attachment.id)).toEqual({ ...attachment, workspaceId: summary.workspaceId })
    expect(() => store.save(summary.id, { pending: [{ ...first, input: { ...first.input, clientMessageId: 'second' } }] })).toThrow(/未保存/)
    store.forgetExpiredAttachment(attachment.id, uploadedAt + 1)
    expect(store.hasAttachment(attachment.id)).toBe(true)
    store.save(summary.id, { pending: [{ ...first, status: 'deleted' }] })
    expect(store.queuedAttachment(attachment.id)).toBeUndefined()
    expect(store.expiredAttachments(uploadedAt + 1)).toContain(attachment.id)
    store.forgetExpiredAttachment(attachment.id, uploadedAt + 1)
    expect(store.hasAttachment(attachment.id)).toBe(false)
  } finally { store.close() }
})

const ask: ConversationMessage = {
  id: 'ask', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
    timestamp: 2, stopReason: 'toolUse', content: [
      { type: 'toolCall', name: 'ask_user_question', id: 'question-call', arguments: { questions: [{ id: 'q1', question: '保留旧接口？' }] } },
      { type: 'toolCall', name: 'read', id: 'read-call', arguments: { path: 'note.txt' } },
    ] },
}
const timedOutResult: ConversationMessage = {
  id: 'ask-result', toolCall: { assistantMessageId: ask.id, contentIndex: 0 },
  message: { role: 'toolResult', toolCallId: 'question-call', toolName: 'ask_user_question', isError: false,
    timestamp: 3, content: [{ type: 'text', text: '{"pending":true}' }] },
}
const readResult: ConversationMessage = {
  id: 'read-result', toolCall: { assistantMessageId: ask.id, contentIndex: 1 },
  message: { role: 'toolResult', toolCallId: 'read-call', toolName: 'read', isError: false,
    timestamp: 4, content: [{ type: 'text', text: '读到的内容' }] },
}

it('重开会话恢复超时问题及其原工具结果，插话保留在工具批次之后', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-store-questions-'))
  const path = join(directory, 'sessions.sqlite')
  const question = {
    id: 'question-id', runId: run.id, assistantMessageId: ask.id, toolCallId: 'question-call',
    status: 'timed-out' as const, deadlineAt: 3, questions: [{ id: 'q1', question: '保留旧接口？' }],
  }
  const steering: ConversationMessage = {
    id: 'steer', clientMessageId: 'steering', runId: run.id, steering: true,
    message: { role: 'user', content: '保留旧接口', timestamp: 5 },
  }
  try {
    const store = SessionStore.open(path)
    try {
      const waiting = { ...question, status: 'waiting' as const }
      store.save(summary.id, { summary, run, messages: [user, ask], questions: [waiting] })
      expect(store.loadSession(summary.id)?.questions).toEqual([waiting])
      store.save(summary.id, { runId: run.id, messages: [timedOutResult], questions: [question] })
      store.save(summary.id, { runId: run.id, messages: [readResult, steering] })
    } finally { store.close() }
    const reopened = SessionStore.open(path)
    try {
      expect(reopened.loadSession(summary.id)).toMatchObject({
        messages: [user, ask, timedOutResult, readResult, steering], questions: [question],
      })
    } finally { reopened.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('有未回填的工具调用时拒绝把后续插话当成完整历史', () => {
  const store = SessionStore.open(':memory:')
  const steering: ConversationMessage = {
    ...user, id: 'steer', clientMessageId: 'steering', runId: run.id, steering: true,
  }
  try {
    store.save(summary.id, { summary, run, messages: [user, ask, timedOutResult, steering] })
    expect(() => store.loadSession(summary.id)).toThrow('无法读取完整会话历史')
  } finally { store.close() }
})
