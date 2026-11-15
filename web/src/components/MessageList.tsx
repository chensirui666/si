import { NoticeText, skillSourceKey } from '../i18n/messages'
import { useTranslation } from 'react-i18next'
import { useRef } from 'react'
import type { ActiveContent, ConversationMessage, RunRecord, RunningState, SaveFailure, SkillInvocationView } from '@agent-learning/server/protocol'
import type { LocalSubmission } from '../types'
import { AssistantMessage, type AssistantEntry } from './AssistantMessage'
import { effortLabel } from './ModelPicker'
import { SaveFailureNotice } from './SaveFailureNotice'
import { QuoteSelection } from './QuoteSelection'

type MessageRow =
  | { type: 'user'; id: string; text: string; local?: LocalSubmission; skill?: SkillInvocationView }
  | { type: 'assistant'; id: string; userId: string; messages: AssistantEntry[] }

export function MessageList({ messages, activeContent = [], running = null, runs = [], saveFailures = [], onQuote }: {
  messages: readonly (ConversationMessage | LocalSubmission)[]
  activeContent?: readonly ActiveContent[]
  running?: RunningState
  runs?: readonly RunRecord[]
  saveFailures?: readonly SaveFailure[]
  onQuote?: (text: string) => void
}) {
  const { t } = useTranslation()
  const list = useRef<HTMLElement>(null)
  const rows: MessageRow[] = []
  const toolResults = new Map<string, Map<number, ConversationMessage>>()
  const taskRuns = new Map(runs.filter(run => run.kind === 'task').map(run => [run.id, run]))
  let userId = ''
  for (const item of messages) {
    if ('state' in item) {
      if (item.kind === 'compaction') continue
      rows.push({ type: 'user', id: item.clientMessageId, text: item.text, local: item })
      continue
    }
    const { id, message, toolCall } = item
    if (message.role === 'user') {
      userId = id
      rows.push({ type: 'user', id, skill: item.skillInvocation, text: typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('') })
    } else if (message.role === 'assistant') {
      const previous = rows.at(-1)
      if (previous?.type === 'assistant') previous.messages.push({ id, message })
      else rows.push({ type: 'assistant', id, userId, messages: [{ id, message }] })
    } else if (message.role === 'toolResult' && toolCall) {
      const results = toolResults.get(toolCall.assistantMessageId) ?? new Map()
      results.set(toolCall.contentIndex, item)
      toolResults.set(toolCall.assistantMessageId, results)
    }
  }
  const answered = new Set(rows.flatMap(row => row.type === 'assistant' ? [row.userId] : []))
  const shown = new Set<string>()

  return (
    <section ref={list} className="message-list" role="region" aria-label={t('chat.messages')} tabIndex={0}>
        <ol className="message-items">
          {rows.flatMap(row => row.type === 'user' && taskRuns.has(row.id) && !answered.has(row.id)
            ? [row, { type: 'assistant' as const, id: `pending:${row.id}`, userId: row.id, messages: [] }]
            : [row]).map((row, index, displayedRows) => {
            const runId = row.type === 'assistant' ? row.userId : row.id
            const run = runs.find(item => item.id === runId)
            const failure = saveFailures.find(item => item.runId === runId)
            const next = displayedRows[index + 1]
            const endsTurn = row.type === 'assistant' || next?.type !== 'assistant' || next.userId !== runId
            const activity = row.type === 'assistant' && !shown.has(runId) ? taskRuns.get(runId) : undefined
            if (activity) shown.add(runId)
            return <li className={`message-item${row.type === 'assistant' ? ' message-item-assistant' : ''}`} key={row.id} data-message-id={row.id} data-run-status={run?.status}>
            {row.type === 'assistant' && run && <p className="message-model">{run.provider ?? 'deepseek'} / {run.modelId}{(run.reasoningEffort ?? (!run.provider ? 'high' : undefined)) &&
              ` · ${effortLabel(t, run.reasoningEffort ?? 'high')}`}</p>}
            {row.type === 'assistant'
              ? <AssistantMessage messages={row.messages} activeContent={activeContent} toolResults={toolResults} restored={run?.restored} saveFailure={failure} run={activity}
                running={running?.kind === 'task' && (row.userId === running.runId || row.messages.some(entry => entry.id === running.assistantMessageId)) ? running : null} />
              : <>
                <div className="message-text">{row.text}<br /></div>
                {row.skill && <div className="submission-status" data-skill-status={row.skill.status}>
                  {row.skill.status === 'loaded'
                    ? t('chat.skillLoaded', { name: row.skill.name })
                    : t('chat.skillLoadFailed', { name: row.skill.name, reason: row.skill.reason })}
                  {' · '}{t(skillSourceKey[row.skill.source])}
                </div>}
                {row.local && <div className="submission-status" data-state={row.local.state}>
                  <span>{t(row.local.accepted ? 'chat.accepted' : row.local.state === 'pending' ? 'chat.sending' : row.local.state === 'failed' ? 'chat.sendFailed' : 'chat.notConfirmed')}</span>
                  {row.local.errorMessage && <p><NoticeText notice={row.local.errorMessage} /></p>}
                </div>}
              </>}
            {endsTurn && failure && <SaveFailureNotice failure={failure} />}
          </li>})}
        </ol>
        {onQuote && <QuoteSelection list={list} onQuote={onQuote} />}
    </section>
  )
}
