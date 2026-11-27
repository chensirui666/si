import type { ModelSelection } from '@agent-learning/model'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { SessionSummary } from './sessions.js'
import { isPermissionMode, type PermissionMode } from './permissions.js'
import { extensionMessage, isJson, object } from './extensions/runtime.js'
import type { McpToolCatalog, McpToolIdentity } from './mcp/manager.js'
import { planCommandArgument } from './plan-mode.js'
import { skillCommand } from './skills.js'
import { ATTACHMENT_TTL_MS, type AttachmentScope, type MessageAttachment, type StagedAttachment } from './session-attachments.js'
import type { AgentInputSource, PendingSubmission, UserQuestionBatch } from './collaboration.js'
import { ASK_USER_QUESTION_TOOL_NAME } from './user-question-tool.js'
import type { ReferenceSource } from './session-references.js'
import { numberedSessionTitle, temporarySessionTitle } from './session-title.js'
import type { CompactionRecord, ConversationMessage, NestedToolCallRecord, PlanState, RunRecord, SubmissionAccepted, SubmissionInput } from './types.js'
import { scheduleSchema, ScheduleStore, type ScheduledSubmission } from './schedule-store.js'
import { readSubagent, subagentSchema, SubagentStore } from './subagent-store.js'
import type { DelegatedItemWrite, Delegation } from './subagent-types.js'

export type StoredRun = Omit<RunRecord, 'restored'> & {
  text: string; finalText?: string; acceptedSeq: number; firstPermissionMode?: PermissionMode; approvedPlanId?: string
  attachmentIds?: string[]; referenceSessionIds?: string[]; firstTitle?: string; mode?: SubmissionInput['mode']
}
export type SessionHistory = {
  summary: SessionSummary
  runs: StoredRun[]
  messages: ConversationMessage[]
  nestedToolCalls?: NestedToolCallRecord[]
  compactions: CompactionRecord[]
  permissionMode: PermissionMode
  plan?: PlanState
  planCommands?: SubmissionInput[]
  pending?: PendingSubmission[]
  questions?: UserQuestionBatch[]
  modelSelection?: ModelSelection
}
export type SessionPersistence = {
  store: SessionStore
  summary: SessionSummary
  first?: () => SessionSummary
  history?: SessionHistory
}
type AttachmentBinding = { ids: readonly string[]; scope: AttachmentScope; cutoff: number; messageId?: string; pendingId?: string }
type SessionWrite = {
  summary?: SessionSummary
  name?: { value: string; expected: string }
  attachments?: AttachmentBinding | AttachmentBinding[]
  pending?: PendingSubmission[]
  questions?: UserQuestionBatch[]
  run?: StoredRun
  runId?: string
  messages?: ConversationMessage[]
  nestedToolCall?: NestedToolCallRecord
  mcpToolLoads?: readonly McpToolIdentity[]
  compaction?: CompactionRecord
  modelSelection?: ModelSelection
  permissionMode?: PermissionMode
  plan?: PlanState | null
  planCommand?: SubmissionInput
  defaultSelection?: ModelSelection
  scheduledSubmission?: ScheduledSubmission
  delegatedItem?: DelegatedItemWrite
}
type Row = Record<string, SQLOutputValue>

function scopeWhere(scope: AttachmentScope): [string, string[]] {
  return 'sessionId' in scope
    ? ['staged_session = ?', [scope.sessionId]]
    : ['workspace_id = ? AND draft_id = ?', [scope.workspaceId, scope.draftSessionId]]
}

const unreservedAttachment = 'NOT EXISTS (SELECT 1 FROM pending_attachments WHERE attachment_id = attachments.id)'

