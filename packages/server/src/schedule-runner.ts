import { SessionReadError, SessionSubmitError, SessionWriteError, type ScheduledRun, type ScheduledSubmission, type SessionStore } from '@agent-learning/coding-agent'
import { nextScheduleTime } from './schedule-time.js'

type Options = {
  store: SessionStore['schedules']
  now(): number
  prepare(run: ScheduledRun): Promise<ScheduledSubmission>
  submit(run: ScheduledRun, signal: AbortSignal): Promise<void>
  changed(): void
  report(error: unknown): void
}

export class ScheduleRunner {
  private interval?: ReturnType<typeof setInterval>
  private scanning?: Promise<void>
  private readonly shutdown = new AbortController()
  private recovering = true
  // The session can still be running its settled hook after saving the terminal result.
  private readonly active = new Map<string, string>()

  constructor(private readonly options: Options) {}

  async start() {
    await this.scan()
    if (this.shutdown.signal.aborted || this.interval) return
    this.interval = setInterval(() => { void this.scan() }, 60_000)
    this.interval.unref()
  }

  scan(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve()
    return this.scanning ??= Promise.resolve().then(() => this.tick())
      .catch(this.options.report).finally(() => { this.scanning = undefined })
  }

  finished(runId: string) {
    for (const [scheduleId, activeId] of this.active) {
      if (activeId !== runId) continue
      this.active.delete(scheduleId)
      this.options.changed()
      break
    }
  }

  async stop() {
    this.shutdown.abort()
    clearInterval(this.interval)
    await this.scanning
  }

  private async tick() {
    if (this.shutdown.signal.aborted) return
    const { store, changed, report } = this.options
    const now = this.options.now()
    if (store.recover(now, this.recovering)) changed()
    this.recovering = false
    for (const run of store.pending()) {
      if (this.shutdown.signal.aborted) return
      try { await this.deliver(run) } catch (error) { report(error) }
    }
    for (const plan of store.due(now)) {
      if (this.shutdown.signal.aborted) return
      try {
        const run = store.claim(plan, nextScheduleTime(plan.schedule, plan.timezone, now), now)
        if (run) {
          changed()
          await this.deliver(run)
        }
      } catch (error) { report(error) }
    }
  }

  private async deliver(run: ScheduledRun) {
    const { store, changed } = this.options
    if (this.active.has(run.scheduleId)) {
      store.settle(run.id, 'skipped', '上一轮尚未结束')
      changed()
      return
    }

    let preparing = true
    try {
      const submission = await this.options.prepare(run)
      if (this.shutdown.signal.aborted || !store.prepare(run.id, submission)) return
      preparing = false
      this.active.set(run.scheduleId, run.id)
      await this.options.submit({ ...run, submission }, this.shutdown.signal)
    } catch (error) {
      this.active.delete(run.scheduleId)
      if (this.shutdown.signal.aborted) return
      const reason = error instanceof Error ? error.message : '无法提交定时任务'
      if (error instanceof SessionSubmitError && error.code === 'busy') {
        store.settle(run.id, 'skipped', '会话正在处理其他消息')
      } else if (!preparing && (error instanceof SessionReadError || error instanceof SessionWriteError && error.reason === 'unconfirmed')) {
        store.settle(run.id, 'unknown', reason)
      } else {
        store.settle(run.id, 'failed', reason)
      }
    }
    changed()
  }
}
