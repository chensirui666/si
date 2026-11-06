import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTools } from '../src/tools.js'
import { ToolRuntime } from '../src/tool-runtime.js'

let cwd: string
let runtime: ToolRuntime

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'agent-tool-test-'))
  runtime = new ToolRuntime()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await runtime.close()
  await rm(cwd, { recursive: true, force: true })
})

function tool(name: string) {
  const tools = createTools(runtime, { web_search: async () => 'search', web_fetch: async () => 'fetch' })
  return tools.find(tool => tool.name === name)!.execute
}

function context(signal = new AbortController().signal) {
  return { cwd, signal }
}

it('reads UTF-8 lines from task cwd and from an absolute path', async () => {
  await writeFile(join(cwd, 'note.txt'), '甲\r\n乙\r\n丙\r\n丁\r\n')
  const read = tool('read')
  expect(await read({ path: 'note.txt', offset: 2, limit: 2 }, context())).toContain('乙\n丙')
  expect(await read({ path: join(cwd, 'note.txt'), offset: 4 }, context())).toContain('丁')
  await expect(read({ path: 'note.txt', offset: 1.5 }, context())).rejects.toThrow('offset')
  await expect(read({ path: 'note.txt', offset: 5 }, context())).rejects.toThrow('offset')
})

it('shows the next offset for a caller-limited read and preserves a final newline at EOF', async () => {
  await writeFile(join(cwd, 'note.txt'), 'first\nsecond\n')
  const read = tool('read')
  expect(await read({ path: 'note.txt', limit: 1 }, context())).toMatch(/^first[\s\S]*offset=2/)
  expect(await read({ path: 'note.txt', offset: 2 }, context())).toBe('second\n')
})

it('keeps read output within the limit without returning a partial line', async () => {
  await writeFile(join(cwd, 'note.txt'), '完整一行\n' + '汉'.repeat(20000) + '\n第三行\n')
  const output = await tool('read')({ path: 'note.txt' }, context())
  expect(output).toContain('完整一行')
  expect(output).toContain('offset=2')
  expect(output).not.toContain('汉')
  expect(output).not.toContain('第三行')
})

it('creates missing parent directories and accepts an empty overwrite', async () => {
  const write = tool('write')
  const path = join(cwd, 'notes', 'note.txt')
  expect(await write({ path: 'notes/note.txt', content: '青禾\n' }, context())).toContain(path)
  expect(await readFile(path, 'utf8')).toBe('青禾\n')
  await write({ path, content: '' }, context())
  expect(await readFile(path)).toHaveLength(0)
})

it('matches edits against the original file and preserves untouched CRLF and BOM', async () => {
  const path = join(cwd, 'note.txt')
  await writeFile(path, '\uFEFF状态：开发中  \r\n负责人：青禾\r\n保留  \r\n')
  const result = await tool('edit')({
    path: 'note.txt',
    edits: [
      { oldText: '状态：开发中\n负责人：青禾', newText: '状态：测试中\n负责人：松柏' },
      { oldText: '保留  ', newText: '仍保留  ' },
    ],
  }, context())
  expect(result).toContain('2')
  expect(await readFile(path, 'utf8')).toBe('\uFEFF状态：测试中\r\n负责人：松柏\r\n仍保留  \r\n')
})

it('uses an exact edit candidate before considering space-only fallback candidates', async () => {
  const path = join(cwd, 'note.txt')
  await writeFile(path, '标题  \n正文\n标题\n正文\n')
  await tool('edit')({ path, edits: [{ oldText: '标题\n正文', newText: '替换' }] }, context())
  expect(await readFile(path, 'utf8')).toBe('标题  \n正文\n替换\n')
})

