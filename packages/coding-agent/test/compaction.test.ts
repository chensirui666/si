import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AssistantMessage, ModelMessage, ToolCall } from '@agent-learning/model'
import { buildModelHistory, createSummaryContext, prepareCompaction } from '../src/compaction.js'
import type { CompactionPreparation } from '../src/compaction.js'
import type { CompactionRecord, ConversationMessage } from '../src/types.js'

const user = (id: string, content: string): ConversationMessage => ({ id, message: { role: 'user', content, timestamp: 0 } })
const assistant = (id: string, content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): ConversationMessage => ({
  id, message: { role: 'assistant', content, stopReason, model: 'deepseek-flash', provider: 'deepseek', api: 'openai-completions', timestamp: 0 },
})
const call: ToolCall = { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'note.txt' } }
const result = (id: string, text: string, assistantMessageId = 'a1', contentIndex = 0, toolCallId = 'read-1'): ConversationMessage => ({
  id, toolCall: { assistantMessageId, contentIndex },
  message: { role: 'toolResult', toolCallId, toolName: contentIndex ? 'grep' : 'read', content: [{ type: 'text', text }], timestamp: 0, isError: false },
})
const previous: Extract<CompactionRecord, { status: 'success' }> = {
  id: 'compact-1', trigger: 'manual', status: 'success', startedAt: 0, finishedAt: 1,
  summary: '项目名称：青禾；输出格式：Markdown。', firstKeptMessageId: 'u2', contextLastMessageId: 'a2',
  estimatedBefore: 100, estimatedAfter: 30,
}
const ready = (preparation: CompactionPreparation) => {
  expect(preparation.status).toBe('ready')
  if (preparation.status !== 'ready') throw new Error('Missing compaction preparation')
  return preparation
}
const serialized = (messages: ModelMessage[]) => messages.map(message => typeof message.content === 'string'
  ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('')).join('\n')

describe('effective model history', () => {
  it('excludes failed, aborted and pending attempts with their tool results', () => {
    const entries = [user('u1', 'task'), assistant('a1', [call], 'error'), result('r1', 'failed result'),
      assistant('a2', [call], 'aborted'), result('r2', 'aborted result', 'a2'),
      assistant('a3', [call], 'pending'), result('r3', 'pending result', 'a3'),
      assistant('a4', [{ type: 'text', text: 'kept' }], 'length')]
    expect(buildModelHistory(entries)).toEqual([entries[0].message, entries[7].message])
  })

  it('replaces only earlier messages with one user-role summary and preserves the raw history', () => {
    const entries = [user('u1', 'superseded raw fact'), user('u2', 'current task'), assistant('a2', [{ type: 'text', text: 'progress' }])]
    const before = structuredClone(entries)
    const fileOperations = { readFiles: ['/read.ts'], modifiedFiles: ['/modified.ts'] }
    const history = buildModelHistory(entries, { ...previous, fileOperations })
    const promptDocument = readFileSync(new URL('../../../docs/prompts/compaction/content.md', import.meta.url), 'utf8')
    const template = promptDocument.split('```text\n')[1].split('\n```')[0]
    const summary = `${previous.summary}\n\n工具确认的文件操作（readFiles 仅读，modifiedFiles 已改）：${JSON.stringify(fileOperations)}`
    expect(history).toHaveLength(3)
    expect(history[0]).toEqual({ role: 'user', timestamp: 1, content: template.replace('${summary}', () => summary) })
    expect(serialized(history)).not.toContain('superseded raw fact')
    expect(history.slice(1)).toEqual(entries.slice(1).map(entry => entry.message))
    ;(history[1] as { content: string }).content = 'mutated copy'
    expect(entries).toEqual(before)
  })
})

