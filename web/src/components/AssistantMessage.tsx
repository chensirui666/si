import { useState, type ReactNode } from 'react'
import type { ActiveContent, ConversationMessage, RunningState, SaveFailure } from '@agent-learning/server/protocol'
import type { AssistantMessage as Message, ToolCall } from '@agent-learning/model'
import { MarkdownText } from './markdown/MarkdownText'

export type AssistantEntry = { id: string; message: Message }
export type ToolResults = ReadonlyMap<string, ReadonlyMap<number, ConversationMessage>>

type ToolState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped' | 'unknown'
const toolLabels: Record<ToolState, string> = { preparing: '准备中', running: '运行中', ok: '成功', error: '失败', stopped: '已停止', unknown: '结果未知' }

const toolSummaries: Record<string, [action: string, target: string]> = {
  read: ['读取', 'path'],
  bash: ['执行 Bash', 'command'],
  edit: ['编辑', 'path'],
  write: ['写入', 'path'],
  find: ['查找文件', 'pattern'],
  grep: ['搜索文本', 'pattern'],
  web_search: ['搜索网页', 'query'],
  web_fetch: ['获取网页', 'urls'],
}

function ProcessGroup({ running, children }: { running: boolean; children: ReactNode }) {
  const [choice, setChoice] = useState<{ running: boolean; open: boolean }>()
  const open = choice?.running === running ? choice.open : running
  return <details className="process-group" open={open}>
    <summary onClick={event => { event.preventDefault(); setChoice({ running, open: !open }) }}>执行过程</summary>
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
  const presentation = Object.hasOwn(toolSummaries, block.name) ? toolSummaries[block.name] : undefined
  const action = presentation?.[0] ?? (block.name || '工具调用')
  const target = presentation ? block.arguments[presentation[1]] : undefined
  const firstUrl = Array.isArray(target) ? target.find(value => typeof value === 'string') : undefined
  const label = typeof target === 'string' ? target : firstUrl
  if (unsaved) return <div className="tool-block tool-block-locked">
    <span>{unsaved === 'unconfirmed' ? '工具已执行，结果保存状态未确认' : '工具已执行，结果未保存'}</span>
    <span className="tool-status" data-state="error" data-result="failure">Error</span>
  </div>
  const outcome = result?.message.role === 'toolResult' ? result.message : undefined
  const state: ToolState = outcome ? result?.toolErrorCode === 'interrupted' ? 'stopped' : outcome.isError ? 'error' : 'ok'
    : executing ? 'running' : unknown ? 'unknown' : stopped ? 'stopped' : failure ? 'error' : running ? 'preparing' : 'error'
  const reason = outcome || state === 'preparing' || state === 'running' ? undefined
    : state === 'unknown' ? '没有已保存的工具结果，文件等外部状态可能已改变。'
    : state === 'stopped' ? '启动前已取消，本项未启动，没有执行结果。'
    : failure ?? block.argumentsError ?? '未取得执行结果，不能确认是否已发生修改。'
  return <details className="tool-block">
    <summary>
      <span className="process-preview">{action}{label && ` · ${label}`}</span>
      <span className="tool-status" data-state={state} data-result={state === 'ok' ? 'success' : state === 'error' ? 'failure' : undefined}>{toolLabels[state]}</span>
    </summary>
    <div className="tool-details">
      <div className="tool-detail-label">参数</div>
      <pre>{argumentsText ?? JSON.stringify(block.arguments, null, 2)}</pre>
      {block.argumentsError && <p className="message-error">{block.argumentsError}</p>}
      {reason && <p className="message-error">{reason}</p>}
      {outcome && <>
        <div className="tool-detail-label">结果</div>
        <pre className="tool-result">{outcome.content.map(item => item.text).join('\n')}</pre>
      </>}
    </div>
  </details>
}

export function AssistantMessage({ messages, activeContent = [], running = null, toolResults, restored, saveFailure }: {
  messages: readonly AssistantEntry[]
  activeContent?: readonly ActiveContent[]
  running?: Extract<RunningState, { kind: 'task' }> | null
  toolResults?: ToolResults
  restored?: true
  saveFailure?: SaveFailure
}) {
  const terminal = [...messages].reverse().find(entry => entry.message.stopReason === 'aborted' || entry.message.stopReason === 'error')?.message
  const rows: ReactNode[] = []
  let process: ReactNode[] = []
  let processKey = ''
  function flushProcess() {
    if (!process.length) return
    rows.push(<ProcessGroup key={processKey} running={running !== null}>{process}</ProcessGroup>)
    process = []
  }

  for (const { id, message } of messages) {
    message.content.forEach((block, index) => {
      const key = `${id}:${index}`
      const active = activeContent.find(item => item.messageId === id && item.contentIndex === index)
      if (block.type === 'text') {
        if (!block.text) return
        flushProcess()
        rows.push(<MarkdownText key={key} text={block.text} streaming={active?.type === 'text'} />)
        return
      }
      if (block.type === 'thinking' && !block.thinking) return
      if (!process.length) processKey = key
      if (block.type === 'thinking') {
        const preview = block.thinking.trim().split(/\r?\n/, 1)[0]?.slice(0, 160)
        process.push(<details className="thinking-block" key={key}>
          <summary><span className="process-preview">{active?.type === 'thinking' ? '思考中' : '思考'}{preview && ` · ${preview}`}</span></summary>
          <MarkdownText text={block.thinking} streaming={active?.type === 'thinking'} />
        </details>)
      } else {
        const unsaved = saveFailure?.toolCall
        process.push(<ToolBlock key={key} block={block} argumentsText={active?.type === 'toolCall' ? active.argumentsText : undefined}
          running={running !== null}
          executing={running?.activeTools.some(tool => tool.assistantMessageId === id && tool.contentIndex === index) ?? false}
          unknown={!running && restored && (message.stopReason === 'toolUse' || message.stopReason === 'stop')}
          unsaved={unsaved?.assistantMessageId === id && unsaved.contentIndex === index ? saveFailure?.reason : undefined}
          stopped={!running && terminal?.stopReason === 'aborted'}
          failure={message.stopReason === 'length' ? '本批工具未执行：本轮回复截断。' : !running && terminal?.stopReason === 'error' ? terminal.errorMessage ?? '任务失败，本项没有执行结果。' : undefined}
          result={toolResults?.get(id)?.get(index)} />)
      }
    })
    const ending = message.stopReason === 'length' ? '达到长度限制，回答可能不完整'
      : message.stopReason === 'aborted' ? message.errorMessage ?? '回答已中止'
      : message.stopReason === 'error' ? message.errorMessage ?? '回答生成失败' : null
    if (ending) {
      flushProcess()
      rows.push(<p key={`${id}:ending`} className="message-ending" role={message.stopReason === 'error' || message.stopReason === 'aborted' ? 'alert' : undefined}>{ending}</p>)
    }
  }
  flushProcess()
  return <div className="assistant-message">{rows}</div>
}
