import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { addAbortListener } from 'node:events'
import { homedir } from 'node:os'
import { basename, dirname, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ExecutableTool } from '@agent-learning/agent'
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, type ToolRuntime } from './tool-runtime.js'
import type { BashParams, EditParams, FindParams, GrepParams, ReadParams, WriteParams } from './tools.js'

type Context = Parameters<ExecutableTool['execute']>[1]

function nonEmpty(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} 不能为空`)
  return value
}

function integer(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} 必须是大于等于 ${minimum} 的整数`)
  return value
}

function pathFrom(cwd: string, value: string): string {
  nonEmpty(value, 'path')
  if (value.includes('\0')) throw new Error('path 不能包含空字符')
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return resolve(homedir(), '.' + value.slice(1))
  return resolve(cwd, value)
}

async function readText(path: string, signal: AbortSignal, keepBom = false): Promise<string> {
  signal.throwIfAborted()
  if (!(await stat(path)).isFile()) throw new Error(`不是文件：${path}`)
  signal.throwIfAborted()
  const bytes = await readFile(path, { signal })
  signal.throwIfAborted()
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: keepBom }).decode(bytes)
    if (text.includes('\0')) throw new Error('binary')
    return text
  } catch {
    throw new Error(`文件不是有效的 UTF-8 文本：${path}`)
  }
}

async function readWithAbort(path: string, signal: AbortSignal) {
  signal.throwIfAborted()
  let subscription: ReturnType<typeof addAbortListener> | undefined
  try {
    return await Promise.race([
      readText(path, signal),
      new Promise<never>((_, reject) => { subscription = addAbortListener(signal, () => reject(signal.reason)) }),
    ])
  } finally { subscription?.[Symbol.dispose]() }
}

function linesOf(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

class OutputLines {
  readonly lines: string[] = []
  private bytes = 0

  append(line: string): boolean {
    const bytes = Buffer.byteLength(line) + (this.lines.length ? 1 : 0)
    if (this.bytes + bytes > MAX_OUTPUT_BYTES) return false
    this.bytes += bytes
    this.lines.push(line)
    return true
  }

  text(): string {
    return this.lines.join('\n')
  }
}

async function read({ path, offset = 1, limit }: ReadParams, { cwd, signal, recordFileOperation }: Context) {
  const start = integer(offset, 'offset') - 1
  const count = limit === undefined ? Infinity : integer(limit, 'limit')
  const target = pathFrom(cwd, path)
  const text = await readWithAbort(target, signal)
  const lines = linesOf(text)
  if (start >= lines.length && (lines.length || start > 0)) throw new Error(`offset 超出文件范围（共 ${lines.length} 行）`)
  recordFileOperation?.(target)

  const output = new OutputLines()
  const requested = Math.min(lines.length - start, count)
  for (let i = 0; i < Math.min(requested, MAX_OUTPUT_LINES); i++) {
    if (!output.append(lines[start + i]!)) break
  }
  const content = output.text()
  const next = start + output.lines.length
  if (output.lines.length < requested) {
    if (!output.lines.length) return `[第 ${offset} 行超过 50 KiB，无法返回完整一行。可用 Bash 查看这一行，或用 offset=${offset + 1} 读取后续内容]`
    return `${content}\n\n[输出已截断，可用 offset=${next + 1} 继续读取]`
  }
  if (next < lines.length) return `${content}\n\n[剩余 ${lines.length - next} 行，可用 offset=${next + 1} 继续读取]`
  if (/[\r\n]$/.test(text) && Buffer.byteLength(content) < MAX_OUTPUT_BYTES) return content + '\n'
  return content
}

async function write({ path, content }: WriteParams, { cwd, signal, recordFileOperation }: Context) {
  const target = pathFrom(cwd, path)
  signal.throwIfAborted()
  await mkdir(dirname(target), { recursive: true })
  signal.throwIfAborted()
  await writeFile(target, content, 'utf8')
  // Cancellation cannot undo a completed write.
  recordFileOperation?.(target)
  signal.throwIfAborted()
  return `已写入 ${target}`
}

type Span = { start: number; end: number }

function findSpans(text: string, fragment: string, accept: (end: number) => boolean = () => true): Span[] {
  const spans: Span[] = []
  for (let start = text.indexOf(fragment); start >= 0; start = text.indexOf(fragment, start + 1)) {
    const end = start + fragment.length
    if (accept(end)) spans.push({ start, end })
    if (spans.length === 2) break
  }
  return spans
}

function trailingSpaces(text: string) {
  return text.replace(/ +(?=\n|$)/g, '')
}

function withoutTrailingSpaces(text: string) {
  const positions: number[] = []
  const pieces: string[] = []
  let start = 0
  for (const line of text.split('\n')) {
    const trimmed = trailingSpaces(line)
    pieces.push(trimmed)
    for (let i = 0; i < trimmed.length; i++) positions.push(start + i)
    positions.push(start + line.length)
    start += line.length + 1
  }
  return { text: pieces.join('\n'), positions }
}

async function edit({ path, edits }: EditParams, { cwd, signal, recordFileOperation }: Context) {
  const target = pathFrom(cwd, path)
  if (!edits.length || edits.some(({ oldText }) => !oldText.length)) throw new Error('edits 至少需要一项，且 oldText 不能为空')
  const original = await readText(target, signal, true)
  const newlines = new Set(original.match(/\r\n|\n|\r/g))
  if (newlines.size > 1) throw new Error('文件使用混合换行，无法安全修改')
  const newline = newlines.values().next().value ?? '\n'
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : ''
  const text = original.slice(bom.length).replace(/\r\n|\r/g, '\n')
  let fallback: ReturnType<typeof withoutTrailingSpaces> | undefined
  const replacements = edits.map(({ oldText, newText }, index) => {
    const needle = oldText.replace(/\r\n|\r/g, '\n')
    let spans = findSpans(text, needle)
    if (!spans.length) {
      fallback ??= withoutTrailingSpaces(text)
      const trimmed = trailingSpaces(needle)
      if (trimmed) {
        spans = findSpans(fallback.text, trimmed, end =>
          !needle.endsWith(' ') || fallback!.text[end] === '\n' || end === fallback!.text.length,
        ).map(({ start, end }) => ({
          start: fallback!.positions[start]!,
          end: fallback!.positions[end - 1]! + 1,
        }))
      }
    }
    if (!spans.length) throw new Error(`第 ${index + 1} 项未找到 oldText`)
    if (spans.length !== 1) throw new Error(`第 ${index + 1} 项的 oldText 必须唯一`)
    return { ...spans[0]!, newText: newText.replace(/\r\n|\r/g, '\n') }
  }).sort((a, b) => a.start - b.start)

  const parts: string[] = []
  let cursor = 0
  for (const { start, end, newText } of replacements) {
    if (start < cursor) throw new Error('edits 的替换范围重叠')
    parts.push(text.slice(cursor, start), newText)
    cursor = end
  }
  parts.push(text.slice(cursor))
  const updated = parts.join('')
  if (updated === text) throw new Error('编辑后文件没有变化')
  signal.throwIfAborted()
  await writeFile(target, bom + updated.replaceAll('\n', newline), 'utf8')
  recordFileOperation?.(target)
  signal.throwIfAborted()
  return `已在 ${target} 完成 ${edits.length} 处替换`
}

function bash(runtime: ToolRuntime, { command, timeout }: BashParams, { cwd, signal }: Context) {
  nonEmpty(command, 'command')
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error('timeout 必须是正数')
  return runtime.bash(command, cwd, signal, timeout)
}

function splitOutput(separator: string, receive: (entry: string) => boolean | void) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  return (chunk: Buffer) => {
    const entries = (pending + decoder.write(chunk)).split(separator)
    pending = entries.pop()!
    for (const entry of entries) {
      if (receive(entry) === false) return false
    }
  }
}

