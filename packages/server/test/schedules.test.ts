import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionReadError, SessionStore, SessionSubmitError, type ScheduledRun } from '@agent-learning/coding-agent'
import { ScheduleRunner } from '../src/schedule-runner.js'
import { Schedules } from '../src/schedules.js'
import { nextScheduleTime } from '../src/schedule-time.js'

const epoch = Date.parse('2026-11-21T00:00:00Z')
const input = { action: 'create', prompt: 'Run the workspace tests', schedule: { kind: 'daily', time: '09:00' } }
const owner = { sessionId: 'session', workspaceId: 'workspace', runId: 'manual-run' }

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'si-scheduling-'))
  const path = join(folder, 'sessions.sqlite')
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  let database = SessionStore.open(path)
  cleanup.push(() => database.close())
  database.save(owner.sessionId, { summary: { id: owner.sessionId, workspaceId: owner.workspaceId, name: 'Project', createdAt: new Date(epoch).toISOString() } })
  let clock = epoch
  const now = () => clock
  const changed = vi.fn()
  const store = () => database.schedules
  return {
    store, now, advance(to: number) { clock = to },
    addOwner(name: string) {
      database.save(name, { summary: { id: name, workspaceId: owner.workspaceId, name, createdAt: new Date(epoch).toISOString() } })
      return { ...owner, sessionId: name }
    },
    load: (id: string) => database.loadSession(id),
    saveTerminal(sessionId: string) {
      const run = database.loadSession(sessionId)!.runs.at(-1)!
      database.save(sessionId, { run: { ...run, status: 'completed', finishedAt: clock } })
    },
    accept(run: ScheduledRun) {
      const submission = run.submission!
      const sessionId = submission.sessionId
      const id = 'user-' + run.id
      database.save(sessionId, {
        ...(sessionId === run.id && { summary: { id: sessionId, workspaceId: submission.workspaceId, name: 'Delivery', createdAt: new Date(clock).toISOString() } }),
        run: {
          ...submission.modelSelection!, id, sessionId, clientMessageId: run.id, scheduledRunId: run.id,
          kind: 'task', status: 'running', text: submission.text, startedAt: clock, acceptedSeq: 1,
        },
        messages: [{ id, clientMessageId: run.id, message: { role: 'user', content: submission.text, timestamp: clock } }],
        scheduledSubmission: submission,
      })
    },
    service: () => new Schedules(database, now, changed),
    reopen() { database.close(); database = SessionStore.open(path) },
    runner(submit: (run: ScheduledRun, signal: AbortSignal) => Promise<void>) {
      const report = vi.fn()
      const runner = new ScheduleRunner({
        store: store(), now, changed, report,
        prepare: async run => ({ ...run.submission!, modelSelection: { provider: 'deepseek', modelId: 'deepseek-flash' }, permissionMode: 'normal' }),
        submit,
      })
      cleanup.push(() => runner.stop())
      return { runner, report }
    },
  }
}

