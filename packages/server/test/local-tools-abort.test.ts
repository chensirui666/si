import * as fs from 'node:fs/promises'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTools } from '../src/tools.js'
import { createLocalTools } from '../src/local-tools.js'
import { ToolRuntime } from '../src/tool-runtime.js'

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, stat: vi.fn(fs.stat), readFile: vi.fn(fs.readFile), mkdir: vi.fn(fs.mkdir), writeFile: vi.fn(fs.writeFile) }
})
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let cwd: string
let runtime: ToolRuntime
beforeEach(async () => {
  for (const fn of [fs.stat, fs.readFile, fs.mkdir, fs.writeFile]) vi.mocked(fn).mockReset()
  cwd = await real.mkdtemp(join(tmpdir(), 'local-abort-'))
  await real.writeFile(join(cwd, 'note.txt'), 'before')
  runtime = new ToolRuntime()
})
afterEach(async () => { await runtime.close(); await real.rm(cwd, { recursive: true, force: true }) })

it.each(['stat', 'readFile'] as const)('read stops waiting during %s and discards late results', async stage => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const paths: string[] = []
  if (stage === 'stat') vi.mocked(fs.stat).mockImplementationOnce(async () => { entered.resolve(); await release.promise; return real.stat(join(cwd, 'note.txt')) })
  else vi.mocked(fs.readFile).mockImplementationOnce(async () => { entered.resolve(); await release.promise; return Buffer.from('late text') })
  const output = createLocalTools(runtime).read({ path: 'note.txt' }, { cwd, signal: controller.signal, recordFileOperation: path => paths.push(path) })
  let settled = false
  void output.then(() => { settled = true }, () => { settled = true })
  const rejected = expect(output).rejects.toThrow()
  await entered.promise
  controller.abort()
  try {
    await vi.waitFor(() => expect(settled).toBe(true))
    await rejected
    expect(paths).toEqual([])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    if (stage === 'stat') expect(fs.readFile).not.toHaveBeenCalled()
  } finally { release.resolve() }
})

it.each(['mkdir', 'writeFile'] as const)('write waits for %s to settle and then reports cancellation', async stage => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const paths: string[] = []
  if (stage === 'mkdir') vi.mocked(fs.mkdir).mockImplementationOnce(async () => { entered.resolve(); await release.promise; return undefined })
  else vi.mocked(fs.writeFile).mockImplementationOnce(async () => { entered.resolve(); await release.promise; await real.writeFile(join(cwd, 'note.txt'), 'after') })
  let settled = false
  const output = createLocalTools(runtime).write({ path: 'note.txt', content: 'after' }, { cwd, signal: controller.signal, recordFileOperation: path => paths.push(path) })
  void output.then(() => { settled = true }, () => { settled = true })
  const rejected = expect(output).rejects.toThrow()
  await entered.promise
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve()
  await rejected
  expect(await real.readFile(join(cwd, 'note.txt'), 'utf8')).toBe(stage === 'mkdir' ? 'before' : 'after')
  expect(paths).toEqual(stage === 'writeFile' ? [join(cwd, 'note.txt')] : [])
})

it.each(['readFile', 'writeFile'] as const)('edit waits for %s and never reports a cancelled operation as success', async stage => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const paths: string[] = []
  if (stage === 'readFile') vi.mocked(fs.readFile).mockImplementationOnce(async () => { entered.resolve(); await release.promise; return Buffer.from('before') })
  else vi.mocked(fs.writeFile).mockImplementationOnce(async () => { entered.resolve(); await release.promise; await real.writeFile(join(cwd, 'note.txt'), 'after') })
  let settled = false
  const output = createLocalTools(runtime).edit({ path: 'note.txt', edits: [{ oldText: 'before', newText: 'after' }] }, { cwd, signal: controller.signal, recordFileOperation: path => paths.push(path) })
  void output.then(() => { settled = true }, () => { settled = true })
  const rejected = expect(output).rejects.toThrow()
  await entered.promise
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve()
  await rejected
  expect(await real.readFile(join(cwd, 'note.txt'), 'utf8')).toBe(stage === 'readFile' ? 'before' : 'after')
  expect(paths).toEqual(stage === 'writeFile' ? [join(cwd, 'note.txt')] : [])
})


it('T1.1 正式 read 工具返回明确的中止码，晚到文件结果不会变成成功', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  vi.mocked(fs.readFile).mockImplementationOnce(async () => { entered.resolve(); await release.promise; return Buffer.from('项目名称：青禾') })
  const controller = new AbortController()
  const read = createTools(runtime, { web_search: async () => '', web_fetch: async () => '' }).find(tool => tool.name === 'read')!
  const output = read.execute({ path: 'note.txt' }, { cwd, signal: controller.signal })
  const rejected = expect(output).rejects.toMatchObject({ code: 'interrupted' })
  await entered.promise
  controller.abort()
  try { await rejected } finally { release.resolve() }
})
