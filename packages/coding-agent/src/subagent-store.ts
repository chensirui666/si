import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { DelegatedItemWrite, Delegation, DelegationItem, SubagentSession } from './subagent-types.js'
import type { ConversationMessage } from './types.js'

export const subagentSchema = `
  CREATE TABLE IF NOT EXISTS subagent_sessions (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    parent_session_id TEXT NOT NULL REFERENCES sessions(id),
    data TEXT NOT NULL CHECK(json_valid(data)),
    CHECK(session_id != parent_session_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS subagent_sessions_parent ON subagent_sessions(parent_session_id);
  CREATE TABLE IF NOT EXISTS delegations (
    id TEXT PRIMARY KEY, caller_session_id TEXT NOT NULL, root_session_id TEXT NOT NULL REFERENCES sessions(id),
    assistant_message_id TEXT NOT NULL, content_index INTEGER NOT NULL CHECK(content_index >= 0),
    tool_call_id TEXT NOT NULL, run_id TEXT NOT NULL, background INTEGER NOT NULL CHECK(background IN (0, 1)),
    mode TEXT NOT NULL CHECK(mode IN ('single', 'parallel', 'chain', 'continue')),
    finished_at INTEGER, report TEXT CHECK(report IN ('pending', 'delivered', 'suppressed')),
    UNIQUE(caller_session_id, assistant_message_id, content_index),
    CHECK(report IS NULL OR background = 1),
    FOREIGN KEY(caller_session_id, run_id) REFERENCES runs(session_id, id),
    FOREIGN KEY(caller_session_id, assistant_message_id) REFERENCES messages(session_id, id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS delegations_root ON delegations(root_session_id);
  CREATE INDEX IF NOT EXISTS delegations_active ON delegations(finished_at) WHERE finished_at IS NULL;
  CREATE INDEX IF NOT EXISTS delegations_pending_report ON delegations(finished_at) WHERE report = 'pending';
  CREATE TABLE IF NOT EXISTS delegation_items (
    delegation_id TEXT NOT NULL REFERENCES delegations(id), item_index INTEGER NOT NULL CHECK(item_index >= 0),
    status TEXT NOT NULL CHECK(status IN ('not-started', 'running', 'completed', 'failed', 'aborted', 'interrupted')),
    session_id TEXT, run_id TEXT, name TEXT, output TEXT, error TEXT,
    PRIMARY KEY (delegation_id, item_index),
    CHECK(run_id IS NULL OR session_id IS NOT NULL),
    CHECK(status NOT IN ('running', 'completed', 'interrupted') OR run_id IS NOT NULL),
    FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, id)
  ) STRICT;
`

type Row = Record<string, SQLOutputValue>

function readItem(row: Row): DelegationItem {
  return {
    status: row.status as DelegationItem['status'],
    ...(typeof row.session_id === 'string' && { sessionId: row.session_id }),
    ...(typeof row.run_id === 'string' && { runId: row.run_id }),
    ...(typeof row.name === 'string' && { name: row.name }),
    ...(typeof row.output === 'string' && { output: row.output }),
    ...(typeof row.error === 'string' && { error: row.error }),
  }
}

export function readSubagent(data: string, parentSessionId: string): SubagentSession {
  const result: SubagentSession = JSON.parse(data)
  const { role } = result
  if (!parentSessionId || result.parentSessionId !== parentSessionId || typeof result.cwd !== 'string' || !result.cwd
    || !Array.isArray(result.allowedTools) || !result.allowedTools.every(tool => typeof tool === 'string' && tool)
    || (result.mcpToolKeys !== undefined && (!Array.isArray(result.mcpToolKeys) || !result.mcpToolKeys.every(key => typeof key === 'string' && key)))
    || (role !== undefined && (!role || typeof role.name !== 'string' || !role.name || typeof role.systemPrompt !== 'string'
      || !['user', 'project'].includes(role.source)
      || (role.source === 'project' && (typeof role.workspaceId !== 'string' || !role.workspaceId))
      || (role.tools !== undefined && (!Array.isArray(role.tools) || !role.tools.every(tool => typeof tool === 'string' && tool)))))) {
    throw new Error('Invalid subagent session')
  }
  return result
}

