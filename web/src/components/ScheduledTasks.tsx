import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { CalendarClockIcon, ChevronDownIcon, CirclePauseIcon, CirclePlayIcon, EllipsisIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import type { SchedulePatch, ScheduleView, SessionSummary, WorkspaceView } from '@agent-learning/server/protocol'
import { deleteSchedule, getSchedules, updateSchedule } from '../chat/client'
import { errorNotice, NoticeText, type Notice } from '../i18n/messages'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { SidebarDismiss, useSidebar } from './ui/sidebar'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

const weekdays = [1, 2, 3, 4, 5, 6, 7]
const scheduleStatuses = ['enabled', 'paused'] as const

function weekdayName(day: number, locale: string) {
  // January 1, 2024 was a Monday.
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short' }).format(Date.UTC(2024, 0, day))
}

function localTime(time: number, timezone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(time)
}

function frequency(rule: ScheduleView['schedule'], locale: string, t: TFunction) {
  if (rule.kind !== 'weekly') return t(`schedule.${rule.kind}`)
  const days = new Intl.ListFormat(locale).format(rule.weekdays.map(day => weekdayName(day, locale)))
  return t('schedule.weeklySummary', { days })
}

export function useScheduleCatalog(revision: number, active: boolean) {
  const [view, setView] = useState<ScheduleView[]>()
  const [error, setError] = useState<Notice>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active) return
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
    void getSchedules(signal).then(value => {
      if (lifetime.signal.aborted) return
      setView(value)
      setError(undefined)
    }).catch(failure => {
      if (!lifetime.signal.aborted) setError(errorNotice('schedule.readFailed', failure))
    })
    return () => lifetime.abort()
  }, [active, revision, retry])
  return { view, setView, error, retry: () => setRetry(value => value + 1) }
}

type CreateAction = { createDisabled: boolean; onCreate(trigger: HTMLButtonElement): void }

export type ScheduleDialogRequest = { kind: 'edit' | 'delete'; schedule: ScheduleView; trigger: HTMLButtonElement | null }

type TaskActions = {
  onSelect(schedule: ScheduleView): void
  onRun(schedule: ScheduleView): void
  onDialog(request: ScheduleDialogRequest): void
  onChanged(schedule?: ScheduleView): void
}

export function ScheduledTaskSidebar({ schedules, sessions, selectedId, onCreate, createDisabled, ...actions }: CreateAction & TaskActions & {
  schedules?: ScheduleView[]
  sessions: SessionSummary[] | null
  selectedId?: string
}) {
  const { t } = useTranslation()
  const titles = new Map(sessions?.map(session => [session.id, session.name]))
  return <>
    <SidebarDismiss>
      <Button type="button" variant="ghost" className="sidebar-new-session" disabled={createDisabled}
        onClick={event => onCreate(event.currentTarget)}><PlusIcon aria-hidden="true" />{t('schedule.newTask')}</Button>
    </SidebarDismiss>
    <nav className="schedule-groups" aria-label={t('schedule.title')}>
      {scheduleStatuses.map(status => <section key={status} aria-label={t(`schedule.${status}`)}>
        <h2>{t(`schedule.${status}`)}</h2>
        <ul role="list">{schedules?.filter(row => row.status === status).map(row =>
          <ScheduledTaskRow key={row.id} schedule={row} title={titles.get(row.sessionId) || t('chat.title')}
            selected={row.id === selectedId} {...actions} />)}</ul>
      </section>)}
    </nav>
  </>
}

