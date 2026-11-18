import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { reviewPlan, type PlanReviewAction } from '../chat/client'
import { errorNotice, NoticeText, type Notice } from '../i18n/messages'
import { Button } from './ui/button'

export function PlanReview({ sessionId, planId, steps, disabled, onAction, onSync }: {
  sessionId: string; planId: string; steps: string[]; disabled: boolean
  onAction: (action: PlanReviewAction) => void
  onSync: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const attempt = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    clearTimeout(attempt.current)
    attempt.current = undefined
  }, [])

  function decide(action: PlanReviewAction) {
    if (disabled || attempt.current !== undefined) return
    setBusy(true)
    setNotice(undefined)
    onAction(action)
    const fail = (error?: unknown) => {
      clearTimeout(attempt.current)
      attempt.current = undefined
      setBusy(false)
      setNotice(errorNotice('plan.reviewFailed', error))
    }
    const timeout = attempt.current = setTimeout(fail, 12_000)
    void reviewPlan(sessionId, planId, action).then(onSync, error => {
      if (attempt.current !== timeout) return
      fail(error)
      onSync()
    })
  }

  return <section className="plan-review" aria-label={t('plan.review')} aria-busy={busy}>
    <h2>{t('plan.review')}</h2>
    <ol>{steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
    {notice && <p className="configuration-error" role="alert"><NoticeText notice={notice} /></p>}
    <div className="plan-review-actions">
      <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => decide('discuss')}>{t('plan.discuss')}</Button>
      <Button type="button" disabled={disabled || busy} onClick={() => decide('approve')}>{t('plan.approve')}</Button>
    </div>
  </section>
}
