import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  MAX_PROJECT_DIRECTORY_BYTES, MAX_PROJECT_ENTRIES, MAX_PROJECT_NOTE_BYTES, MAX_USER_CHARACTERS,
  MemoryStoreError, applyOperations, applyUserEntries, editUserMarkdown, formatProjectNote, formatUserFile,
  invalidRequest, parseProjectNote, parseUserFile, publicUserMemory, requireVersion, validEntryId,
  type MemoryEntry, type MemoryOperation, type MemoryOperationResult, type UserMemory,
} from './memory-markdown.js'
import { gitBoundary } from './project-context.js'
import { errorCode, readRegularFile } from './regular-file.js'

export {
  MAX_PROJECT_DIRECTORY_BYTES, MAX_PROJECT_ENTRIES, MAX_PROJECT_NOTE_BYTES, MAX_USER_CHARACTERS,
  PROJECT_MEMORY_DIRECTORY_LIMIT, PROJECT_MEMORY_ENTRY_LIMIT, PROJECT_MEMORY_NOTE_LIMIT, USER_MEMORY_LIMIT,
  MemoryStoreError,
  type EntrySource, type MemoryEntry, type MemoryOperation, type MemoryOperationReceipt, type MemoryOperationResult,
  type MemorySource, type MemoryType, type UserMemory,
} from './memory-markdown.js'

export type MemoryProject = { projectId: string; name: string; path: string }
export type ProjectMemoryEntry = { entryId: string; revision: number; title: string; summary: string; path: string; line: string }
export type ProjectMemory = MemoryProject & {
  directoryPath: string
  markdown: string
  count: number
  bytes: number
  entries: ProjectMemoryEntry[]
}
type CommitOptions = { signal?: AbortSignal; canCommit?: () => boolean }
type ApplyOptions = CommitOptions & { sessionId?: string }
type ProjectOptions = CommitOptions & { prune?: boolean }
type SavedNote = { entry: MemoryEntry; path: string; bytes: number }
type ProjectSnapshot = { notes: SavedNote[]; expired: SavedNote[]; exists: boolean }

const INDEX_NAME = 'MEMORY.md'
const PROJECT_INFO_NAME = 'project.json'
const queues = new Map<string, Promise<unknown>>()

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(canonicalPath(parent), basename(path))
  }
}

function within(path: string, root: string) {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
}

const exists = (path: string) => lstat(path).catch(error => {
  if (errorCode(error) !== 'ENOENT') throw error
  return undefined
})

async function readManagedFile(path: string) {
  const info = await exists(path)
  if (info === undefined) return
  if (!info.isFile()) throw new MemoryStoreError('invalid_memory', '记忆文件须为普通文件。')
  // shortcut: bound hand-edited Markdown reads to 1 MB, revisit if the management UI supports larger files.
  const content = await readRegularFile(path, 1_000_000)
  if (!Buffer.isBuffer(content)) throw new MemoryStoreError('invalid_memory', '记忆文件无法读取。')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
  } catch {
    throw new MemoryStoreError('invalid_memory', '记忆文件不是有效的 UTF-8。')
  }
}

async function checkDirectory(path: string) {
  const info = await exists(path)
  if (info && !info.isDirectory()) throw new MemoryStoreError('invalid_memory', '记忆路径须为本机目录。')
  return info !== undefined
}

function checkCommit(options: CommitOptions = {}) {
  options.signal?.throwIfAborted()
  if (options.canCommit?.() === false) throw new MemoryStoreError('write_forbidden', '当前会话无法修改记忆。')
  options.signal?.throwIfAborted()
}

async function replaceFile(path: string, content: string, options?: CommitOptions) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    checkCommit(options)
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function readGitPointer(path: string) {
  const content = await readRegularFile(path, 8192)
  return Buffer.isBuffer(content) ? content.toString('utf8').trim() : ''
}

async function worktreeRoot(root: string, gitDirectory: string) {
  try {
    if (!(await lstat(join(root, '.git'))).isFile()) return root
    const worktree = await realpath(gitDirectory)
    const commonPointer = await readGitPointer(join(worktree, 'commondir'))
    if (!commonPointer) return root
    const common = await realpath(resolve(worktree, commonPointer))
    if (dirname(worktree) !== join(common, 'worktrees')) return root
    const backlink = await readGitPointer(join(worktree, 'gitdir'))
    if (!backlink || await realpath(resolve(worktree, backlink)) !== join(root, '.git')) return root
    return basename(common) === '.git' ? dirname(common) : common
  } catch {
    return root
  }
}

const projectIdFor = (path: string) => createHash('sha256').update(path).digest('hex')
const isProjectId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)

function capacityError(details: Record<string, unknown>) {
  return new MemoryStoreError('capacity_exceeded', '拟保存的记忆超出容量，原内容已保留。', details)
}

