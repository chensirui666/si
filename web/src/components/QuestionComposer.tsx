import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, SquareIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { QuestionAnswer, UserQuestionBatch } from '@agent-learning/server/protocol'
import { replyToQuestions } from '../chat/client'
import { errorNotice, NoticeText, questionStatusKey, type Notice } from '../i18n/messages'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import './conversation-interaction.css'

type AnswerDraft = QuestionAnswer & { skipped?: true }

function finished(answer: AnswerDraft | undefined): boolean {
  return Boolean(answer?.skipped || answer?.selected.length || answer?.custom?.trim())
}

export function QuestionComposer({ batch, sessionId, open, disabled, onClose, onSync, onAbort, abortPending, abortDisabled }: {
  batch: UserQuestionBatch
  sessionId: string
  open: boolean
  disabled: boolean
  onClose(): void
  onSync(): void
  onAbort?: () => void
  abortPending: boolean
  abortDisabled: boolean
}) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState(() => new Map<string, AnswerDraft>())
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<Notice>()
  const sent = useRef<{ id: string; content: string }>(undefined)
  const title = useRef<HTMLLegendElement>(null)
  const focusTitle = useRef(false)
  const review = batch.status !== 'waiting' && batch.status !== 'timed-out'
  const deadline = batch.status === 'waiting' ? batch.deadlineAt : undefined
  useEffect(() => {
    if (!open || deadline === undefined) return
    const tick = () => setNow(Date.now())
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [open, deadline])
  useLayoutEffect(() => {
    if (!focusTitle.current) return
    focusTitle.current = false
    title.current?.focus({ preventScroll: true })
  }, [index])

  if (!open || confirmed && !review) return null
  const question = batch.questions[index]!
  const answer: AnswerDraft | undefined = review ? batch.answers?.find(item => item.id === question.id) : drafts.get(question.id)
  const draft = answer ?? { id: question.id, selected: [] }
  const skipped = review ? answer && !finished(answer) : draft.skipped
  const last = index === batch.questions.length - 1
  const complete = batch.questions.every(({ id }) => finished(drafts.get(id)))
  const setDraft = (answer: AnswerDraft) => {
    setDrafts(current => new Map(current).set(answer.id, answer))
    setError(undefined)
  }

  function goToQuestion(nextIndex: number) {
    focusTitle.current = true
    setIndex(nextIndex)
  }

  function advance() {
    if (!last) goToQuestion(index + 1)
  }

  async function submit() {
    if (review || disabled || busy || !complete) return
    const answers = batch.questions.map(({ id }) => {
      const answer = drafts.get(id)!
      const custom = answer.custom?.trim()
      return { id, selected: answer.selected, ...(custom && { custom }) }
    })
    const content = JSON.stringify(answers)
    const reply = sent.current?.content === content ? sent.current : { id: crypto.randomUUID(), content }
    sent.current = reply
    setBusy(true)
    setError(undefined)
    try {
      await replyToQuestions(sessionId, batch.id, reply.id, answers)
      setConfirmed(true)
      onClose()
    } catch (error) {
      setError(errorNotice('question.submitFailed', error))
    } finally {
      setBusy(false)
      onSync()
    }
  }

  return <section className="question-composer" data-review={review || undefined} aria-label={t(review ? 'question.review' : 'question.answer')}>
    <div className="question-heading">
      {question.header && <span className="question-topic">{question.header}</span>}
      <div className="question-heading-actions">
        {review && <span>{t(questionStatusKey(batch))}</span>}
        {deadline !== undefined && <time dateTime={new Date(deadline).toISOString()} title={new Date(deadline).toLocaleString()}>
          {t('question.remaining', { seconds: Math.max(0, Math.ceil((deadline - now) / 1000)) })}
        </time>}
        <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={onClose}>{t('question.hide')}</Button>
        {!review && onAbort && <Button variant="ghost" size="icon-sm" type="button" aria-label={t(abortPending ? 'chat.aborting' : 'chat.abort')}
          title={t(abortPending ? 'chat.aborting' : 'chat.abort')} disabled={abortPending || abortDisabled} onClick={onAbort}>
          <SquareIcon aria-hidden="true" fill="currentColor" />
        </Button>}
      </div>
    </div>
    <fieldset disabled={review || disabled || busy}>
      <legend ref={title} tabIndex={-1}>{question.question}</legend>
      {!!question.options?.length && <div className="question-options">
        {question.options.map((option, optionIndex) => <Button key={option.label} asChild variant="ghost" className="question-option">
          <label>
            <input className="sr-only" type={question.multi_select ? 'checkbox' : 'radio'} name={`question-${batch.id}-${question.id}`}
              checked={draft.selected.includes(option.label)}
              onClick={event => { if (!question.multi_select && event.detail > 0) advance() }}
              onChange={event => {
                let selected = [option.label]
                if (question.multi_select) {
                  selected = event.currentTarget.checked
                    ? [...draft.selected, option.label]
                    : draft.selected.filter(label => label !== option.label)
                }
                setDraft({ id: question.id, selected, custom: question.multi_select ? draft.custom : undefined })
              }} />
            <span className="question-option-number" aria-hidden="true">{optionIndex + 1}</span>
            <span>{option.label}{option.description && <small>{option.description}</small>}</span>
          </label>
        </Button>)}
      </div>}
      {review
        ? draft.custom && <p className="question-review-answer">{draft.custom}</p>
        : <Textarea aria-label={t('question.custom')} placeholder={t('question.custom')} rows={2} value={draft.custom ?? ''}
          onChange={event => setDraft({ id: question.id, selected: question.multi_select ? draft.selected : [], custom: event.target.value })}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            event.preventDefault()
            if (draft.custom?.trim()) advance()
          }} />}
      {skipped && <div className="interaction-note">{t('question.skipped')}</div>}
    </fieldset>
    {!review && error && <p className="configuration-error" role="alert"><NoticeText notice={error} /></p>}
    <div className="question-footer">
      {batch.questions.length > 1 && <div className="question-pagination">
        <Button variant="ghost" size="icon-sm" type="button" aria-label={t('question.previous')} title={t('question.previous')}
          disabled={index === 0 || busy} onClick={() => goToQuestion(index - 1)}><ChevronLeftIcon aria-hidden="true" /></Button>
        <span className="question-progress" aria-hidden="true">{index + 1}/{batch.questions.length}</span>
        <span className="sr-only" aria-live="polite">{t('question.progress', { index: index + 1, count: batch.questions.length })}</span>
        <Button variant="ghost" size="icon-sm" type="button" aria-label={t('question.nextPage')} title={t('question.next')}
          disabled={last || busy} onClick={() => goToQuestion(index + 1)}><ChevronRightIcon aria-hidden="true" /></Button>
      </div>}
      {!review && <div className="question-actions">
        <Button variant="secondary" type="button" disabled={disabled || busy} onClick={() => {
          setDraft({ id: question.id, selected: [], skipped: true })
          advance()
        }}>{t('question.skip')}</Button>
        {last
          ? <Button type="button" disabled={disabled || busy || !complete} onClick={() => void submit()}>{t('question.submit')}</Button>
          : <Button type="button" disabled={disabled || busy || !finished(draft)} onClick={advance}>{t('question.next')}</Button>}
      </div>}
    </div>
  </section>
}