describe('compaction preparation', () => {
  it('does not summarize when the recent budget already covers all messages', () => {
    const entries = [user('u1', 'short'), assistant('a1', [{ type: 'text', text: 'answer' }])]
    expect(prepareCompaction(entries, undefined, 20_000, false)).toEqual({ status: 'skipped', reason: 'nothing_to_compact' })
    expect(prepareCompaction([], undefined, 20_000, false)).toEqual({ status: 'skipped', reason: 'nothing_to_compact' })
  })

  it('does not recompact an unchanged effective tail or count failed attempts as new content', () => {
    const entries = [user('u1', 'old'), user('u2', 'kept'), assistant('a2', [{ type: 'text', text: 'done' }]), assistant('failed', [], 'error')]
    expect(prepareCompaction(entries, previous, 1, true)).toEqual({ status: 'skipped', reason: 'already_compacted' })
  })

  it('keeps an assistant call and all its results on the same side of a cut', () => {
    const grep: ToolCall = { type: 'toolCall', id: 'grep-1', name: 'grep', arguments: { pattern: 'name' } }
    const entries = [user('u1', 'original request'), assistant('a0', [{ type: 'text', text: 'earlier progress' }]),
      assistant('a1', [call, grep], 'toolUse'), result('r1', 'a'.repeat(300)), result('r2', 'b'.repeat(300), 'a1', 1, 'grep-1')]
    const prepared = ready(prepareCompaction(entries, undefined, 30, true))
    expect(prepared.firstKeptMessageId).toBe('a1')
    expect(prepared.contextLastMessageId).toBe('r2')
    expect(prepared.messagesToSummarize).toEqual(entries.slice(0, 2).map(entry => entry.message))
    expect(buildModelHistory(entries, { ...previous, firstKeptMessageId: prepared.firstKeptMessageId }).slice(1))
      .toEqual(entries.slice(2).map(entry => entry.message))
  })

  it('can move an entire old tool group into the summary while retaining newer messages', () => {
    const entries = [user('u1', 'task'), assistant('a1', [call], 'toolUse'), result('r1', 'old tool result'), user('u2', 'new '.repeat(100))]
    const prepared = ready(prepareCompaction(entries, undefined, 10, true))
    expect(prepared.firstKeptMessageId).toBe('u2')
    expect(prepared.messagesToSummarize).toEqual(entries.slice(0, 3).map(entry => entry.message))
  })

  it('lists only confirmed operations before the new cut, including operations from previously compacted history', () => {
    const fileRead = (id: string, assistantId: string, path: string): ConversationMessage => ({
      ...result(id, 'x'.repeat(200), assistantId), fileOperation: { kind: 'read', path },
    })
    const entries = [user('u1', 'old task'), assistant('a1', [call], 'toolUse'), fileRead('r1', 'a1', '/old.ts'),
      user('u2', 'new task'), assistant('a2', [call], 'toolUse'), fileRead('r2', 'a2', '/new.ts'),
      assistant('a3', [call], 'toolUse'), fileRead('r3', 'a3', '/recent.ts')]
    const prepared = ready(prepareCompaction(entries, previous, 30, false))
    expect(prepared.firstKeptMessageId).toBe('a3')
    expect(prepared.fileOperations).toEqual({ readFiles: ['/new.ts', '/old.ts'], modifiedFiles: [] })
  })

  it('merges the previous summary with newly summarized raw messages without replaying replaced history', () => {
    const entries = [user('u1', 'replaced secret'), user('u2', '输出格式更正为 JSON'),
      assistant('a2', [{ type: 'text', text: '已确认更正' }]), user('u3', 'next task '.repeat(100))]
    const prepared = ready(prepareCompaction(entries, previous, 10, true))
    const context = createSummaryContext(prepared)
    expect(prepared.previousSummary).toBe(previous.summary)
    expect(prepared.firstKeptMessageId).toBe('u3')
    expect(serialized(context.messages)).toContain('项目名称：青禾')
    expect(serialized(context.messages)).toContain('输出格式更正为 JSON')
    expect(serialized(context.messages)).not.toContain('replaced secret')
  })

  it('counts applicable thinking when deciding how much recent history to retain', () => {
    const entries = [user('u1', 'original task'), assistant('a1', [{ type: 'thinking', thinking: 'x'.repeat(800) }, { type: 'text', text: 'progress' }]), user('u2', 'new')]
    expect(prepareCompaction(entries, undefined, 100, false)).toEqual({ status: 'skipped', reason: 'nothing_to_compact' })
    expect(ready(prepareCompaction(entries, undefined, 100, true)).firstKeptMessageId).toBe('a1')
  })
})

describe('summary context', () => {
  const preparation = (message: ModelMessage): Extract<CompactionPreparation, { status: 'ready' }> => ({
    status: 'ready', messagesToSummarize: [message], firstKeptMessageId: 'kept', contextLastMessageId: 'last',
  })

  it('uses independent instructions, omits thinking and retains task, progress and tool arguments', () => {
    const entries = [user('u1', '只修改临时目录；下一步读取 note.txt'), assistant('a1', [
      { type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'index.txt 已读取' }, call,
    ], 'toolUse'), user('u2', 'recent '.repeat(100))]
    const before = structuredClone(entries)
    const context = createSummaryContext(ready(prepareCompaction(entries, undefined, 10, true)))
    const text = serialized(context.messages)
    const promptDocument = readFileSync(new URL('../../../docs/prompts/compaction/systemPrompt.md', import.meta.url), 'utf8')
    expect(context.systemPrompt).toBe(promptDocument.split('```text\n')[1].split('\n```')[0])
    expect(context.tools).toBeUndefined()
    expect(text).toContain('只修改临时目录')
    expect(text).toContain('index.txt 已读取')
    expect(text).toContain('note.txt')
    expect(text).toContain('read-1')
    expect(text).not.toContain('PRIVATE_THINKING')
    expect(entries).toEqual(before)
  })

  it.each(['项目青禾，退出码 0', '短'.repeat(2000), '😀'.repeat(2000)])('preserves a result of at most 2000 complete characters unchanged', text => {
    const context = createSummaryContext(preparation(result('r1', text).message))
    const rendered = serialized(context.messages)
    expect(rendered).toContain(text)
    expect(rendered).not.toContain('截断')
  })

  it('preserves a failed tool result as a failure rather than successful evidence', () => {
    const failed = result('r1', 'permission denied').message
    if (failed.role !== 'toolResult') throw new Error('Missing tool result')
    failed.isError = true
    const rendered = serialized(createSummaryContext(preparation(failed)).messages)
    expect(rendered).toMatch(/Tool result read-1 read error/)
    expect(rendered).toContain('permission denied')
  })

  it('keeps 1500 leading and 500 trailing Unicode characters with a truncation marker', () => {
    const head = '项目青禾' + 'a'.repeat(1495) + '😀'
    const tail = '🚀' + 'b'.repeat(494) + '退出码 0'
    expect(Array.from(head)).toHaveLength(1500)
    expect(Array.from(tail)).toHaveLength(500)
    const text = head + 'MIDDLE_ONLY'.repeat(100) + tail
    const context = createSummaryContext(preparation(result('r1', text).message))
    const rendered = serialized(context.messages)
    expect(rendered).toContain(head)
    expect(rendered).toContain(tail)
    expect(rendered).toContain('截断')
    expect(rendered).not.toContain('MIDDLE_ONLY')
    expect(rendered).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
  })
})
