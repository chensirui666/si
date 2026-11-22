import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { ModelSelection } from '@agent-learning/model'
import type { PermissionMode } from './permissions.js'
import type { RunRecord } from './types.js'

export type ScheduleRule =
  | { kind: 'daily' | 'weekdays'; time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }

export type ScheduledPlan = {
  id: string
  sessionId: string
  creationRunId: string
  workspaceId: string
  prompt: string
  schedule: ScheduleRule
  timezone: string
  sessionMode: 'reuse' | 'new'
  status: 'enabled' | 'paused'
  nextRunAt: number | null
  deleted?: true
}

export type ScheduledSubmission = {
  workspaceId: string
  sessionId: string
  text: string
  modelSelection?: ModelSelection
  permissionMode?: PermissionMode
}

export type ScheduledRun = {
  id: string
  scheduleId: string
  scheduledAt: number
  claimedAt: number
  status: 'pending' | 'submitting' | 'accepted' | 'skipped' | 'failed' | 'unknown'
  reason?: string
  submission?: ScheduledSubmission
  sessionId?: string
  runId?: string
}

export type ScheduledRunView = ScheduledRun & { runStatus?: RunRecord['status']; acceptedAt?: number }

export const scheduleSchema = `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), creation_run_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL, prompt TEXT NOT NULL, schedule_rule TEXT NOT NULL CHECK(json_valid(schedule_rule)),
    timezone TEXT NOT NULL, session_mode TEXT NOT NULL CHECK(session_mode IN ('reuse', 'new')),
    status TEXT NOT NULL CHECK(status IN ('enabled', 'paused')), next_run_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, creation_run_id),
    CHECK(deleted IN (0, 1)),
    CHECK((deleted = 0 AND status = 'enabled') = (next_run_at IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS schedules_active_session ON schedules(session_id) WHERE deleted = 0;
  CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_run_at) WHERE next_run_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS scheduled_runs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id), scheduled_at INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'submitting', 'accepted', 'skipped', 'failed', 'unknown')),
    reason TEXT, submission TEXT CHECK(json_valid(submission)), session_id TEXT, run_id TEXT,
    UNIQUE(schedule_id, scheduled_at),
    CHECK((session_id IS NULL) = (run_id IS NULL)),
    CHECK((status = 'accepted') = (run_id IS NOT NULL)),
    FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, id)
  ) STRICT;
`

type Row = Record<string, SQLOutputValue>

function readPlan(row: Row): ScheduledPlan {
  return {
    id: String(row.id), sessionId: String(row.session_id), creationRunId: String(row.creation_run_id),
    workspaceId: String(row.workspace_id), prompt: String(row.prompt), schedule: JSON.parse(String(row.schedule_rule)),
    timezone: String(row.timezone), sessionMode: row.session_mode as ScheduledPlan['sessionMode'],
    status: row.status as ScheduledPlan['status'], nextRunAt: row.next_run_at as number | null,
    ...(row.deleted === 1 && { deleted: true }),
  }
}

function readRun(row: Row): ScheduledRunView {
  return {
    id: String(row.id), scheduleId: String(row.schedule_id), scheduledAt: Number(row.scheduled_at), claimedAt: Number(row.claimed_at),
    status: row.status as ScheduledRun['status'],
    ...(typeof row.reason === 'string' && { reason: row.reason }),
    ...(typeof row.submission === 'string' && { submission: JSON.parse(row.submission) }),
    ...(typeof row.session_id === 'string' && { sessionId: row.session_id }),
    ...(typeof row.run_id === 'string' && { runId: row.run_id }),
    ...(typeof row.runStatus === 'string' && { runStatus: row.runStatus as RunRecord['status'] }),
    ...(typeof row.acceptedAt === 'number' && { acceptedAt: row.acceptedAt }),
  }
}

