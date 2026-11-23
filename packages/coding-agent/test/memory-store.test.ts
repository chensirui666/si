import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { MemoryStore, projectMemoryLines, type MemoryOperation } from '../src/memory-store.js'

const now = Date.parse('2026-11-23T00:00:00.000Z')
const sessionOptions = { sessionId: 'session-1' }
const sessionWrite = { type: 'session_write', sessionId: 'session-1', timestamp: now }

function write(title: string, fields: Partial<Extract<MemoryOperation, { operation: 'write' }>> = {}): Extract<MemoryOperation, { operation: 'write' }> {
  return { operation: 'write', title, summary: title, content: '保留可复用约定。', ...fields }
}

function update(entry: { entryId: string; revision: number }, changes: Extract<MemoryOperation, { operation: 'update' }>['changes']): Extract<MemoryOperation, { operation: 'update' }> {
  return { operation: 'update', entryId: entry.entryId, expectedRevision: entry.revision, changes }
}

function remove(entry: { entryId: string; revision: number }): MemoryOperation {
  return { operation: 'delete', entryId: entry.entryId, expectedRevision: entry.revision }
}

async function seedNotes(directoryPath: string, count: number, summary = 'x') {
  const directory = dirname(directoryPath)
  await mkdir(directory, { recursive: true })
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    const entryId = `note-${String(i).padStart(3, '0')}`
    const metadata = { entryId, type: 'feedback', title: 'Test', summary, revision: 1, updatedAt: new Date(now).toISOString(), sources: [] }
    await writeFile(join(directory, `${entryId}.md`), `---\n${stringify(metadata)}---\n\nA project memory.\n`)
  }))
}

