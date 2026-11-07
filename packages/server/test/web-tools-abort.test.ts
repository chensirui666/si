import { createServer } from 'node:http'
import { once, getEventListeners } from 'node:events'
import * as dns from 'node:dns/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Credentials } from '@agent-learning/credentials'
import { createTavilyProvider } from '../src/web-providers.js'
import { createTools } from '../src/tools.js'
import { createWebTools } from '../src/web-tools.js'
import { ToolRuntime } from '../src/tool-runtime.js'

vi.mock('node:dns/promises', async original => {
  const dns = await original<typeof import('node:dns/promises')>()
  return { ...dns, lookup: vi.fn(dns.lookup) }
})
afterEach(() => vi.mocked(dns.lookup).mockReset())

it.each(['search', 'fetch'] as const)('Tavily %s cancellation closes a real local HTTP response', async capability => {
  const cwd = await mkdtemp(join(tmpdir(), 'tavily-abort-'))
  const entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain the real request. */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"results":[')
    res.once('close', () => closed.resolve())
    entered.resolve()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  try {
    const credentials = new Credentials(join(cwd, 'auth.json'))
    await credentials.saveApiKey('tavily', 'test-only')
    const provider = createTavilyProvider(credentials, (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init))
    const tools = createWebTools({ provider: async () => provider }, { saveTemporary: async () => { throw new Error('unused') } })
    const controller = new AbortController()
    const context = { cwd, signal: controller.signal }
    const runtime = new ToolRuntime()
    const tool = createTools(runtime, tools).find(tool => tool.name === `web_${capability}`)!
    const output = tool.execute(capability === 'search' ? { query: 'test' } : { urls: ['https://8.8.8.8/'] }, context).finally(() => runtime.close())
    const rejected = expect(output).rejects.toMatchObject({ code: 'interrupted' })
    await entered.promise
    controller.abort()
    await rejected
    await closed.promise
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(cwd, { recursive: true, force: true })
  }
})

it('web_fetch cancels DNS waiting without starting a provider request or retaining listeners', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<dns.LookupAddress[]>()
  vi.mocked(dns.lookup).mockImplementationOnce(() => { entered.resolve(); return release.promise })
  const provider = vi.fn()
  const controller = new AbortController()
  const tools = createWebTools({ provider }, { saveTemporary: vi.fn() })
  const output = tools.web_fetch({ urls: ['https://example.com/'] }, { cwd: tmpdir(), signal: controller.signal })
  const rejected = expect(output).rejects.toThrow()
  await entered.promise
  controller.abort()
  await rejected
  release.resolve([{ address: '8.8.8.8', family: 4 }])
  expect(provider).not.toHaveBeenCalled()
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

it('web_fetch waits for an already-started real cache write before returning', async () => {
  const runtime = new ToolRuntime()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const content = '项目资料'.repeat(5000) + '青禾正文结束'
  let path = '', settled = false
  const tools = createWebTools({ provider: async () => ({ id: 'test', name: 'Test', fetch: async () => [{ url: 'https://8.8.8.8/', content }] }) }, {
    saveTemporary: async text => { entered.resolve(); await release.promise; path = await runtime.saveTemporary(text); return path },
  })
  try {
    const output = tools.web_fetch({ urls: ['https://8.8.8.8/'] }, { cwd: tmpdir(), signal: controller.signal })
    void output.then(() => { settled = true })
    await entered.promise
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    expect(await output).toContain(path)
    expect(await readFile(path, 'utf8')).toBe(content)
  } finally { release.resolve(); await runtime.close() }
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['search', 'fetch'] as const)('普通 %s 网络失败不被同时到达的中止改写', async capability => {
  const controller = new AbortController()
  const failure = async () => { controller.abort(); throw new Error('网络原始失败') }
  const tools = createWebTools({ provider: async () => ({ id: 'test', name: 'Test', search: failure, fetch: failure }) }, { saveTemporary: vi.fn() })
  const runtime = new ToolRuntime()
  try {
    const tool = createTools(runtime, tools).find(tool => tool.name === `web_${capability}`)!
    await expect(tool.execute(capability === 'search' ? { query: 'test' } : { urls: ['https://8.8.8.8/'] }, { cwd: tmpdir(), signal: controller.signal })).rejects.toMatchObject({ message: expect.stringContaining('网络原始失败') })
  } finally { await runtime.close() }
})
