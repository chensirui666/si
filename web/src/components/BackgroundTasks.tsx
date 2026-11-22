import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListIcon } from 'lucide-react'
import type { BashJobsView } from '@agent-learning/server/protocol'
import { getBashJobs, stopBashJob } from '../chat/client'
import { Button } from './ui/button'
import { errorNotice, NoticeText, type Notice } from '../i18n/messages'

type Job = BashJobsView['jobs'][number]
type StopAttempt = { job: Job; checking: boolean }

export function BackgroundTasks({ sessionId }: { sessionId: string }) {
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
    {open && <BackgroundTaskList key={sessionId} sessionId={sessionId} panelId={panelId} />}
  </div>
}

function BackgroundTaskList({ sessionId, panelId }: { sessionId: string; panelId: string }) {
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
    {visible.length > 0 && <ul className="background-task-list" role="list">
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
    </ul>}
  </section>
}