it.each([
  ['标题  \n正文\n标题   \n正文\n', [{ oldText: '标题\n正文', newText: '替换' }], /唯一/],
  ['“青禾”\n', [{ oldText: '"青禾"', newText: '替换' }], /未找到/],
  ['标题\t\n正文\n', [{ oldText: '标题\n正文', newText: '替换' }], /未找到/],
  ['abc\n', [{ oldText: 'ab', newText: 'X' }, { oldText: 'bc', newText: 'Y' }], /重叠/],
  ['abc\n', [{ oldText: 'abc', newText: 'abc' }], /变化/],
  ['abc\r\nabc\n', [{ oldText: 'abc', newText: 'X' }], /混合/],
] as const)('protects the original bytes when an edit fails for %j', async (original, edits, error) => {
  const path = join(cwd, 'note.txt')
  await writeFile(path, original)
  await expect(tool('edit')({ path, edits: edits.map(edit => ({ ...edit })) }, context())).rejects.toThrow(error)
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('returns Bash stdout, stderr and the actual exit code', async () => {
  await writeFile(join(cwd, 'note.txt'), '青禾')
  const bash = tool('bash')
  const output = await bash({ command: 'cat note.txt; printf " stderr" >&2' }, context())
  expect(output).toContain('青禾')
  expect(output).toContain('stderr')
  expect(output).toContain('退出码 0')
  await expect(bash({ command: 'printf "partial"; exit 7' }, context())).rejects.toThrow(/partial[\s\S]*退出码 7/)
})

it('ends the Bash process group on timeout and reports existing output', async () => {
  const command = 'printf "partial"; (sleep 0.6; touch survived) & wait'
  await expect(tool('bash')({ command, timeout: 0.1 }, context())).rejects.toThrow(/partial[\s\S]*超时/)
  await new Promise(resolve => setTimeout(resolve, 650))
  await expect(readFile(join(cwd, 'survived'))).rejects.toHaveProperty('code', 'ENOENT')
})

it('stops a running Bash process group when the service closes', async () => {
  const output = tool('bash')({
    command: 'printf started; touch ready; (sleep 0.6; touch survived) & wait',
  }, context())
  const result = expect(output).rejects.toThrow(/started[\s\S]*服务关闭/)
  await vi.waitFor(async () => { await readFile(join(cwd, 'ready')) })
  await runtime.close()
  await result
  await delay(650)
  await expect(readFile(join(cwd, 'survived'))).rejects.toHaveProperty('code', 'ENOENT')
})

it('keeps Bash tail output, saves the complete bytes and cleans up on runtime close', async () => {
  const output = await tool('bash')({ command: 'echo first; yes filler | head -n 9000; echo last' }, context())
  expect(output).toContain('last')
  expect(output).not.toContain('first')
  const path = output.match(/完整输出已保存到 (.+)/)![1]!
  expect(await readFile(path, 'utf8')).toBe('first\n' + 'filler\n'.repeat(9000) + 'last\n')
  await runtime.close()
  await expect(readFile(path)).rejects.toHaveProperty('code', 'ENOENT')
})

it('refuses file writes when the task is already cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  const path = join(cwd, 'should-not-exist')
  await expect(tool('write')({ path, content: 'test' }, context(controller.signal))).rejects.toThrow()
  await expect(readFile(path)).rejects.toHaveProperty('code', 'ENOENT')
})

function installed(binary: string) {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

it.skipIf(!installed('fd') && !installed('fdfind'))('find applies path globs, reports relative hidden paths and honors nested ignore rules', async () => {
  await mkdir(join(cwd, 'src'))
  await writeFile(join(cwd, 'src', '.gitignore'), 'ignored.txt\n')
  for (const name of ['keep.txt', '.hidden.txt', 'ignored.txt', 'other.md']) {
    await writeFile(join(cwd, 'src', name), '')
  }
  const result = await tool('find')({ pattern: 'src/*.txt' }, context())
  expect(result.split('\n').sort()).toEqual(['src/.hidden.txt', 'src/keep.txt'])
})

it('reports fd download failure when an existing binary is unavailable', async () => {
  vi.stubEnv('PATH', cwd)
  const fetch = vi.fn(async () => new Response('unavailable', { status: 503 }))
  vi.stubGlobal('fetch', fetch)
  await expect(tool('find')({ pattern: '*.txt' }, context())).rejects.toThrow(/fd.*503/)
})

it('retains fd partial results and distinguishes an execution failure', async () => {
  const bin = join(cwd, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'fd'), '#!/bin/sh\n[ "$1" = --version ] && exit 0\nprintf "known.txt\\000"; echo "read failed" >&2; exit 2\n', { mode: 0o700 })
  vi.stubEnv('PATH', bin)
  await expect(tool('find')({ pattern: '*.txt' }, context())).rejects.toThrow(/部分结果[\s\S]*known.txt[\s\S]*fd.*read failed/)
})

it('rejects altered release bytes before extracting a search executable', async () => {
  vi.stubEnv('PATH', cwd)
  vi.stubGlobal('fetch', async () => new Response('not the pinned bytes'))
  await expect(tool('find')({ pattern: '*.txt' }, context())).rejects.toThrow(/fd.*校验失败/)
})

it.skipIf(!installed('rg'))('grep distinguishes matched lines from context and stops at the global limit', async () => {
  await writeFile(join(cwd, 'note.txt'), 'before\n-Hit.\nafter\n-hitX\n-hit.\n')
  const result = await tool('grep')({
    pattern: '-hit.', path: 'note.txt', literal: true, ignoreCase: true, context: 1, limit: 1,
  }, context())
  expect(result).toContain('note.txt-1- before\nnote.txt:2: -Hit.\nnote.txt-3- after')
  expect(result).not.toContain('note.txt:5:')
  expect(result).toContain('1 条')
  await expect(tool('grep')({ pattern: '[', path: 'note.txt' }, context())).rejects.toThrow(/rg/)
  expect(await tool('grep')({ pattern: '不存在', path: 'note.txt' }, context())).toContain('未找到')
})
