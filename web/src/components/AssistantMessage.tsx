import { useTranslation } from 'react-i18next'
import { NoticeText } from '../i18n/messages'
import { useRef, useState, type ReactNode } from 'react'
import type { ActiveContent, ConversationMessage, RunRecord, RunningState, SaveFailure, UserQuestionBatch } from '@agent-learning/server/protocol'
import type { AssistantMessage as Message, ToolCall } from '@agent-learning/model'
import { MarkdownText } from './markdown/MarkdownText'
import { CopyMarkdownButton } from './markdown/CopyMarkdownButton'
import { ModelRequestDetail } from './ModelRequestDetail'
import { QuestionRecord } from './QuestionRecord'
import { RunStatus } from './RunStatus'

export type AssistantEntry = { id: string; message: Message }
export type ToolResults = ReadonlyMap<string, ReadonlyMap<number, ConversationMessage>>
type ToolQuestions = ReadonlyMap<string, ReadonlyMap<string, UserQuestionBatch>>

type ToolState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped' | 'denied' | 'unknown'

const toolTargets: Readonly<Record<string, string>> = {
  read: 'path',
  bash: 'command',
  edit: 'path',
  write: 'path',
  find: 'pattern',
  grep: 'pattern',
  ls: 'path',
  web_search: 'query',
  web_fetch: 'urls',
}

function ProcessGroup({ running, run, children }: { running: boolean; run?: RunRecord; children: ReactNode }) {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<{ running: boolean; open: boolean }>()
  const open = choice?.running === running ? choice.open : running
  return <details className="process-group" open={open}>
    <summary onClick={event => { event.preventDefault(); setChoice({ running, open: !open }) }}>{run ? <RunStatus run={run} /> : t('assistant.process')}</summary>
    <div className="process-steps">{children}</div>
  </details>
}

