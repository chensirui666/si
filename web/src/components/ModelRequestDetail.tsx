import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssistantMessage } from '@agent-learning/model'
import type { ModelRetryState } from '@agent-learning/server/protocol'
import { needsServerDeadline, retryReasons } from '../chat/model-retry'

function retryTime(deadline: number) {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', timeZoneName: 'longOffset',
  }).format(Math.ceil(deadline / 1000) * 1000).replace('GMT', 'UTC')
}

export function ModelRequestDetail({ retry, ending }: { retry?: ModelRetryState; ending?: AssistantMessage }) {
  const { t } = useTranslation()
  const deadline = retry?.retryAt
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (deadline === undefined) return
    let timer: ReturnType<typeof setTimeout>
    function tick() {
      const now = Date.now()
      setNow(now)
      const remaining = deadline! - now
      if (remaining > 0) timer = setTimeout(tick, remaining % 1000 || 1000)
    }
    tick()
    return () => clearTimeout(timer)
  }, [deadline])

  if (retry) {
    const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000))
    const text = retry.mode === 'connection'
      ? t(retry.phase === 'waiting' ? 'retry.connectionWait' : 'retry.reconnecting', { seconds })
      : retry.phase === 'waiting'
        ? t('retry.wait', { reason: t(retryReasons[retry.reason], { status: retry.status }), seconds, attempt: retry.attempt, max: retry.maxAttempts })
        : t('retry.retrying', { attempt: retry.attempt, max: retry.maxAttempts })
    return <p className="message-ending" data-run-detail={retry.phase}>{text}{retry.incomplete && t('retry.incomplete')}</p>
  }

  if (ending?.stopReason === 'aborted') return <p className="message-ending" data-run-detail="aborted" role="alert">{t('retry.aborted')}</p>
  if (ending?.stopReason === 'length') return <p className="message-ending" data-run-detail="length">{t('assistant.length')}</p>
  const failure = ending?.failure
  if (!failure) return null
  const reason = t(retryReasons[failure.kind], { status: failure.status })
  const text = failure.attempts
    ? failure.retryAt === undefined
      ? t('retry.exhausted', { reason, attempts: failure.attempts })
      : t('retry.exhaustedUntil', { reason, attempts: failure.attempts, time: retryTime(failure.retryAt) })
    : needsServerDeadline.has(failure.kind)
      ? t(failure.kind === 'rate-limit' ? 'retry.tryLater' : 'retry.tryLaterOrSwitch', { reason })
      : t('retry.failed', { reason })
  return <p className="message-ending" data-run-detail="failed" role="alert">{text}</p>
}
