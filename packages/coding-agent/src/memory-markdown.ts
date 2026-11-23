import { createHash, randomUUID } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'

export const MAX_USER_CHARACTERS = 1_375
export const MAX_PROJECT_ENTRIES = 200
export const MAX_PROJECT_DIRECTORY_BYTES = 24_000
export const MAX_PROJECT_NOTE_BYTES = 4_000
export const USER_MEMORY_LIMIT = MAX_USER_CHARACTERS
export const PROJECT_MEMORY_ENTRY_LIMIT = MAX_PROJECT_ENTRIES
export const PROJECT_MEMORY_DIRECTORY_LIMIT = MAX_PROJECT_DIRECTORY_BYTES
export const PROJECT_MEMORY_NOTE_LIMIT = MAX_PROJECT_NOTE_BYTES

export type MemoryType = 'feedback' | 'project' | 'reference'
export type MemorySource = { sessionId: string; messageId: string; timestamp: number; position: number }
export type EntrySource =
  | MemorySource
  | { type: 'user_edit'; timestamp: number }
  | { type: 'session_write'; sessionId: string; timestamp: number }
type MemoryText = { title: string; summary: string; content: string }
type ProjectFields = { type?: MemoryType; expiresAt?: string }
export type MemoryEntry = MemoryText & ProjectFields & {
  entryId: string
  revision: number
  updatedAt: string
  sources: EntrySource[]
}
export type MemoryOperation =
  | (MemoryText & ProjectFields & { operation: 'write' })
  | {
      operation: 'update'
      entryId: string
      expectedRevision: number
      changes: Partial<MemoryText> & { type?: MemoryType; expiresAt?: string | null }
      mergeFromEntryIds?: string[]
    }
  | { operation: 'delete'; entryId: string; expectedRevision: number }
export type MemoryOperationReceipt =
  | { status: 'saved' | 'unchanged'; entryId: string; revision: number }
  | { status: 'deleted'; entryId: string }
export type MemoryOperationResult = MemoryOperationReceipt | { status: 'saved'; operations: MemoryOperationReceipt[] }
export type UserMemory = { markdown: string; revision: number; characters: number; entries: MemoryEntry[] }

export class MemoryStoreError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'MemoryStoreError'
  }
}

export function invalidRequest(message: string): never {
  throw new MemoryStoreError('invalid_request', message)
}

export const validEntryId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)
const validVersion = (revision: unknown): revision is number =>
  typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
const iso = (time: number) => new Date(time).toISOString()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

function parseHeader(raw: string, userDocument = false) {
  const match = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)(?:\r?\n)?/m.exec(raw)
  if (match?.index !== 0) {
    if (userDocument && /^---\r?\nmemoryFormat:/.test(raw)) throw new MemoryStoreError('invalid_memory', '个人记忆的 YAML 头不完整。')
    return { markdown: raw }
  }
  if (userDocument && !/^memoryFormat:/m.test(match[1])) return { markdown: raw }
  const header = parseDocument(match[1])
  if (header.errors.length) throw new MemoryStoreError('invalid_memory', '记忆文件的 YAML 头无法读取。')
  let data: unknown
  try {
    data = header.toJS({ maxAliasCount: 0 })
  } catch {
    throw new MemoryStoreError('invalid_memory', '记忆文件的 YAML 头无法读取。')
  }
  return { data: object(data), markdown: raw.slice(match[0].length) }
}

