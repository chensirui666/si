import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListIcon, SquareIcon } from 'lucide-react'
import type { BashJobsView, ConversationSnapshot } from '@agent-learning/server/protocol'
import { getBashJobs, stopBashJob, stopSubagent } from '../chat/client'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { errorNotice, NoticeText, type Notice } from '../i18n/messages'

type Subagent = NonNullable<ConversationSnapshot['subagents']>[number]
type TaskPanelProps = {
  sessionId: string
  subagents?: readonly Subagent[]
  stopDisabled?: boolean
  onSync: () => void
}

type Job = BashJobsView['jobs'][number]
type StopAttempt = { job: Job; checking: boolean }

export function BackgroundTasks(props: TaskPanelProps) {
  const { t } = useTranslation()
  const title = t('background.title')
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  return <div className="background-tasks" onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      setOpen(false)
      trigger.current?.focus()
    }
  }}>
    <Button ref={trigger} type="button" variant={open ? 'secondary' : 'ghost'} size="icon" aria-label={title} title={title}
      aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      <ListIcon aria-hidden="true" />
    </Button>
    {open && <BackgroundTaskList key={props.sessionId} {...props} panelId={panelId} />}
  </div>
}

function SubagentRow({ sessionId, child, stopDisabled, onSync }: {
  sessionId: string
  child: Subagent
  stopDisabled?: boolean
  onSync: () => void
}) {
  const { t } = useTranslation()
  const [stopping, setStopping] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const inFlight = useRef(false)

  async function stop() {
    if (inFlight.current || stopDisabled) return
    inFlight.current = true
    setStopping(true)
    setUnconfirmed(false)
    try {
      const result = await stopSubagent(sessionId, child.sessionId, child.runId)
      setUnconfirmed(result.status === 'running')
    } catch {
      setUnconfirmed(true)
    } finally {
      inFlight.current = false
      setStopping(false)
      onSync()
    }
  }

  return <li className="background-task-item">
    <div className="background-task-row">
      <span className="background-task-name">{child.name}</span>
      {child.status === 'running' ? <Tooltip>
        {stopping && <span className="background-task-status" role="status">{t('background.stopping')}</span>}
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" disabled={stopDisabled || stopping}
            aria-label={t('background.stopAgent', { name: child.name })} onClick={() => { void stop() }}>
            <SquareIcon aria-hidden="true" fill="currentColor" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="background-task-tooltip" sideOffset={4}>{t('background.stop')}</TooltipContent>
      </Tooltip> : <span className="background-task-status">{t(`background.${child.status}`)}</span>}
    </div>
    {unconfirmed && child.status === 'running' && <p className="background-task-error" role="alert">{t('background.stopUnconfirmed')}</p>}
  </li>
}

function BackgroundTaskList({ sessionId, panelId, subagents = [], stopDisabled, onSync }: TaskPanelProps & { panelId: string }) {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<Job[]>([])
  const [stops, setStops] = useState<StopAttempt[]>([])
  const [readError, setReadError] = useState<Notice | null>(null)
  const [refresh, setRefresh] = useState(0)
  const readVersion = useRef(0)

  useEffect(() => {
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      const version = ++readVersion.current
      const current = () => !lifetime.signal.aborted && version === readVersion.current
      try {
        const next = await getBashJobs(sessionId, AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]))
        if (!current()) return
        setJobs(next)
        setStops(previous => previous.some(stop => stop.checking) ? previous.filter(stop => !stop.checking) : previous)
        setReadError(null)
      } catch (error) {
        if (current()) setReadError(errorNotice('background.readFailed', error))
      } finally {
        if (!lifetime.signal.aborted) timer = setTimeout(read, 1000)
      }
    }
    void read()
    return () => {
      lifetime.abort()
      clearTimeout(timer)
    }
  }, [sessionId, refresh])

  async function stop(job: Job) {
    const id = job.jobId
    setStops(previous => [...previous, { job, checking: false }])
    try {
      await stopBashJob(sessionId, id)
      setJobs(previous => previous.filter(row => row.jobId !== id))
      setStops(previous => previous.filter(attempt => attempt.job.jobId !== id))
    } catch {
      setStops(previous => previous.map(attempt => attempt.job.jobId === id ? { job, checking: true } : attempt))
    } finally {
      // A list requested before the stop response may still contain this job.
      readVersion.current++
      setRefresh(value => value + 1)
    }
  }

  const visible = [...jobs, ...stops.map(({ job }) => job).filter(job => !jobs.some(row => row.jobId === job.jobId))]
  return <section id={panelId} className="background-task-panel" aria-label={t('background.title')}>
    {readError && <p className="background-task-error" role="alert"><NoticeText notice={readError} /></p>}
    {subagents.length > 0 && <>
      <h2 className="background-task-heading">{t('background.subagents')}</h2>
      <TooltipProvider delayDuration={200}>
        <ul className="background-task-list" role="list">
          {subagents.map(child => <SubagentRow key={`${child.sessionId}:${child.runId}`} sessionId={sessionId} child={child}
            stopDisabled={stopDisabled} onSync={onSync} />)}
        </ul>
      </TooltipProvider>
    </>}
    {visible.length > 0 && <>
      <h2 className="background-task-heading">{t('background.bash')}</h2>
      <ul className="background-task-list" role="list">
        {visible.map(job => {
          const attempt = stops.find(stop => stop.job.jobId === job.jobId)
          return <li className="background-task-row" key={job.jobId}>
            <code>{job.command}</code>
            {!attempt && <span className="background-task-status">{t('background.running')}</span>}
            <Button type="button" variant="outline" size="xs" disabled={!!attempt} onClick={() => { void stop(job) }}>
              {t(attempt ? attempt.checking ? 'background.checking' : 'background.stopping' : 'background.stop')}
            </Button>
          </li>
        })}
      </ul>
    </>}
  </section>
}
