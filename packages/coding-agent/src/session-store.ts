import type { ModelSelection } from '@agent-learning/model'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { SessionSummary } from './sessions.js'
import { isPermissionMode, type PermissionMode } from './permissions.js'
import { extensionMessage, isJson, object } from './extensions/runtime.js'
import { planCommandArgument } from './plan-mode.js'
import { skillCommand } from './skills.js'
import type { AttachmentScope, MessageAttachment, StagedAttachment } from './session-attachments.js'
import type { ReferenceSource } from './session-references.js'
import { numberedSessionTitle, temporarySessionTitle } from './session-title.js'
import type { CompactionRecord, ConversationMessage, PlanState, RunRecord, SubmissionAccepted, SubmissionInput } from './types.js'

export type StoredRun = Omit<RunRecord, 'restored'> & {
  text: string; finalText?: string; acceptedSeq: number; firstPermissionMode?: PermissionMode; approvedPlanId?: string
  attachmentIds?: string[]; referenceSessionIds?: string[]; firstTitle?: string
}
export type SessionHistory = {
  summary: SessionSummary
  runs: StoredRun[]
  messages: ConversationMessage[]
  compactions: CompactionRecord[]
  permissionMode: PermissionMode
  plan?: PlanState
  planCommands?: SubmissionInput[]
  modelSelection?: ModelSelection
}
export type SessionPersistence = {
  store: SessionStore
  summary: SessionSummary
  first?: () => SessionSummary
  history?: SessionHistory
}
type SessionWrite = {
  summary?: SessionSummary
  name?: { value: string; expected: string }
  attachments?: { ids: readonly string[]; scope: AttachmentScope; cutoff: number }
  run?: StoredRun
  runId?: string
  messages?: ConversationMessage[]
  compaction?: CompactionRecord
  modelSelection?: ModelSelection
  permissionMode?: PermissionMode
  plan?: PlanState | null
  planCommand?: SubmissionInput
  defaultSelection?: ModelSelection
}
type Row = Record<string, SQLOutputValue>

function scopeWhere(scope: AttachmentScope): [string, string[]] {
  return 'sessionId' in scope
    ? ['staged_session = ?', [scope.sessionId]]
    : ['workspace_id = ? AND draft_id = ?', [scope.workspaceId, scope.draftSessionId]]
}

function storedMessage(entry: ConversationMessage): ConversationMessage {
  const { message } = entry
  if (message.role !== 'toolResult' || !message.content.some(block => block.type === 'image')) return entry
  return { ...entry, imageOmitted: true, message: { ...message, content: message.content.filter(block => block.type === 'text') } }
}

