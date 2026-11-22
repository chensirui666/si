import { randomUUID } from 'node:crypto'
import type { ScheduledPlan, SessionStore } from '@agent-learning/coding-agent'
import { nextScheduleTime, parseSchedule } from './schedule-time.js'
import { isSettingsObject } from './settings-file.js'
import type { ScheduledRunView, ScheduleView } from './webserver/protocol.js'

export class ScheduleError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message) }
}

type Owner = { sessionId: string; workspaceId: string; runId: string }

function scheduleView({ creationRunId: _run, deleted: _deleted, ...plan }: ScheduledPlan): ScheduleView {
  return plan
}

function checkedPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 32_000) throw new ScheduleError(400, '请填写有效的定时任务说明')
  return value.trim()
}

function checkedSchedule(value: unknown) {
  const rule = parseSchedule(value)
  if (!rule) throw new ScheduleError(400, '请指定有效的执行时间和重复规则。支持每天、工作日或每周指定星期。')
  return rule
}

function onlyFields(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new ScheduleError(400, '定时任务包含不可修改或未知的字段')
}

export class Schedules {
  constructor(
    private readonly store: SessionStore,
    private readonly now: () => number,
    private readonly changed: () => void,
  ) {}

  list() { return this.store.schedules.list().map(scheduleView) }

  runs(id: string): ScheduledRunView[] {
    this.livePlan(id)
    return this.store.schedules.runs(id).map(({ submission: _submission, ...run }) => run)
  }

  private livePlan(id: string): ScheduledPlan {
    const plan = this.store.schedules.get(id)
    if (!plan || plan.deleted) throw new ScheduleError(404, '定时任务已不可用')
    return plan
  }

  private create(owner: Owner, input: Record<string, unknown>) {
    onlyFields(input, ['action', 'prompt', 'schedule'])
    const prompt = checkedPrompt(input.prompt)
    const schedule = checkedSchedule(input.schedule)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const id = randomUUID()
    const saved = this.store.schedules.create({
      id, sessionId: owner.sessionId, workspaceId: owner.workspaceId, creationRunId: owner.runId, prompt, schedule, timezone,
      sessionMode: 'reuse', status: 'enabled', nextRunAt: nextScheduleTime(schedule, timezone, this.now()),
    })
    if (saved.id === id) this.changed()
    return { ...scheduleView(saved), outcome: saved.deleted ? 'deleted' : saved.id === id ? 'created' : 'existing' }
  }

  manageFromChat(owner: Owner, input: unknown) {
    if (!isSettingsObject(input)) throw new ScheduleError(400, '请提交有效的定时任务操作')
    if (input.action === 'create') return this.create(owner, input)

    const current = this.store.schedules.findForSession(owner.sessionId)
    if (!current || current.workspaceId !== owner.workspaceId || ('id' in input && current.id !== input.id)) {
      throw new ScheduleError(404, '当前会话没有这条定时任务')
    }
    const { id: _id, ...patch } = input
    if (patch.action === 'delete') {
      onlyFields(patch, ['action'])
      return { ...this.remove(current.id), outcome: 'deleted' }
    }
    return { ...this.edit(current.id, patch), outcome: 'updated' }
  }

  edit(id: string, input: unknown): ScheduleView {
    if (!isSettingsObject(input)) throw new ScheduleError(400, '请提交有效的定时任务操作')
    const plan = this.livePlan(id)
    let invalidateReason: string | undefined
    switch (input.action) {
      case 'pause':
        onlyFields(input, ['action'])
        plan.status = 'paused'
        plan.nextRunAt = null
        invalidateReason = '计划已暂停'
        break
      case 'resume':
        onlyFields(input, ['action'])
        if (plan.status === 'paused') {
          plan.status = 'enabled'
          plan.nextRunAt = nextScheduleTime(plan.schedule, plan.timezone, this.now())
        }
        break
      case 'update': {
        onlyFields(input, ['action', 'prompt', 'schedule', 'sessionMode'])
        if ('prompt' in input) plan.prompt = checkedPrompt(input.prompt)
        if ('sessionMode' in input) {
          if (input.sessionMode !== 'reuse' && input.sessionMode !== 'new') throw new ScheduleError(400, '执行会话方式无效')
          plan.sessionMode = input.sessionMode
        }
        if ('schedule' in input) {
          const schedule = checkedSchedule(input.schedule)
          if (JSON.stringify(schedule) !== JSON.stringify(plan.schedule)) {
            plan.schedule = schedule
            if (plan.status === 'enabled') plan.nextRunAt = nextScheduleTime(schedule, plan.timezone, this.now())
            invalidateReason = '日程已修改'
          }
        }
        break
      }
      default: throw new ScheduleError(400, '定时任务操作无效')
    }
    const saved = this.store.schedules.update(plan, invalidateReason)
    this.changed()
    return scheduleView(saved)
  }

  remove(id: string): ScheduleView {
    const plan = this.livePlan(id)
    const saved = this.store.schedules.update({ ...plan, deleted: true, nextRunAt: null }, '计划已删除')
    this.changed()
    return scheduleView(saved)
  }
}
