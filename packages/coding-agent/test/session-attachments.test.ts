import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionAttachments } from '../src/session-attachments.js'

let root: string
let attachments: SessionAttachments
const scope = { workspaceId: 'workspace-id', draftSessionId: 'draft-id' }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-attachments-test-'))
  attachments = new SessionAttachments(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('keeps the original upload and prepares a bounded model image loadable after restart', async () => {
  const original = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: 'white' } })
    .png({ compressionLevel: 0 }).toBuffer()
  expect(original.length).toBeGreaterThan(512 * 1024)
  const record = await attachments.upload(scope, '图.png', original)
  expect(record).toMatchObject({ scope, name: '图.png', mediaType: 'image/png', size: original.length })
  const reopened = new SessionAttachments(root)
  expect((await readFile(reopened.path(record.id))).equals(original)).toBe(true)
  const image = reopened.image(record.id)
  expect(image.data.length).toBeLessThanOrEqual(512 * 1024)
  const { width, height } = await sharp(Buffer.from(image.data, 'base64')).metadata()
  expect(width).toBeLessThanOrEqual(2000)
  expect(width).toBe(2 * height)
})

it('preserves the exact bytes of an attachment that already fits the model limits', async () => {
  const original = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'black' } }).webp().toBuffer()
  const record = await attachments.upload(scope, 'shot.webp', original)
  expect(attachments.image(record.id)).toEqual({ type: 'image', mimeType: 'image/webp', data: original.toString('base64') })
})

it('preserves UTF-8 source and removes expired file copies by upload id', async () => {
  const source = Buffer.from('\ufeff// 中文\r\nconsole.log("已启动")\r\n')
  const record = await attachments.upload({ sessionId: 'session-a' }, 'source.ts', source)
  expect(record).toMatchObject({ scope: { sessionId: 'session-a' }, name: 'source.ts', mediaType: 'text/plain', size: source.length })
  await expect(attachments.read(record.id)).resolves.toEqual(source)
  await attachments.remove(record.id)
  await expect(attachments.read(record.id)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reclaims old uploads interrupted before registration and preserves registered and recent files', async () => {
  const upload = () => attachments.upload(scope, 'notes.txt', Buffer.from('日志'))
  const [orphan, kept, recent] = await Promise.all([upload(), upload(), upload()])
  const stale = new Date(Date.now() - 200_000)
  await Promise.all([orphan, kept].map(({ id }) => utimes(join(root, id), stale, stale)))
  await attachments.removeUnregistered(Date.now() - 100_000, id => id === kept.id)
  await expect(attachments.read(orphan.id)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(attachments.read(kept.id)).resolves.toEqual(Buffer.from('日志'))
  await expect(attachments.read(recent.id)).resolves.toEqual(Buffer.from('日志'))
})

it.each([
  ['file.pdf', Buffer.from('%PDF-1.4'), /支持 PNG、JPG、WebP/],
  ['disguised.txt', Buffer.from('%PDF-1.4'), /支持 PNG、JPG、WebP/],
  ['invalid.txt', Buffer.from([0xff]), /UTF-8/],
  ['invalid.png', Buffer.from('not a PNG'), /支持 PNG、JPG、WebP/],
  ['truncated.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), /图片/],
  ['../outside.txt', Buffer.from('unsafe name'), /文件名/],
])('rejects an invalid upload named %s', async (name, data, error) => {
  await expect(attachments.upload(scope, name, data)).rejects.toThrow(error)
})

it('rejects files larger than 50 MiB before decoding their contents', async () => {
  await expect(attachments.upload(scope, 'large.log', Buffer.alloc(50 * 1024 * 1024 + 1))).rejects.toThrow(/50 MiB/)
})
