import { useTranslation } from 'react-i18next'
import { NoticeText } from '../i18n/messages'
import type { CompactionRecord, ConversationMessage, SaveFailure } from '@agent-learning/server/protocol'
import type { LocalSubmission } from '../types'
import { SaveFailureNotice } from './SaveFailureNotice'
import { MarkdownText } from './markdown/MarkdownText'

function RecordView({ record, messages, failure }: { record: CompactionRecord; messages: readonly ConversationMessage[]; failure?: SaveFailure }) {
  const { t, i18n } = useTranslation()
  const format = (value: number) => value.toLocaleString(i18n.language)
  const followup = record.status === 'success' ? messages.find(item => item.id === record.followupMessageId)?.message : undefined
  const input = followup?.role === 'assistant' ? followup.usage?.input : undefined
  return <div className="compaction-record" data-status={record.status} data-compaction-id={record.id}>
    <div className="compaction-heading">{t(`compact.trigger.${record.trigger}`)} · {t(`compact.status.${record.status}`)}</div>
    {record.status === 'success' ? <>
      <p>{t('compact.estimate', { before: format(record.estimatedBefore), after: format(record.estimatedAfter), reduction: format(record.estimatedBefore - record.estimatedAfter) })}</p>
      <p>{input === undefined ? t('compact.noInput') : t('compact.input', { input: format(input) })}</p>
      <details>
        <summary>{t('compact.summary')}</summary>
        <MarkdownText text={record.summary} />
        {record.fileOperations && ([
          ['compact.readFiles', record.fileOperations.readFiles],
          ['compact.modifiedFiles', record.fileOperations.modifiedFiles],
        ] as const).map(([label, paths]) => paths.length > 0 && <div key={label}>
          <p>{t(label)}</p>
          <ul aria-label={t(label)} role="list">{paths.map(path => <li key={path}><code className="whitespace-pre-wrap break-all">{path}</code></li>)}</ul>
        </div>)}
      </details>
    </> : record.status !== 'running' && <p>{record.reason}</p>}
    {failure && <SaveFailureNotice failure={failure} />}
    {record.summaryUsage && <p>{t('compact.usage', {
      input: record.summaryUsage.input === undefined ? t('common.notReported') : format(record.summaryUsage.input),
      output: record.summaryUsage.output === undefined ? t('common.notReported') : format(record.summaryUsage.output),
    })}</p>}
  </div>
}

export function CompactionRecords({ records, messages, pending = [], saveFailures = [] }: {
  records: readonly CompactionRecord[]
  messages: readonly ConversationMessage[]
  pending?: readonly LocalSubmission[]
  saveFailures?: readonly SaveFailure[]
}) {
  const { t } = useTranslation()
  const locals = pending.filter(local => !records.some(record => record.clientMessageId === local.clientMessageId))
  if (!records.length && !locals.length) return null
  return <section className="compaction-records" aria-label={t('compact.records')} aria-live="polite">
    {records.length > 1 && <details className="compaction-history"><summary>{t('compact.history', { count: records.length - 1 })}</summary>
      {records.slice(0, -1).map(record => <RecordView key={record.id} record={record} messages={messages} failure={saveFailures.find(item => item.runId === record.id)} />)}
    </details>}
    {records.at(-1) && <RecordView record={records.at(-1)!} messages={messages} failure={saveFailures.find(item => item.runId === records.at(-1)?.id)} />}
    {locals.map(local => <div className="compaction-record" key={local.clientMessageId} data-state={local.state}>
      <div className="compaction-heading">{t('compact.trigger.manual')} · {t(local.accepted ? 'chat.accepted' : local.state === 'pending' ? 'chat.sending' : local.state === 'failed' ? 'chat.sendFailed' : 'chat.notConfirmed')}</div>
      {local.errorMessage && <p><NoticeText notice={local.errorMessage} /></p>}
    </div>)}
  </section>
}