function formatHeader(metadata: Record<string, unknown>, markdown: string) {
  return `---\n${stringify(metadata, { lineWidth: 0 })}---\n\n${markdown}`
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function formatSources(sources: EntrySource[]) {
  return sources.map(source => {
    if ('type' in source) {
      if (source.type === 'session_write') return { type: source.type, sessionId: source.sessionId, savedAt: iso(source.timestamp) }
      return { type: source.type, editedAt: iso(source.timestamp) }
    }
    return { messageRef: `${source.sessionId}#${source.messageId}`, sentAt: iso(source.timestamp), position: source.position }
  })
}

function parseSources(value: unknown): EntrySource[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): EntrySource[] => {
    const source = object(item)
    if (!source) return []
    if (source.type === 'session_write') {
      if (typeof source.sessionId !== 'string' || !source.sessionId || typeof source.savedAt !== 'string') return []
      const timestamp = Date.parse(source.savedAt)
      return Number.isFinite(timestamp) ? [{ type: 'session_write', sessionId: source.sessionId, timestamp }] : []
    }
    if (source.type === 'user_edit' && typeof source.editedAt === 'string') {
      const timestamp = Date.parse(source.editedAt)
      return Number.isFinite(timestamp) ? [{ type: 'user_edit', timestamp }] : []
    }
    const ref = typeof source.messageRef === 'string' && /^([^#]+)#(.+)$/.exec(source.messageRef)
    const timestamp = typeof source.sentAt === 'string' && Date.parse(source.sentAt)
    const position = source.position
    return ref && typeof timestamp === 'number' && Number.isFinite(timestamp) && validVersion(position)
      ? [{ sessionId: ref[1], messageId: ref[2], timestamp, position }]
      : []
  })
}

function commonFields(metadata: Record<string, unknown>) {
  const { entryId, revision, summary, updatedAt } = metadata
  if (!validEntryId(entryId) || !validVersion(revision) || typeof summary !== 'string' || typeof updatedAt !== 'string') return
  return { entryId, revision, summary, updatedAt, sources: parseSources(metadata.sources) }
}

function formatMetadata(entry: MemoryEntry) {
  return { entryId: entry.entryId, revision: entry.revision, summary: entry.summary, updatedAt: entry.updatedAt, sources: formatSources(entry.sources) }
}

const isMemoryType = (type: unknown): type is MemoryType => type === 'project' || type === 'feedback' || type === 'reference'
const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim()

export function parseProjectNote(raw: string): MemoryEntry | undefined {
  const { data, markdown } = parseHeader(raw)
  if (!data) return
  const common = commonFields(data)
  const { type, title, expiresAt } = data
  if (!common || !isMemoryType(type) || typeof title !== 'string' || !title.trim() || !markdown.trim()) return
  if (expiresAt !== undefined && (type !== 'project' || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) return
  return {
    ...common,
    title: oneLine(title),
    summary: oneLine(common.summary),
    content: markdown.trim(),
    type,
    ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
  }
}

export function formatProjectNote(entry: MemoryEntry) {
  return formatHeader(
    { ...formatMetadata(entry), title: entry.title, type: entry.type, ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}) },
    `${entry.content}\n`,
  )
}

type Section = { raw: string; title: string; content: string; heading?: string }
type UserSection = Section & { entry: MemoryEntry }
type UserDocument = UserMemory & { prefix: string; sections: UserSection[] }
type EntryMetadata = ReturnType<typeof commonFields> & { fingerprint: string; title: string }