export class ScheduleStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(operation: () => T) => T,
    private readonly assertReadable: () => void,
  ) {}

  list(): ScheduledPlan[] {
    this.assertReadable()
    return this.db.prepare('SELECT * FROM schedules WHERE deleted = 0 ORDER BY rowid').all().map(readPlan)
  }

  get(id: string): ScheduledPlan | undefined {
    this.assertReadable()
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id)
    return row && readPlan(row)
  }

  findForSession(sessionId: string): ScheduledPlan | undefined {
    this.assertReadable()
    const row = this.db.prepare('SELECT * FROM schedules WHERE session_id = ? AND deleted = 0').get(sessionId)
    return row && readPlan(row)
  }

  create(plan: ScheduledPlan): ScheduledPlan {
    return this.write(() => {
      const prior = this.db.prepare('SELECT * FROM schedules WHERE session_id = ? AND creation_run_id = ?')
        .get(plan.sessionId, plan.creationRunId)
      if (prior) return readPlan(prior)
      const existing = this.findForSession(plan.sessionId)
      if (existing) return existing
      if (!this.db.prepare('SELECT 1 FROM sessions WHERE id = ? AND workspaceId = ?').get(plan.sessionId, plan.workspaceId)) {
        throw new Error('所属会话或项目已不可用')
      }
      this.db.prepare(`INSERT INTO schedules
        (id, session_id, creation_run_id, workspace_id, prompt, schedule_rule, timezone, session_mode, status, next_run_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.id, plan.sessionId, plan.creationRunId, plan.workspaceId,
        plan.prompt, JSON.stringify(plan.schedule), plan.timezone, plan.sessionMode, plan.status, plan.nextRunAt)
      return plan
    })
  }

  update(plan: ScheduledPlan, invalidateReason?: string): ScheduledPlan {
    return this.write(() => {
      const row = this.db.prepare(`UPDATE schedules SET prompt = ?, schedule_rule = ?, session_mode = ?,
        status = ?, next_run_at = ?, deleted = ? WHERE id = ? AND deleted = 0 RETURNING *`)
        .get(plan.prompt, JSON.stringify(plan.schedule), plan.sessionMode, plan.status, plan.nextRunAt, Number(plan.deleted === true), plan.id)
      if (!row) throw new Error('定时任务已不可用')
      if (invalidateReason) this.db.prepare(`UPDATE scheduled_runs SET status = 'skipped', reason = ?
        WHERE schedule_id = ? AND status IN ('pending', 'submitting', 'unknown')`).run(invalidateReason, plan.id)
      return readPlan(row)
    })
  }

  due(now: number): ScheduledPlan[] {
    this.assertReadable()
    return this.db.prepare('SELECT * FROM schedules WHERE next_run_at <= ? ORDER BY next_run_at, rowid').all(now).map(readPlan)
  }

  claim(plan: ScheduledPlan, nextRunAt: number, claimedAt: number): ScheduledRun | undefined {
    if (plan.nextRunAt === null || plan.nextRunAt > claimedAt) return
    return this.write(() => {
      const row = this.db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ? AND next_run_at = ?
        AND schedule_rule = ? RETURNING *`).get(nextRunAt, plan.id, plan.nextRunAt, JSON.stringify(plan.schedule))
      if (!row) return
      const current = readPlan(row)
      const id = randomUUID()
      const submission: ScheduledSubmission = {
        sessionId: current.sessionMode === 'reuse' ? current.sessionId : id,
        workspaceId: current.workspaceId,
        text: current.prompt,
      }
      const run = this.db.prepare(`INSERT INTO scheduled_runs (id, schedule_id, scheduled_at, claimed_at, status, submission)
        VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT(schedule_id, scheduled_at) DO NOTHING RETURNING *`)
        .get(id, current.id, plan.nextRunAt, claimedAt, JSON.stringify(submission))
      return run && readRun(run)
    })
  }

  pending(): ScheduledRun[] {
    this.assertReadable()
    return this.db.prepare(`SELECT * FROM scheduled_runs WHERE status = 'pending' ORDER BY scheduled_at, rowid`).all().map(readRun)
  }

  runs(scheduleId: string): ScheduledRunView[] {
    this.assertReadable()
    return this.db.prepare(`SELECT s.*, json_extract(r.data, '$.status') AS runStatus,
        json_extract(r.data, '$.startedAt') AS acceptedAt
      FROM scheduled_runs s LEFT JOIN runs r ON r.session_id = s.session_id AND r.id = s.run_id
      WHERE s.schedule_id = ? ORDER BY s.scheduled_at DESC`).all(scheduleId).map(readRun)
  }

  prepare(id: string, submission: ScheduledSubmission): boolean {
    if (!submission.modelSelection || !submission.permissionMode) return false
    return this.write(() => this.db.prepare(`UPDATE scheduled_runs SET status = 'submitting', submission = ?
      WHERE id = ? AND status = 'pending' AND json_extract(submission, '$.sessionId') = ?
        AND json_extract(submission, '$.workspaceId') = ? AND json_extract(submission, '$.text') = ?`)
      .run(JSON.stringify(submission), id, submission.sessionId, submission.workspaceId, submission.text).changes === 1)
  }

  settle(id: string, status: 'skipped' | 'failed' | 'unknown', reason: string): void {
    this.write(() => {
      this.db.prepare(`UPDATE scheduled_runs SET status = ?, reason = ? WHERE id = ? AND status IN ('pending', 'submitting')`)
        .run(status, reason, id)
    })
  }

  recover(now = Date.now(), restart = true): boolean {
    return this.write(() => {
      const receipt = this.db.prepare(`UPDATE scheduled_runs AS s SET status = 'accepted', reason = NULL, session_id = r.session_id, run_id = r.id
        FROM runs AS r WHERE s.status IN ('submitting', 'unknown') AND r.client_id = s.id
          AND r.session_id = json_extract(s.submission, '$.sessionId') AND json_extract(r.data, '$.scheduledRunId') = s.id`).run()
      if (!restart) return receipt.changes !== 0
      const interrupted = this.db.prepare(`UPDATE runs AS r SET data = json_set(r.data, '$.status', 'interrupted', '$.finishedAt', ?)
        WHERE json_extract(r.data, '$.status') = 'running' AND EXISTS (
          SELECT 1 FROM scheduled_runs s WHERE s.status = 'accepted' AND s.session_id = r.session_id AND s.run_id = r.id
        )`).run(now)
      // This process owns the database. An absent receipt after reopening proves the acceptance rolled back.
      const unaccepted = this.db.prepare(`UPDATE scheduled_runs SET status = 'pending', reason = NULL
        WHERE status IN ('submitting', 'unknown')`).run()
      return receipt.changes !== 0 || interrupted.changes !== 0 || unaccepted.changes !== 0
    })
  }

  // Called inside the transaction that inserts the user message and its run.
  accept(id: string, runId: string, submission: ScheduledSubmission): void {
    const saved = this.db.prepare(`UPDATE scheduled_runs SET status = 'accepted', session_id = ?, run_id = ?, submission = ?
      WHERE id = ? AND status = 'submitting' AND json_extract(submission, '$.sessionId') = ?
        AND json_extract(submission, '$.workspaceId') = ? AND json_extract(submission, '$.text') = ?
        AND EXISTS (SELECT 1 FROM schedules p WHERE p.id = schedule_id AND p.deleted = 0 AND p.status = 'enabled')`)
      .run(submission.sessionId, runId, JSON.stringify(submission), id, submission.sessionId, submission.workspaceId, submission.text)
    if (saved.changes !== 1) throw new Error('定时任务已变更，本轮未接收')
  }
}
