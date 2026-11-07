import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Credentials } from '@agent-learning/credentials'
import { createTavilyProvider } from '../src/web-providers.js'
import { createWebTools } from '../src/web-tools.js'
import { WebSettings } from '../src/web-settings.js'
import { ToolRuntime } from '../src/tool-runtime.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'web-providers-'))
  roots.push(cwd)
  return { cwd, signal: new AbortController().signal, credentials: new Credentials(join(cwd, 'auth.json')) }
}

it('P2: selects a search-only provider without a provider field in the tool call', async () => {
  const context = await setup()
  const search = vi.fn(async () => [{ title: '结果标题', url: 'https://example.com/', description: '相关片段' }])
  const settings = new WebSettings([createTavilyProvider(context.credentials), { id: 'search-only', name: 'Alternate', search }], context.credentials, join(context.cwd, 'settings.json'))
  expect(settings.validSelection({ searchProvider: 'tavily', fetchProvider: 'search-only' })).toBe(false)
  await settings.save({ searchProvider: 'search-only', fetchProvider: 'tavily' })
  const tools = createWebTools(settings, { saveTemporary: vi.fn() })
  expect(await tools.web_search({ query: '测试网页' }, context)).toBe('1. 结果标题\nhttps://example.com/\n相关片段')
  expect(search).toHaveBeenCalledExactlyOnceWith('测试网页', 5, expect.any(AbortSignal))
  await expect(tools.web_search({ query: '测试网页', provider: 'tavily' }, context)).rejects.toThrow()
  expect(search).toHaveBeenCalledTimes(1)
})

it('maps Tavily search and mixed extraction results to the original URLs, using the current shared Key', async () => {
  const { credentials, signal } = await setup()
  const first = 'https://example.com/'
  const second = 'https://example.org/failed'
  const third = 'https://example.net/ok'
  const missing = 'https://example.net/omitted'
  const fakeFetch = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ results: [{ title: 'Found', url: first, content: 'Relevant snippet' }] }))
    .mockResolvedValueOnce(Response.json({
      results: [{ url: third, raw_content: 'Third page' }, { url: 'https://example.com', raw_content: 'First page' }],
      failed_results: [{ url: second, error: 'private upstream detail' }],
    }))
  const tavily = createTavilyProvider(credentials, fakeFetch)
  await credentials.saveApiKey('tavily', 'first-test-key')
  expect(await tavily.search!('test search', 40, signal)).toEqual([{ title: 'Found', url: first, description: 'Relevant snippet' }])
  await credentials.saveApiKey('tavily', 'next-test-key')
  const urls = [first, second, third, missing]
  expect(await tavily.fetch!(urls, signal)).toEqual([
    { url: first, content: 'First page' },
    { url: second, error: 'Tavily 未能获取该网址的正文。' },
    { url: third, content: 'Third page' },
    { url: missing, error: 'Tavily 未返回该网址的正文。' },
  ])
  expect(fakeFetch.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get('authorization'), JSON.parse(String(init?.body))])).toEqual([
    ['https://api.tavily.com/search', 'Bearer first-test-key', { query: 'test search', max_results: 20, search_depth: 'basic' }],
    ['https://api.tavily.com/extract', 'Bearer next-test-key', { urls, extract_depth: 'basic', timeout: 60 }],
  ])
  await credentials.deleteApiKey('tavily')
  await expect(tavily.fetch!([first], signal)).rejects.toThrow(/not configured/)
  expect(fakeFetch).toHaveBeenCalledTimes(2)
})

it('reads old Exa selections as Tavily without reusing the Exa Key or rewriting settings on read', async () => {
  const { credentials, cwd } = await setup()
  await credentials.saveApiKey('exa', 'old-provider-key')
  const filename = join(cwd, 'settings.json')
  const original = { editor: { compact: true }, web: { searchProvider: 'exa', fetchProvider: 'exa' } }
  await writeFile(filename, JSON.stringify(original), { mode: 0o600 })
  const tavily = { id: 'tavily', name: 'Tavily', search: async () => [], fetch: async () => [] }
  const settings = new WebSettings([tavily], credentials, filename)
  const defaults = { searchProvider: 'tavily', fetchProvider: 'tavily' }
  expect(await settings.view()).toMatchObject({ ...defaults, providers: [{ id: 'tavily', status: { state: 'missing' } }] })
  expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(original)
  await settings.save(defaults)
  expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ ...original, web: defaults })
  expect(await credentials.readApiKey('exa')).toBe('old-provider-key')
})

it('returns mixed URL statuses in input order and caches oversize content within service lifetime', async () => {
  const context = await setup()
  const first = 'https://8.8.8.8/'
  const second = 'https://1.1.1.1/'
  const local = 'http://[::ffff:127.0.0.1]/'
  const privateUrl = 'http://192.168.0.1/'
  const content = '开头' + '中'.repeat(2_000_001) + '结尾'
  const fetch = vi.fn(async () => [{ url: second, error: '缺少正文' }, { url: first, title: '标题', content }])
  const runtime = new ToolRuntime()
  try {
    const tools = createWebTools({ provider: async () => ({ id: 'test', name: 'Test', fetch }) }, runtime)
    const result = await tools.web_fetch({ urls: [local, first, privateUrl, second], char_limit: 2_000 }, context)
    expect(fetch).toHaveBeenCalledExactlyOnceWith([first, second], expect.any(AbortSignal))
    expect(result.indexOf(local)).toBeLessThan(result.indexOf(first))
    expect(result.indexOf(first)).toBeLessThan(result.indexOf(second))
    expect(result).toContain('缺少正文')
    expect(result).toContain('开头')
    expect(result).toContain('结尾')
    expect(result.length).toBeLessThan(2_600)
    const path = result.match(/正文保存于 (.+?)（/)?.[1]
    expect(path).toBeDefined()
    expect((await readFile(path!, 'utf8')).length).toBe(2_000_000)
    await expect(tools.web_fetch({ urls: ['http://127.0.0.1/', 'file:///private'] }, context)).rejects.toThrow('失败')
    expect(fetch).toHaveBeenCalledTimes(1)
    await runtime.close()
    await expect(readFile(path!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await runtime.close() }
})

it('传输普通失败与取消同时到达时，Tavily 仍报告网络失败', async () => {
  const { credentials } = await setup()
  await credentials.saveApiKey('tavily', 'test-only')
  const controller = new AbortController()
  const provider = createTavilyProvider(credentials, async () => { controller.abort(); throw new Error('transport failed') })
  await expect(provider.search!('test', 1, controller.signal)).rejects.toThrow('Tavily 请求失败，请检查网络')
})