function stagedAttachmentWhere(scope: AttachmentScope, cutoff: number, pendingId?: string): [string, (string | number)[]] {
  const [condition, values] = scopeWhere(scope)
  if (pendingId !== undefined) {
    if (!('sessionId' in scope)) throw new Error('Pending attachment requires an existing session')
    return [`bound_session IS NULL AND ${condition} AND EXISTS (SELECT 1 FROM pending_attachments
      WHERE attachment_id = attachments.id AND session_id = ? AND client_id = ?)`, [...values, scope.sessionId, pendingId]]
  }
  return [`bound_session IS NULL AND ${condition} AND uploaded_at > ? AND ${unreservedAttachment}`, [...values, cutoff]]
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
  CREATE INDEX IF NOT EXISTS runs_session_seq ON runs(session_id, seq);
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
    id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    UNIQUE(session_id, id), FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS nested_tool_calls (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL,
    content_index INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    UNIQUE(session_id, assistant_message_id, content_index, id),
    FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, id),
    FOREIGN KEY(session_id, assistant_message_id) REFERENCES messages(session_id, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS session_mcp_tool_loads (
    session_id TEXT NOT NULL, server_id TEXT NOT NULL, credential_ref TEXT NOT NULL, remote_tool_name TEXT NOT NULL,
    result_message_id TEXT NOT NULL,
    PRIMARY KEY (session_id, server_id, credential_ref, remote_tool_name),
    FOREIGN KEY (session_id, result_message_id) REFERENCES messages(session_id, id)
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
  CREATE TABLE IF NOT EXISTS pending_submissions (
    session_id TEXT NOT NULL REFERENCES sessions(id), client_id TEXT NOT NULL, accepted_seq INTEGER NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(session_id, client_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS pending_attachments (
    attachment_id TEXT PRIMARY KEY REFERENCES attachments(id), session_id TEXT NOT NULL, client_id TEXT NOT NULL,
    FOREIGN KEY(session_id, client_id) REFERENCES pending_submissions(session_id, client_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS user_questions (
    session_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(session_id, id),
    UNIQUE(session_id, assistant_message_id, tool_call_id),
    FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, id),
    FOREIGN KEY(session_id, assistant_message_id) REFERENCES messages(session_id, id)
  ) STRICT;
  ${scheduleSchema}
  ${subagentSchema}
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

function validAgentInputSource(source: AgentInputSource | undefined): boolean {
  return source === undefined || Boolean(source && ['steer', 'report', 'continue', 'task'].includes(source.kind)
    && typeof source.sessionId === 'string' && source.sessionId && typeof source.name === 'string' && source.name)
}

function summaryFrom(row: Row): SessionSummary {
  const { id, workspaceId, name, createdAt } = row
  if (typeof id !== 'string' || !id || typeof workspaceId !== 'string' || !workspaceId
    || typeof name !== 'string' || !name || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Invalid session summary')
  }
  const subagent = typeof row.subagentData === 'string' ? readSubagent(row.subagentData, String(row.parent_session_id)) : undefined
  return { id, workspaceId, name, createdAt, ...(row.hasScheduledTask === 1 && { hasScheduledTask: true }), ...(subagent && { subagent }) }
}

export class SessionStore {
  private uncertain = false
  readonly schedules: ScheduleStore
  private readonly subagents: SubagentStore

  private constructor(private readonly db: DatabaseSync) {
    this.subagents = new SubagentStore(db)
    this.schedules = new ScheduleStore(db, operation => this.write(operation), () => {
      if (this.uncertain) throw new SessionReadError('定时任务保存状态未确认，请重启服务后核对')
    })
  }

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

  private saveNestedToolCall(sessionId: string, runId: string | undefined, record: NestedToolCallRecord) {
    const { assistantMessageId, contentIndex } = record.parent
    const row = this.db.prepare('SELECT id, data FROM messages WHERE session_id = ? AND run_id = ? AND id = ?')
      .get(sessionId, record.runId, assistantMessageId)
    const message = row && parse<ConversationMessage>(row).message
    const parent = message?.role === 'assistant' && message.content[contentIndex]
    if (record.runId !== runId || !parent || parent.type !== 'toolCall' || parent.name !== 'codemode'
      || !record.id.startsWith(parent.id + '/') || record.status === 'unknown') throw new Error('Invalid nested tool owner')
    const key = [sessionId, assistantMessageId, contentIndex, record.id] as const
    const prior = this.db.prepare(`SELECT id, data FROM nested_tool_calls
      WHERE session_id = ? AND assistant_message_id = ? AND content_index = ? AND id = ?`).get(...key)
    const encoded = JSON.stringify(record)
    if (!prior && (record.status === 'running' || record.status === 'not-executed')) {
      this.db.prepare(`INSERT INTO nested_tool_calls
        (session_id, assistant_message_id, content_index, id, run_id, data) VALUES (?, ?, ?, ?, ?, ?)`).run(...key, record.runId, encoded)
      return
    }
    const running = prior && parse<NestedToolCallRecord>(prior)
    if (!running || record.status === 'running' || running.status !== 'running'
      || running.name !== record.name) throw new Error('Invalid nested tool checkpoint')
    this.db.prepare(`UPDATE nested_tool_calls SET data = ?
      WHERE session_id = ? AND assistant_message_id = ? AND content_index = ? AND id = ?`).run(encoded, ...key)
  }

  save(sessionId: string, { summary, name, attachments, run, runId = run?.id, messages, nestedToolCall, pending, questions, mcpToolLoads, compaction, modelSelection, defaultSelection, permissionMode, plan, planCommand, scheduledSubmission, delegatedItem }: SessionWrite) {
    return this.write(() => {
      if (summary) {
        this.db.prepare('INSERT INTO sessions (id, workspaceId, name, createdAt) VALUES (?, ?, ?, ?)')
          .run(summary.id, summary.workspaceId, summary.name, summary.createdAt)
        if (summary.subagent) this.subagents.saveSession(summary.id, summary.subagent)
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
        const current = this.db.prepare(`SELECT json_extract(data, '$.status') AS status FROM pending_submissions
          WHERE session_id = ? AND client_id = ? AND NOT EXISTS (SELECT 1 FROM runs WHERE session_id = ? AND id = ?)`)
          .get(sessionId, run.clientMessageId, sessionId, run.id)
        if (current && (!['queued', 'steering'].includes(String(current.status)) || !pending?.some(item =>
          item.input.clientMessageId === run.clientMessageId && item.status === 'started'))) throw new Error('Run must claim its pending submission')
        this.db.prepare(`INSERT INTO runs (session_id, id, client_id, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, id) DO UPDATE SET data = excluded.data`)
          .run(sessionId, run.id, run.clientMessageId, JSON.stringify(run))
      }
      if (messages?.length) {
        const insert = this.db.prepare('INSERT INTO messages (session_id, run_id, id, data) VALUES (?, ?, ?, ?)')
        for (const message of messages) insert.run(sessionId, runId!, message.id, JSON.stringify(storedMessage(message)))
      }
      if (nestedToolCall) this.saveNestedToolCall(sessionId, runId, nestedToolCall)
      if (delegatedItem) {
        if (!run || run.id !== runId || run.sessionId !== sessionId) throw new Error('Invalid delegated run')
        this.subagents.writeItem(delegatedItem, run)
      }
      if (scheduledSubmission) {
        if (!run?.scheduledRunId || run.id !== runId || run.sessionId !== scheduledSubmission.sessionId) throw new Error('无效的定时执行关联')
        this.schedules.accept(run.scheduledRunId, run.id, scheduledSubmission)
      }
      if (mcpToolLoads?.length) {
        const [entry] = messages ?? []
        if (messages?.length !== 1 || entry?.message.role !== 'toolResult' ||
          entry.message.toolName !== 'tool_search' || entry.message.isError) throw new Error('Invalid MCP search checkpoint')
        const load = this.db.prepare(`INSERT INTO session_mcp_tool_loads
          (session_id, server_id, credential_ref, remote_tool_name, result_message_id) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, server_id, credential_ref, remote_tool_name) DO NOTHING`)
        for (const tool of mcpToolLoads) load.run(sessionId, tool.serverId, tool.credentialRef, tool.remoteToolName, entry.id)
      }
      if (attachments) {
        for (const { ids, scope, cutoff, messageId = runId, pendingId } of Array.isArray(attachments) ? attachments : [attachments]) {
          if ('sessionId' in scope && scope.sessionId !== sessionId) throw new Error('Attachment belongs to another session')
          if (pendingId !== undefined && (!pending?.some(item => item.input.clientMessageId === pendingId
            && (item.status === 'started' || item.status === 'delivered')) || !messages?.some(message =>
              message.id === messageId && message.clientMessageId === pendingId))) throw new Error('Binding must claim its pending submission')
          const [condition, values] = stagedAttachmentWhere(scope, cutoff, pendingId)
          const bind = this.db.prepare(`UPDATE attachments SET bound_session = ?, bound_message = ? WHERE id = ? AND ${condition}`)
          for (const id of ids) if (bind.run(sessionId, messageId!, id, ...values).changes !== 1) throw new Error('Attachment ownership changed')
        }
      }
      if (pending?.length) this.savePending(sessionId, pending)
      if (questions?.length) {
        const upsert = this.db.prepare(`INSERT INTO user_questions (session_id, id, run_id, assistant_message_id, tool_call_id, data)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, id) DO UPDATE SET data = excluded.data`)
        for (const batch of questions) upsert.run(sessionId, batch.id, batch.runId, batch.assistantMessageId, batch.toolCallId, JSON.stringify(batch))
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
      return renamed === true
    })
  }

  private savePending(sessionId: string, pending: PendingSubmission[]) {
    const upsert = this.db.prepare(`INSERT INTO pending_submissions (session_id, client_id, accepted_seq, data)
      VALUES (?, ?, ?, ?) ON CONFLICT(session_id, client_id) DO UPDATE SET data = excluded.data
      WHERE pending_submissions.accepted_seq = excluded.accepted_seq
        AND json_extract(pending_submissions.data, '$.input') = json_extract(excluded.data, '$.input')`)
    const release = this.db.prepare('DELETE FROM pending_attachments WHERE session_id = ? AND client_id = ?')
    const reserve = this.db.prepare(`INSERT INTO pending_attachments (attachment_id, session_id, client_id)
      SELECT id, ?, ? FROM attachments WHERE id = ? AND staged_session = ? AND bound_session IS NULL AND uploaded_at > ?
      ON CONFLICT(attachment_id) DO NOTHING`)
    const held = this.db.prepare('SELECT 1 FROM pending_attachments WHERE attachment_id = ? AND session_id = ? AND client_id = ?')
    const cutoff = Date.now() - ATTACHMENT_TTL_MS
    for (const item of pending) {
      const { clientMessageId, attachmentIds } = item.input
      if (upsert.run(sessionId, clientMessageId, item.acceptedSeq, JSON.stringify(item)).changes !== 1) {
        throw new Error('Pending submission identity changed')
      }
      if (item.status !== 'queued' && item.status !== 'steering') {
        release.run(sessionId, clientMessageId)
        continue
      }
      // Active edits and transfers preserve the originally accepted attachment IDs.
      for (const id of attachmentIds ?? []) {
        if (!held.get(id, sessionId, clientMessageId) && reserve.run(sessionId, clientMessageId, id, sessionId, cutoff).changes !== 1) {
          throw new Error('Attachment unavailable for pending submission')
        }
      }
    }
  }

  private write<T>(operation: () => T): T {
    if (this.uncertain) throw new SessionWriteError('unconfirmed')
    let committing = false
    try {
      this.db.exec('BEGIN')
      const result = operation()
      committing = true
      this.db.exec('COMMIT')
      return result
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

  pendingAttachment(id: string, scope: AttachmentScope, cutoff: number, pendingId?: string): MessageAttachment | undefined {
    if (this.uncertain) throw new SessionReadError('无法确认附件归属，请重启服务后重试')
    const [condition, values] = stagedAttachmentWhere(scope, cutoff, pendingId)
    const row = this.db.prepare(`SELECT id, data FROM attachments WHERE id = ? AND ${condition}`).get(id, ...values)
    return row && parse<MessageAttachment>(row)
  }

  sentAttachment(id: string): (MessageAttachment & { workspaceId: string }) | undefined {
    if (this.uncertain) throw new SessionReadError('无法确认附件归属，请重启服务后重试')
    const row = this.db.prepare(`SELECT a.id, a.data, s.workspaceId FROM attachments a
      JOIN sessions s ON s.id = a.bound_session
      JOIN messages m ON m.id = a.bound_message AND m.session_id = a.bound_session WHERE a.id = ?`).get(id)
    return row && { ...parse<MessageAttachment>(row), workspaceId: String(row.workspaceId) }
  }

  queuedAttachment(id: string): (MessageAttachment & { workspaceId: string }) | undefined {
    if (this.uncertain) throw new SessionReadError('无法确认附件归属，请重启服务后重试')
    const row = this.db.prepare(`SELECT a.id, a.data, s.workspaceId FROM attachments a
      JOIN pending_attachments p ON p.attachment_id = a.id AND p.session_id = a.staged_session
      JOIN pending_submissions q ON q.session_id = p.session_id AND q.client_id = p.client_id
      JOIN sessions s ON s.id = p.session_id
      WHERE a.id = ? AND a.bound_session IS NULL AND json_extract(q.data, '$.status') IN ('queued', 'steering')`).get(id)
    return row && { ...parse<MessageAttachment>(row), workspaceId: String(row.workspaceId) }
  }

  expiredAttachments(cutoff: number): string[] {
    if (this.uncertain) return []
    return this.db.prepare(`SELECT id FROM attachments WHERE bound_session IS NULL AND uploaded_at <= ? AND ${unreservedAttachment}`)
      .all(cutoff).map(row => String(row.id))
  }

  hasAttachment(id: string): boolean {
    return this.uncertain || this.db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(id) !== undefined
  }

  forgetExpiredAttachment(id: string, cutoff: number) {
    if (!this.uncertain) this.db.prepare(`DELETE FROM attachments WHERE id = ? AND bound_session IS NULL AND uploaded_at <= ? AND ${unreservedAttachment}`).run(id, cutoff)
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
      return this.db.prepare(`SELECT s.*, EXISTS (
        SELECT 1 FROM schedules p WHERE p.session_id = s.id AND p.deleted = 0
          AND p.status = 'enabled' AND p.session_mode = 'reuse' AND p.next_run_at IS NOT NULL
      ) AS hasScheduledTask FROM sessions s
      WHERE NOT EXISTS (SELECT 1 FROM subagent_sessions WHERE session_id = s.id) ORDER BY s.rowid`).all().map(summaryFrom)
    } catch (error) { throw new SessionReadError('无法读取会话列表，请重试', { cause: error }) }
  }

  readSessionSummary(id: string): SessionSummary | undefined {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      const row = this.db.prepare(`SELECT s.*, c.parent_session_id, c.data AS subagentData FROM sessions s
        LEFT JOIN subagent_sessions c ON c.session_id = s.id WHERE s.id = ?`).get(id)
      return row ? summaryFrom(row) : undefined
    } catch (error) { throw new SessionReadError('无法读取会话信息，请重试', { cause: error }) }
  }

  listSubagents(parentSessionId: string): SessionSummary[] {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      return this.db.prepare(`SELECT s.*, c.parent_session_id, c.data AS subagentData FROM subagent_sessions c
        JOIN sessions s ON s.id = c.session_id WHERE c.parent_session_id = ? ORDER BY s.rowid`).all(parentSessionId).map(summaryFrom)
    } catch (error) { throw new SessionReadError('无法读取子会话列表，请重试', { cause: error }) }
  }

  readSubagentRun(sessionId: string, runId?: string): StoredRun | undefined {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      const row = runId === undefined
        ? this.db.prepare('SELECT id, data FROM runs WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId)
        : this.db.prepare('SELECT id, data FROM runs WHERE session_id = ? AND id = ?').get(sessionId, runId)
      return row && parse<StoredRun>(row)
    } catch (error) { throw new SessionReadError('无法读取委派运行记录，请重试', { cause: error }) }
  }

  createDelegation(delegation: Delegation) {
    this.write(() => this.subagents.create(delegation))
  }

  updateDelegationItem(change: DelegatedItemWrite) {
    this.write(() => this.subagents.writeItem(change))
  }

  finishDelegation(id: string): Delegation {
    return this.write(() => this.subagents.finish(id))
  }

  listDelegations(callerSessionId: string): Delegation[] {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      return this.subagents.list(callerSessionId)
    } catch (error) { throw new SessionReadError('无法读取委派记录，请重试', { cause: error }) }
  }

  recoverDelegations(): Delegation[] {
    return this.write(() => this.subagents.recover())
  }

  setDelegationReport(id: string, status: 'delivered' | 'suppressed'): boolean {
    return this.write(() => this.subagents.markReport(id, status))
  }

  suppressDelegationReports(rootSessionId: string) {
    this.write(() => this.subagents.suppressReports(rootSessionId))
  }

  listMcpToolLoads(sessionId: string): McpToolIdentity[] {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      return this.db.prepare(`SELECT server_id, credential_ref, remote_tool_name FROM session_mcp_tool_loads
        WHERE session_id = ? ORDER BY rowid`).all(sessionId).map(row => ({
        serverId: String(row.server_id), credentialRef: String(row.credential_ref), remoteToolName: String(row.remote_tool_name),
      }))
    } catch (error) { throw new SessionReadError('无法读取会话的 MCP 工具，请重试', { cause: error }) }
  }

  reconcileMcpToolLoads({ serverId, credentialRef, remoteToolNames }: McpToolCatalog): void {
    if (this.uncertain) throw new SessionWriteError('unconfirmed')
    try {
      this.db.prepare(`DELETE FROM session_mcp_tool_loads
        WHERE server_id = ? AND credential_ref = ? AND remote_tool_name NOT IN (SELECT value FROM json_each(?))`)
        .run(serverId, credentialRef, JSON.stringify(remoteToolNames))
    } catch (error) {
      throw new SessionWriteError(sqliteCode(error) === 13 ? 'storage-full' : 'write-failed', error)
    }
  }

  loadSession(id: string): SessionHistory | undefined {
    try {
      if (this.uncertain) throw new Error('Commit state unknown')
      this.db.exec('BEGIN')
      const summary = this.readSessionSummary(id)
      const history = summary ? this.readHistory(summary) : undefined
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
    if (this.readSessionSummary(id)?.subagent) return
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
          || (run.mode !== undefined && run.mode !== 'steer')
          || (run.firstPermissionMode !== undefined && !isPermissionMode(run.firstPermissionMode))
          || typeof run.modelId !== 'string' || !['task', 'compaction'].includes(run.kind)
          || (run.scheduledRunId !== undefined && (run.kind !== 'task' || run.scheduledRunId !== run.clientMessageId))
          || !['running', 'completed', 'failed', 'aborted', ...(run.scheduledRunId ? ['interrupted'] : [])].includes(run.status)
          || !Number.isFinite(run.startedAt) || (run.status !== 'running' && !Number.isFinite(run.finishedAt))
          || !Number.isSafeInteger(run.acceptedSeq) || run.acceptedSeq < 1) throw new Error('Invalid run')
        return run
      })
    const byRun = new Map(runs.map(run => [run.id, run]))
    const seen = new Map<string, { entry: ConversationMessage; runId: string; index: number }>()
    const resultPositions = new Map<string, number>()
    let lastId = '', currentRunId = '', remainingCalls = 0
    const messages = this.db.prepare('SELECT id, run_id, data FROM messages WHERE session_id = ? ORDER BY seq').all(summary.id)
      .map((row, index) => {
        const entry = parse<ConversationMessage>(row)
        const run = byRun.get(String(row.run_id))
        const message = entry.message
        if (!run || run.kind !== 'task' || !message || !Number.isFinite(message.timestamp)) throw new Error('Invalid message owner')
        if ((entry.runId !== undefined && entry.runId !== run.id) || (entry.steering !== undefined
          && (entry.steering !== true || entry.runId !== run.id || message.role !== 'user' || entry.extension !== undefined))) throw new Error('Invalid message owner')
        if (!validAgentInputSource(entry.agentSource) || (entry.agentSource && message.role !== 'user')) throw new Error('Invalid agent input source')
        if (entry.imageOmitted !== undefined && (entry.imageOmitted !== true || message.role !== 'toolResult')) throw new Error('Invalid image marker')
        const invocation = entry.skillInvocation
        if (invocation !== undefined && (!invocation || message.role !== 'user' || typeof message.content !== 'string'
          || typeof invocation.name !== 'string' || skillCommand.exec(message.content)?.[1] !== invocation.name
          || !['project-si', 'project-agents', 'user-si', 'user-agents', 'bundled'].includes(invocation.source)
          || (invocation.status === 'loaded'
            ? typeof invocation.body !== 'string' || typeof invocation.directory !== 'string' || !invocation.directory
            : invocation.status !== 'failed' || typeof invocation.reason !== 'string'))) throw new Error('Invalid Skill invocation')
        if (entry.extension !== undefined) {
          if (run.id !== currentRunId || !seen.has(run.id) || message.role !== 'user' || entry.id === run.id || entry.clientMessageId !== undefined
            || !extensionMessage({ ...entry.extension, content: message.content })) throw new Error('Invalid extension message')
        } else if (message.role === 'user') {
          if (run.id !== currentRunId) {
            if (seen.has(run.id) || (currentRunId && !seen.has(currentRunId))) throw new Error('Invalid message order')
            currentRunId = run.id
            remainingCalls = 0
          }
          if (entry.steering) {
            if (entry.id === run.id || typeof entry.clientMessageId !== 'string' || !entry.clientMessageId
              || entry.clientMessageId === run.clientMessageId || typeof message.content !== 'string' || remainingCalls) throw new Error('Invalid steering message')
          } else if (entry.id !== run.id || entry.clientMessageId !== run.clientMessageId || message.content !== (run.finalText ?? run.text)) {
            throw new Error('Invalid submitted message')
          }
        } else if (run.id !== currentRunId || !seen.has(run.id)) throw new Error('Invalid message order')
        else if (message.role === 'assistant') {
          if (!Array.isArray(message.content) || typeof message.model !== 'string' || typeof message.api !== 'string'
            || typeof message.provider !== 'string' || !['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason)
            || !message.content.every(block => block && (block.type === 'text' && typeof block.text === 'string'
              || block.type === 'thinking' && typeof block.thinking === 'string' || block.type === 'toolCall'
                && typeof block.id === 'string' && typeof block.name === 'string' && block.arguments
                && typeof block.arguments === 'object' && !Array.isArray(block.arguments)))) throw new Error('Invalid assistant message')
          remainingCalls = message.content.filter(block => block.type === 'toolCall').length
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
          remainingCalls--
        } else throw new Error('Invalid message')
        if (message.role !== 'toolResult' && entry.toolCall !== undefined) throw new Error('Invalid tool result reference')
        const restored = storedMessage(entry)
        seen.set(entry.id, { entry: restored, runId: run.id, index })
        lastId = entry.id
        return restored
      })
    const nestedToolCalls = this.db.prepare('SELECT * FROM nested_tool_calls WHERE session_id = ? ORDER BY seq')
      .all(summary.id).map(row => {
        const record = parse<NestedToolCallRecord>(row)
        const owner = seen.get(String(row.assistant_message_id))
        const parent = owner?.entry.message.role === 'assistant' && owner.entry.message.content[Number(row.content_index)]
        if (!parent || parent.type !== 'toolCall' || parent.name !== 'codemode' || !record.id.startsWith(parent.id + '/')
          || owner?.runId !== row.run_id || record.runId !== row.run_id || record.id !== row.id
          || record.parent.assistantMessageId !== row.assistant_message_id || record.parent.contentIndex !== row.content_index
          || !['running', 'succeeded', 'failed', 'not-executed', 'stopped'].includes(record.status)
          || typeof record.name !== 'string' || !object(record.argumentsPreview) || !isJson(record.argumentsPreview)
          || record.resultPreview !== undefined && typeof record.resultPreview !== 'string'
          || record.fileOperation && (!['read', 'modified'].includes(record.fileOperation.kind) || typeof record.fileOperation.path !== 'string')) {
          throw new Error('Invalid nested tool checkpoint')
        }
        return record.status === 'running' ? { ...record, status: 'unknown' as const } : record
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
    const pending = this.db.prepare('SELECT client_id, accepted_seq, data FROM pending_submissions WHERE session_id = ? ORDER BY accepted_seq, rowid')
      .all(summary.id).map(row => {
        const item: PendingSubmission = JSON.parse(String(row.data))
        if (item?.input?.clientMessageId !== row.client_id || typeof item.input.text !== 'string' || typeof item.input.modelId !== 'string'
          || typeof item.text !== 'string' || item.acceptedSeq !== row.accepted_seq || !Number.isSafeInteger(item.acceptedSeq) || item.acceptedSeq < 1
          || (item.steeringSeq !== undefined && (!Number.isSafeInteger(item.steeringSeq) || item.steeringSeq < item.acceptedSeq))
          || !validAgentInputSource(item.agentSource)
          || (item.waitForUser !== undefined && (item.waitForUser !== true || item.agentSource?.kind !== 'report'))
          || (item.targetRunId !== undefined && (typeof item.targetRunId !== 'string' || !item.targetRunId))
          || !['queued', 'steering', 'deleted', 'started', 'delivered', 'undelivered'].includes(item.status)) throw new Error('Invalid pending submission')
        return item
      })
    const questions = this.db.prepare('SELECT id, run_id, assistant_message_id, tool_call_id, data FROM user_questions WHERE session_id = ? ORDER BY rowid')
      .all(summary.id).map(row => {
        const batch = parse<UserQuestionBatch>(row)
        const assistant = seen.get(batch.assistantMessageId)
        const reply = assistant?.entry.message
        if (batch.runId !== row.run_id || batch.assistantMessageId !== row.assistant_message_id || batch.toolCallId !== row.tool_call_id
          || assistant?.runId !== batch.runId || reply?.role !== 'assistant'
          || !reply.content.some(block => block.type === 'toolCall' && block.id === batch.toolCallId && block.name === ASK_USER_QUESTION_TOOL_NAME)
          || !Array.isArray(batch.questions) || !batch.questions.length || (batch.deadlineAt !== undefined && !Number.isFinite(batch.deadlineAt))
          || !['waiting', 'answered', 'timed-out', 'closed', 'aborted'].includes(batch.status)) throw new Error('Invalid user question batch')
        return batch
      })
    return { summary, runs, messages, compactions, permissionMode, ...(nestedToolCalls.length && { nestedToolCalls }), ...(planCommands.length && { planCommands }),
      ...(modelSelection && { modelSelection }), ...(plan && { plan }), ...(pending.length && { pending }), ...(questions.length && { questions }) }
  }
}