function ToolBlock({ block, argumentsText, running, executing, result, stopped, failure, unknown, unsaved }: {
  block: ToolCall
  argumentsText?: string
  running: boolean
  executing: boolean
  result?: ConversationMessage
  stopped: boolean
  failure?: string
  unknown?: boolean
  unsaved?: SaveFailure['reason']
}) {
  const { t } = useTranslation()
  const targetKey = Object.hasOwn(toolTargets, block.name) ? toolTargets[block.name] : undefined
  const action = targetKey ? t(`tool.${block.name}`) : block.name || t('tool.call')
  const target = targetKey ? block.arguments[targetKey] : undefined
  const firstUrl = Array.isArray(target) ? target.find(value => typeof value === 'string') : undefined
  const label = typeof target === 'string' ? target : firstUrl
  if (unsaved) return <div className="tool-block tool-block-locked">
    <span>{t(unsaved === 'unconfirmed' ? 'tool.saveUnconfirmed' : 'tool.unsaved')}</span>
    <span className="tool-status" data-state="error" data-result="failure">{t('tool.status.error')}</span>
  </div>
  const outcome = result?.message.role === 'toolResult' ? result.message : undefined
  const state: ToolState = outcome ? ['permission_denied', 'hook_blocked'].includes(result?.toolErrorCode ?? '') ? 'denied'
    : result?.toolErrorCode === 'interrupted' ? 'stopped' : outcome.isError ? 'error' : 'ok'
    : executing ? 'running' : unknown ? 'unknown' : stopped ? 'stopped' : failure ? 'error' : running ? 'preparing' : 'error'
  const reason = outcome || state === 'preparing' || state === 'running' ? undefined
    : state === 'unknown' ? t('tool.noSavedResult')
    : state === 'stopped' ? t('tool.cancelled')
    : failure ?? t('tool.noResult')
  return <details className="tool-block">
    <summary>
      <span className="process-preview">{action}{label && ` · ${label}`}</span>
      <span className="tool-status" data-state={state} data-result={state === 'ok' ? 'success' : state === 'error' ? 'failure' : undefined}>{t(`tool.status.${state}`)}</span>
    </summary>
    <div className="tool-details">
      <div className="tool-detail-label">{t('tool.args')}</div>
      <pre>{argumentsText ?? JSON.stringify(block.arguments, null, 2)}</pre>
      {block.argumentsError && <p className="message-error">{block.argumentsError}</p>}
      {reason && <p className="message-error">{reason}</p>}
      {outcome && <>
        <div className="tool-detail-label">{t('tool.result')}</div>
        <pre className="tool-result">{outcome.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')}</pre>
      </>}
    </div>
  </details>
}

export function AssistantMessage({ messages, activeContent = [], running = null, run, showRetry = true, toolResults, toolQuestions, onOpenQuestion, restored, saveFailure }: {
  messages: readonly AssistantEntry[]
  activeContent?: readonly ActiveContent[]
  running?: Extract<RunningState, { kind: 'task' }> | null
  run?: RunRecord
  showRetry?: boolean
  toolResults?: ToolResults
  toolQuestions?: ToolQuestions
  onOpenQuestion?: (batch: UserQuestionBatch) => void
  restored?: true
  saveFailure?: SaveFailure
}) {
  const { t } = useTranslation()
  const response = useRef<HTMLDivElement>(null)
  const terminal = [...messages].reverse().find(entry => entry.message.stopReason === 'aborted' || entry.message.stopReason === 'error')?.message
  const rows: ReactNode[] = []
  const reply: string[] = []
  let process: ReactNode[] = []
  let processKey = ''
  const retry = showRetry ? running?.retry : undefined
  const last = messages.at(-1)?.message
  const detailMessage = last && (last.stopReason === 'length' || last.stopReason === 'aborted'
    || last.stopReason === 'error' && last.failure) ? last : undefined
  const separateSummary = retry || detailMessage
  let activityRun = separateSummary ? undefined : run
  function flushProcess() {
    if (!process.length) return
    rows.push(<ProcessGroup key={processKey} running={running !== null} run={activityRun}>{process}</ProcessGroup>)
    activityRun = undefined
    process = []
  }

  for (const { id, message } of messages) {
    const questions = toolQuestions?.get(id)
    message.content.forEach((block, index) => {
      const key = `${id}:${index}`
      const active = activeContent.find(item => item.messageId === id && item.contentIndex === index)
      if (block.type === 'text') {
        if (!block.text) return
        reply.push(block.text)
        flushProcess()
        rows.push(<MarkdownText key={key} text={block.text} streaming={active?.type === 'text'} response />)
        return
      }
      const question = block.type === 'toolCall' && block.name === 'ask_user_question' ? questions?.get(block.id) : undefined
      if (question) {
        flushProcess()
        if (activityRun) {
          rows.push(<p className="run-status-line" key={`${key}:status`}><RunStatus run={activityRun} /></p>)
          activityRun = undefined
        }
        rows.push(<QuestionRecord key={key} batch={question} onOpen={onOpenQuestion && (() => onOpenQuestion(question))} />)
        return
      }
      if (block.type === 'thinking' && !block.thinking) return
      if (!process.length) processKey = key
      if (block.type === 'thinking') {
        const preview = block.thinking.trim().split(/\r?\n/, 1)[0]?.slice(0, 160)
        process.push(<details className="thinking-block" key={key}>
          <summary><span className="process-preview">{t(active?.type === 'thinking' ? 'assistant.thinkingActive' : 'assistant.thinking')}{preview && ` · ${preview}`}</span></summary>
          <MarkdownText text={block.thinking} streaming={active?.type === 'thinking'} />
        </details>)
      } else {
        const unsaved = saveFailure?.toolCall
        const result = toolResults?.get(id)?.get(index)
        const executing = running?.activeTools.find(tool => tool.assistantMessageId === id && tool.contentIndex === index)
        const actualArguments = result?.toolCall?.actualArguments ?? executing?.actualArguments
        process.push(<ToolBlock key={key} block={actualArguments ? { ...block, arguments: actualArguments } : block} argumentsText={active?.type === 'toolCall' ? active.argumentsText : undefined}
          running={running !== null}
          executing={!!executing}
          unknown={!running && restored && (message.stopReason === 'toolUse' || message.stopReason === 'stop')}
          unsaved={unsaved?.assistantMessageId === id && unsaved.contentIndex === index ? saveFailure?.reason : undefined}
          stopped={!running && terminal?.stopReason === 'aborted'}
          failure={message.stopReason === 'length' ? t('tool.truncated') : !running && terminal?.stopReason === 'error' ? t('tool.taskFailed') : undefined}
          result={result} />)
      }
    })
    const recoveringOverflow = message.errorCode === 'context_overflow' && !message.failure && (message !== last || running)
    if (message === detailMessage || recoveringOverflow) continue
    const ending = message.stopReason === 'length' ? 'assistant.length'
      : message.stopReason === 'aborted' ? 'assistant.aborted'
      : message.stopReason === 'error' ? 'assistant.failed' : null
    if (ending) {
      flushProcess()
      rows.push(<p key={`${id}:ending`} className="message-ending" role={message.stopReason === 'error' || message.stopReason === 'aborted' ? 'alert' : undefined}><NoticeText notice={{ key: ending, detail: message.errorMessage }} /></p>)
    }
  }
  flushProcess()
  const summaryRun = separateSummary ? run : activityRun
  const markdown = reply.join('\n\n')
  return <div className="assistant-message" ref={response}>
    {summaryRun && <p className="run-status-line"><RunStatus run={summaryRun} /></p>}
    <ModelRequestDetail retry={retry} ending={detailMessage} />
    {rows}
    {!running && markdown.trim() && <div className="response-actions">
      <CopyMarkdownButton label={t('markdown.copyResponse')} markdown={markdown}
        getElements={() => response.current?.querySelectorAll(':scope > [data-response-text]') ?? []} />
    </div>}
  </div>
}
