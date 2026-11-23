import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@agent-learning/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryTool } from '../src/memory-tool.js'
import { formatMemoryInstructions, formatProjectMemory, formatUserMemory, formatUserMemoryTargets } from '../src/memory-prompt.js'
import { MemoryStore, type MemoryProject } from '../src/memory-store.js'

const sessionId = 'session-1'
const savedAt = Date.parse('2026-11-23T02:00:00Z')
const newEntry = {
  operation: 'write', scope: 'user', title: '讲解顺序', summary: '先用例子', content: '先用例子解释概念。',
} satisfies JsonObject

describe('memory model tool', () => {
  let directory: string
  let store: MemoryStore
  let canWrite: () => boolean

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'si-memory-tool-'))
    store = new MemoryStore(join(directory, 'memory'), () => savedAt)
    canWrite = () => true
  })

  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  async function execute(args: JsonObject, options: { signal?: AbortSignal; project?: MemoryProject } = {}) {
    const { signal = new AbortController().signal, project } = options
    const tool = createMemoryTool({ store, sessionId, canWrite, project })
    const output = await tool.execute(args, { signal, recordDetails: () => {} })
    if (typeof output === 'string' || Array.isArray(output) || output.content[0]?.type !== 'text') {
      throw new Error('应返回包含 JSON 文本和 isError 的工具结果')
    }
    return { isError: output.isError, receipt: JSON.parse(output.content[0].text) }
  }

  it('records the session and save time and keeps an unchanged write unchanged', async () => {
    const first = await execute(newEntry)
    expect(first).toMatchObject({ isError: false, receipt: { status: 'saved', revision: 1, message: '已保存，这次修改已完成。继续当前任务。' } })
    expect((await store.readUser()).entries[0].sources).toEqual([{
      type: 'session_write', sessionId, timestamp: savedAt,
    }])
    expect(await execute(newEntry)).toMatchObject({
      isError: false, receipt: { status: 'unchanged', entryId: first.receipt.entryId, revision: 1 },
    })
  })

  it('deletes a located entry without requiring its body or a source', async () => {
    const { receipt: { entryId } } = await execute(newEntry)
    expect(await execute({ scope: 'user', operation: 'delete', entryId, expectedRevision: 1 })).toMatchObject({
      isError: false, receipt: { status: 'deleted', entryId },
    })
    expect(await store.readUser()).toMatchObject({ entries: [], markdown: '' })
  })

  it.each([
    { ...newEntry, type: 'feedback' },
    { ...newEntry, expiresAt: '2026-11-27T09:00:00+08:00' },
    { ...newEntry, entryId: 'forged-target' },
    { ...newEntry, title: ' ' },
    { ...newEntry, operations: [{ operation: 'delete', entryId: 'old-entry', expectedRevision: 1 }] },
    { ...newEntry, sourceMessageIds: ['model-chosen-message'] },
    { ...newEntry, sessionId: 'model-chosen-session' },
    { ...newEntry, timestamp: 1 },
    { ...newEntry, content: '\n\n' },
    { scope: 'user', operation: 'update', entryId: 'old-entry', expectedRevision: 1, changes: {} },
    { scope: 'user', operation: 'delete', entryId: 'old-entry', expectedRevision: 0 },
  ])('rejects parameters outside the allowed memory operation shapes (%j)', async (args) => {
    expect(await execute(args)).toMatchObject({ isError: true, receipt: { status: 'invalid_request' } })
    expect((await store.readUser()).entries).toEqual([])
  })

  it('checks write permission again at commit', async () => {
    const before = await store.readUser()
    let checks = 0
    canWrite = () => ++checks === 1
    expect(await execute(newEntry)).toMatchObject({ isError: true, receipt: { status: 'write_forbidden' } })
    expect(await store.readUser()).toEqual(before)
  })

  it('lets the Agent keep its interrupted result when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(execute(newEntry, { signal: controller.signal })).rejects.toMatchObject({ code: 'interrupted' })
    expect((await store.readUser()).entries).toEqual([])
  })

  it('returns the latest revision and body for a stale update', async () => {
    const { receipt: { entryId } } = await execute(newEntry)
    const update = { operation: 'update', scope: 'user', entryId, expectedRevision: 1 }
    await execute({ ...update, changes: { content: '先给一个能运行的例子。' } })
    expect(await execute({ ...update, changes: { content: '先列出完整的概念术语。' } })).toMatchObject({
      isError: true, receipt: { status: 'version_conflict', latest: { entryId, revision: 2, content: '先给一个能运行的例子。' } },
    })
  })

  it('returns current entries for single-write overflow and accepts one atomic retry', async () => {
    const { receipt: { entryId } } = await execute({ ...newEntry, content: '例'.repeat(1300) })
    const old = await store.readUser()
    const write = { operation: 'write', title: '重要取舍', summary: '逐项确认', content: '确'.repeat(75) }
    const overflow = await execute({ scope: 'user', ...write })
    expect(overflow).toMatchObject({
      isError: true,
      receipt: { status: 'capacity_exceeded', usedChars: old.characters, limitChars: 1375, overByChars: expect.any(Number), message: expect.stringContaining('operations'),
        entries: [{ entryId, revision: 1, content: '例'.repeat(1300) }] },
    })
    const update = { operation: 'update', entryId, expectedRevision: 1, changes: { content: '先用例子。' } }
    const overflowAgain = await execute({ scope: 'user', operations: [update, { ...write, content: '长'.repeat(1375) }] })
    expect(overflowAgain).toMatchObject({ isError: true, receipt: { status: 'capacity_exceeded', message: expect.stringContaining('整批未保存') } })
    expect(overflowAgain.receipt).not.toHaveProperty('entries')
    expect(await store.readUser()).toEqual(old)
    const result = await execute({ scope: 'user', operations: [
      update, write,
    ] })
    expect(result).toMatchObject({ isError: false, receipt: { status: 'saved', operations: [
      { status: 'saved', entryId, revision: 2 }, { status: 'saved', revision: 1 },
    ] } })
    expect((await store.readUser()).markdown).toContain('先用例子。')
  })

  it('rejects a capacity retry that would delete an entry without merging it', async () => {
    const { receipt: { entryId } } = await execute(newEntry)
    const before = await store.readUser()
    expect(await execute({ scope: 'user', operations: [
      { operation: 'delete', entryId, expectedRevision: 1 },
      { operation: 'write', title: '另一条约定', summary: '逐项确认', content: '先确认取舍。' },
    ] })).toMatchObject({ isError: true, receipt: { status: 'invalid_request' } })
    expect(await store.readUser()).toEqual(before)
  })

  it('retains the current note and reports each exceeded project byte limit', async () => {
    const workspace = join(directory, 'project')
    await mkdir(workspace)
    const project = await store.resolveProject(workspace)
    const { receipt: { entryId } } = await execute({ ...newEntry, scope: 'project', type: 'feedback' }, { project })
    const before = await store.prepareProject(project)
    const oversized = await execute({
      scope: 'project', operation: 'update', entryId, expectedRevision: 1,
      changes: { summary: '中'.repeat(8000) },
    }, { project })
    expect(oversized).toMatchObject({ isError: true, receipt: {
      status: 'capacity_exceeded', overByDirectoryBytes: expect.any(Number), overByNoteBytes: expect.any(Number),
    } })
    expect(oversized.receipt.message).toContain(`目录大小超限 ${oversized.receipt.overByDirectoryBytes} 字节`)
    expect(oversized.receipt.message).toContain(`单篇笔记超限 ${oversized.receipt.overByNoteBytes} 字节`)
    expect(await store.prepareProject(project)).toEqual(before)
  })

  it('requires real calendar dates with a timezone for expiring project facts', async () => {
    const workspace = join(directory, 'project')
    await mkdir(workspace)
    const project = await store.resolveProject(workspace)
    const fact = { ...newEntry, scope: 'project', type: 'project' }
    expect(await execute({ ...fact, expiresAt: '2032-02-31T18:00:00+08:00' }, { project })).toMatchObject({
      isError: true, receipt: { status: 'invalid_request' },
    })
    expect(await execute({ ...fact, expiresAt: '2032-02-29T18:00:00+08:00' }, { project })).toMatchObject({
      isError: false, receipt: { status: 'saved' },
    })
  })
})