describe('Markdown memory store', () => {
  let temp: string
  let store: MemoryStore
  let workspace: string
  let memory: string

  beforeEach(async () => {
    temp = await realpath(await mkdtemp(join(tmpdir(), 'si-memory-')))
    workspace = join(temp, 'workspace')
    await mkdir(workspace)
    memory = join(temp, 'memory')
    store = new MemoryStore(memory, () => now)
  })

  afterEach(async () => { await rm(temp, { recursive: true, force: true }) })

  it('records the saving session and time for project edits and leaves exact duplicates unchanged', async () => {
    const project = await store.resolveProject(workspace)
    const note = write('测试约定', { type: 'feedback' })
    await store.apply('project', project, [note], sessionOptions)
    const saved = await store.prepareProject(project)
    const [entry] = saved.entries
    const original = await readFile(entry.path, 'utf8')
    expect(parse(original.split(/^---$/m)[1]).sources).toEqual([
      { type: 'session_write', sessionId: 'session-1', savedAt: '2026-11-23T00:00:00.000Z' },
    ])
    expect(await store.readEntry('project', project, entry.entryId)).toMatchObject({ revision: 1, sources: [sessionWrite] })
    expect(await readFile(saved.directoryPath, 'utf8')).toBe(saved.markdown)
    const later = new MemoryStore(memory, () => now + 1_000)
    const laterSession = { sessionId: 'session-2' }
    const unchanged = { status: 'unchanged', entryId: entry.entryId, revision: 1 }
    expect(await later.apply('project', project, [note], laterSession)).toEqual(unchanged)
    expect(await later.apply('project', project, [update(entry, { content: note.content })], laterSession)).toEqual(unchanged)
    expect(await readFile(entry.path, 'utf8')).toBe(original)

    const results = await Promise.allSettled([
      later.apply('project', project, [update(entry, { content: '先确认迁移。' })], laterSession),
      store.apply('project', project, [update(entry, { content: '另一个版本。' })], { sessionId: 'stale-session' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find(result => result.status === 'rejected')
    expect(failed).toMatchObject({ reason: { code: 'version_conflict', details: { latest: { entryId: entry.entryId, revision: 2 } } } })
    expect(await later.readEntry('project', project, entry.entryId)).toMatchObject({
      revision: 2,
      sources: [sessionWrite, { type: 'session_write', sessionId: 'session-2', timestamp: now + 1_000 }],
    })
    expect((await store.prepareProject(project)).entries[0]).toMatchObject({ entryId: entry.entryId, revision: 2 })
  })

  it('round-trips legacy message provenance and user edits when a project note is updated', async () => {
    const project = await store.resolveProject(workspace)
    await store.apply('project', project, [write('旧约定', { type: 'feedback' })])
    const [entry] = (await store.prepareProject(project)).entries
    const original = await readFile(entry.path, 'utf8')
    await writeFile(entry.path, original.replace('sources: []', [
      'sources:',
      '  - messageRef: old-session#message-1',
      '    sentAt: 2026-11-22T00:00:00.000Z',
      '    position: 3',
      '  - type: user_edit',
      '    editedAt: 2026-11-22T12:00:00.000Z',
    ].join('\n')))
    await store.apply('project', project, [update(entry, { summary: '更新后的约定' })], sessionOptions)
    expect(await store.readEntry('project', project, entry.entryId)).toMatchObject({ sources: [
      { sessionId: 'old-session', messageId: 'message-1', timestamp: Date.parse('2026-11-22T00:00:00.000Z'), position: 3 },
      { type: 'user_edit', timestamp: Date.parse('2026-11-22T12:00:00.000Z') },
      sessionWrite,
    ] })
  })

  it('keeps a no-op unchanged after separate edits share the same session and time', async () => {
    await store.apply('user', undefined, [write('约定')], sessionOptions)
    const [first] = (await store.readUser()).entries
    await store.apply('user', undefined, [update(first, { content: '改过的约定。' })], sessionOptions)
    const [second] = (await store.readUser()).entries
    expect(second.sources).toEqual([sessionWrite, sessionWrite])
    await expect(store.apply('user', undefined, [update(second, {})], sessionOptions)).resolves.toEqual({
      status: 'unchanged', entryId: first.entryId, revision: 2,
    })
    expect((await store.readUser()).entries).toEqual([second])
  })

  it('checks cancellation and permission again after staging the update', async () => {
    const project = await store.resolveProject(workspace)
    await store.apply('project', project, [write('测试', { type: 'feedback' })])
    const saved = await store.prepareProject(project)
    const [entry] = saved.entries
    const original = await readFile(entry.path, 'utf8')
    const abort = new AbortController()
    let checks = 0
    const canCommit = () => {
      if (++checks === 2) abort.abort()
      return true
    }
    await expect(store.apply('project', project, [update(entry, { content: '尚未提交。' })], { ...sessionOptions, signal: abort.signal, canCommit })).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readFile(entry.path, 'utf8')).toBe(original)
    expect(await readFile(saved.directoryPath, 'utf8')).toBe(saved.markdown)
  })

  it('validates exact Unicode characters and keeps the previous full text after an oversized user write', async () => {
    const markdown = '🧪'.repeat(1375)
    const saved = await store.saveUser(markdown, 0)
    expect(saved).toMatchObject({ markdown, revision: 1, characters: 1375 })
    await expect(store.saveUser(markdown + '界', 1)).rejects.toMatchObject({ code: 'capacity_exceeded', details: { usedChars: 1375, limitChars: 1375, overByChars: 1 } })
    await expect(store.apply('user', undefined, [write('新约定', { content: '一' })])).rejects.toMatchObject({ code: 'capacity_exceeded', details: { usedChars: 1375, limitChars: 1375, overByChars: 10, entries: [{ revision: 1, content: markdown }] } })
    expect(await store.readUser()).toEqual(saved)
  })

  it('round-trips user markdown and retains metadata only for untouched sections', async () => {
    const original = '开头\r\n\r\n## A\r\n记忆\r\n\r\n```md\r\n## code\r\n```\r\n\r\n## B\r\n原文'
    const first = await store.saveUser(original, 0)
    expect(first.entries.map(entry => entry.title)).toEqual(['用户摘要', 'A', 'B'])
    const changed = original.replace('原文', '改写')
    const next = await store.saveUser(changed, first.revision)
    expect(await store.readUser()).toEqual(next)
    expect(next.markdown).toBe(changed)
    expect(next.entries.slice(0, 2)).toEqual(first.entries.slice(0, 2))
    expect(next.entries[2]).toMatchObject({ entryId: first.entries[2].entryId, revision: 2, content: '改写', sources: [{ type: 'user_edit', timestamp: now }] })
    await expect(store.saveUser('错误覆盖', first.revision)).rejects.toMatchObject({ code: 'version_conflict', details: { latest: { markdown: changed, revision: next.revision } } })
  })

  it('preserves untouched Markdown layout when a tool updates one personal section', async () => {
    const first = await store.saveUser('\r\n## 偏好\r\n原文  \r\n## 行为\r\n保留原文', 0)
    await store.apply('user', undefined, [update(first.entries[1], { content: '已修改' })])
    expect((await store.readUser()).markdown).toBe('\r\n## 偏好\r\n原文  \r\n## 行为\r\n已修改')
  })

  it('commits a user merge with its addition and preserves the merged sources', async () => {
    await store.saveUser(`## 已有 A\n${'A'.repeat(650)}`, 0)
    const first = await store.apply('user', undefined, [write('已有 B', { content: 'B'.repeat(650) })], sessionOptions)
    expect(first.status).toBe('saved')
    const before = await store.readUser()
    const [a, b] = before.entries
    await expect(store.apply('user', undefined, [write('新增', { content: '新'.repeat(100) })])).rejects.toMatchObject({ code: 'capacity_exceeded' })
    const merged = { ...update(a, { content: '合并后的约定' }), mergeFromEntryIds: [b.entryId] }
    const receipt = await store.apply('user', undefined, [merged, remove(b), write('新增')], { sessionId: 'merge-session' })
    expect(receipt).toMatchObject({ status: 'saved', operations: [{ status: 'saved', revision: 2 }, { status: 'deleted' }, { status: 'saved' }] })
    const after = await store.readUser()
    expect(after.revision).toBe(before.revision + 1)
    expect(after.entries.map(entry => entry.title)).toEqual(['已有 A', '新增'])
    const mergeWrite = { type: 'session_write', sessionId: 'merge-session', timestamp: now }
    expect(after.entries[0].sources).toEqual([{ type: 'user_edit', timestamp: now }, sessionWrite, mergeWrite])
    expect(await store.readEntry('user', undefined, a.entryId)).toEqual(after.entries[0])
    expect(await store.readEntry('user', undefined, b.entryId)).toBeUndefined()
    expect(after.entries[1].sources).toEqual([mergeWrite])
  })

  it('rejects a whole user merge when a member is stale or the final result still exceeds the limit', async () => {
    await store.apply('user', undefined, [write('A'), write('B')])
    const [a, b] = (await store.readUser()).entries
    const selected = { ...update(a, { content: '兼容 A 和 B。' }), mergeFromEntryIds: [b.entryId] }
    const before = await readFile(join(memory, 'USER.md'), 'utf8')
    await expect(store.apply('user', undefined, [selected, remove(b), write('新增', { content: 'x'.repeat(1375) })])).rejects.toMatchObject({
      code: 'capacity_exceeded', details: { overByChars: expect.any(Number) },
    })
    expect(await readFile(join(memory, 'USER.md'), 'utf8')).toBe(before)
    await store.apply('user', undefined, [update(b, { content: '另一个会话已改 B。' })])
    const newer = await readFile(join(memory, 'USER.md'), 'utf8')
    await expect(store.apply('user', undefined, [selected, remove(b), write('新增')])).rejects.toMatchObject({ code: 'version_conflict', details: { latest: { entryId: b.entryId, revision: 2 } } })
    expect(await readFile(join(memory, 'USER.md'), 'utf8')).toBe(newer)
  })

  it('shares validated worktrees, keeps clones and nested repositories separate, and rejects false backlinks', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
    git(workspace, 'init')
    git(workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
    const linked = join(temp, 'linked')
    git(workspace, 'worktree', 'add', '-b', 'linked', linked)
    const clone = join(temp, 'clone')
    git(temp, 'clone', workspace, clone)
    const nested = join(workspace, 'nested')
    await mkdir(nested)
    git(nested, 'init')
    const project = await store.resolveProject(workspace)
    expect(await store.resolveProject(linked)).toEqual(project)
    expect((await store.resolveProject(clone)).projectId).not.toBe(project.projectId)
    expect((await store.resolveProject(nested)).projectId).not.toBe(project.projectId)
    const fake = join(temp, 'fake')
    await mkdir(fake)
    await writeFile(join(fake, '.git'), `gitdir: ${join(workspace, '.git', 'worktrees', 'linked')}\n`)
    expect((await store.resolveProject(fake)).projectId).not.toBe(project.projectId)
    await store.apply('project', project, [write('约定', { type: 'feedback' })])
    const [note] = (await store.prepareProject(await store.resolveProject(linked))).entries
    const other = await store.resolveProject(clone)
    await expect(store.validateRead(other, note.path)).rejects.toMatchObject({ code: 'memory_not_available' })
    await expect(store.readEntry('project', other, note.entryId)).resolves.toBeUndefined()
  })

  it('recognizes the canonical memory location when the configured parent is an alias', async () => {
    const alias = join(temp, 'alias')
    await symlink(temp, alias, 'dir')
    const aliased = new MemoryStore(join(alias, 'memory'), () => now)
    expect(aliased.isManagedPath(join(memory, 'USER.md'))).toBe(true)
    const project = await aliased.resolveProject(workspace)
    await aliased.apply('project', project, [write('约定', { type: 'feedback' })])
    const [note] = (await aliased.prepareProject(project)).entries
    await expect(aliased.validateRead(project, await realpath(note.path))).resolves.toBeUndefined()
    await expect(aliased.validateRead(project, join(alias, 'memory', 'USER.md'))).rejects.toMatchObject({ code: 'memory_not_available' })
  })

  it('excludes expired entries on read, then physically removes them only when clearing is allowed', async () => {
    const project = await store.resolveProject(workspace)
    let time = now
    const advancing = new MemoryStore(memory, () => time)
    await advancing.apply('project', project, [write('发布冻结', { type: 'project', expiresAt: new Date(now + 100).toISOString() })])
    await advancing.apply('project', project, [write('有效约定', { type: 'feedback' })])
    const old = await advancing.prepareProject(project)
    const expired = old.entries.find(entry => entry.title === '发布冻结')!
    time += 100
    expect((await advancing.prepareProject(project)).entries.map(entry => entry.title)).toEqual(['有效约定'])
    await expect(advancing.readEntry('project', project, expired.entryId)).resolves.toBeUndefined()
    await expect(advancing.validateRead(project, expired.path)).rejects.toMatchObject({ code: 'memory_expired' })
    await expect(advancing.validateRead(project, old.directoryPath)).rejects.toMatchObject({ code: 'memory_not_available' })
    await expect(readFile(expired.path)).resolves.toBeDefined()
    expect(await readFile(old.directoryPath, 'utf8')).toBe(old.markdown)
    const prepared = await advancing.prepareProject(project, { prune: true })
    expect(await readFile(prepared.directoryPath, 'utf8')).toBe(prepared.markdown)
    await expect(advancing.validateRead(project, prepared.directoryPath)).resolves.toBeUndefined()
    await expect(readFile(expired.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps usable project notes discoverable when another note has malformed frontmatter', async () => {
    const project = await store.resolveProject(workspace)
    const empty = await store.prepareProject(project)
    await seedNotes(empty.directoryPath, 2)
    const corrupt = join(dirname(empty.directoryPath), 'note-001.md')
    await writeFile(corrupt, '---\nsummary: [unclosed\n---\n\n正文')
    const prepared = await store.prepareProject(project)
    expect(prepared.entries.map(entry => entry.entryId)).toEqual(['note-000'])
    await expect(store.validateRead(project, corrupt)).rejects.toMatchObject({ code: 'invalid_memory' })
  })

  it('checks project-note count at 200 and still permits updating an existing note', async () => {
    const project = await store.resolveProject(workspace)
    const empty = await store.prepareProject(project)
    await seedNotes(empty.directoryPath, 199)
    await store.apply('project', project, [write('200', { type: 'feedback' })])
    const atLimit = await store.prepareProject(project)
    expect(atLimit.count).toBe(200)
    await expect(store.apply('project', project, [write('201', { type: 'feedback' })])).rejects.toMatchObject({ code: 'capacity_exceeded', details: { overByCount: 1 } })
    expect(await store.prepareProject(project)).toEqual(atLimit)
    await expect(store.apply('project', project, [update(atLimit.entries[0], { content: '新内容。' })])).resolves.toMatchObject({ status: 'saved', revision: 2 })
  })

  it('returns the complete directory and UTF-8 usage for manually maintained notes over the prompt limits', async () => {
    const project = await store.resolveProject(workspace)
    const empty = await store.prepareProject(project)
    await seedNotes(empty.directoryPath, 205, '中'.repeat(60))
    const complete = await store.prepareProject(project)
    expect(complete.count).toBe(205)
    expect(complete.bytes).toBe(205 * (Buffer.byteLength('- [Test](note-000.md) — ') + 180) + 204)
    expect(complete.entries).toHaveLength(205)
    expect(complete.markdown.split('\n')).toEqual(complete.entries.map(entry => entry.line))
    const lines = projectMemoryLines(complete)
    expect(lines).toEqual(complete.entries.slice(0, 115).map(entry => entry.line))
    expect(Buffer.byteLength(lines.join('\n'))).toBeLessThanOrEqual(24_000)
    const expanded = [...lines, complete.entries[lines.length].line]
    expect(Buffer.byteLength(expanded.join('\n'))).toBeGreaterThan(24_000)
  })

  it('limits model recall to the first 200 complete rows when the directory fits the byte budget', async () => {
    const project = await store.resolveProject(workspace)
    await seedNotes((await store.prepareProject(project)).directoryPath, 205)
    const complete = await store.prepareProject(project)
    expect(projectMemoryLines(complete)).toEqual(complete.entries.slice(0, 200).map(entry => entry.line))
    expect(complete.count).toBe(205)
  })

  it('checks exact UTF-8 directory bytes when updating a summary', async () => {
    const project = await store.resolveProject(workspace)
    const empty = await store.prepareProject(project)
    await seedNotes(empty.directoryPath, 120, '中'.repeat(57))
    const before = await store.prepareProject(project)
    const entry = before.entries[0]
    const gap = 24_000 - before.bytes
    const summary = entry.summary + '加'.repeat(Math.floor(gap / 3)) + 'a'.repeat(gap % 3)
    await store.apply('project', project, [update(entry, { summary })])
    const atLimit = await store.prepareProject(project)
    expect(atLimit.bytes).toBe(24_000)
    await expect(store.apply('project', project, [update(atLimit.entries[0], { summary: summary + 'a' })])).rejects.toMatchObject({ code: 'capacity_exceeded', details: { overByDirectoryBytes: 1 } })
    expect(await store.prepareProject(project)).toEqual(atLimit)
  })

  it('counts frontmatter and multibyte content in each note and keeps the file after overflow', async () => {
    const project = await store.resolveProject(workspace)
    await store.apply('project', project, [write('测试', { type: 'feedback', content: '字' })])
    const [entry] = (await store.prepareProject(project)).entries
    await store.apply('project', project, [update(entry, { content: '字字' })])
    const [second] = (await store.prepareProject(project)).entries
    const previousSize = (await readFile(second.path)).length
    const gap = 4_000 - previousSize
    const content = '字字' + '中'.repeat(Math.floor(gap / 3)) + 'a'.repeat(gap % 3)
    await store.apply('project', project, [update(second, { content })])
    const [atLimit] = (await store.prepareProject(project)).entries
    const original = await readFile(atLimit.path)
    expect(original.length).toBe(4_000)
    await expect(store.apply('project', project, [update(atLimit, { content: content + 'a' })])).rejects.toMatchObject({ code: 'capacity_exceeded', details: { overByNoteBytes: 1 } })
    expect(await readFile(atLimit.path)).toEqual(original)
  })

  it('groups saved projects and removes the group after deleting its last note', async () => {
    const project = await store.resolveProject(workspace)
    expect(await store.listProjects()).toEqual([])
    await store.apply('project', project, [write('测试', { type: 'feedback' })])
    const [listed] = await store.listProjects()
    expect(listed).toMatchObject({ ...project, count: 1 })
    const [entry] = listed.entries
    await expect(store.deleteProjectEntry(project.projectId, entry.entryId, 99)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(await store.deleteProjectEntry(project.projectId, entry.entryId, entry.revision)).toBeNull()
    expect(await store.listProjects()).toEqual([])
    await expect(readFile(entry.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