describe('schedule persistence and recovery', () => {
  it('returns the existing enabled or paused plan and replays a deleted creation by its original run', () => {
    const f = fixture()
    const service = f.service()
    const original = service.manageFromChat(owner, input)
    expect(service.manageFromChat({ ...owner, runId: 'next' }, input)).toMatchObject({ id: original.id, outcome: 'existing' })
    service.edit(original.id, { action: 'pause' })
    expect(service.manageFromChat({ ...owner, runId: 'next' }, input)).toMatchObject({ id: original.id, status: 'paused', outcome: 'existing' })
    service.remove(original.id)
    expect(service.manageFromChat(owner, input)).toMatchObject({ id: original.id, outcome: 'deleted' })
    expect(service.list()).toEqual([])
    expect(service.manageFromChat({ ...owner, runId: 'next' }, input).id).not.toBe(original.id)
  })

  it('submits only the selected weekdays and keeps the saved local time across recurring deliveries', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    const f = fixture()
    f.advance(Date.parse('2026-11-20T16:01:00Z'))
    const rules = [
      { schedule: { kind: 'daily', time: '09:00' }, due: [21, 22, 23, 24, 25, 26, 27] },
      { schedule: { kind: 'weekdays', time: '09:00' }, due: [23, 24, 25, 26, 27] },
      { schedule: { kind: 'weekly', time: '09:00', weekdays: [1, 3] }, due: [23, 25] },
      { schedule: { kind: 'weekly', time: '09:00', weekdays: [3] }, due: [25] },
    ]
    const service = f.service()
    const plans = rules.map(({ schedule }, index) => service.manageFromChat(f.addOwner('schedule-' + index), { ...input, schedule }))
    expect(plans.map(plan => plan.timezone)).toEqual(rules.map(() => 'Asia/Shanghai'))
    const submit = vi.fn(async (run: ScheduledRun) => {
      f.accept(run)
      f.saveTerminal(run.submission!.sessionId)
      runner.finished(run.id)
    })
    const { runner } = f.runner(submit)
    await runner.start()
    for (let day = 21; day <= 27; day++) {
      f.advance(Date.UTC(2026, 10, day, 1))
      await runner.scan()
    }
    expect(submit).toHaveBeenCalledTimes(15)
    for (const [index, plan] of plans.entries()) {
      expect(service.runs(plan.id).reverse()).toMatchObject(
        rules[index]!.due.map(day => ({ scheduledAt: Date.UTC(2026, 10, day, 1), status: 'accepted', runStatus: 'completed' })),
      )
    }
  })

  it.each(['before', 'after'] as const)('looks up the original creation after a fault %s COMMIT', point => {
    const f = fixture()
    const exec = DatabaseSync.prototype.exec
    const transaction = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT') {
        if (point === 'after') exec.call(this, sql)
        throw new Error('fixture commit failure')
      }
      exec.call(this, sql)
    })
    expect(() => f.service().manageFromChat(owner, input)).toThrow()
    transaction.mockRestore()
    f.reopen()
    const saved = f.service().list()
    if (point === 'before') expect(saved).toHaveLength(0)
    else expect(saved).toHaveLength(1)
    const replayed = f.service().manageFromChat(owner, input)
    expect(replayed.outcome).toBe(point === 'after' ? 'existing' : 'created')
    if (saved[0]) expect(replayed.id).toBe(saved[0].id)
    expect(f.service().list()).toHaveLength(1)
  })

  it.each(['restart', 'sleep'] as const)('consolidates missed recurrences after %s and keeps the normal next time', async scenario => {
    const f = fixture()
    const plan = f.service().manageFromChat(owner, input)
    const first = plan.nextRunAt!
    const submit = vi.fn<(run: ScheduledRun) => Promise<void>>(async () => { throw new Error('fixture workspace rejected the message') })
    let active = f.runner(submit).runner
    await active.start()
    if (scenario === 'restart') {
      await active.stop()
      f.reopen()
      active = f.runner(submit).runner
    }
    f.advance(first + 4 * 86400_000)
    if (scenario === 'restart') await active.start()
    else await active.scan()
    await active.scan()
    const runs = f.service().runs(plan.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ scheduledAt: first, status: 'failed', reason: 'fixture workspace rejected the message' })
    expect(submit).toHaveBeenCalledTimes(1)
    const next = f.service().list()[0]!.nextRunAt!
    expect(next).toBe(nextScheduleTime(plan.schedule, plan.timezone, f.now()))
    submit.mockImplementation(async run => { f.accept(run) })
    f.advance(next)
    await active.scan()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(f.service().runs(plan.id)[0]).toMatchObject({ scheduledAt: next, status: 'accepted' })
  })

  it('keeps both the original deadline and an empty execution list if claim rolls back', async () => {
    const f = fixture()
    const plan = f.service().manageFromChat(owner, input)
    const submit = vi.fn(async () => { throw new Error('fixture rejection') })
    const { runner, report } = f.runner(submit)
    await runner.start()
    f.advance(plan.nextRunAt!)
    const exec = DatabaseSync.prototype.exec
    const transaction = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT' && this.prepare('SELECT count(*) AS n FROM scheduled_runs').get()?.n === 1) {
        throw new Error('claim failed before commit')
      }
      exec.call(this, sql)
    })
    await runner.scan()
    expect(report).toHaveBeenCalled()
    expect(f.service().runs(plan.id)).toEqual([])
    expect(f.service().list()[0]?.nextRunAt).toBe(plan.nextRunAt)
    expect(submit).not.toHaveBeenCalled()
    transaction.mockRestore()
    await runner.scan()
    expect(f.service().runs(plan.id)).toHaveLength(1)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('recovers a claimed but unsent run with its original id, prompt and target', async () => {
    const f = fixture()
    const service = f.service()
    const plan = service.manageFromChat(owner, input)
    f.advance(plan.nextRunAt!)
    const savedPlan = f.store().get(plan.id)!
    const next = nextScheduleTime(plan.schedule, plan.timezone, f.now())
    const claim = f.store().claim(savedPlan, next, f.now())!
    service.edit(plan.id, { action: 'update', prompt: 'Updated task', sessionMode: 'new' })
    f.reopen()
    const submit = vi.fn(async run => f.accept(run))
    const { runner } = f.runner(submit)
    await runner.start()
    await runner.scan()
    expect(f.store().runs(plan.id)).toEqual([expect.objectContaining({ id: claim.id, status: 'accepted' })])
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: claim.id, submission: expect.objectContaining({ sessionId: owner.sessionId, text: input.prompt }),
    }), expect.any(AbortSignal))
    expect(f.service().list()[0]?.nextRunAt).toBe(next)
  })
})

