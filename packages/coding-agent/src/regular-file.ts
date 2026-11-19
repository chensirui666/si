import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'

export const tooLarge = Symbol('file exceeds read budget')

export function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

export async function readRegularFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | typeof tooLarge | null> {
  signal?.throwIfAborted()
  if (!(await stat(path)).isFile()) return null
  signal?.throwIfAborted()
  // The path can change between stat and open. A FIFO must not block open.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) return null
    if (info.size > maxBytes) return tooLarge
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1))
    const chunks: Buffer[] = []
    let size = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - size), null)
      signal?.throwIfAborted()
      if (bytesRead === 0) return Buffer.concat(chunks, size)
      size += bytesRead
      if (size > maxBytes) return tooLarge
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
  } finally {
    await handle.close()
  }
}
