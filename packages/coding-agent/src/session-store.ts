import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { SessionSummary } from './sessions.js'
import type { CompactionRecord, ConversationMessage, RunRecord, SubmissionAccepted } from './types.js'

export type StoredRun = Omit<RunRecord, 'restored'> & { text: string; acceptedSeq: number }
export type SessionHistory = {
  summary: SessionSummary
  runs: StoredRun[]
  messages: ConversationMessage[]
  compactions: CompactionRecord[]
}
export type SessionPersistence = {
  store: SessionStore
  summary: SessionSummary
  first?: () => SessionSummary
  history?: SessionHistory
}
type SessionWrite = {
  summary?: SessionSummary
  run?: StoredRun
  runId?: string
  messages?: ConversationMessage[]
  compaction?: CompactionRecord
}
type Row = Record<string, SQLOutputValue>

const schema = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS runs (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    id TEXT NOT NULL, client_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    UNIQUE(session_id, id), UNIQUE(session_id, client_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
    id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    UNIQUE(session_id, id), FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS compactions (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
    id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    UNIQUE(session_id, id), FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, id)
  ) STRICT;
`

function sqliteCode(error: unknown): number | undefined {
  if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number') return error.errcode & 255
}

export class SessionWriteError extends Error {
  constructor(readonly reason: 'storage-full' | 'write-failed' | 'unconfirmed', cause?: unknown) {
    super(reason === 'storage-full' ? '磁盘空间不足，未保存' : reason === 'unconfirmed' ? '会话保存状态未确认，请重启服务后核对' : '会话记录未保存，请重试', { cause })
  }
}

export class SessionReadError extends Error {}

export function submissionReceipt(run: StoredRun): SubmissionAccepted {
  const common = { clientMessageId: run.clientMessageId, acceptedSeq: run.acceptedSeq }
  return run.kind === 'task' ? { ...common, kind: 'message', userMessageId: run.id }
    : { ...common, kind: 'compaction', compactionId: run.id }
}

function parse<T extends { id: string }>(row: Row): T {
  const value = JSON.parse(String(row.data))
  if (!value || typeof value !== 'object' || value.id !== row.id) throw new Error('Invalid record ID')
  return value
}

function summaryFrom(row: Row): SessionSummary {
  const { id, workspaceId, name, createdAt } = row
  if (typeof id !== 'string' || !id || typeof workspaceId !== 'string' || !workspaceId
    || typeof name !== 'string' || !name || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Invalid session summary')
  }
  return { id, workspaceId, name, createdAt }
}

export class SessionStore {
  private uncertain = false
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): SessionStore {
    let db: DatabaseSync | undefined
    try {
      if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        closeSync(openSync(path, 'a', 0o600))
      }
      db = new DatabaseSync(path)
      db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;')
      db.exec(schema)
      db.exec('COMMIT')
      return new SessionStore(db)
    } catch (error) {
      db?.close()
      throw new Error([5, 6].includes(sqliteCode(error) ?? 0) ? '会话库已被占用' : '无法打开会话库，请检查文件和权限', { cause: error })
    }
  }

  close() { this.db.close() }

  save(sessionId: string, { summary, run, runId = run?.id, messages, compaction }: SessionWrite) {
    if (this.uncertain) throw new SessionWriteError('unconfirmed')
    let committing = false
    try {
      this.db.exec('BEGIN')
      if (summary) {
        this.db.prepare('INSERT INTO sessions (id, workspaceId, name, createdAt) VALUES (?, ?, ?, ?)')
          .run(summary.id, summary.workspaceId, summary.name, summary.createdAt)
      }
      if (run) {
        this.db.prepare(`INSERT INTO runs (session_id, id, client_id, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, id) DO UPDATE SET data = excluded.data`)
          .run(sessionId, run.id, run.clientMessageId, JSON.stringify(run))
      }
      if (messages?.length) {
        const insert = this.db.prepare('INSERT INTO messages (session_id, run_id, id, data) VALUES (?, ?, ?, ?)')
        for (const message of messages) insert.run(sessionId, runId!, message.id, JSON.stringify(message))
      }
      if (compaction) {
        this.db.prepare(`INSERT INTO compactions (session_id, run_id, id, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, id) DO UPDATE SET data = excluded.data`)
          .run(sessionId, runId!, compaction.id, JSON.stringify(compaction))
      }
      committing = true
      this.db.exec('COMMIT')
    } catch (error) {
      // SQLite may automatically roll back a failed statement. A failed COMMIT without an active transaction is ambiguous.
      if (this.db.isTransaction) {
        try { this.db.exec('ROLLBACK') } catch { this.uncertain = true }
      } else if (committing) this.uncertain = true
      throw new SessionWriteError(this.uncertain ? 'unconfirmed' : sqliteCode(error) === 13 ? 'storage-full' : 'write-failed', error)
    }
  }

  listSessions(): SessionSummary[] {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      return this.db.prepare('SELECT * FROM sessions ORDER BY rowid').all().map(summaryFrom)
    } catch (error) { throw new SessionReadError('无法读取会话列表，请重试', { cause: error }) }
  }

  loadSession(id: string): SessionHistory | undefined {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      this.db.exec('BEGIN')
      const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
      const history = session ? this.readHistory(summaryFrom(session)) : undefined
      this.db.exec('COMMIT')
      return history
    } catch (error) {
      if (this.db.isTransaction) {
        try { this.db.exec('ROLLBACK') } catch { this.uncertain = true }
      }
      throw new SessionReadError('无法读取完整会话历史，请重试', { cause: error })
    }
  }

  private readHistory(summary: SessionSummary): SessionHistory {
    const runs = this.db.prepare('SELECT id, client_id, data FROM runs WHERE session_id = ? ORDER BY seq').all(summary.id)
      .map(row => {
        const run = parse<StoredRun>(row)
        if (run.sessionId !== summary.id || run.clientMessageId !== row.client_id || typeof run.text !== 'string'
          || typeof run.modelId !== 'string' || !['task', 'compaction'].includes(run.kind)
          || !['running', 'completed', 'failed', 'aborted'].includes(run.status)
          || !Number.isFinite(run.startedAt) || (run.status !== 'running' && !Number.isFinite(run.finishedAt))
          || !Number.isSafeInteger(run.acceptedSeq) || run.acceptedSeq < 1) throw new Error('Invalid run')
        return run
      })
    const byRun = new Map(runs.map(run => [run.id, run]))
    const seen = new Map<string, { entry: ConversationMessage; runId: string; index: number }>()
    const resultPositions = new Map<string, number>()
    let lastId = '', currentRunId = ''
    const messages = this.db.prepare('SELECT id, run_id, data FROM messages WHERE session_id = ? ORDER BY seq').all(summary.id)
      .map((row, index) => {
        const entry = parse<ConversationMessage>(row)
        const run = byRun.get(String(row.run_id))
        const message = entry.message
        if (!run || run.kind !== 'task' || !message || !Number.isFinite(message.timestamp)) throw new Error('Invalid message owner')
        if (message.role === 'user') {
          if (entry.id !== run.id || entry.clientMessageId !== run.clientMessageId || message.content !== run.text) throw new Error('Invalid submitted message')
          currentRunId = run.id
        } else if (run.id !== currentRunId) throw new Error('Invalid message order')
        else if (message.role === 'assistant') {
          if (!Array.isArray(message.content) || typeof message.model !== 'string' || typeof message.api !== 'string'
            || typeof message.provider !== 'string' || !['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason)
            || !message.content.every(block => block && (block.type === 'text' && typeof block.text === 'string'
              || block.type === 'thinking' && typeof block.thinking === 'string' || block.type === 'toolCall'
                && typeof block.id === 'string' && typeof block.name === 'string' && block.arguments
                && typeof block.arguments === 'object' && !Array.isArray(block.arguments)))) throw new Error('Invalid assistant message')
        } else if (message.role === 'toolResult' && entry.toolCall) {
          const { assistantMessageId, contentIndex } = entry.toolCall
          const assistant = seen.get(assistantMessageId)
          const reply = assistant?.entry.message
          const call = reply?.role === 'assistant' ? reply.content[contentIndex] : undefined
          if (assistant?.runId !== run.id || call?.type !== 'toolCall' || call.id !== message.toolCallId
            || call.name !== message.toolName || !Number.isSafeInteger(contentIndex) || contentIndex <= (resultPositions.get(assistantMessageId) ?? -1)
            || (index !== assistant.index + 1 && seen.get(lastId)?.entry.toolCall?.assistantMessageId !== assistantMessageId)
            || typeof message.isError !== 'boolean' || !Array.isArray(message.content)
            || !message.content.every(block => block?.type === 'text' && typeof block.text === 'string')) throw new Error('Invalid tool result')
          resultPositions.set(assistantMessageId, contentIndex)
        } else throw new Error('Invalid message')
        if (message.role !== 'toolResult' && entry.toolCall !== undefined) throw new Error('Invalid tool result reference')
        seen.set(entry.id, { entry, runId: run.id, index })
        lastId = entry.id
        return entry
      })
    const compactions = this.db.prepare('SELECT id, run_id, data FROM compactions WHERE session_id = ? ORDER BY seq').all(summary.id)
      .map(row => {
        const item = parse<CompactionRecord>(row)
        const run = byRun.get(String(row.run_id))
        if (!run || !['manual', 'auto', 'overflow'].includes(item.trigger)
          || !['running', 'success', 'failed', 'aborted', 'skipped'].includes(item.status) || !Number.isFinite(item.startedAt)
          || (item.status !== 'running' && !Number.isFinite(item.finishedAt))
          || (item.trigger === 'manual' ? run.kind !== 'compaction' || run.id !== item.id || run.clientMessageId !== item.clientMessageId : run.kind !== 'task')) throw new Error('Invalid compaction')
        if (item.status === 'success') {
          const first = seen.get(item.firstKeptMessageId), last = seen.get(item.contextLastMessageId)
          const followup = item.followupMessageId ? seen.get(item.followupMessageId) : undefined
          const reply = followup?.entry.message
          const input = reply?.role === 'assistant' ? reply.usage?.input : undefined
          if (!first || !last || first.index > last.index || !['user', 'assistant'].includes(first.entry.message.role) || typeof item.summary !== 'string' || !item.summary.trim()
            || !Number.isFinite(item.estimatedBefore) || !Number.isFinite(item.estimatedAfter) || item.estimatedAfter < 0 || item.estimatedAfter >= item.estimatedBefore
            || (item.followupMessageId !== undefined && (!followup || followup.index <= last.index || typeof input !== 'number' || !Number.isFinite(input) || input < 0))) throw new Error('Invalid compaction references')
        } else if (item.status !== 'running' && typeof item.reason !== 'string') throw new Error('Invalid compaction outcome')
        return item
      })
    const compactionIds = new Set(compactions.map(item => item.id))
    if (runs.some(run => run.kind === 'task' ? !seen.has(run.id) : !compactionIds.has(run.id))) throw new Error('Missing submitted record')
    return { summary, runs, messages, compactions }
  }
}