describe('when a scheduled message meets a live or changed plan', () => {
  it('skips overlap and distinguishes a session busy with a manual turn', async () => {
    const f = fixture()
    const plan = f.service().manageFromChat(owner, input)
    const submit = vi.fn(async run => f.accept(run))
    const { runner } = f.runner(submit)
    f.advance(plan.nextRunAt!)
    await runner.start()
    f.advance(f.service().list()[0]!.nextRunAt!)
    await runner.scan()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(f.service().runs(plan.id).map(run => [run.status, run.reason])).toEqual([
      ['skipped', '上一轮尚未结束'], ['accepted', undefined],
    ])
    await runner.stop()
    f.reopen()
    const busy = vi.fn(async () => { throw new SessionSubmitError('busy', 'test session is occupied') })
    f.advance(f.service().list()[0]!.nextRunAt!)
    const resumed = f.runner(busy).runner
    await resumed.start()
    expect(busy).toHaveBeenCalledTimes(1)
    expect(f.service().runs(plan.id)[0]).toMatchObject({ status: 'skipped', reason: '会话正在处理其他消息' })
  })

  it('does not overlap a persisted terminal run until its session finishes settling', async () => {
    const f = fixture()
    const plan = f.service().manageFromChat(owner, input)
    f.service().edit(plan.id, { action: 'update', sessionMode: 'new' })
    const submit = vi.fn(async run => f.accept(run))
    const { runner } = f.runner(submit)
    f.advance(plan.nextRunAt!)
    await runner.start()
    const first = f.store().runs(plan.id)[0]!
    f.saveTerminal(first.sessionId!)
    f.advance(f.service().list()[0]!.nextRunAt!)
    await runner.scan()
    expect(f.store().runs(plan.id)[0]).toMatchObject({ status: 'skipped', reason: '上一轮尚未结束' })
    expect(submit).toHaveBeenCalledTimes(1)
    runner.finished(first.id)
    f.advance(f.service().list()[0]!.nextRunAt!)
    await runner.scan()
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('continues scheduling after the live session ends even when its terminal write failed', async () => {
    const f = fixture()
    const plan = f.service().manageFromChat(owner, input)
    const submit = vi.fn(async run => f.accept(run))
    const { runner } = f.runner(submit)
    f.advance(plan.nextRunAt!)
    await runner.start()
    runner.finished(f.store().runs(plan.id)[0]!.id)
    f.advance(f.service().list()[0]!.nextRunAt!)
    await runner.scan()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(f.store().runs(plan.id)[0]).toMatchObject({ status: 'accepted' })
  })

  it('cancels a blocked handoff on shutdown and resumes it under the original ID on restart', async () => {
    const f = fixture()
    const plan = f.service().manageFromChat(owner, input)
    const handedOff = Promise.withResolvers<ScheduledRun>()
    const { runner } = f.runner((run, signal) => {
      if (!signal) {
        handedOff.reject(new Error('The handoff did not receive a shutdown signal'))
        return Promise.resolve()
      }
      handedOff.resolve(run)
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    f.advance(plan.nextRunAt!)
    const start = runner.start()
    const claim = await handedOff.promise
    await runner.stop()
    await start
    expect(f.load(owner.sessionId)?.messages).toHaveLength(0)
    f.reopen()
    const resumed = f.runner(async run => f.accept(run)).runner
    await resumed.start()
    expect(f.store().runs(plan.id)).toEqual([expect.objectContaining({ id: claim.id, status: 'accepted' })])
  })

  it('keeps an unknown submission ID and input while receipt reads are unavailable', async () => {
    const f = fixture()
    const plan = f.service().manageFromChat(owner, input)
    f.advance(plan.nextRunAt!)
    const submit = vi.fn(async () => { throw new SessionReadError('fixture receipt temporarily unavailable') })
    const { runner } = f.runner(submit)
    await runner.start()
    await runner.scan()
    const record = f.store().runs(plan.id)[0]!
    expect(record).toMatchObject({ status: 'unknown', submission: { text: input.prompt, sessionId: owner.sessionId } })
    expect(submit).toHaveBeenCalledTimes(1)
    await runner.stop()
    f.reopen()
    const resumed = f.runner(async run => f.accept(run)).runner
    await resumed.start()
    expect(f.store().runs(plan.id)).toEqual([expect.objectContaining({ id: record.id, status: 'accepted' })])
    expect(f.load(owner.sessionId)?.messages).toHaveLength(1)
  })

  it.each(['reuse', 'new'] as const)('finds the original %s receipt after the accept call loses its response', async mode => {
    const f = fixture()
    const plan = f.service().manageFromChat(owner, input)
    f.service().edit(plan.id, { action: 'update', sessionMode: mode })
    f.advance(plan.nextRunAt!)
    const { runner } = f.runner(async run => {
      f.accept(run)
      throw new SessionReadError('accept saved but its response was lost')
    })
    await runner.start()
    await runner.stop()
    const original = f.store().runs(plan.id)[0]!
    expect(original).toMatchObject({ status: 'accepted', runStatus: 'running' })
    f.reopen()
    const submit = vi.fn(async run => f.accept(run))
    const resumed = f.runner(submit).runner
    await resumed.start()
    expect(f.store().runs(plan.id)).toEqual([
      expect.objectContaining({ status: 'accepted', id: original.id, sessionId: original.sessionId, runId: original.runId, runStatus: 'interrupted' }),
    ])
    expect(f.load(original.sessionId!)?.messages).toHaveLength(1)
    expect(submit).not.toHaveBeenCalled()
    f.advance(f.service().list()[0]!.nextRunAt!)
    await resumed.scan()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it.each(['pause', 'delete', 'reschedule'] as const)('lets %s and acceptance take effect in actual commit order', async action => {
    function admin(f: ReturnType<typeof fixture>, id: string) {
      const service = f.service()
      if (action === 'delete') service.remove(id)
      else if (action === 'pause') service.edit(id, { action: 'pause' })
      else service.edit(id, { action: 'update', schedule: { kind: 'weekdays', time: '20:00' } })
    }

    for (const acceptFirst of [false, true]) {
      const f = fixture()
      const plan = f.service().manageFromChat(owner, input)
      f.advance(plan.nextRunAt!)
      const { runner } = f.runner(async run => {
        if (acceptFirst) f.accept(run)
        admin(f, plan.id)
        if (!acceptFirst) f.accept(run)
      })
      await runner.start()
      const result = f.store().runs(plan.id)[0]!
      expect(result.status).toBe(acceptFirst ? 'accepted' : 'skipped')
      expect(f.load(owner.sessionId)?.messages).toHaveLength(acceptFirst ? 1 : 0)
    }
  })
})
