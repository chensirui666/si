import type { NestedToolCheckpoint } from '@agent-learning/agent'
import type { NestedToolCallRecord } from './types.js'

function preview(text: string, length: number) {
  return text.length > length ? text.slice(0, length) + '…' : text
}

export function summarizeNestedTool(checkpoint: NestedToolCheckpoint): Omit<NestedToolCallRecord, 'parent' | 'runId'> {
  const { id, name, status } = checkpoint
  const keys = Object.keys(checkpoint.arguments)
  const ordered = [...new Set(['path', 'command', 'pattern', 'query', ...keys])].filter(key =>
    Object.hasOwn(checkpoint.arguments, key)).slice(0, 12)
  const argumentsPreview = Object.fromEntries(ordered.map(key => {
    const value = checkpoint.arguments[key]
    const text = JSON.stringify(value)
    return [preview(key, 100), text.length <= 320 ? value : preview(typeof value === 'string' ? value : text, 320)]
  }))
  if (status === 'running') return { id, name, status, argumentsPreview }
  const { result, details } = checkpoint.outcome
  const operation = details.find((detail): detail is NonNullable<NestedToolCallRecord['fileOperation']> =>
    !!detail && typeof detail === 'object' && 'kind' in detail && (detail.kind === 'read' || detail.kind === 'modified')
    && 'path' in detail && typeof detail.path === 'string')
  const resultPreview = preview(result.content.map(block => block.type === 'text' ? block.text : '[图片]').join('\n'), 2000)
  return { id, name, status, argumentsPreview, resultPreview, ...(operation && { fileOperation: operation }) }
}
