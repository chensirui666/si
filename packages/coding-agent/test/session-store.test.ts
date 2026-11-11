import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { SessionStore } from '../src/session-store.js'

const summary = { id: 'session', workspaceId: 'workspace', name: '会话 1', createdAt: new Date().toISOString() }
const run = {
  id: 'user', sessionId: summary.id, clientMessageId: 'send', modelId: 'deepseek-flash',
  text: '原文', kind: 'task', status: 'running', startedAt: 1, acceptedSeq: 1,
} as const
const user = { id: run.id, clientMessageId: run.clientMessageId, message: { role: 'user', content: run.text, timestamp: 1 } } as const

it('首发一起提交；任何一条写入失败就回滚会话登记', () => {
  const store = SessionStore.open(':memory:')
  try {
    expect(() => store.save(summary.id, { summary, run, messages: [user, user] })).toThrow(/未保存/)
    expect(store.listSessions()).toEqual([])
    expect(store.loadSession(summary.id)).toBeUndefined()
    store.save(summary.id, { summary, run, messages: [user] })
    expect(store.loadSession(summary.id)).toEqual({ summary, runs: [run], messages: [user], compactions: [] })
  } finally { store.close() }
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

it('27 读取四表时维持同一事务，第二连接无法在中途改写任务或消息', async () => {
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
        expect(store.loadSession(summary.id)).toEqual({ summary, runs: [run], messages: [user], compactions: [] })
        expect(readSteps).toHaveLength(4)
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
