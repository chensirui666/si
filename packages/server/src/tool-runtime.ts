import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const MAX_OUTPUT_BYTES = 50 * 1024
export const MAX_OUTPUT_LINES = 2000

type SearchBinary = 'fd' | 'rg'
type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stderr: string; stopped?: string }
type RunOptions = {
  cwd: string
  signal: AbortSignal
  stdout?: (chunk: Buffer) => boolean | void
  outputFd?: number
  processGroup?: boolean
  timeout?: number
}

// GitHub's official release assets and published SHA-256 digests.
const releases = {
  fd: {
    base: 'https://github.com/sharkdp/fd/releases/download/v10.3.0/',
    prefix: 'fd-v10.3.0',
    assets: {
      'darwin-arm64': ['aarch64-apple-darwin', '0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904'],
      'darwin-x64': ['x86_64-apple-darwin', '50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3'],
      'linux-arm64': ['aarch64-unknown-linux-musl', '996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b'],
      'linux-x64': ['x86_64-unknown-linux-musl', '2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14'],
    },
  },
  rg: {
    base: 'https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/',
    prefix: 'ripgrep-15.1.0',
    assets: {
      'darwin-arm64': ['aarch64-apple-darwin', '378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715'],
      'darwin-x64': ['x86_64-apple-darwin', '64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882'],
      'linux-arm64': ['aarch64-unknown-linux-gnu', '2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e'],
      'linux-x64': ['x86_64-unknown-linux-musl', '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599'],
    },
  },
} as const

