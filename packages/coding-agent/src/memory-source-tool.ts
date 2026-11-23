import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { MemoryStoreError, type MemoryProject, type MemoryStore } from './memory-store.js'
import type { CodingTool } from './tools.js'
import type { ConversationMessage } from './types.js'

export const MEMORY_SOURCE_TOOL_NAME = 'memory_source'

const pageSize = 6
const messageLimit = 750
const cursor = { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const parameters = Type.Object({
  scope: Type.Union([Type.Literal('user'), Type.Literal('project')]),
  entryId: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,100}$' }),
  sourceIndex: Type.Optional(Type.Integer({ ...cursor, description: '来源序号，从最近的 0 开始。用 nextSourceIndex 查看下一条来源。' })),
  offset: Type.Optional(Type.Integer({ ...cursor, description: '会话片段偏移，默认 0。用 nextOffset 查看更早的消息。' })),
}, { additionalProperties: false })

function receipt(status: string, message: string, details: Record<string, unknown> = {}) {
  return {
    isError: status !== 'found' && status !== 'user_edit',
    content: [{ type: 'text' as const, text: JSON.stringify({ status, message, ...details }) }],
  }
}

function visibleText({ message, extension }: ConversationMessage) {
  if (extension || (message.role !== 'user' && message.role !== 'assistant')) return
  const { role, timestamp, content } = message
  const text = (typeof content === 'string' ? content : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).trim()
  if (!text) return
  // shortcut: return the start of long messages, add within-message paging if long quotes are needed.
  return text.length > messageLimit
    ? { role, timestamp, text: text.slice(0, messageLimit).replace(/[\uD800-\uDBFF]$/u, ''), truncated: true }
    : { role, timestamp, text }
}

export function createMemorySourceTool({ store, project, readSession }: {
  store: MemoryStore
  project?: MemoryProject
  readSession: (id: string) => Promise<readonly ConversationMessage[] | undefined>
}): CodingTool {
  return {
    name: MEMORY_SOURCE_TOOL_NAME, parameters, preserveFailure: true,
    description: '仅在用户要求核对记忆出处或原话时使用。用个人或当前项目的记忆条目编号查询保存时间附近的普通对话片段，可向前翻页。平时应用记忆直接读取笔记。',
    promptSnippet: '用户要求核对记忆出处时，按条目读取来源会话。',
    async execute(args, { signal }) {
      signal.throwIfAborted()
      if (!Check(parameters, args)) return receipt('invalid_request', 'memory_source 工具参数不符合声明。')
      const { scope, entryId, sourceIndex = 0, offset = 0 } = args
      try {
        const entry = await store.readEntry(scope, project, entryId)
        signal.throwIfAborted()
        if (!entry) return receipt('entry_not_found', '找不到当前范围内的有效记忆条目。')
        const sources = [...entry.sources].reverse().sort((a, b) => b.timestamp - a.timestamp)
        const source = sources[sourceIndex]
        if (!source) return receipt('source_unavailable', '没有可查阅的这条来源记录。')
        const { timestamp } = source
        const date = new Date(timestamp).toISOString()
        const nextSource = sourceIndex + 1 < sources.length ? { nextSourceIndex: sourceIndex + 1 } : {}
        if ('type' in source && source.type === 'user_edit') {
          return receipt('user_edit', '这条来源是用户直接编辑记忆。', { timestamp, editedAt: date, ...nextSource })
        }
        const history = await readSession(source.sessionId).catch(() => undefined)
        signal.throwIfAborted()
        const unavailable = () => receipt('source_unavailable', '已记录的来源会话无法查阅，或原消息已不可用。', nextSource)
        if (!history) return unavailable()

        const legacy = 'messageId' in source
        const last = legacy ? history.findIndex(entry => entry.id === source.messageId) : history.length - 1
        if (last < 0) return unavailable()
        const messages: NonNullable<ReturnType<typeof visibleText>>[] = []
        let eligible = 0
        let nextOffset: number | undefined
        for (let index = last; index >= 0; index--) {
          const item = history[index]
          const sentAt = item.message.timestamp
          if (sentAt > timestamp || (sentAt === timestamp && !legacy)) continue
          const message = visibleText(item)
          if (!message) continue
          if (eligible < offset) {
            eligible++
            continue
          }
          if (messages.length === pageSize) {
            nextOffset = offset + pageSize
            break
          }
          messages.push(message)
        }
        if (!messages.length) {
          return receipt('excerpt_unavailable', '这页没有可供引用的普通对话。', nextSource)
        }
        return receipt('found', '已读取来源会话的普通对话片段。', {
          sessionId: source.sessionId,
          timestamp,
          ...(legacy ? { messageAt: date } : { savedAt: date }),
          messages: messages.reverse(),
          ...(nextOffset === undefined ? {} : { nextOffset }),
          ...nextSource,
        })
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof MemoryStoreError) return receipt(error.code, '无法查阅这条记忆的来源。')
        throw error
      }
    },
  }
}
