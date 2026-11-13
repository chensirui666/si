import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunRecord } from '@agent-learning/server/protocol'

const statusLabels = {
  running: 'assistant.running',
  completed: 'assistant.completed',
  failed: 'assistant.runFailed',
  aborted: 'assistant.runAborted',
  interrupted: 'chat.interrupted',
} as const

export function RunStatus({ run }: { run: RunRecord }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now)
  const ticking = run.status === 'running' && run.finishedAt === undefined
  useEffect(() => {
    if (!ticking) return
    let timer: ReturnType<typeof setTimeout>
    function tick() {
      const now = Date.now()
      setNow(now)
      timer = setTimeout(tick, 1000 - Math.max(0, now - run.startedAt) % 1000)
    }
    tick()
    return () => clearTimeout(timer)
  }, [run.startedAt, ticking])
  const end = ticking ? now : run.finishedAt
  const seconds = end === undefined ? 0 : Math.max(0, Math.floor((end - run.startedAt) / 1000))
  const duration = end === undefined || ticking && seconds === 0 ? '' : seconds < 60
    ? t('assistant.seconds', { seconds })
    : t('assistant.minutes', { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, '0') })
  const label = run.status === 'completed' && duration
    ? t('assistant.elapsed', { duration })
    : [t(statusLabels[run.status]), duration].filter(Boolean).join(' · ')
  return <span className="run-status">{label}</span>
}