describe('memory prompt', () => {
  it('exposes recall instructions independently of writing permission', () => {
    expect(formatMemoryInstructions(false, false)).toContain('任务相关、用户提到旧工作')
    expect(formatMemoryInstructions(false, false)).not.toContain('memory_source')
    expect(formatMemoryInstructions(false, true)).toContain('memory_source')
    expect(formatMemoryInstructions(false, true)).not.toContain('记录长期记忆')
    expect(formatMemoryInstructions(true, true)).toContain('记录长期记忆')
    expect(formatMemoryInstructions(true, true)).toContain('当前可见的对话')
    expect(formatMemoryInstructions(true, true)).not.toContain('本轮可引用的消息')
  })

  it('reports full directory usage while rendering only the selected entries', () => {
    const line = '- [做法](test.md) — 实际约定'
    const data = {
      projectId: 'project', name: 'project', path: '/project', directoryPath: '/app/memory/project/MEMORY.md',
      markdown: `${line}\n- [别的做法](other.md) — 另一主题\n`, count: 2, bytes: 90, entries: [],
    }
    const prompt = formatProjectMemory(data, [line])
    expect(prompt).toContain('目录总用量 2 / 200 条，90 / 24000 字节')
    expect(prompt).toContain('/app/memory/project/MEMORY.md')
    expect(prompt).toContain(line)
    expect(prompt).not.toContain('other.md')
    expect(formatProjectMemory(data, [])).toBe('')
  })

  it('keeps personal target metadata separate from the summary', () => {
    const data = {
      markdown: '## 约定\n\n举例。\n', characters: 11, revision: 4,
      entries: [{ entryId: 'entry-1', revision: 5, title: '约定', summary: '举例', content: '举例。', updatedAt: '2026-11-23T00:00:00Z', sources: [] }],
    }
    expect(formatUserMemory(data)).toContain('正文用量 11 / 1375 字符')
    expect(formatUserMemory(data)).not.toContain('entry-1')
    expect(formatUserMemoryTargets(data)).toContain('"entryId":"entry-1","revision":5,"title":"约定"')
    expect(formatUserMemory({ ...data, markdown: '', characters: 0, entries: [] })).toBe('')
  })
})
