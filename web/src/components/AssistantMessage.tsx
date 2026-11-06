import { useState, type ReactNode } from 'react'
import type { ActiveContent, RunningState } from '@agent-learning/agent'
import type { AssistantMessage as Message, ToolCall, ToolResultMessage } from '@agent-learning/model'
import { MarkdownText } from './markdown/MarkdownText'

export type AssistantEntry = { id: string; message: Message }
export type ToolResults = ReadonlyMap<string, ReadonlyMap<number, ToolResultMessage>>

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

function ToolBlock({ block, streaming, argumentsText, running, executing, result }: {
  block: ToolCall
  streaming: boolean
  argumentsText?: string
  running: boolean
  executing: boolean
  result?: ToolResultMessage
}) {
  const presentation = Object.hasOwn(toolSummaries, block.name) ? toolSummaries[block.name] : undefined
  const action = presentation?.[0] ?? (block.name || '工具调用')
  const target = presentation ? block.arguments[presentation[1]] : undefined
  const firstUrl = Array.isArray(target) ? target.find(value => typeof value === 'string') : undefined
  const label = typeof target === 'string' ? target : firstUrl
  const status = result ? result.isError ? '失败' : '成功'
    : executing ? '执行中' : streaming ? '接收参数中'
    : block.argumentsError ? '参数无效' : running ? '等待执行' : '未执行'
  return <details className="tool-block">
    <summary>
      <span className="process-preview">{action}{label && ` · ${label}`}</span>
      <span className="tool-status" data-result={result ? (result.isError ? 'failure' : 'success') : undefined}>{status}</span>
    </summary>
    <div className="tool-details">
      <div className="tool-detail-label">参数</div>
      <pre>{argumentsText ?? JSON.stringify(block.arguments, null, 2)}</pre>
      {block.argumentsError && <p className="message-error">{block.argumentsError}</p>}
      {result && <>
        <div className="tool-detail-label">结果</div>
        <pre className="tool-result">{result.content.map(item => item.text).join('\n')}</pre>
      </>}
    </div>
  </details>
}

export function AssistantMessage({ messages, activeContent = [], running = null, toolResults }: {
  messages: readonly AssistantEntry[]
  activeContent?: readonly ActiveContent[]
  running?: RunningState
  toolResults?: ToolResults
}) {
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
        process.push(<ToolBlock key={key} block={block} streaming={active?.type === 'toolCall'} argumentsText={active?.type === 'toolCall' ? active.argumentsText : undefined}
          running={running?.phase === 'model' || running?.phase === 'tools'}
          executing={running?.activeTool?.assistantMessageId === id && running.activeTool.contentIndex === index}
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