function splitSections(markdown: string) {
  const headings: { start: number; end: number; title: string }[] = []
  let cursor = 0
  let fence = ''
  for (const line of markdown.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const text = line[0]
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/s.exec(text.trimEnd())
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''
    } else if (!fence) {
      const heading = /^ {0,3}##(?:[ \t]+|\r?$)(.*)$/.exec(text.trimEnd())
      if (heading) headings.push({ start: cursor, end: cursor + text.length, title: heading[1].replace(/[ \t]+#+$/, '').trim() })
    }
    cursor += text.length
  }
  const prefix = markdown.slice(0, headings[0]?.start ?? markdown.length)
  const sections: Section[] = prefix.trim() ? [{ title: '用户摘要', raw: prefix, content: prefix.trim() }] : []
  headings.forEach(({ start, end, title }, i) => {
    const stop = headings[i + 1]?.start ?? markdown.length
    sections.push({ raw: markdown.slice(start, stop), heading: markdown.slice(start, end), title, content: markdown.slice(end, stop).trim() })
  })
  return { prefix: prefix.trim() ? '' : prefix, sections }
}

const fingerprint = (section: Section) => hash(section.raw.trimEnd())

export function publicUserMemory(document: UserDocument): UserMemory {
  const { markdown, revision, characters, entries } = document
  return { markdown, revision, characters, entries }
}

function makeUserDocument(markdown: string, revision: number, prefix: string, sections: UserSection[]): UserDocument {
  return { markdown, revision, prefix, sections, characters: Array.from(markdown).length, entries: sections.map(section => section.entry) }
}

export function parseUserFile(raw: string | undefined, now: number): UserDocument {
  const { data, markdown } = parseHeader(raw ?? '', true)
  const managed = data?.memoryFormat === 1
  const body = managed ? markdown : raw ?? ''
  const { prefix, sections } = splitSections(body)
  const revision = managed ? data?.revision : raw === undefined ? 0 : 1
  if (managed && !validVersion(revision)) throw new MemoryStoreError('invalid_memory', '个人记忆文件的版本无效。')
  const metadata = managed && Array.isArray(data?.entries) ? data.entries.flatMap((item): EntryMetadata[] => {
    const value = object(item)
    const common = value && commonFields(value)
    return common && typeof value?.fingerprint === 'string' && typeof value.title === 'string'
      ? [{ ...common, fingerprint: value.fingerprint, title: value.title }]
      : []
  }) : []
  if (new Set(metadata.map(entry => entry.entryId)).size !== metadata.length) {
    throw new MemoryStoreError('invalid_memory', '个人记忆包含重复的条目编号。')
  }
  const entries = sections.map((section, index) => {
    const value = metadata.find(item => item.fingerprint === fingerprint(section) && item.title === section.title)
    if (value) metadata.splice(metadata.indexOf(value), 1)
    const entry: MemoryEntry = {
      entryId: value?.entryId ?? hash(`personal:${index}:${section.raw}`).slice(0, 16),
      revision: value?.revision ?? 1,
      title: section.title,
      summary: value?.summary ?? oneLine(section.content),
      content: section.content,
      updatedAt: value?.updatedAt ?? iso(now),
      sources: value?.sources ?? [{ type: 'user_edit', timestamp: now }],
    }
    return { ...section, entry }
  })
  return makeUserDocument(body, typeof revision === 'number' ? revision : 0, prefix, entries)
}

export function formatUserFile(document: UserDocument) {
  return formatHeader({
    memoryFormat: 1,
    revision: document.revision,
    entries: document.sections.map(section => ({
      ...formatMetadata(section.entry), title: section.title, fingerprint: fingerprint(section),
    })),
  }, document.markdown)
}

export function editUserMarkdown(current: UserDocument, markdown: string, now: number): UserDocument {
  const { prefix, sections } = splitSections(markdown)
  const remaining = new Set(current.sections)
  const same = sections.map(section => {
    const previous = [...remaining].find(old => fingerprint(old) === fingerprint(section))
    if (previous) remaining.delete(previous)
    return previous
  })
  const entries = sections.map((section, i) => {
    const preserved = same[i]
    if (preserved) return { ...section, entry: preserved.entry }
    const previous = [...remaining].find(old => old.title === section.title)
    if (previous) remaining.delete(previous)
    return {
      ...section,
      entry: {
        entryId: previous?.entry.entryId ?? newEntryId(),
        revision: (previous?.entry.revision ?? 0) + 1,
        title: section.title,
        summary: oneLine(section.content),
        content: section.content,
        updatedAt: iso(now),
        sources: [{ type: 'user_edit', timestamp: now } as const],
      },
    }
  })
  return makeUserDocument(markdown, current.revision + 1, prefix, entries)
}

function newEntryId() {
  return randomUUID().replaceAll('-', '').slice(0, 16)
}

function joinSections(prefix: string, sections: UserSection[]) {
  let markdown = prefix
  for (const section of sections) {
    if (markdown && !markdown.endsWith('\n')) markdown += '\n\n'
    markdown += section.raw
  }
  return markdown
}

export function applyUserEntries(current: UserDocument, entries: MemoryEntry[]) {
  const old = new Map(current.sections.map(section => [section.entry.entryId, section]))
  const sections = entries.map(entry => {
    const previous = old.get(entry.entryId)
    if (previous?.entry === entry) return previous
    if (previous?.title === entry.title && previous.content === entry.content) return { ...previous, entry }
    let heading = previous?.title === entry.title ? previous.heading ?? '' : `## ${entry.title}\n`
    if (heading && !heading.endsWith('\n')) heading += '\n'
    const trailing = previous?.content ? previous.raw.slice(previous.raw.trimEnd().length) : ''
    const raw = heading + entry.content + trailing
    const parsed = splitSections(raw).sections
    if (parsed.length !== 1 || parsed[0].title !== entry.title) invalidRequest('个人记忆正文须留在当前主题下。')
    return { ...parsed[0], entry }
  })
  // Separators belong to the preceding section when reloaded.
  const markdown = joinSections(current.prefix, sections)
  const { prefix, sections: normalized } = splitSections(markdown)
  if (normalized.length !== entries.length) invalidRequest('个人记忆正文须留在当前主题下。')
  return makeUserDocument(markdown, current.revision + 1, prefix, normalized.map((section, index) => ({ ...section, entry: entries[index] })))
}

export function requireVersion(entry: MemoryEntry | undefined, revision: number): asserts entry is MemoryEntry {
  if (!entry || entry.revision !== revision) {
    throw new MemoryStoreError('version_conflict', '条目版本已变化，本次未修改。', { latest: entry ?? null })
  }
}

function sameContent(a: MemoryEntry, b: MemoryEntry) {
  return a.title === b.title && a.summary === b.summary && a.content === b.content && a.type === b.type && a.expiresAt === b.expiresAt
}

function checkFields(entry: MemoryEntry, scope: 'user' | 'project') {
  if (!entry.title || !entry.summary || !entry.content || (scope === 'project' ? !isMemoryType(entry.type) : entry.type !== undefined)) {
    invalidRequest('记忆的标题、简述、正文或类别无效。')
  }
  if (entry.expiresAt !== undefined && (entry.type !== 'project' || !Number.isFinite(Date.parse(entry.expiresAt)))) {
    invalidRequest('到期时间仅适用于项目事实，且必须是有效时间。')
  }
}

function unionSources(...sources: EntrySource[][]) {
  return [...new Map(sources.flat().map(source => [JSON.stringify(source), source])).values()]
}

export function applyOperations(current: MemoryEntry[], operations: MemoryOperation[], scope: 'user' | 'project', now: number, sessionId?: string) {
  if (!operations.length || (scope === 'project' && operations.length !== 1)) invalidRequest('记忆修改数量无效。')
  const original = new Map(current.map(entry => [entry.entryId, entry]))
  const touched = new Set<string>()
  for (const operation of operations) {
    if (operation.operation === 'write') continue
    if (touched.has(operation.entryId)) invalidRequest('一组修改只能对同一条目操作一次。')
    touched.add(operation.entryId)
    requireVersion(original.get(operation.entryId), operation.expectedRevision)
  }
  const removals = new Set(operations.filter(operation => operation.operation === 'delete').map(operation => operation.entryId))
  const entries = new Map(original)
  const receipts: MemoryOperationReceipt[] = []
  for (const operation of operations) {
    if (operation.operation === 'delete') {
      entries.delete(operation.entryId)
      receipts.push({ status: 'deleted', entryId: operation.entryId })
      continue
    }
    const previous = operation.operation === 'update' ? original.get(operation.entryId) : undefined
    const inherited: EntrySource[][] = []
    if (operation.operation === 'update') {
      for (const entryId of operation.mergeFromEntryIds ?? []) {
        if (scope !== 'user' || !removals.delete(entryId)) invalidRequest('归并来源须在同一批提交中删除一次。')
        inherited.push(original.get(entryId)!.sources)
      }
    }
    const fields = operation.operation === 'write' ? operation : { ...previous!, ...operation.changes }
    const previousSources = previous?.sources ?? []
    const entry: MemoryEntry = {
      entryId: previous?.entryId ?? newEntryId(),
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: iso(now),
      title: oneLine(fields.title),
      summary: oneLine(fields.summary),
      content: fields.content.trim(),
      sources: inherited.length ? unionSources(previousSources, ...inherited) : [...previousSources],
      ...(fields.type ? { type: fields.type } : {}),
      ...(fields.expiresAt ? { expiresAt: fields.expiresAt } : {}),
    }
    checkFields(entry, scope)
    const same = previous
      ? sameContent(previous, entry) && (!inherited.length || JSON.stringify(previousSources) === JSON.stringify(entry.sources)) ? previous : undefined
      : [...entries.values()].find(item => sameContent(item, entry))
    if (same) {
      receipts.push({ status: 'unchanged', entryId: same.entryId, revision: same.revision })
      continue
    }
    if (sessionId) entry.sources.push({ type: 'session_write', sessionId, timestamp: now })
    entries.set(entry.entryId, entry)
    receipts.push({ status: 'saved', entryId: entry.entryId, revision: entry.revision })
  }
  if (operations.length > 1 && removals.size) invalidRequest('整批修改只能删除已归并的个人记忆。')
  const result: MemoryOperationResult = receipts.length === 1 ? receipts[0] : { status: 'saved', operations: receipts }
  return { entries: [...entries.values()], result, receipts }
}