const schema = `
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, staged_session TEXT, workspace_id TEXT, draft_id TEXT, uploaded_at INTEGER NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)), bound_session TEXT REFERENCES sessions(id), bound_message TEXT,
    CHECK((staged_session IS NOT NULL AND workspace_id IS NULL AND draft_id IS NULL)
      OR (staged_session IS NULL AND workspace_id IS NOT NULL AND draft_id IS NOT NULL)),
    CHECK((bound_session IS NULL) = (bound_message IS NULL)),
    FOREIGN KEY (bound_session, bound_message) REFERENCES messages(session_id, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS model_selections (
    scope TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), data TEXT NOT NULL CHECK(json_valid(data)),
    CHECK(scope = coalesce(session_id, ''))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS session_permissions (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id), mode TEXT NOT NULL CHECK(mode IN ('normal', 'read-only'))
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
  CREATE TABLE IF NOT EXISTS session_plan_commands (
    session_id TEXT NOT NULL REFERENCES sessions(id), client_id TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(session_id, client_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS session_plan_state (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id), state TEXT NOT NULL,
    assistant_message_id TEXT, steps TEXT CHECK(json_valid(steps)),
    CHECK((state = 'planning' AND assistant_message_id IS NULL AND steps IS NULL)
      OR (state = 'review' AND assistant_message_id IS NOT NULL AND steps IS NOT NULL)),
    FOREIGN KEY(session_id, assistant_message_id) REFERENCES messages(session_id, id)
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

export function runSelection(run: Pick<RunRecord, 'provider' | 'modelId' | 'reasoningEffort'>): ModelSelection {
  return run.provider ? { provider: run.provider, modelId: run.modelId, reasoningEffort: run.reasoningEffort }
    : { provider: 'deepseek', modelId: run.modelId, reasoningEffort: 'high' }
}

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
      if (db.prepare('PRAGMA user_version').get()?.user_version === 0) {
        const legacy = db.prepare(`SELECT id, name, (SELECT json_extract(data, '$.text') FROM runs
          WHERE session_id = sessions.id AND json_extract(data, '$.kind') = 'task' ORDER BY seq LIMIT 1) AS first
          FROM sessions WHERE name GLOB '会话 [0-9]*'`).all()
        const update = db.prepare('UPDATE sessions SET name = ? WHERE id = ?')
        for (const { id, name, first } of legacy) if (typeof name === 'string' && numberedSessionTitle.test(name)) {
          update.run((typeof first === 'string' && temporarySessionTitle(first)) || '新会话', id!)
        }
        db.exec('PRAGMA user_version=1')
      }
      db.exec('COMMIT')
      return new SessionStore(db)
    } catch (error) {
      db?.close()
      throw new Error([5, 6].includes(sqliteCode(error) ?? 0) ? '会话库已被占用' : '无法打开会话库，请检查文件和权限', { cause: error })
    }
  }

  close() { this.db.close() }

  save(sessionId: string, { summary, name, attachments, run, runId = run?.id, messages, compaction, modelSelection, defaultSelection, permissionMode, plan, planCommand }: SessionWrite) {
    if (this.uncertain) throw new SessionWriteError('unconfirmed')
    let committing = false
    try {
      this.db.exec('BEGIN')
      if (summary) {
        this.db.prepare('INSERT INTO sessions (id, workspaceId, name, createdAt) VALUES (?, ?, ?, ?)')
          .run(summary.id, summary.workspaceId, summary.name, summary.createdAt)
      }
      const renamed = name && this.db.prepare('UPDATE sessions SET name = ? WHERE id = ? AND name = ?')
        .run(name.value, sessionId, name.expected).changes === 1
      if (permissionMode !== undefined) {
        this.db.prepare(`INSERT INTO session_permissions (session_id, mode) VALUES (?, ?)
          ON CONFLICT(session_id) DO UPDATE SET mode = excluded.mode`).run(sessionId, permissionMode)
      }
      if (planCommand) {
        this.db.prepare('INSERT INTO session_plan_commands (session_id, client_id, data) VALUES (?, ?, ?)')
          .run(sessionId, planCommand.clientMessageId, JSON.stringify(planCommand))
      }
      if (plan === null) this.db.prepare('DELETE FROM session_plan_state WHERE session_id = ?').run(sessionId)
      if (run) {
        this.db.prepare(`INSERT INTO runs (session_id, id, client_id, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, id) DO UPDATE SET data = excluded.data`)
          .run(sessionId, run.id, run.clientMessageId, JSON.stringify(run))
      }
      if (messages?.length) {
        const insert = this.db.prepare('INSERT INTO messages (session_id, run_id, id, data) VALUES (?, ?, ?, ?)')
        for (const message of messages) insert.run(sessionId, runId!, message.id, JSON.stringify(storedMessage(message)))
      }
      if (attachments) {
        const [condition, values] = scopeWhere(attachments.scope)
        const bind = this.db.prepare(`UPDATE attachments SET bound_session = ?, bound_message = ?
          WHERE id = ? AND bound_session IS NULL AND uploaded_at > ? AND ${condition}`)
        for (const id of attachments.ids) if (bind.run(sessionId, runId!, id, attachments.cutoff, ...values).changes !== 1) {
          throw new Error('Attachment ownership changed')
        }
      }
      if (plan) {
        this.db.prepare(`INSERT INTO session_plan_state (session_id, state, assistant_message_id, steps) VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, assistant_message_id = excluded.assistant_message_id, steps = excluded.steps`)
          .run(sessionId, plan.state, plan.state === 'review' ? plan.assistantMessageId : null, plan.state === 'review' ? JSON.stringify(plan.steps) : null)
      }
      if (compaction) {
        this.db.prepare(`INSERT INTO compactions (session_id, run_id, id, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, id) DO UPDATE SET data = excluded.data`)
          .run(sessionId, runId!, compaction.id, JSON.stringify(compaction))
      }
      if (modelSelection || defaultSelection) {
        const upsert = this.db.prepare(`INSERT INTO model_selections (scope, session_id, data) VALUES (?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET data = excluded.data`)
        if (modelSelection) upsert.run(sessionId, sessionId, JSON.stringify(modelSelection))
        if (defaultSelection) upsert.run('', null, JSON.stringify(defaultSelection))
      }
      committing = true
      this.db.exec('COMMIT')
      return renamed === true
    } catch (error) {
      // SQLite may automatically roll back a failed statement. A failed COMMIT without an active transaction is ambiguous.
      if (this.db.isTransaction) {
        try { this.db.exec('ROLLBACK') } catch { this.uncertain = true }
      } else if (committing) this.uncertain = true
      throw new SessionWriteError(this.uncertain ? 'unconfirmed' : sqliteCode(error) === 13 ? 'storage-full' : 'write-failed', error)
    }
  }

  registerAttachment({ scope, uploadedAt, ...attachment }: StagedAttachment) {
    if (this.uncertain) throw new SessionWriteError('unconfirmed')
    try {
      this.db.prepare(`INSERT INTO attachments (id, staged_session, workspace_id, draft_id, uploaded_at, data)
        VALUES (?, ?, ?, ?, ?, ?)`).run(attachment.id,
        'sessionId' in scope ? scope.sessionId : null, 'workspaceId' in scope ? scope.workspaceId : null,
        'draftSessionId' in scope ? scope.draftSessionId : null, uploadedAt, JSON.stringify(attachment))
    } catch (error) { throw new SessionWriteError(sqliteCode(error) === 13 ? 'storage-full' : 'write-failed', error) }
  }

  pendingAttachment(id: string, scope: AttachmentScope, cutoff: number): MessageAttachment | undefined {
    if (this.uncertain) throw new SessionReadError('无法确认附件归属，请重启服务后重试')
    const [condition, values] = scopeWhere(scope)
    const row = this.db.prepare(`SELECT id, data FROM attachments
      WHERE id = ? AND bound_session IS NULL AND uploaded_at > ? AND ${condition}`).get(id, cutoff, ...values)
    return row && parse<MessageAttachment>(row)
  }

  sentAttachment(id: string): (MessageAttachment & { workspaceId: string }) | undefined {
    if (this.uncertain) throw new SessionReadError('无法确认附件归属，请重启服务后重试')
    const row = this.db.prepare(`SELECT a.id, a.data, s.workspaceId FROM attachments a
      JOIN sessions s ON s.id = a.bound_session
      JOIN messages m ON m.id = a.bound_message AND m.session_id = a.bound_session WHERE a.id = ?`).get(id)
    return row && { ...parse<MessageAttachment>(row), workspaceId: String(row.workspaceId) }
  }

  expiredAttachments(cutoff: number): string[] {
    if (this.uncertain) return []
    return this.db.prepare('SELECT id FROM attachments WHERE bound_session IS NULL AND uploaded_at <= ?')
      .all(cutoff).map(row => String(row.id))
  }

  hasAttachment(id: string): boolean {
    return this.uncertain || this.db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(id) !== undefined
  }

  forgetExpiredAttachment(id: string, cutoff: number) {
    if (!this.uncertain) this.db.prepare('DELETE FROM attachments WHERE id = ? AND bound_session IS NULL AND uploaded_at <= ?').run(id, cutoff)
  }

  saveModelSelection(selection: ModelSelection, sessionId?: string) {
    this.save(sessionId ?? '', { modelSelection: sessionId ? selection : undefined, defaultSelection: selection })
  }

  getDefaultSelection(): ModelSelection | undefined {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      return this.readSelection('')
    } catch (error) { throw new SessionReadError('无法读取默认模型选择，请重试', { cause: error }) }
  }

  private readSelection(scope: string): ModelSelection | undefined {
    const row = this.db.prepare('SELECT data FROM model_selections WHERE scope = ?').get(scope)
    if (!row) return
    const selection = JSON.parse(String(row.data)) as ModelSelection
    if (!selection || typeof selection.provider !== 'string' || !selection.provider || typeof selection.modelId !== 'string'
      || !selection.modelId || (selection.reasoningEffort !== undefined && typeof selection.reasoningEffort !== 'string')) {
      throw new Error('Invalid model selection')
    }
    return selection
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

  readReferenceSource(id: string): ReferenceSource | undefined {
    const history = this.loadSession(id)
    if (!history) return
    const capturedThroughSeq = this.db.prepare('SELECT MAX(seq) AS seq FROM messages WHERE session_id = ?').get(id)?.seq
    return { summary: history.summary, capturedThroughSeq: Number(capturedThroughSeq ?? 0),
      messages: history.messages.flatMap<ReferenceSource['messages'][number]>(({ message, extension }) => {
        if (extension || (message.role !== 'user' && message.role !== 'assistant')) return []
        const text = typeof message.content === 'string' ? message.content
          : message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        return text.trim() ? [{ role: message.role, text }] : []
      }),
    }
  }

  private readHistory(summary: SessionSummary): SessionHistory {
    const runs = this.db.prepare('SELECT id, client_id, data FROM runs WHERE session_id = ? ORDER BY seq').all(summary.id)
      .map(row => {
        const run = parse<StoredRun>(row)
        if (run.sessionId !== summary.id || run.clientMessageId !== row.client_id || typeof run.text !== 'string'
          || (run.approvedPlanId !== undefined && (typeof run.approvedPlanId !== 'string' || !run.approvedPlanId
            || run.kind !== 'task' || run.clientMessageId !== `plan:${run.approvedPlanId}`))
          || (run.finalText !== undefined && (run.kind !== 'task' || typeof run.finalText !== 'string' || !run.finalText.trim()))
          || (run.firstPermissionMode !== undefined && !isPermissionMode(run.firstPermissionMode))
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
        if (entry.imageOmitted !== undefined && (entry.imageOmitted !== true || message.role !== 'toolResult')) throw new Error('Invalid image marker')
        const invocation = entry.skillInvocation
        if (invocation !== undefined && (!invocation || message.role !== 'user' || typeof message.content !== 'string'
          || typeof invocation.name !== 'string' || skillCommand.exec(message.content)?.[1] !== invocation.name
          || !['project-si', 'project-agents', 'user-si', 'user-agents', 'bundled'].includes(invocation.source)
          || (invocation.status === 'loaded'
            ? typeof invocation.body !== 'string' || typeof invocation.directory !== 'string' || !invocation.directory
            : invocation.status !== 'failed' || typeof invocation.reason !== 'string'))) throw new Error('Invalid Skill invocation')
        if (entry.extension !== undefined) {
          if (run.id !== currentRunId || message.role !== 'user' || entry.id === run.id || entry.clientMessageId !== undefined
            || !extensionMessage({ ...entry.extension, content: message.content })) throw new Error('Invalid extension message')
        } else if (message.role === 'user') {
          if (entry.id !== run.id || entry.clientMessageId !== run.clientMessageId || message.content !== (run.finalText ?? run.text)) throw new Error('Invalid submitted message')
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
            || !message.content.every(block => block && (block.type === 'text' && typeof block.text === 'string'
              || block.type === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)
                && typeof block.data === 'string' && block.data.length > 0))) throw new Error('Invalid tool result')
          const actual = entry.toolCall.actualArguments
          if (actual !== undefined && (!object(actual) || !isJson(actual))) throw new Error('Invalid actual tool arguments')
          resultPositions.set(assistantMessageId, contentIndex)
        } else throw new Error('Invalid message')
        if (message.role !== 'toolResult' && entry.toolCall !== undefined) throw new Error('Invalid tool result reference')
        const restored = storedMessage(entry)
        seen.set(entry.id, { entry: restored, runId: run.id, index })
        lastId = entry.id
        return restored
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
    const modelSelection = this.readSelection(summary.id)
    const permission = this.db.prepare('SELECT mode FROM session_permissions WHERE session_id = ?').get(summary.id)
    const permissionMode = permission ? permission.mode : 'normal'
    if (!isPermissionMode(permissionMode)) throw new Error('Invalid session permission mode')
    const row = this.db.prepare('SELECT state, assistant_message_id, steps FROM session_plan_state WHERE session_id = ?').get(summary.id)
    let plan: PlanState | undefined
    if (row?.state === 'planning') plan = { state: 'planning' }
    else if (row?.state === 'review') {
      const assistantMessageId = String(row.assistant_message_id)
      const assistant = seen.get(assistantMessageId)
      const reply = assistant?.entry.message
      const steps: unknown = JSON.parse(String(row.steps))
      if (!assistant || reply?.role !== 'assistant' || reply.stopReason !== 'stop' || byRun.get(assistant.runId)?.status !== 'completed'
        || !Array.isArray(steps) || !steps.length || !steps.every(step => typeof step === 'string' && step.trim())) throw new Error('Invalid plan review')
      plan = { state: 'review', assistantMessageId, steps }
    } else if (row) throw new Error('Invalid plan state')
    const planCommands = this.db.prepare('SELECT client_id, data FROM session_plan_commands WHERE session_id = ?').all(summary.id)
      .map(row => {
        const input: SubmissionInput = JSON.parse(String(row.data))
        const argument = typeof input?.text === 'string' ? planCommandArgument(input.text) : undefined
        if (input?.clientMessageId !== row.client_id || typeof input?.modelId !== 'string' || (argument !== '' && argument !== 'off')) {
          throw new Error('Invalid plan command receipt')
        }
        return input
      })
    return { summary, runs, messages, compactions, permissionMode, ...(planCommands.length && { planCommands }), ...(modelSelection && { modelSelection }), ...(plan && { plan }) }
  }
}
