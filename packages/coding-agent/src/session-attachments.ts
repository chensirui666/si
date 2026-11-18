import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ImageContent } from '@agent-learning/model'
import { imageContent, imageMimeType, MAX_IMAGE_SOURCE_BYTES, prepareReadImage } from './read-image.js'

export const MAX_ATTACHMENT_UPLOAD_BYTES = MAX_IMAGE_SOURCE_BYTES
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000
export const ATTACHMENT_FORMATS_HINT = '支持 PNG、JPG、WebP 图片，以及 TXT、Markdown、CSV、JSON 和 UTF-8 源代码。'
const attachmentId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

export type AttachmentScope = { sessionId: string } | { workspaceId: string; draftSessionId: string }
export type MessageAttachment = { id: string; name: string; mediaType: ImageContent['mimeType'] | 'text/plain'; size: number }
export type StagedAttachment = MessageAttachment & { scope: AttachmentScope; uploadedAt: number }

export class AttachmentInputError extends Error {}

const textExtensions = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.php',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.lua', '.dart', '.vue', '.svelte',
  '.sql', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
])
const textNames = new Set(['.env', '.editorconfig', '.gitignore', 'dockerfile', 'makefile', 'gemfile', 'readme', 'license'])

function validateText(name: string, bytes: Buffer) {
  const lower = name.toLowerCase()
  if ((!textNames.has(lower) && !textExtensions.has(extname(lower))) || bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    throw new AttachmentInputError(ATTACHMENT_FORMATS_HINT)
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (bytes.includes(0)) throw new Error('NUL byte')
  } catch {
    throw new AttachmentInputError('附件必须是有效的 UTF-8 文本。')
  }
}

export class SessionAttachments {
  constructor(private readonly root: string) {}

  async upload(scope: AttachmentScope, name: string, bytes: Buffer, signal = new AbortController().signal): Promise<StagedAttachment> {
    signal.throwIfAborted()
    if (!name.trim() || Buffer.byteLength(name) > 255 || /[\/\\\u0000-\u001f\u007f]/.test(name)) throw new AttachmentInputError('文件名无效。')
    if (bytes.length > MAX_ATTACHMENT_UPLOAD_BYTES) throw new AttachmentInputError('单个附件最多 50 MiB。')
    const mediaType = imageMimeType(bytes) ?? 'text/plain'
    let processed: ImageContent | undefined
    if (mediaType === 'text/plain') validateText(name, bytes)
    else {
      try { processed = await prepareReadImage(name, bytes, mediaType, signal) }
      catch (error) {
        signal.throwIfAborted()
        throw new AttachmentInputError(error instanceof Error ? error.message : '图片无法读取。', { cause: error })
      }
    }
    signal.throwIfAborted()
    const id = randomUUID()
    const directory = this.directory(id)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(directory, { mode: 0o700 })
    try {
      const options = { flag: 'wx', mode: 0o600, flush: true, signal }
      await writeFile(this.path(id), bytes, options)
      if (processed) await writeFile(join(directory, 'model'), Buffer.from(processed.data, 'base64'), options)
      signal.throwIfAborted()
      return { id, name, mediaType, size: bytes.length, scope, uploadedAt: Date.now() }
    } catch (error) {
      await this.remove(id).catch(() => undefined)
      throw error
    }
  }

  path(id: string): string {
    return join(this.directory(id), 'original')
  }

  read(id: string, signal?: AbortSignal): Promise<Buffer> {
    return readFile(this.path(id), { signal })
  }

  image(id: string): ImageContent {
    const bytes = readFileSync(join(this.directory(id), 'model'))
    const mimeType = imageMimeType(bytes)
    if (!mimeType) throw new Error('已处理的附件图片内容无效。')
    return imageContent(bytes, mimeType)
  }

  remove(id: string): Promise<void> {
    return rm(this.directory(id), { recursive: true, force: true })
  }

  async removeUnregistered(cutoff: number, registered: (id: string) => boolean) {
    const items = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const item of items) {
      if (!item.isDirectory() || !attachmentId.test(item.name)) continue
      const details = await stat(this.directory(item.name)).catch(() => undefined)
      if (details && details.mtimeMs <= cutoff && !registered(item.name)) await this.remove(item.name)
    }
  }

  private directory(id: string): string {
    if (!attachmentId.test(id)) throw new AttachmentInputError('附件编号无效。')
    return join(this.root, id)
  }
}
