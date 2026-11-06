import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { addAbortListener } from 'node:events'
import type { WebSettings } from './web-settings.js'
import type { ToolRuntime } from './tool-runtime.js'
import type { ExecutableTool } from '@agent-learning/agent'

const nonPublic = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) nonPublic.addSubnet(network, bits)
for (const [network, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  nonPublic.addSubnet(network, bits, 'ipv6')
}
const benchmarkNetwork = new BlockList()
benchmarkNetwork.addSubnet('198.18.0.0', 15)
const globalIPv6 = new BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')

async function publicUrl(value: string, signal: AbortSignal) {
  if (value.length > 2048) throw new Error('网址超过 2048 字符。')
  const url = URL.parse(value)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入不含登录信息的 HTTP(S) 公网网址。')
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '')
  if (!isIP(host) && (!host.includes('.') || /(?:^|\.)(localhost|local|internal|test|invalid|home\.arpa)$/i.test(host))) {
    throw new Error('仅允许访问公网网址。')
  }
  let subscription: ReturnType<typeof addAbortListener> | undefined
  try {
    signal.throwIfAborted()
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => { subscription = addAbortListener(signal, () => reject(signal.reason)) }),
    ])
    if (!isIP(host) && addresses.some(({ address, family }) => family === 4 && benchmarkNetwork.check(address))) {
      throw new Error('本机 DNS 返回代理占位地址，无法验证该网址为公网地址。')
    }
    if (!addresses.length || addresses.some(({ address, family }) => family === 4
      ? nonPublic.check(address)
      : !globalIPv6.check(address, 'ipv6') || nonPublic.check(address, 'ipv6'))) {
      throw new Error('仅允许访问公网网址。')
    }
  } finally { subscription?.[Symbol.dispose]() }
}

function safeHead(text: string, size: number) {
  const last = text.charCodeAt(size - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? size - 1 : size)
}

function safeTail(text: string, size: number) {
  const start = text.length - size
  const first = text.charCodeAt(start)
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? start + 1 : start)
}

export function createWebTools(settings: Pick<WebSettings, 'provider'>, runtime: Pick<ToolRuntime, 'saveTemporary'>): {
  web_search: ExecutableTool['execute']
  web_fetch: ExecutableTool['execute']
} {
  return {
    async web_search(args, { signal }) {
      const { query, limit = 5 } = args
      if (Object.keys(args).some(key => key !== 'query' && key !== 'limit') || typeof query !== 'string' || !query.trim()) {
        throw new Error('搜索词必须为非空字符串。')
      }
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) throw new Error('limit 必须为正整数。')
      const provider = await settings.provider('search')
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      const hits = await provider.search!(query, limit, requestSignal)
      const output = hits.slice(0, limit).map((hit, i) => `${i + 1}. ${hit.title}\n${hit.url}\n${hit.description}`).join('\n\n')
      const bytes = Buffer.from(output)
      return bytes.length > 50 * 1024
        ? new TextDecoder().decode(bytes.subarray(0, 50 * 1024), { stream: true }) + '\n[搜索结果超过 50 KiB，已截断。]'
        : output || '未找到相关网页。'
    },
    async web_fetch(args, { signal }) {
      const { urls, char_limit: limit = 15_000 } = args
      if (Object.keys(args).some(key => key !== 'urls' && key !== 'char_limit') || !Array.isArray(urls) || urls.length < 1 || urls.length > 5) {
        throw new Error('每次须提供 1～5 个网址。')
      }
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 2_000 || limit > 500_000) {
        throw new Error('char_limit 必须为 2000～500000 的整数。')
      }
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      const entries = await Promise.all(urls.map(async value => {
        if (typeof value !== 'string') return { url: '无效网址', error: '网址须为字符串。' }
        try { await publicUrl(value, requestSignal); return { url: value, error: '' } }
        catch (error) {
          signal.throwIfAborted()
          return { url: safeHead(value, 240), error: error instanceof Error ? error.message : '网址无法验证。' }
        }
      }))
      const eligible = [...new Set(entries.filter(entry => !entry.error).map(entry => entry.url))]
      const pages = new Map<string, import('./web-providers.js').WebFetchPage>()
      let requestError = ''
      if (eligible.length) {
        try {
          const provider = await settings.provider('fetch')
          for (const page of await provider.fetch!(eligible, requestSignal)) pages.set(page.url, page)
        } catch (error) {
          signal.throwIfAborted()
          requestError = error instanceof Error ? error.message : '正文请求失败。'
        }
      }
      const output: { header: string; content?: string; notice?: string }[] = []
      let successes = 0
      const pageBudget = Math.min(limit, Math.floor(85_000 / entries.length))
      for (const entry of entries) {
        signal.throwIfAborted()
        const page = entry.error ? undefined : pages.get(entry.url)
        const url = safeHead(entry.url, 2048)
        if (!page?.content) {
          output.push({ header: `${url}\n失败：${safeHead(entry.error || requestError || page?.error || '未返回正文。', 400)}` })
          continue
        }
        successes++
        const header = `${url}\n${safeHead(page.title ?? '', 160)}\n成功\n`
        if (page.content.length <= pageBudget) {
          output.push({ header, content: page.content })
          continue
        }
        let notice: string
        try {
          const cache = await runtime.saveTemporary(safeHead(page.content, 2_000_000))
          notice = `已截断，正文保存于 ${cache}${page.content.length > 2_000_000 ? '（最多保存 200 万字符）' : ''}`
        } catch { notice = '已截断，未能保存正文缓存。' }
        output.push({ header, content: page.content, notice: `\n[… ${notice} …]\n` })
      }
      const reserved = output.reduce((size, item) => size + item.header.length + (item.content === undefined ? 0 : (item.notice?.length ?? 32)) + 2, 0)
      const available = Math.min(pageBudget, Math.max(0, Math.floor((100_000 - reserved) / Math.max(1, successes))))
      const text = output.map(({ header, content, notice }) => {
        if (content === undefined) return header
        if (content.length <= available) return header + content
        const half = Math.floor(available / 2)
        return header + safeHead(content, half) + (notice ?? '\n[… 已达到整批正文上限 …]\n') + safeTail(content, half)
      }).join('\n\n')
      if (!successes) throw new Error(text)
      return text
    },
  }
}
