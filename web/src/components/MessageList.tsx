import { NoticeText, skillSourceKey } from '../i18n/messages'
import { useTranslation } from 'react-i18next'
import { useRef } from 'react'
import { Clock3Icon } from 'lucide-react'
import type { ActiveContent, ConversationMessage, RunRecord, RunningState, SaveFailure, SkillInvocationView, PendingMessage, UserQuestionBatch } from '@agent-learning/server/protocol'
import type { LocalSubmission } from '../types'
import { AssistantMessage, type AssistantEntry } from './AssistantMessage'
import { SentAttachments } from './MessageAttachments'
import { QuestionReply } from './QuestionReply'
import { SaveFailureNotice } from './SaveFailureNotice'
import { QuoteSelection } from './QuoteSelection'

type MessageRow =
  | { type: 'user'; id: string; text: string; local?: LocalSubmission; pendingSteering?: true; runId?: string; clientMessageId?: string; skill?: SkillInvocationView; attachments?: ConversationMessage['attachments']; references?: ConversationMessage['references'] }
  | { type: 'assistant'; id: string; userId: string; messages: AssistantEntry[] }

export function MessageList({ messages, activeContent = [], running = null, showRetry = true, runs = [], saveFailures = [], steering = [], questions = [], onOpenQuestion, onQuote }: {
  messages: readonly (ConversationMessage | LocalSubmission)[]
  activeContent?: readonly ActiveContent[]
  running?: RunningState
  showRetry?: boolean
  runs?: readonly RunRecord[]
  saveFailures?: readonly SaveFailure[]
  steering?: readonly PendingMessage[]
  questions?: readonly UserQuestionBatch[]
  onOpenQuestion?: (batch: UserQuestionBatch) => void
  onQuote?: (text: string) => void
}) {
  const { t } = useTranslation()
  const list = useRef<HTMLElement>(null)
  const rows: MessageRow[] = []
  const toolResults = new Map<string, Map<number, ConversationMessage>>()
  const taskRuns = new Map(runs.filter(run => run.kind === 'task').map(run => [run.id, run]))
  let userId = ''
  const optimisticSteering: MessageRow[] = []
  const recorded = new Set<string>()
  const lateReplies = new Map(questions.filter(batch => batch.replyKind === 'late').map(batch => [`question:${batch.id}`, batch]))
  for (const item of messages) {
    if ('state' in item) {
      if (item.kind === 'compaction') continue
      const row = { type: 'user' as const, id: item.clientMessageId, clientMessageId: item.clientMessageId, text: item.text, local: item, attachments: item.attachments }
      if (item.mode === 'steer' && item.state !== 'failed') optimisticSteering.push(row)
      else rows.push(row)
      continue
    }
    const { id, message, toolCall } = item
    if (message.role === 'user') {
      userId = item.runId ?? id
      if (item.clientMessageId) recorded.add(item.clientMessageId)
      rows.push({ type: 'user', id, runId: userId, clientMessageId: item.clientMessageId, skill: item.skillInvocation, attachments: item.attachments, references: item.references,
        text: typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('') })
    } else if (message.role === 'assistant') {
      const previous = rows.at(-1)
      if (previous?.type === 'assistant' && previous.userId === userId) previous.messages.push({ id, message })
      else rows.push({ type: 'assistant', id, userId, messages: [{ id, message }] })
    } else if (message.role === 'toolResult' && toolCall) {
      const results = toolResults.get(toolCall.assistantMessageId) ?? new Map()
      results.set(toolCall.contentIndex, item)
      toolResults.set(toolCall.assistantMessageId, results)
    }
  }
  for (const item of steering) {
    if (recorded.has(item.clientMessageId)) continue
    rows.push({ type: 'user', id: item.clientMessageId, clientMessageId: item.clientMessageId, text: item.text, attachments: item.attachments, pendingSteering: true })
  }
  rows.push(...optimisticSteering)
  const questionsByAssistant = new Map<string, Map<string, UserQuestionBatch>>()
  for (const batch of questions) {
    const entries = questionsByAssistant.get(batch.assistantMessageId) ?? new Map()
    entries.set(batch.toolCallId, batch)
    questionsByAssistant.set(batch.assistantMessageId, entries)
  }
  const answered = new Set(rows.flatMap(row => row.type === 'assistant' ? [row.userId] : []))
  const lastAssistant = new Map(rows.flatMap(row => row.type === 'assistant' ? [[row.userId, row.id] as const] : []))
  const shown = new Set<string>()

  return (
    <section ref={list} className="message-list" role="region" aria-label={t('chat.messages')} tabIndex={0}>
        <ol className="message-items">
          {rows.flatMap(row => row.type === 'user' && (taskRuns.has(row.id) || running?.kind === 'task' && running.runId === row.id && running.retry) && !answered.has(row.id)
            ? [row, { type: 'assistant' as const, id: `pending:${row.id}`, userId: row.id, messages: [] }]
            : [row]).map((row, index, displayedRows) => {
            const runId = row.type === 'assistant' ? row.userId : row.runId ?? row.id
            const isLatest = row.type === 'assistant' && (lastAssistant.get(runId) === row.id || !row.messages.length)
            const isRunning = running?.kind === 'task' && isLatest && row.userId === running.runId
            const run = runs.find(item => item.id === runId)
            const failure = saveFailures.find(item => item.runId === runId)
            const next = displayedRows[index + 1]
            const endsTurn = row.type === 'assistant' ? isLatest : !answered.has(runId) && (next?.type !== 'assistant' || next.userId !== runId)
            const activity = isLatest ? taskRuns.get(runId) : undefined
            const first = row.type === 'assistant' && taskRuns.has(runId) && !shown.has(runId)
            const lateReply = row.type === 'user' && row.clientMessageId ? lateReplies.get(row.clientMessageId) : undefined
            const local = row.type === 'user' ? row.local : undefined
            const waiting = row.type === 'user' && (row.pendingSteering || local?.accepted?.kind === 'steering')
            const submitting = local?.mode === 'steer' && local.state === 'pending' && !local.accepted
            const steeringStatus = waiting ? t('chat.steeringWaiting') : submitting ? t('chat.steerSending') : undefined
            if (first) shown.add(runId)
            return <li className={`message-item${row.type === 'assistant' ? ' message-item-assistant' : ''}`} key={first ? `run:${runId}` : row.type === 'user' ? row.clientMessageId ?? row.id : row.id} data-message-id={row.id} data-run-status={run?.status}>
            {row.type === 'assistant'
              ? <AssistantMessage showRetry={showRetry} messages={row.messages} activeContent={activeContent} toolResults={toolResults} restored={run?.restored} saveFailure={failure} run={activity}
                running={isRunning ? running : null} toolQuestions={questionsByAssistant} onOpenQuestion={onOpenQuestion} />
              : <>
                {lateReply ? <QuestionReply batch={lateReply} />
                  : row.text && <div className="message-text">{row.clientMessageId?.startsWith('question:') ? t('question.lateReply') : row.text}<br /></div>}
                {row.attachments && <SentAttachments attachments={row.attachments} previews={row.local?.accepted ? undefined : row.local?.attachmentPreviews} />}
                {!!row.references?.length && <div className="reference-list" role="group" aria-label={t('chat.selectedReferences')}>
                  {row.references.map(ref => <span className="reference-draft" key={ref.sourceSessionId}>Session · {ref.label}</span>)}
                </div>}
                {row.skill && <div className="submission-status" data-skill-status={row.skill.status}>
                  {row.skill.status === 'loaded'
                    ? t('chat.skillLoaded', { name: row.skill.name })
                    : t('chat.skillLoadFailed', { name: row.skill.name, reason: row.skill.reason })}
                  {' · '}{t(skillSourceKey[row.skill.source])}
                </div>}
                {steeringStatus && <span className="steering-status" role="status" title={steeringStatus}>
                  <Clock3Icon aria-hidden="true" />
                  <span className="sr-only">{steeringStatus}</span>
                </span>}
                {local && !steeringStatus && <div className="submission-status" data-state={local.state}>
                  <span>{t(local.accepted ? 'chat.accepted' : local.state === 'pending' ? 'chat.sending' : local.state === 'failed' ? 'chat.sendFailed' : 'chat.notConfirmed')}</span>
                  {local.errorMessage && <p><NoticeText notice={local.errorMessage} /></p>}
                </div>}
              </>}
            {endsTurn && failure && <SaveFailureNotice failure={failure} />}
          </li>})}
        </ol>
        {onQuote && <QuoteSelection list={list} onQuote={onQuote} />}
    </section>
  )
}