async function downloadArchive(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`下载返回 HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, bytes)
      bytes += value.length
      if (bytes > 16 * 1024 * 1024) throw new Error('下载文件超过 16 MiB')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function stopGroup(child: ChildProcess) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // macOS may report EPERM for a group whose only member has just exited.
    if (code === 'EPERM') child.kill('SIGKILL')
    else if (code !== 'ESRCH') throw error
  }
}

export class ToolRuntime {
  private readonly shutdown = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly binaries = new Map<SearchBinary, string>()
  private directory?: Promise<string>
  private closing?: Promise<void>

  close(): Promise<void> {
    return this.closing ??= this.cleanup()
  }

  private async cleanup() {
    this.shutdown.abort(new Error('服务关闭'))
    await Promise.allSettled(this.tasks)
    if (this.directory) {
      const path = await this.directory.catch(() => undefined)
      if (path) await rm(path, { recursive: true, force: true })
    }
  }

  private active<T>(signal: AbortSignal, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([this.shutdown.signal, signal])
    const task = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return callback(combined)
    })
    this.tasks.add(task)
    task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  private temporaryDirectory(): Promise<string> {
    return this.directory ??= mkdtemp(join(tmpdir(), 'agent-learning-tools-'))
  }

  saveTemporary(content: string): Promise<string> {
    return this.active(this.shutdown.signal, async () => {
      const path = join(await this.temporaryDirectory(), `output-${randomUUID()}.txt`)
      await writeFile(path, content, { mode: 0o600, flag: 'wx' })
      return path
    })
  }

  prepare(binary: SearchBinary, cwd: string, signal: AbortSignal): Promise<string> {
    return this.active(signal, async activeSignal => {
      const cached = this.binaries.get(binary)
      if (cached) return cached

      for (const candidate of binary === 'fd' ? ['fd', 'fdfind'] : ['rg']) {
        try {
          const result = await this.run(candidate, ['--version'], { cwd, signal: activeSignal, timeout: 5 })
          if (result.code === 0 && !result.stopped) return candidate
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }

      const downloadSignal = AbortSignal.any([activeSignal, AbortSignal.timeout(120_000)])
      let installation: string | undefined
      try {
        const release = releases[binary]
        const platform = `${process.platform}-${process.arch}` as keyof typeof release.assets
        const asset = release.assets[platform]
        if (!asset) throw new Error(`没有适用于 ${platform} 的自动下载包`)
        const [target, digest] = asset
        const name = `${release.prefix}-${target}`
        const archive = await downloadArchive(`${release.base}${name}.tar.gz`, downloadSignal)
        if (createHash('sha256').update(archive).digest('hex') !== digest) throw new Error('下载校验失败')

        installation = await mkdtemp(join(await this.temporaryDirectory(), `${binary}-`))
        const archivePath = join(installation, 'release.tar.gz')
        const executablePath = join(installation, binary)
        await writeFile(archivePath, archive, { mode: 0o600 })
        const executable = await open(executablePath, 'wx', 0o600)
        try {
          const result = await this.run('/usr/bin/tar', ['-xOf', archivePath, `${name}/${binary}`], {
            cwd, signal: downloadSignal, outputFd: executable.fd,
          })
          if (result.code !== 0 || result.stopped) throw new Error(result.stopped ?? (result.stderr || '解压失败'))
        } finally {
          await executable.close()
        }
        await chmod(executablePath, 0o700)
        const version = await this.run(executablePath, ['--version'], { cwd, signal: downloadSignal })
        if (version.code !== 0 || version.stopped) throw new Error(version.stopped ?? '下载的程序无法运行')
        await rm(archivePath)
        this.binaries.set(binary, executablePath)
        return executablePath
      } catch (error) {
        if (installation) await rm(installation, { recursive: true, force: true })
        activeSignal.throwIfAborted()
        throw new Error(`${binary} 不可用，下载或准备失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  run(command: string, args: string[], options: RunOptions): Promise<ChildResult> {
    return this.active(options.signal, signal => new Promise((resolve, reject) => {
      const { cwd, stdout, outputFd, processGroup = false, timeout } = options
      const child = spawn(command, args, {
        cwd, detached: processGroup,
        stdio: ['ignore', outputFd ?? 'pipe', processGroup ? outputFd ?? 'pipe' : 'pipe'],
      })
      const decoder = new StringDecoder('utf8')
      let stderr = ''
      let stopped: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let error: Error | undefined

      const stop = (reason: string) => {
        if (stopped) return
        stopped = reason
        if (processGroup) stopGroup(child)
        else child.kill('SIGKILL')
      }
      const onAbort = () => stop(this.shutdown.signal.aborted ? '服务关闭' : '任务已取消')
      signal.addEventListener('abort', onAbort, { once: true })

      if (timeout !== undefined) {
        const deadline = performance.now() + timeout * 1000
        const checkDeadline = () => {
          const remaining = deadline - performance.now()
          if (remaining > 0) timer = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647))
          else stop(`执行超时（${timeout} 秒）`)
        }
        checkDeadline()
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stopped) return
        try {
          if (stdout?.(chunk) === false) stop('达到结果上限')
        } catch (cause) {
          error = cause instanceof Error ? cause : new Error(String(cause))
          stop('处理工具输出失败')
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + decoder.write(chunk)).slice(-4096) })
      child.once('error', cause => { error = cause })
      // The tool has ended when its foreground command exits. Reap background jobs in its group.
      if (processGroup) child.once('exit', () => stopGroup(child))
      child.once('close', (code, exitSignal) => {
        signal.removeEventListener('abort', onAbort)
        clearTimeout(timer)
        if (error) reject(error)
        else resolve({ code, signal: exitSignal, stderr: (stderr + decoder.end()).trim(), stopped })
      })
    }))
  }

  bash(command: string, cwd: string, signal: AbortSignal, timeout?: number): Promise<string> {
    return this.active(signal, async activeSignal => {
      const path = join(await this.temporaryDirectory(), `bash-${randomUUID()}.txt`)
      const file = await open(path, 'wx+', 0o600)
      let keep = false
      try {
        const result = await this.run('/bin/bash', ['-c', command], {
          cwd, signal: activeSignal, outputFd: file.fd, processGroup: true, timeout,
        })
        const size = (await file.stat()).size
        const bytes = Buffer.alloc(Math.min(size, MAX_OUTPUT_BYTES))
        await file.read({ buffer: bytes, position: size - bytes.length })
        let start = 0
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
        let output = bytes.subarray(start).toString('utf8')
        const lines = output.split('\n')
        const trailingNewline = lines.at(-1) === '' ? 1 : 0
        if (size > bytes.length || lines.length - trailingNewline > MAX_OUTPUT_LINES) {
          output = lines.slice(-MAX_OUTPUT_LINES - trailingNewline).join('\n')
          output += `\n[输出已截断] 完整输出已保存到 ${path}`
          keep = true
        }
        if (result.stderr) output = [output, result.stderr].filter(Boolean).join('\n')
        const status = result.stopped ?? (result.code === null ? `进程因 ${result.signal} 结束` : `退出码 ${result.code}`)
        const text = [output, status].filter(Boolean).join('\n')
        if (result.code !== 0 || result.stopped) throw new Error(text)
        return text
      } finally {
        await file.close()
        if (!keep) await rm(path, { force: true })
      }
    })
  }
}