function checkUserCapacity(previous: UserMemory, next: UserMemory, includeEntries = false) {
  if (next.characters > MAX_USER_CHARACTERS) {
    throw capacityError({
      usedChars: previous.characters,
      limitChars: MAX_USER_CHARACTERS,
      overByChars: next.characters - MAX_USER_CHARACTERS,
      ...(includeEntries ? { entries: previous.entries } : {}),
    })
  }
}

function buildProject(project: MemoryProject, directory: string, notes: SavedNote[]): ProjectMemory {
  const entries = notes.map(({ entry, path }) => {
    const { entryId, title, summary, revision } = entry
    const line = `- [${title.replace(/[\\\[\]]/g, '\\$&')}](${basename(path)}) — ${summary}`
    return { entryId, title, summary, revision, path, line }
  })
  const markdown = entries.map(entry => entry.line).join('\n')
  return { ...project, directoryPath: join(directory, INDEX_NAME), markdown, count: entries.length, bytes: Buffer.byteLength(markdown), entries }
}

export function projectMemoryLines(project: ProjectMemory): string[] {
  const lines: string[] = []
  let bytes = 0
  for (const { line } of project.entries) {
    bytes += Buffer.byteLength(line) + (lines.length ? 1 : 0)
    if (lines.length >= MAX_PROJECT_ENTRIES || bytes > MAX_PROJECT_DIRECTORY_BYTES) break
    lines.push(line)
  }
  return lines
}

function checkProjectCapacity(current: ProjectMemory, next: ProjectMemory, written: SavedNote, previous?: SavedNote) {
  const overByCount = next.count - MAX_PROJECT_ENTRIES
  const overByDirectoryBytes = next.bytes - MAX_PROJECT_DIRECTORY_BYTES
  const overByNoteBytes = written.bytes - MAX_PROJECT_NOTE_BYTES
  if (overByCount > 0 || overByDirectoryBytes > 0 || overByNoteBytes > 0) {
    throw capacityError({
      usedCount: current.count, limitCount: MAX_PROJECT_ENTRIES,
      usedDirectoryBytes: current.bytes, limitDirectoryBytes: MAX_PROJECT_DIRECTORY_BYTES,
      usedNoteBytes: previous?.bytes ?? 0, limitNoteBytes: MAX_PROJECT_NOTE_BYTES,
      ...(overByCount > 0 ? { overByCount } : {}),
      ...(overByDirectoryBytes > 0 ? { overByDirectoryBytes } : {}),
      ...(overByNoteBytes > 0 ? { overByNoteBytes } : {}),
    })
  }
}

function availableError() {
  return new MemoryStoreError('memory_not_available', '只能读取当前项目中有效的记忆文件。')
}

export class MemoryStore {
  private readonly root: string
  private readonly userPath: string
  private readonly projectsPath: string
  private readonly canonicalRoot: string

  constructor(root: string, private readonly now: () => number = Date.now) {
    this.root = resolve(root)
    this.canonicalRoot = canonicalPath(this.root)
    this.userPath = join(this.root, 'USER.md')
    this.projectsPath = join(this.root, 'projects')
  }

  async resolveProject(cwd: string): Promise<MemoryProject> {
    const workspace = await realpath(cwd)
    let path = workspace
    for (let directory = workspace; ; directory = dirname(directory)) {
      const marker = await gitBoundary(directory)
      if (marker !== undefined) {
        path = typeof marker === 'string' ? await worktreeRoot(directory, marker) : directory
        break
      }
      if (directory === dirname(directory)) break
    }
    return { projectId: projectIdFor(path), name: basename(path) || path, path }
  }

  isManagedPath(path: string): boolean {
    const absolute = resolve(path)
    return within(absolute, this.root) || within(absolute, this.canonicalRoot)
  }

  async validateRead(project: MemoryProject | undefined, path: string): Promise<void> {
    if (!project) throw availableError()
    const directory = this.projectDirectory(project.projectId)
    if (!await checkDirectory(this.projectsPath) || !await checkDirectory(directory)) throw availableError()
    const file = await realpath(path).catch(error => {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') throw availableError()
      throw error
    })
    if (dirname(file) !== canonicalPath(directory)) throw availableError()
    const name = basename(file)
    if (name !== INDEX_NAME && !this.noteName(name)) throw availableError()
    const raw = await readManagedFile(path)
    if (raw === undefined) throw availableError()
    if (name === INDEX_NAME) {
      if (raw !== (await this.prepareProject(project)).markdown) throw availableError()
      return
    }
    const entry = parseProjectNote(raw)
    if (!entry) throw availableError()
    if (this.isExpired(entry, this.now())) throw new MemoryStoreError('memory_expired', '该项目记忆已到期。')
  }