function ScheduledTaskRow({ schedule, title, selected, onSelect, onRun, onDialog, onChanged }: TaskActions & {
  schedule: ScheduleView
  title: string
  selected: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? i18n.language
  const { dismissOnMobile } = useSidebar()
  const trigger = useRef<HTMLButtonElement>(null)
  const changing = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Notice>()
  const isEnabled = schedule.status === 'enabled'

  async function toggle() {
    if (changing.current) return
    changing.current = true
    setPending(true)
    setError(undefined)
    let saved: ScheduleView | undefined
    try {
      saved = await updateSchedule(schedule.id, { action: isEnabled ? 'pause' : 'resume' })
    } catch (failure) {
      setError(errorNotice('schedule.saveFailed', failure))
    } finally {
      onChanged(saved)
      changing.current = false
      setPending(false)
    }
  }

  function openDialog(kind: ScheduleDialogRequest['kind']) {
    onDialog({ kind, schedule, trigger: trigger.current })
    dismissOnMobile()
  }

  return <li className="schedule-row" data-task-session-id={schedule.sessionId} data-selected={selected}>
    <SidebarDismiss>
      <Button type="button" className="schedule-list-button" variant="ghost"
        aria-current={selected ? 'true' : undefined} onClick={() => onSelect(schedule)}>
        <span className="sidebar-session-title" title={title}>{title}</span>
        <span className="schedule-meta">
          {schedule.nextRunAt !== null && <><time dateTime={new Date(schedule.nextRunAt).toISOString()}>{localTime(schedule.nextRunAt, schedule.timezone, locale)}</time> · </>}
          {frequency(schedule.schedule, locale, t)}
        </span>
      </Button>
    </SidebarDismiss>
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button ref={trigger} type="button" className="schedule-row-actions" variant="ghost" size="icon-sm"
          aria-label={t('schedule.actions', { name: title })} disabled={pending}><EllipsisIcon aria-hidden="true" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="schedule-row-menu">
        <DropdownMenuItem onSelect={() => { void toggle() }}>
          {isEnabled ? <CirclePauseIcon aria-hidden="true" /> : <CirclePlayIcon aria-hidden="true" />}
          {t(isEnabled ? 'schedule.pause' : 'schedule.resume')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { onRun(schedule); dismissOnMobile() }}><PlayIcon aria-hidden="true" />{t('schedule.runNow')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog('edit')}><PencilIcon aria-hidden="true" />{t('schedule.edit')}</DropdownMenuItem>
        <DropdownMenuItem className="schedule-delete-action" onSelect={() => openDialog('delete')}><Trash2Icon aria-hidden="true" />{t('schedule.delete')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {error && <p className="schedule-error" role="alert"><NoticeText notice={error} /></p>}
  </li>
}

export function ScheduledTasks({ catalog, createDisabled, onCreate }: CreateAction & {
  catalog: ReturnType<typeof useScheduleCatalog>
}) {
  const { t } = useTranslation()
  const { view: schedules, error, retry } = catalog
  return <main className="scheduled-tasks" aria-labelledby="scheduled-tasks-heading">
    <h1 className="sr-only" id="scheduled-tasks-heading">{t('schedule.title')}</h1>
    {error && <div className="schedule-notice">
      <p role="alert"><NoticeText notice={error} /></p>
      <Button type="button" variant="outline" size="sm" onClick={retry}>{t('schedule.retry')}</Button>
    </div>}
    {schedules === undefined && !error && <p role="status">{t('schedule.loading')}</p>}
    <div className="schedule-welcome">
      <span className="schedule-welcome-icon"><CalendarClockIcon aria-hidden="true" /></span>
      <h2>{t('schedule.welcome')}</h2>
      <p>{t('schedule.empty')}</p>
      <Button type="button" disabled={createDisabled} onClick={event => onCreate(event.currentTarget)}>
        <PlusIcon aria-hidden="true" />{t('schedule.createTask')}
      </Button>
    </div>
  </main>
}

type TimingDraft = { kind: ScheduleView['schedule']['kind']; time: string; days: number[] }

function toSchedule({ kind, time, days }: TimingDraft): ScheduleView['schedule'] {
  return kind === 'weekly' ? { kind, time, weekdays: days } : { kind, time }
}

const quarterHourTimes = Array.from({ length: 24 * 4 }, (_, index) => {
  const hour = String(Math.floor(index / 4)).padStart(2, '0')
  const minute = String((index % 4) * 15).padStart(2, '0')
  return `${hour}:${minute}`
})

function ScheduleTime({ time, timezone, disabled, onChange }: {
  time: string
  timezone: string
  disabled: boolean
  onChange(time: string): void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [editingTime, setEditingTime] = useState(false)
  const times = time && !quarterHourTimes.includes(time) ? [...quarterHourTimes, time].sort() : quarterHourTimes

  return <>
    <div className="schedule-field">
      <label htmlFor={`${id}-time`}>{t('schedule.time')}</label>
      <div className="schedule-time">
        <span id={`${id}-timezone`}>{timezone}</span>
        <Select value={editingTime ? 'custom' : time} disabled={disabled} onValueChange={value => {
          setEditingTime(value === 'custom')
          if (value !== 'custom') onChange(value)
        }}>
          <SelectTrigger id={`${id}-time`} aria-describedby={`${id}-timezone`}><SelectValue /></SelectTrigger>
          <SelectContent data-schedule-time="" align="end">
            <SelectItem value="custom">{t('schedule.customTimeOption')}</SelectItem>
            {times.map(value => <SelectItem value={value} key={value}>{value}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
    {editingTime && <div className="schedule-field">
      <label htmlFor={`${id}-custom`}>{t('schedule.customTime')}</label>
      <Input id={`${id}-custom`} type="time" value={time} required disabled={disabled}
        aria-describedby={`${id}-timezone`} onChange={event => onChange(event.target.value)} />
    </div>}
  </>
}

function ScheduleTiming({ timing, onChange, timezone, pending }: {
  timing: TimingDraft
  onChange(timing: TimingDraft): void
  timezone: string
  pending: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? i18n.language
  const id = useId()
  const { kind, time, days } = timing
  return <>
    <div className="schedule-field">
      <label htmlFor={`${id}-kind`}>{t('schedule.repeats')}</label>
      <Select value={kind} disabled={pending} onValueChange={(value: TimingDraft['kind']) => onChange({ ...timing, kind: value })}>
        <SelectTrigger id={`${id}-kind`}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="daily">{t('schedule.daily')}</SelectItem>
          <SelectItem value="weekdays">{t('schedule.weekdays')}</SelectItem>
          <SelectItem value="weekly">{t('schedule.weekly')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    {kind === 'weekly' && <fieldset className="schedule-weekdays">
      <legend className="sr-only">{t('schedule.weekdaySelection')}</legend>
      {weekdays.map(day => {
        const checked = days.includes(day)
        return <Button key={day} type="button" variant={checked ? 'secondary' : 'ghost'} size="sm" aria-pressed={checked} disabled={pending}
          onClick={() => onChange({ ...timing, days: checked ? days.filter(item => item !== day) : [...days, day].sort() })}>
          {weekdayName(day, locale)}
        </Button>
      })}
      {!days.length && <p role="status" className="schedule-error">{t('schedule.weekdayRequired')}</p>}
    </fieldset>}
    <ScheduleTime time={time} timezone={timezone} disabled={pending} onChange={value => onChange({ ...timing, time: value })} />
  </>
}

export function ScheduleCreateDialog({ workspaces, preferredWorkspaceId, picking, blocker, error, phase, onPickWorkspace, onSubmit, onRetry, onClose, restoreFocus }: {
  workspaces: WorkspaceView | null
  preferredWorkspaceId?: string
  picking: boolean
  blocker?: Notice
  error?: Notice | null
  phase: 'sending' | 'unconfirmed' | null
  onPickWorkspace(): Promise<string | undefined>
  onSubmit(workspaceId: string, text: string): void
  onRetry(): void
  onClose(): void
  restoreFocus(): void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? i18n.language
  const id = useId()
  const [prompt, setPrompt] = useState('')
  const [timing, setTiming] = useState<TimingDraft>({ kind: 'daily', time: '09:00', days: [] })
  const [project, setProject] = useState<string>()
  const available = workspaces?.workspaces.filter(item => item.available) ?? []
  const workspaceId = project ?? available.find(item => item.id === preferredWorkspaceId)?.id ?? available[0]?.id ?? ''
  const hasWorkspace = available.some(item => item.id === workspaceId)
  const busy = phase !== null || picking
  const canSubmit = !busy && !blocker && hasWorkspace && prompt.trim() && timing.time && (timing.kind !== 'weekly' || timing.days.length > 0)

  return <Dialog open onOpenChange={open => { if (!open && phase !== 'sending') onClose() }}>
    <DialogContent className="schedule-dialog schedule-create-dialog" closeLabel={t('common.close')}
      onCloseAutoFocus={event => { event.preventDefault(); restoreFocus() }}>
      <DialogTitle>{t('schedule.createTitle')}</DialogTitle>
      <DialogDescription>{t('schedule.createDescription')}</DialogDescription>
      <form className="schedule-editor" onSubmit={event => {
        event.preventDefault()
        if (canSubmit) onSubmit(workspaceId, t('schedule.createMessage', {
          prompt: prompt.trim(), repeat: frequency(toSchedule(timing), locale, t), time: timing.time,
        }))
      }}>
        <div className="schedule-prompt-field">
          <label htmlFor={`${id}-prompt`}>{t('schedule.prompt')}</label>
          <Textarea id={`${id}-prompt`} value={prompt} required maxLength={32_000} rows={4} disabled={busy}
            onChange={event => setPrompt(event.target.value)} />
        </div>
        <div className="schedule-fields">
          <ScheduleTiming timing={timing} onChange={setTiming} pending={busy} timezone={t('schedule.localTime')} />
          <div className="schedule-field">
            <label htmlFor={`${id}-project`}>{t('schedule.project')}</label>
            <Select value={hasWorkspace ? workspaceId : ''} disabled={busy || !workspaces} onValueChange={value => {
              if (value === 'add-workspace') void onPickWorkspace().then(id => { if (id) setProject(id) })
              else setProject(value)
            }}>
              <SelectTrigger id={`${id}-project`}><SelectValue placeholder={t('chat.chooseWorkspace')} /></SelectTrigger>
              <SelectContent>
                {available.map(item => <SelectItem key={item.id} value={item.id} title={item.path}>{item.name}</SelectItem>)}
                <SelectItem value="add-workspace">{t('chat.addWorkspaceOption')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {blocker && <p className="schedule-error" role="status"><NoticeText notice={blocker} /></p>}
        {error && <p className="schedule-error" role="alert"><NoticeText notice={error} /></p>}
        {phase === 'unconfirmed' && <p className="schedule-error" role="alert">{t('chat.firstUnconfirmed')}</p>}
        <div className="schedule-actions">
          <Button type="button" variant="secondary" disabled={phase === 'sending'} onClick={onClose}>
            {t(phase === 'unconfirmed' ? 'common.close' : 'schedule.cancel')}
          </Button>
          {phase === 'unconfirmed' ? <Button type="button" disabled={blocker?.key === 'schedule.connection'} onClick={onRetry}>
            {t('chat.retryFirst')}
          </Button> : <Button type="submit" disabled={!canSubmit}>
            {t(phase === 'sending' ? 'schedule.creating' : 'schedule.create')}
          </Button>}
        </div>
      </form>
    </DialogContent>
  </Dialog>
}

export function ScheduleActionDialog({ request, workspace, onChanged, onDeleted, onClose, restoreFocus }: {
  request: ScheduleDialogRequest
  workspace?: WorkspaceView['workspaces'][number]
  onChanged(schedule?: ScheduleView): void
  onDeleted(id: string): void
  onClose(): void
  restoreFocus(): void
}) {
  const { t } = useTranslation()
  const { kind, schedule } = request
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Notice>()
  const timezone = schedule.timezone === 'Asia/Shanghai' ? t('schedule.beijingTime') : schedule.timezone

  async function manage(action: SchedulePatch | { action: 'delete' }) {
    if (pending) return
    setPending(true)
    setError(undefined)
    let saved: ScheduleView | undefined
    try {
      if (action.action === 'delete') {
        await deleteSchedule(schedule.id)
        onDeleted(schedule.id)
      } else saved = await updateSchedule(schedule.id, action)
      onClose()
    } catch (failure) {
      setError(errorNotice('schedule.saveFailed', failure))
    } finally {
      // A lost response may follow a successful write.
      onChanged(saved)
      setPending(false)
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent className="schedule-dialog schedule-action-dialog" closeLabel={t('common.close')}
      onCloseAutoFocus={event => { event.preventDefault(); restoreFocus() }}
      {...(kind === 'edit' ? { 'aria-describedby': undefined } : {})}>
      <DialogTitle>{t(kind === 'edit' ? 'schedule.editTitle' : 'schedule.deleteTitle')}</DialogTitle>
      {error && <p className="schedule-error" role="alert"><NoticeText notice={error} /></p>}
      {kind === 'edit' ? <ScheduleEditor base={schedule} project={workspace?.name ?? schedule.workspaceId} timezone={timezone}
        pending={pending} onCancel={onClose} onSave={patch => { void manage(patch) }} />
        : <>
          <DialogDescription>{t('schedule.deleteDescription')}</DialogDescription>
          <div className="schedule-actions">
            <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={onClose}>{t('schedule.cancel')}</Button>
            <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => { void manage({ action: 'delete' }) }}>{t('schedule.delete')}</Button>
          </div>
        </>}
    </DialogContent>
  </Dialog>
}

function ScheduleEditor({ base, project, timezone, pending, onCancel, onSave }: {
  base: ScheduleView
  project: string
  timezone: string
  pending: boolean
  onCancel(): void
  onSave(patch: SchedulePatch): void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [prompt, setPrompt] = useState(base.prompt)
  const [timing, setTiming] = useState<TimingDraft>({
    kind: base.schedule.kind, time: base.schedule.time,
    days: base.schedule.kind === 'weekly' ? [...base.schedule.weekdays].sort() : [],
  })
  const [mode, setMode] = useState(base.sessionMode)
  const { kind, time, days } = timing
  const schedule = toSchedule(timing)
  const scheduleChanged = kind !== base.schedule.kind || time !== base.schedule.time
    || (base.schedule.kind === 'weekly' && kind === 'weekly' && days.join() !== [...base.schedule.weekdays].sort().join())
  const patch = {
    action: 'update' as const,
    ...(prompt.trim() !== base.prompt ? { prompt: prompt.trim() } : {}),
    ...(scheduleChanged ? { schedule } : {}),
    ...(mode !== base.sessionMode ? { sessionMode: mode } : {}),
  }
  const canSave = prompt.trim() && time && (kind !== 'weekly' || days.length > 0) && Object.keys(patch).length > 1

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSave) return
    onSave(patch)
  }

  return <form className="schedule-editor" onSubmit={submit}>
    <div className="schedule-prompt-field">
      <label htmlFor={`${id}-prompt`}>{t('schedule.prompt')}</label>
      <Textarea id={`${id}-prompt`} value={prompt} required rows={4} disabled={pending} onChange={event => setPrompt(event.target.value)} />
    </div>
    <div className="schedule-fields">
      <ScheduleTiming timing={timing} onChange={setTiming} timezone={timezone} pending={pending} />
      <div className="schedule-field">
        <label htmlFor={`${id}-project`}>{t('schedule.project')}</label>
        <Input id={`${id}-project`} value={project} readOnly />
      </div>
    </div>
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" type="button" className="schedule-advanced">
          {t('schedule.advanced')}<ChevronDownIcon aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="schedule-field">
        <label htmlFor={`${id}-new-session`}>{t('schedule.everyRunNew')}</label>
        <Switch id={`${id}-new-session`} type="button" checked={mode === 'new'} disabled={pending}
          onCheckedChange={checked => setMode(checked ? 'new' : 'reuse')} />
      </CollapsibleContent>
    </Collapsible>
    <div className="schedule-actions">
      <Button type="submit" size="sm" disabled={pending || !canSave}>
        {t('schedule.save')}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>{t('schedule.cancel')}</Button>
    </div>
  </form>
}
