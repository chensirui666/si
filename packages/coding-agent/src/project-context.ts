import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const candidates = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']
const tooLarge = Symbol('project context exceeds read budget')

export type ProjectContextFile = { path: string; content: string }
export class ProjectContextOverflow extends Error {
  constructor() { super('项目说明预计超出模型容量，请精简项目说明。') }
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

async function readRegularFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer | typeof tooLarge | null> {
  signal.throwIfAborted()
  if (!(await stat(path)).isFile()) return null
  signal.throwIfAborted()
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
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - size), null)
      signal.throwIfAborted()
      if (bytesRead === 0) return Buffer.concat(chunks, size)
      size += bytesRead
      if (size > maxBytes) return tooLarge
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
  } finally {
    await handle.close()
  }
}

async function gitBoundary(directory: string, signal: AbortSignal) {
  const path = join(directory, '.git')
  const marker = await stat(path).catch(() => undefined)
  if (marker?.isDirectory()) return true
  if (!marker?.isFile()) return
  try {
    // shortcut: Git pointer files only need room for a local path, revisit for filesystems with longer paths.
    const pointer = await readRegularFile(path, 8192, signal)
    const text = Buffer.isBuffer(pointer) ? pointer.toString('utf8').trim() : ''
    if (text.startsWith('gitdir: ')) return resolve(directory, text.slice(8).trim())
  } catch (error) {
    signal.throwIfAborted()
    if (errorCode(error) !== 'ENOENT') return true
  }
}

async function shadowedContextPath(worktree: string, gitDirectory: string, filename: string, signal: AbortSignal) {
  try {
    signal.throwIfAborted()
    await stat(join(gitDirectory, 'HEAD'))
    const common = await readRegularFile(join(gitDirectory, 'commondir'), 8192, signal)
    if (!Buffer.isBuffer(common)) return
    const commonDirectory = await realpath(resolve(gitDirectory, common.toString('utf8').trim()))
    signal.throwIfAborted()
    const main = dirname(commonDirectory)
    const child = relative(main, await realpath(worktree))
    if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) return
    signal.throwIfAborted()
    if (await realpath(join(main, '.git')) === commonDirectory) return join(main, filename)
  } catch {
    signal.throwIfAborted()
  }
}

export async function loadProjectContextFiles({ cwd, globalDirectory, maxBytes, signal }: {
  cwd: string; globalDirectory?: string; maxBytes: number; signal: AbortSignal
}): Promise<ProjectContextFile[]> {
  let remaining = maxBytes
  const select = async (directory: string) => {
    for (const name of candidates) {
      const path = join(directory, name)
      try {
        const body = await readRegularFile(path, remaining, signal)
        if (body !== null) return { path, body }
      } catch (error) {
        signal.throwIfAborted()
        const code = errorCode(error)
        if (code !== 'ENOENT' && code !== 'ENOTDIR') console.warn('无法读取项目说明', path, code, String(error))
      }
    }
  }
  const accept = ({ path, body }: NonNullable<Awaited<ReturnType<typeof select>>>): ProjectContextFile => {
    if (!Buffer.isBuffer(body)) throw new ProjectContextOverflow()
    remaining -= body.length
    return { path, content: body.toString('utf8').replace(/^\uFEFF/, '') }
  }

  const global = globalDirectory === undefined ? undefined : resolve(globalDirectory)
  const globalCandidate = global === undefined ? undefined : await select(global)
  const globalFile = globalCandidate && accept(globalCandidate)
  const ancestors: ProjectContextFile[] = []
  let foundGit = false
  let shadowed: string | undefined
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    signal.throwIfAborted()
    const file = directory === global ? globalCandidate : await select(directory)
    signal.throwIfAborted()
    if (!foundGit) {
      const git = await gitBoundary(directory, signal)
      foundGit = git !== undefined
      if (typeof git === 'string' && file) shadowed = await shadowedContextPath(directory, git, basename(file.path), signal)
    }
    signal.throwIfAborted()
    if (file && directory !== global) {
      const isShadowed = shadowed && basename(file.path) === basename(shadowed)
        && await realpath(directory).catch(() => directory) === dirname(shadowed)
      if (!isShadowed) ancestors.push(accept(file))
    }
    if (directory === dirname(directory)) break
  }
  signal.throwIfAborted()
  ancestors.reverse()
  return globalFile ? [globalFile, ...ancestors] : ancestors
}