async function insideGit(directory: string): Promise<boolean> {
  for (let current = directory; ; current = dirname(current)) {
    if (await access(resolve(current, '.git')).then(() => true, () => false)) return true
    if (current === dirname(current)) return false
  }
}

async function find(runtime: ToolRuntime, { pattern, path = '.', limit = 1000 }: FindParams, { cwd, signal }: Context) {
  nonEmpty(pattern, 'pattern')
  integer(limit, 'limit')
  const directory = pathFrom(cwd, path)
  if (!(await stat(directory)).isDirectory()) throw new Error(`不是目录：${directory}`)
  const command = await runtime.prepare('fd', directory, signal)
  const args = ['--glob', '--color=never', '--hidden', '--show-errors', '--print0']
  if (!(await insideGit(directory))) args.push('--no-require-git')
  if (pattern.includes('/')) {
    args.push('--full-path')
    if (!pattern.startsWith('/') && !pattern.startsWith('**/')) pattern = '**/' + pattern
  }
  args.push('--', pattern)
  const output = new OutputLines()
  let notice: string | undefined
  const result = await runtime.run(command, args, {
    cwd: directory, signal,
    stdout: splitOutput('\0', entry => {
      const path = entry.replace(/^\.\//, '')
      if (!output.append(path.includes('\n') || path.includes('\r') ? JSON.stringify(path) : path)) {
        notice = '已达到 50 KiB 输出上限'
        return false
      }
      if (output.lines.length === limit) {
        notice = `已达到 ${limit} 条结果上限`
        return false
      }
    }),
  })
  const text = output.text()
  const reachedLimit = result.stopped === '达到结果上限'
  if (result.stderr || (!reachedLimit && result.stopped) || (result.code !== 0 && (!reachedLimit || result.code !== null))) {
    const failure = result.stderr || (!reachedLimit && result.stopped) || `退出码 ${result.code ?? result.signal}`
    throw Object.assign(new Error([text && `部分结果（不完整）\n${text}`, `fd 执行失败：${failure}`].filter(Boolean).join('\n')), result.aborted ? { code: 'interrupted' } : {})
  }
  return [text || '未找到匹配路径', notice && `[${notice}]`].filter(Boolean).join('\n')
}

type RgValue = { text?: string; bytes?: string }
type RgEvent = { type: string; data: { path: RgValue; lines: RgValue; line_number: number } }
type Match = { path: string; line: number; text: string }

function rgText(value: RgValue) {
  return value.text ?? Buffer.from(value.bytes ?? '', 'base64').toString('utf8')
}

async function grep(runtime: ToolRuntime, params: GrepParams, { cwd, signal }: Context) {
  const { pattern, path = '.', glob, ignoreCase, literal, context = 0, limit = 100 } = params
  nonEmpty(pattern, 'pattern')
  integer(context, 'context', 0)
  integer(limit, 'limit')
  if (glob !== undefined) nonEmpty(glob, 'glob')
  const search = pathFrom(cwd, path)
  const stats = await stat(search)
  if (!stats.isDirectory() && !stats.isFile()) throw new Error(`不是文件或目录：${search}`)

  const command = await runtime.prepare('rg', cwd, signal)
  const args = ['--no-config', '--json', '--line-number', '--color=never', '--hidden']
  if (ignoreCase) args.push('--ignore-case')
  if (literal) args.push('--fixed-strings')
  if (glob !== undefined) args.push('--glob', glob)
  args.push('--', pattern, search)
  const matches: Match[] = []
  let matchBytes = 0
  let longLine = false
  let limitReached = false
  let bytesReached = false
  const shorten = (text: string) => {
    if (text.length <= 500) return text
    let index = 0
    let count = 0
    for (const character of text) {
      if (++count === 500) {
        if (index + character.length === text.length) break
        longLine = true
        return text.slice(0, index) + '…'
      }
      index += character.length
    }
    return text
  }
  const result = await runtime.run(command, args, {
    cwd, signal,
    stdout: splitOutput('\n', entry => {
      const event = JSON.parse(entry) as RgEvent
      if (event.type !== 'match') return
      const path = rgText(event.data.path)
      const line = event.data.line_number
      const text = shorten(rgText(event.data.lines).replace(/\r?\n$/, ''))
      const label = stats.isDirectory() ? relative(search, path) : basename(path)
      matchBytes += Buffer.byteLength(`${label}:${line}: ${text}\n`)
      matches.push({ path, line, text })
      if (matches.length === limit) limitReached = true
      if (matchBytes > MAX_OUTPUT_BYTES) bytesReached = true
      if (limitReached || bytesReached) return false
    }),
  })
  const reachedLimit = result.stopped === '达到结果上限'
  if ((!reachedLimit && result.stopped) ||
      (result.code !== 0 && result.code !== 1 && (!reachedLimit || result.code !== null))) {
    const partial = matches.map(match => `${stats.isDirectory() ? relative(search, match.path) : basename(match.path)}:${match.line}: ${match.text}`).join('\n')
    throw Object.assign(new Error([partial && `部分结果（不完整）\n${partial}`, `rg 执行失败：${result.stopped ?? (result.stderr || `退出码 ${result.code}`)}`].filter(Boolean).join('\n')), result.aborted ? { code: 'interrupted' } : {})
  }
  if (!matches.length) return '未找到匹配项'

  const output = new OutputLines()
  let contextPath: string | undefined
  let lines: string[] = []
  for (const match of matches) {
    signal.throwIfAborted()
    const label = stats.isDirectory() ? relative(search, match.path) : basename(match.path)
    if (context > 0 && contextPath !== match.path) {
      try {
        lines = linesOf(await readWithAbort(match.path, signal))
      } catch {
        signal.throwIfAborted()
        lines = []
      }
      contextPath = match.path
    }
    const start = lines.length ? Math.max(1, match.line - context) : match.line
    const end = lines.length ? Math.max(match.line, Math.min(lines.length, match.line + context)) : match.line
    let full = false
    for (let line = start; line <= end; line++) {
      const row = line === match.line ? `${label}:${line}: ${match.text}` : `${label}-${line}- ${shorten(lines[line - 1]!)}`
      if (!output.append(row)) {
        full = true
        break
      }
    }
    if (full) {
      bytesReached = true
      break
    }
  }

  return [
    output.text(),
    limitReached && `[已达到 ${limit} 条命中上限]`,
    bytesReached && '[已达到 50 KiB 输出上限]',
    longLine && '[部分行已截断至 500 字符]',
  ].filter(Boolean).join('\n')
}

export function createLocalTools(runtime: ToolRuntime) {
  return {
    read,
    write,
    edit,
    bash: (params: BashParams, context: Context) => bash(runtime, params, context),
    find: (params: FindParams, context: Context) => find(runtime, params, context),
    grep: (params: GrepParams, context: Context) => grep(runtime, params, context),
  }
}