  async readUser(): Promise<UserMemory> {
    return publicUserMemory(await this.readUserDocument())
  }

  async readEntry(scope: 'user' | 'project', project: MemoryProject | undefined, entryId: string): Promise<MemoryEntry | undefined> {
    if (!validEntryId(entryId)) invalidRequest('条目编号无效。')
    if (scope === 'user') return (await this.readUserDocument()).entries.find(entry => entry.entryId === entryId)
    if (!project) return
    const directory = this.projectDirectory(project.projectId)
    return this.serial(directory, async () => {
      const { notes } = await this.readProject(directory)
      return notes.find(note => note.entry.entryId === entryId)?.entry
    })
  }

  async saveUser(markdown: string, expectedRevision: number): Promise<UserMemory> {
    if (typeof markdown !== 'string' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalidRequest('个人记忆版本或正文无效。')
    return this.serial(this.userPath, async () => {
      const current = await this.readUserDocument()
      if (expectedRevision !== current.revision) {
        throw new MemoryStoreError('version_conflict', '个人记忆已更新，本次未修改。', { latest: publicUserMemory(current) })
      }
      if (markdown === current.markdown) return publicUserMemory(current)
      const next = editUserMarkdown(current, markdown, this.now())
      checkUserCapacity(current, next)
      await this.writeUserDocument(next)
      return publicUserMemory(next)
    })
  }

  async prepareProject(project: MemoryProject, options: ProjectOptions = {}): Promise<ProjectMemory> {
    const directory = this.projectDirectory(project.projectId)
    return this.serial(directory, async () => {
      options.signal?.throwIfAborted()
      const snapshot = await this.readProject(directory)
      const prepared = buildProject(project, directory, snapshot.notes)
      if (options.prune && snapshot.exists) {
        checkCommit(options)
        for (const note of snapshot.expired) {
          checkCommit(options)
          await unlink(note.path)
        }
        if (snapshot.notes.length) await this.writeProjectInfo(project, directory)
        await this.writeProjectIndex(prepared, options)
      }
      options.signal?.throwIfAborted()
      return prepared
    })
  }

  async listProjects(): Promise<ProjectMemory[]> {
    if (!await checkDirectory(this.projectsPath)) return []
    const projects: ProjectMemory[] = []
    for (const directory of await readdir(this.projectsPath, { withFileTypes: true })) {
      if (!directory.isDirectory() || !isProjectId(directory.name)) continue
      const project = await this.readProjectInfo(directory.name)
      if (!project) continue
      const prepared = await this.prepareProject(project)
      if (prepared.count) projects.push(prepared)
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  }

  async deleteProjectEntry(projectId: string, entryId: string, expectedRevision: number): Promise<ProjectMemory | null> {
    const directory = this.projectDirectory(projectId)
    if (!validEntryId(entryId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalidRequest('条目编号或版本无效。')
    return this.serial(directory, async () => {
      const project = await this.readProjectInfo(projectId)
      if (!project) return null
      const snapshot = await this.readProject(directory)
      const target = [...snapshot.notes, ...snapshot.expired].find(note => note.entry.entryId === entryId)
      const prepared = buildProject(project, directory, snapshot.notes.filter(note => note !== target))
      if (target) {
        requireVersion(target.entry, expectedRevision)
        await unlink(target.path)
        await this.refreshProjectIndex(prepared)
      }
      return prepared.count ? prepared : null
    })
  }

  async apply(scope: 'user' | 'project', project: MemoryProject | undefined, operations: MemoryOperation[], options: ApplyOptions = {}): Promise<MemoryOperationResult> {
    if (scope === 'user') {
      return this.serial(this.userPath, async () => {
        checkCommit(options)
        const current = await this.readUserDocument()
        const { entries, result, receipts } = applyOperations(current.entries, operations, scope, this.now(), options.sessionId)
        if (receipts.every(receipt => receipt.status === 'unchanged')) return result
        const next = applyUserEntries(current, entries)
        if (operations.some(operation => operation.operation !== 'delete')) {
          checkUserCapacity(current, next, operations.length === 1 && operations[0].operation === 'write')
        }
        await this.writeUserDocument(next, options)
        return result
      })
    }
    if (!project) invalidRequest('当前工作区没有可写的项目记忆。')
    const directory = this.projectDirectory(project.projectId)
    return this.serial(directory, async () => {
      checkCommit(options)
      const { notes } = await this.readProject(directory)
      const { entries, result, receipts: [receipt] } = applyOperations(notes.map(note => note.entry), operations, scope, this.now(), options.sessionId)
      if (receipt.status === 'unchanged') return result
      const previous = notes.find(note => note.entry.entryId === receipt.entryId)
      const updated = notes.filter(note => note !== previous)
      if (receipt.status === 'deleted') {
        checkCommit(options)
        await unlink(previous!.path)
      } else {
        const entry = entries.find(item => item.entryId === receipt.entryId)!
        if (this.isExpired(entry, this.now())) invalidRequest('只能保存仍然有效的项目记忆。')
        const content = formatProjectNote(entry)
        const written = { entry, path: previous?.path ?? join(directory, `${entry.entryId}.md`), bytes: Buffer.byteLength(content) }
        updated.push(written)
        updated.sort((a, b) => a.path.localeCompare(b.path))
        checkProjectCapacity(buildProject(project, directory, notes), buildProject(project, directory, updated), written, previous)
        await mkdir(directory, { mode: 0o700, recursive: true })
        await this.writeProjectInfo(project, directory)
        await replaceFile(written.path, content, options)
      }
      await this.refreshProjectIndex(buildProject(project, directory, updated))
      return result
    })
  }

  private serial<T>(path: string, action: () => Promise<T>): Promise<T> {
    const key = join(this.canonicalRoot, relative(this.root, path))
    // shortcut: one SI backend owns this memory root, use an inter-process lock if backends begin sharing it.
    const operation = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
    queues.set(key, operation)
    return operation.finally(() => {
      if (queues.get(key) === operation) queues.delete(key)
    })
  }

  private async readUserDocument() {
    return parseUserFile(await readManagedFile(this.userPath), this.now())
  }

  private async writeUserDocument(document: ReturnType<typeof parseUserFile>, options?: CommitOptions) {
    await mkdir(this.root, { mode: 0o700, recursive: true })
    await replaceFile(this.userPath, formatUserFile(document), options)
  }

  private projectDirectory(projectId: string) {
    if (!isProjectId(projectId)) invalidRequest('项目编号无效。')
    return join(this.projectsPath, projectId)
  }

  private noteName(name: string) {
    return name !== INDEX_NAME && name.endsWith('.md') && validEntryId(name.slice(0, -3))
  }

  private isExpired(entry: MemoryEntry, time: number) {
    return entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= time
  }

  private async readProject(directory: string): Promise<ProjectSnapshot> {
    const notes: SavedNote[] = []
    const expired: SavedNote[] = []
    if (!await checkDirectory(this.projectsPath) || !await checkDirectory(directory)) return { notes, expired, exists: false }
    const records = await readdir(directory, { withFileTypes: true })
    const now = this.now()
    const seen = new Set<string>()
    for (const record of records.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!record.isFile() || !this.noteName(record.name)) continue
      const path = join(directory, record.name)
      let note: SavedNote
      try {
        const raw = await readManagedFile(path)
        const entry = raw && parseProjectNote(raw)
        if (!entry) continue
        note = { entry, path, bytes: Buffer.byteLength(raw) }
      } catch (error) {
        if (error instanceof MemoryStoreError && error.code === 'invalid_memory') continue
        throw error
      }
      const { entry } = note
      if (seen.has(entry.entryId)) throw new MemoryStoreError('invalid_memory', '项目记忆包含重复的条目编号。')
      seen.add(entry.entryId)
      const target = this.isExpired(entry, now) ? expired : notes
      target.push(note)
    }
    return { notes, expired, exists: true }
  }

  private async readProjectInfo(projectId: string): Promise<MemoryProject | undefined> {
    const directory = this.projectDirectory(projectId)
    if (!await checkDirectory(this.projectsPath) || !await checkDirectory(directory)) return
    const data = await readManagedFile(join(directory, PROJECT_INFO_NAME))
    if (!data) return
    let project: MemoryProject
    try {
      project = JSON.parse(data) as MemoryProject
    } catch {
      throw new MemoryStoreError('invalid_memory', '项目记忆的归属信息无法读取。')
    }
    if (project?.projectId !== projectId || typeof project.name !== 'string' || typeof project.path !== 'string' || projectIdFor(project.path) !== projectId) {
      throw new MemoryStoreError('invalid_memory', '项目记忆的归属信息无效。')
    }
    return project
  }

  private async writeProjectInfo(project: MemoryProject, directory: string) {
    const path = join(directory, PROJECT_INFO_NAME)
    if (!await exists(path)) await replaceFile(path, JSON.stringify(project))
  }

  private async writeProjectIndex(project: ProjectMemory, options?: CommitOptions) {
    if (await readManagedFile(project.directoryPath) === project.markdown) return
    await replaceFile(project.directoryPath, project.markdown, options)
  }

  private async refreshProjectIndex(project: ProjectMemory) {
    try {
      await this.writeProjectIndex(project)
    } catch (error) {
      // The note is already committed. Preparing the next directory derives it from the note files.
      console.warn('无法刷新项目记忆目录', error)
    }
  }
}
