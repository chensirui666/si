import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JsonObject } from '@agent-learning/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemorySourceTool } from '../src/memory-source-tool.js'
import { formatProjectNote } from '../src/memory-markdown.js'
import { MemoryStore, type MemoryProject } from '../src/memory-store.js'
import type { ConversationMessage } from '../src/types.js'

const savedAt = Date.parse('2026-11-23T02:00:00Z')
const sourceId = 'recorded-session'
const user = (id: string, content: string, timestamp: number): ConversationMessage => ({
  id, message: { role: 'user', content, timestamp },
})

describe('memory source tool', () => {
  let directory: string
  let store: MemoryStore
  let entryId: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'si-memory-source-'))
    store = new MemoryStore(directory, () => savedAt)
    const saved = await store.apply('user', undefined, [{
      operation: 'write', title: '演示顺序', summary: '演示前确认分支', content: '演示前确认目标分支。',
    }], { sessionId: sourceId })
    if (!('entryId' in saved)) throw new Error('本测试应保存一条记忆')
    entryId = saved.entryId
  })

  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  async function execute(
    args: JsonObject,
    readSession: (sessionId: string) => Promise<readonly ConversationMessage[] | undefined>,
    project?: MemoryProject,
  ) {
    const tool = createMemorySourceTool({ store, project, readSession })
    const output = await tool.execute(args, { signal: new AbortController().signal, recordDetails: () => {} })
    if (typeof output === 'string' || Array.isArray(output) || output.content[0]?.type !== 'text') {
      throw new Error('应返回包含 JSON 文本的工具结果')
    }
    return { isError: output.isError, receipt: JSON.parse(output.content[0].text) }
  }

  it('links the exact recorded session and returns only its visible text before the saved time', async () => {
    const history: ConversationMessage[] = [
      user('origin', '请以后在演示前先和我确认要演示的分支。', savedAt - 4),
      {
        id: 'assistant',
        message: {
          role: 'assistant', api: 'test', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: savedAt - 3,
          content: [
            { type: 'thinking', thinking: 'private-thinking' },
            { type: 'toolCall', id: 'call', name: 'memory', arguments: { secret: 'tool-argument' } },
            { type: 'text', text: '演示前会确认分支。' },
          ],
        },
      },
      { id: 'tool', message: {
        role: 'toolResult', toolCallId: 'call', toolName: 'memory', timestamp: savedAt - 2, isError: false,
        content: [{ type: 'text', text: 'private-tool-result' }],
      } },
      { ...user('extension', 'hidden-extension', savedAt - 1), extension: { customType: 'test', display: false } },
      user('same-ms', '保存同一毫秒的其他内容', savedAt),
      user('later', '保存之后才说的内容', savedAt + 1),
    ]
    const output = await execute({ scope: 'user', entryId }, async id => id === sourceId ? history : undefined)
    expect(output.receipt).toMatchObject({
      status: 'found', sessionId: sourceId, timestamp: savedAt, savedAt: '2026-11-23T02:00:00.000Z',
      messages: [
        { role: 'user', timestamp: savedAt - 4, text: '请以后在演示前先和我确认要演示的分支。' },
        { role: 'assistant', timestamp: savedAt - 3, text: '演示前会确认分支。' },
      ],
    })
    expect(JSON.stringify(output)).not.toMatch(/private-thinking|tool-argument|private-tool-result|hidden-extension|保存同一毫秒|保存之后/)
  })

  it('returns a bounded page and a cursor for older messages', async () => {
    const history = Array.from({ length: 24 }, (_, index) => user(
      String(index), `message-${index} ${'长'.repeat(8000)}`, savedAt - 30 + index,
    ))
    const args = { scope: 'user', entryId }
    const { receipt: first } = await execute(args, async () => history)
    expect(first.messages.length).toBeLessThan(24)
    expect(JSON.stringify(first).length).toBeLessThan(10_000)
    expect(first.messages.at(-1)).toMatchObject({ text: expect.stringContaining('message-23 '), truncated: true })
    expect(first.nextOffset).toBeGreaterThan(0)
    const { receipt: older } = await execute({ ...args, offset: first.nextOffset }, async () => history)
    expect(older.messages.at(-1).timestamp).toBe(first.messages[0].timestamp - 1)
  })

  it('does not expose a stale or denied history and does not accept session identifiers as input', async () => {
    const forbiddenRead = async () => { throw new Error('The history should not be requested') }
    const args = { scope: 'user', entryId }
    expect((await execute({ ...args, sessionId: sourceId }, forbiddenRead)).receipt.status).toBe('invalid_request')
    expect((await execute({ ...args, entryId: 'deleted-memory' }, forbiddenRead)).receipt.status).toBe('entry_not_found')
    const denied = await execute(args, async () => undefined)
    expect(denied).toMatchObject({ isError: true, receipt: { status: 'source_unavailable' } })
    expect(JSON.stringify(denied)).not.toContain(sourceId)
  })

  it('defaults to the last saved source when write times match', async () => {
    const laterId = 'second-session'
    await store.apply('user', undefined, [{
      operation: 'update', entryId, expectedRevision: 1, changes: { content: '演示前先确认分支和环境。' },
    }], { sessionId: laterId })
    const log = async (id: string) => [user('record', id, savedAt - 1)]
    const args = { scope: 'user', entryId }
    const latest = await execute(args, log)
    expect(latest.receipt).toMatchObject({ status: 'found', sessionId: laterId, nextSourceIndex: 1 })
    const earlier = await execute({ ...args, sourceIndex: latest.receipt.nextSourceIndex }, log)
    expect(earlier.receipt).toMatchObject({ status: 'found', sessionId: sourceId })
  })

  it('follows a legacy message anchor without treating its sent time as the save time', async () => {
    const project = await store.resolveProject(directory)
    await store.apply('project', project, [{
      operation: 'write', type: 'feedback', title: '演示前确认分支', summary: '确认分支', content: '先确认分支。',
    }], { sessionId: sourceId })
    const [noteRecord] = (await store.prepareProject(project)).entries
    const note = (await store.readEntry('project', project, noteRecord.entryId))!
    await writeFile(noteRecord.path, formatProjectNote({
      ...note,
      sources: [{ sessionId: sourceId, messageId: 'anchor', timestamp: savedAt, position: 1 }],
    }))
    const history = [user('anchor', '这是保存的原话。', savedAt), user('after', '这一行在原话之后。', savedAt)]
    const log = async (id: string) => id === sourceId ? history : undefined
    const args = { scope: 'project', entryId: noteRecord.entryId }
    const output = await execute(args, log, project)
    expect(output.receipt).toMatchObject({
      status: 'found', sessionId: sourceId, messageAt: '2026-11-23T02:00:00.000Z',
      messages: [{ role: 'user', text: '这是保存的原话。' }],
    })
    expect(output.receipt).not.toHaveProperty('savedAt')
    const absent = await execute(args, async () => history.slice(1), project)
    expect(absent.receipt.status).toBe('source_unavailable')
  })

  it('identifies settings edits without attempting to access session history', async () => {
    const before = await store.readUser()
    const edited = await store.saveUser('## 个人约定\n\n原文由用户录入。\n', before.revision)
    const { receipt } = await execute({ scope: 'user', entryId: edited.entries[0].entryId }, async () => {
      throw new Error('The history should not be requested')
    })
    expect(receipt).toMatchObject({ status: 'user_edit', timestamp: savedAt })
    expect(receipt).not.toHaveProperty('sessionId')
  })
})