export class SubagentStore {
  constructor(private readonly db: DatabaseSync) {}

  saveSession(sessionId: string, metadata: SubagentSession) {
    const data = JSON.stringify(metadata)
    const parent = this.db.prepare(`SELECT p.id FROM sessions p JOIN sessions s ON s.id = ? AND s.workspaceId = p.workspaceId
      WHERE p.id = ? AND NOT EXISTS (SELECT 1 FROM subagent_sessions WHERE session_id = p.id)`)
      .get(sessionId, metadata.parentSessionId)
    if (!parent) throw new Error('Invalid parent session')
    readSubagent(data, metadata.parentSessionId)
    this.db.prepare('INSERT INTO subagent_sessions (session_id, parent_session_id, data) VALUES (?, ?, ?)')
      .run(sessionId, metadata.parentSessionId, data)
  }

  create({ id, callerSessionId, rootSessionId, call, background, mode, items }: Delegation) {
    const row = this.db.prepare(`SELECT m.data FROM messages m LEFT JOIN subagent_sessions s ON s.session_id = m.session_id
      WHERE m.session_id = ? AND m.run_id = ? AND m.id = ? AND coalesce(s.parent_session_id, m.session_id) = ?`)
      .get(callerSessionId, call.runId, call.assistantMessageId, rootSessionId)
    const entry: ConversationMessage | undefined = row && JSON.parse(String(row.data))
    const message = entry?.message
    const block = message?.role === 'assistant' && message.content[call.contentIndex]
    const nested = block && block.type === 'toolCall' && block.name === 'codemode'
      && this.db.prepare(`SELECT 1 FROM nested_tool_calls WHERE session_id = ? AND run_id = ?
        AND assistant_message_id = ? AND content_index = ? AND id = ?
        AND json_extract(data, '$.name') = 'subagent' AND json_extract(data, '$.status') = 'running'`)
        .get(callerSessionId, call.runId, call.assistantMessageId, call.contentIndex, call.toolCallId)
    if (!block || block.type !== 'toolCall' || (block.id !== call.toolCallId && !nested) || !items.length) {
      throw new Error('Invalid delegation tool call')
    }
    this.db.prepare(`INSERT INTO delegations (id, caller_session_id, root_session_id, assistant_message_id, content_index, tool_call_id,
      run_id, background, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, callerSessionId, rootSessionId, call.assistantMessageId, call.contentIndex, call.toolCallId, call.runId, Number(background), mode)
    const insert = this.db.prepare(`INSERT INTO delegation_items (delegation_id, item_index, status, session_id, name)
      VALUES (?, ?, 'not-started', ?, ?)`)
    for (const [index, item] of items.entries()) {
      if (item.status !== 'not-started' || item.runId !== undefined) throw new Error('Invalid initial delegation item')
      insert.run(id, index, item.sessionId ?? null, item.name ?? null)
    }
  }

  writeItem({ id, index, item }: DelegatedItemWrite, run?: { sessionId: string; id: string }) {
    const prior = this.db.prepare(`SELECT i.*, d.root_session_id FROM delegation_items i JOIN delegations d ON d.id = i.delegation_id
      WHERE i.delegation_id = ? AND i.item_index = ? AND d.finished_at IS NULL`).get(id, index)
    if (!prior) throw new Error('Delegation item is unavailable')
    const saved = readItem(prior)
    const next = { ...saved, ...item }
    if (saved.runId !== undefined && (saved.sessionId !== next.sessionId || saved.runId !== next.runId)) {
      throw new Error('Cannot change the accepted delegation run')
    }
    if (saved.status !== 'not-started' && saved.status !== 'running') throw new Error('Delegation item is already finished')
    if (run && (run.sessionId !== next.sessionId || run.id !== next.runId)) throw new Error('Delegation item belongs to another run')
    if (next.runId !== undefined) {
      const linked = this.db.prepare(`SELECT json_extract(r.data, '$.status') AS status FROM runs r
        LEFT JOIN subagent_sessions s ON s.session_id = r.session_id
        WHERE r.session_id = ? AND r.id = ? AND coalesce(s.parent_session_id, r.session_id) = ?`)
        .get(next.sessionId ?? null, next.runId, prior.root_session_id!)
      if (linked?.status !== next.status) throw new Error('Delegation item does not match its stored run')
    }
    this.db.prepare(`UPDATE delegation_items SET status = ?, session_id = ?, run_id = ?, name = ?, output = ?, error = ?
      WHERE delegation_id = ? AND item_index = ?`).run(next.status, next.sessionId ?? null, next.runId ?? null, next.name ?? null,
        next.output ?? null, next.error ?? null, id, index)
  }

  finish(id: string): Delegation {
    if (this.db.prepare("SELECT 1 FROM delegation_items WHERE delegation_id = ? AND status = 'running'").get(id)) {
      throw new Error('Delegation still has running items')
    }
    this.db.prepare(`UPDATE delegations SET finished_at = ?,
      report = CASE WHEN background = 1 THEN coalesce(report, 'pending') END WHERE id = ? AND finished_at IS NULL`).run(Date.now(), id)
    const row = this.db.prepare('SELECT * FROM delegations WHERE id = ?').get(id)
    if (!row) throw new Error('Delegation is unavailable')
    return this.read(row)
  }

  recover(): Delegation[] {
    this.db.exec(`UPDATE delegation_items SET status = 'interrupted', error = '服务中断，子任务未完成'
      WHERE status = 'running' AND delegation_id IN (SELECT id FROM delegations WHERE finished_at IS NULL)`)
    this.db.prepare(`UPDATE delegations SET finished_at = ?,
      report = CASE WHEN background = 1 THEN coalesce(report, 'pending') END WHERE finished_at IS NULL`).run(Date.now())
    return this.db.prepare("SELECT * FROM delegations WHERE report = 'pending' ORDER BY finished_at, rowid").all().map(row => this.read(row))
  }

  list(callerSessionId: string): Delegation[] {
    return this.db.prepare('SELECT * FROM delegations WHERE caller_session_id = ? ORDER BY rowid').all(callerSessionId)
      .map(row => this.read(row))
  }

  markReport(id: string, status: 'delivered' | 'suppressed'): boolean {
    return this.db.prepare("UPDATE delegations SET report = ? WHERE id = ? AND report = 'pending'").run(status, id).changes === 1
  }

  suppressReports(rootSessionId: string) {
    this.db.prepare(`UPDATE delegations SET report = 'suppressed' WHERE root_session_id = ? AND background = 1
      AND (report = 'pending' OR (report IS NULL AND finished_at IS NULL))`).run(rootSessionId)
  }

  private read(row: Row): Delegation {
    const id = String(row.id)
    return {
      id,
      callerSessionId: String(row.caller_session_id),
      rootSessionId: String(row.root_session_id),
      call: { assistantMessageId: String(row.assistant_message_id), contentIndex: Number(row.content_index),
        toolCallId: String(row.tool_call_id), runId: String(row.run_id) },
      background: row.background === 1,
      mode: row.mode as Delegation['mode'],
      items: this.db.prepare('SELECT * FROM delegation_items WHERE delegation_id = ? ORDER BY item_index').all(id).map(readItem),
      ...(typeof row.finished_at === 'number' && { finished: true }),
      ...(typeof row.report === 'string' && { report: row.report as NonNullable<Delegation['report']> }),
    }
  }
}
