import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareSessionReferences, renderReference } from '../src/session-references.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const source = (id: string, text: string) => ({
  summary: { id, workspaceId: 'source-workspace', name: '来源会话', createdAt: new Date().toISOString() },
  capturedThroughSeq: 9,
  messages: [
    { role: 'user' as const, text: '早期决定：青色与白色' },
    { role: 'assistant' as const, text },
  ],
})

it('14/17 读取可见正文、去重，并拒绝不可读或未登记的引用', async () => {
  const read = (id: string) => id === 'source' ? source(id, '最后一条回复') : undefined
  const input = { sessionId: 'target', sourceIds: ['source', 'source'], read, canReference: async () => true }
  const { references } = await prepareSessionReferences(input)
  expect(references).toEqual([{
    sourceSessionId: 'source', capturedThroughSeq: 9, label: '来源会话',
    excerpt: source('source', '最后一条回复').messages,
  }])
  await expect(prepareSessionReferences({ ...input, sourceIds: ['target'] })).rejects.toThrow('不能引用当前会话')
  await expect(prepareSessionReferences({ ...input, sourceIds: ['missing'] })).rejects.toThrow('无法读取引用会话')
  await expect(prepareSessionReferences({ ...input, canReference: async () => false })).rejects.toThrow('无法读取引用会话')
  await expect(prepareSessionReferences({ ...input, read: () => { throw new Error('database read failed') } })).rejects.toThrow('无法读取引用会话')
  await expect(prepareSessionReferences({ ...input, sourceIds: ['a', 'b', 'c', 'd'] })).rejects.toThrow('最多引用 3 个会话')
})

it('15/18 为三个引用各自保留近期摘录和发送时的完整快照', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-refs-'))
  directories.push(directory)
  let latest = '中文摘录'.repeat(6000) + '发送前补充'
  const { references } = await prepareSessionReferences({
    sessionId: 'target', sourceIds: ['a', 'b', 'c'], contextWindow: 128_000, directory,
    read: id => source(id, latest), canReference: async () => true,
  })
  latest += '发送后才新增'
  for (const reference of references) {
    expect(Buffer.byteLength(renderReference(reference))).toBeLessThanOrEqual(51_200)
    expect(Buffer.byteLength(renderReference(reference))).toBeGreaterThan(50_000)
    expect(reference.excerpt.at(-1)?.text).toMatch(/发送前补充$/)
    expect(reference.omitted).toMatchObject({ messages: 2, bytes: expect.any(Number) })
    expect(reference.omitted!.bytes).toBeGreaterThan(0)
    expect(reference.snapshot?.status).toBe('saved')
    if (reference.snapshot?.status !== 'saved') throw new Error('Expected snapshot')
    const snapshot = await readFile(reference.snapshot.path, 'utf8')
    expect(snapshot).toContain('早期决定：青色与白色')
    expect(snapshot).toContain('发送前补充')
    expect(snapshot).not.toContain('发送后才新增')
  }
  expect(new Set(references.map(reference => reference.snapshot?.status === 'saved' && reference.snapshot.path)).size).toBe(3)
})

it.each([32_000, undefined])('16/19 小或未知窗口用 32 KiB，写快照出错仍给摘录（%s）', async contextWindow => {
  const path = await mkdtemp(join(tmpdir(), 'chat-refs-'))
  directories.push(path)
  const directory = join(path, 'not-a-directory')
  await writeFile(directory, '')
  const { references } = await prepareSessionReferences({
    sessionId: 'target', sourceIds: ['source'], contextWindow, directory,
    read: id => source(id, '中文🙂<'.repeat(8000)), canReference: async () => true,
  })
  const [reference] = references
  expect(Buffer.byteLength(renderReference(reference))).toBeLessThanOrEqual(32_768)
  expect(Buffer.byteLength(renderReference(reference))).toBeGreaterThan(32_000)
  expect(reference.snapshot).toEqual({ status: 'unavailable', reason: 'save-failed' })
  expect(renderReference(reference)).not.toContain('<')
  expect(reference.omitted).toMatchObject({ messages: 2, bytes: expect.any(Number) })
})
