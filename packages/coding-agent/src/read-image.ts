import type { ImageContent } from '@agent-learning/model'

export const MAX_IMAGE_SOURCE_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_PIXELS = 100_000_000
const MAX_IMAGE_SIDE = 2000
const MAX_ATTACHMENT_BYTES = (512 * 1024 * 3) / 4
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function imageMimeType(bytes: Buffer): ImageContent['mimeType'] | undefined {
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
}

export function imageContent(bytes: Buffer, mimeType: ImageContent['mimeType']): ImageContent {
  return { type: 'image', mimeType, data: bytes.toString('base64') }
}

export async function prepareReadImage(path: string, bytes: Buffer, mimeType: ImageContent['mimeType'], signal: AbortSignal): Promise<ImageContent> {
  if (bytes.length > MAX_IMAGE_SOURCE_BYTES) throw new Error(`原始图片超过 50 MiB：${path}`)
  try {
    const { default: sharp } = await import('sharp')
    signal.throwIfAborted()
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS })
    const { autoOrient: { width, height } } = await image.metadata()
    signal.throwIfAborted()
    if (Math.max(width, height) <= MAX_IMAGE_SIDE && bytes.length <= MAX_ATTACHMENT_BYTES) {
      await image.stats()
      signal.throwIfAborted()
      return imageContent(bytes, mimeType)
    }

    const { data, info } = await image.autoOrient().resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE,
      fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true })
    signal.throwIfAborted()
    const resized = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    let longest = Math.max(info.width, info.height)
    for (;;) {
      signal.throwIfAborted()
      const candidate = resized.clone().resize({ width: longest, height: longest, fit: 'inside', withoutEnlargement: true })
      const png = await candidate.clone().png().toBuffer()
      signal.throwIfAborted()
      if (png.length <= MAX_ATTACHMENT_BYTES) return imageContent(png, 'image/png')
      for (const quality of [85, 70, 55, 40]) {
        const jpeg = await candidate.clone().flatten({ background: 'white' }).jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer()
        signal.throwIfAborted()
        if (jpeg.length <= MAX_ATTACHMENT_BYTES) return imageContent(jpeg, 'image/jpeg')
      }
      if (longest === 1) break
      longest = Math.max(1, Math.floor(longest * 0.75))
    }
  } catch (cause) {
    signal.throwIfAborted()
    throw new Error(`图片解码或缩放失败：${path}`, { cause })
  }
  throw new Error(`图片无法缩放到 512 KiB 以内：${path}`)
}
