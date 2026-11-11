import type { CompactionRecord, ConversationMessage, SaveFailure } from '@agent-learning/server/protocol'
import type { LocalSubmission } from '../types'
import { SaveFailureNotice } from './SaveFailureNotice'
import { MarkdownText } from './markdown/MarkdownText'

const statusLabels = { running: '正在压缩…', success: '已完成', failed: '失败', aborted: '已停止', skipped: '未执行', interrupted: '已中断' }
const triggerLabels = { manual: '手动压缩', auto: '自动压缩', overflow: '超限后压缩' }

function RecordView({ record, messages, failure }: { record: CompactionRecord; messages: readonly ConversationMessage[]; failure?: SaveFailure }) {
  const followup = record.status === 'success' ? messages.find(item => item.id === record.followupMessageId)?.message : undefined
  const input = followup?.role === 'assistant' ? followup.usage?.input : undefined
  return <div className="compaction-record" data-status={record.status} data-compaction-id={record.id}>
    <div className="compaction-heading">{triggerLabels[record.trigger]} · {statusLabels[record.status]}</div>
    {record.status === 'success' ? <>
      <p>估算输入：~{record.estimatedBefore.toLocaleString('en-US')} → ~{record.estimatedAfter.toLocaleString('en-US')} token，预计减少 ~{(record.estimatedBefore - record.estimatedAfter).toLocaleString('en-US')}</p>
      <p>{input === undefined ? '尚未取得后续实际输入用量' : `后续实际输入：${input.toLocaleString('en-US')} token`}</p>
      <details>
        <summary>查看摘要</summary>
        <MarkdownText text={record.summary} />
        {record.fileOperations && ([
          ['仅读文件', record.fileOperations.readFiles],
          ['已改文件', record.fileOperations.modifiedFiles],
        ] as const).map(([label, paths]) => paths.length > 0 && <div key={label}>
          <p>{label}</p>
          <ul aria-label={label} role="list">{paths.map(path => <li key={path}><code className="whitespace-pre-wrap break-all">{path}</code></li>)}</ul>
        </div>)}
      </details>
    </> : record.status !== 'running' && <p>{record.reason}</p>}
    {failure && <SaveFailureNotice failure={failure} />}
    {record.summaryUsage && <p>摘要调用消耗：输入 {record.summaryUsage.input?.toLocaleString('en-US') ?? '未报告'} · 输出 {record.summaryUsage.output?.toLocaleString('en-US') ?? '未报告'} token</p>}
  </div>
}

export function CompactionRecords({ records, messages, pending = [], saveFailures = [] }: {
  records: readonly CompactionRecord[]
  messages: readonly ConversationMessage[]
  pending?: readonly LocalSubmission[]
  saveFailures?: readonly SaveFailure[]
}) {
  const locals = pending.filter(local => !records.some(record => record.clientMessageId === local.clientMessageId))
  if (!records.length && !locals.length) return null
  return <section className="compaction-records" aria-label="压缩记录" aria-live="polite">
    {records.length > 1 && <details className="compaction-history"><summary>较早的压缩记录（{records.length - 1}）</summary>
      {records.slice(0, -1).map(record => <RecordView key={record.id} record={record} messages={messages} failure={saveFailures.find(item => item.runId === record.id)} />)}
    </details>}
    {records.at(-1) && <RecordView record={records.at(-1)!} messages={messages} failure={saveFailures.find(item => item.runId === records.at(-1)?.id)} />}
    {locals.map(local => <div className="compaction-record" key={local.clientMessageId} data-state={local.state}>
      <div className="compaction-heading">手动压缩 · {local.accepted ? '已接收，正在同步' : local.state === 'pending' ? '正在发送…' : local.state === 'failed' ? '发送失败' : '未确认接收'}</div>
      {local.errorMessage && <p>{local.errorMessage}</p>}
    </div>)}
  </section>
}
