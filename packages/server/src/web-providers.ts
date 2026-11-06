import type { Credentials } from '@agent-learning/credentials'

export type WebSearchHit = { title: string; url: string; description: string }
export type WebFetchPage = { url: string; title?: string } & ({ content: string; error?: never } | { content?: never; error: string })
export type WebProvider = {
  id: string
  name: string
  search?(query: string, limit: number, signal: AbortSignal): Promise<WebSearchHit[]>
  fetch?(urls: string[], signal: AbortSignal): Promise<WebFetchPage[]>
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function urlKey(value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.href
  } catch { return undefined }
}

export function createTavilyProvider(credentials: Credentials, fetchRequest = globalThis.fetch): WebProvider {
  const id = 'tavily'
  async function request(endpoint: 'search' | 'extract', body: object, signal: AbortSignal) {
    const key = await credentials.readApiKey(id)
    let response: Response
    try {
      response = await fetchRequest('https://api.tavily.com/' + endpoint, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body), signal,
      })
    } catch {
      signal.throwIfAborted()
      throw new Error('Tavily 请求失败，请检查网络。')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Tavily 请求失败（HTTP ${response.status}）。`)
    }
    const data = object(await response.json().catch(() => { signal.throwIfAborted(); return undefined }))
    if (!Array.isArray(data.results)) throw new Error('Tavily 返回了无效响应。')
    return {
      results: data.results.map(object),
      failures: Array.isArray(data.failed_results) ? data.failed_results.map(object) : [],
    }
  }

  return {
    id, name: 'Tavily',
    async search(query, limit, signal) {
      const maxResults = Math.min(limit, 20)
      const { results } = await request('search', { query, max_results: maxResults, search_depth: 'basic' }, signal)
      return results.slice(0, maxResults).flatMap(result => {
        if (typeof result.url !== 'string' || !urlKey(result.url)) return []
        return [{
          title: typeof result.title === 'string' && result.title ? result.title : result.url,
          url: result.url,
          description: typeof result.content === 'string' ? result.content : '',
        }]
      })
    },
    async fetch(urls, signal) {
      const { results, failures } = await request('extract', { urls, extract_depth: 'basic', timeout: 60 }, signal)
      return urls.map((url): WebFetchPage => {
        const key = urlKey(url)
        if (failures.some(item => urlKey(item.url) === key)) return { url, error: 'Tavily 未能获取该网址的正文。' }
        const result = results.find(item => urlKey(item.url) === key)
        if (typeof result?.raw_content !== 'string' || !result.raw_content.trim()) return { url, error: 'Tavily 未返回该网址的正文。' }
        return { url, content: result.raw_content, ...(typeof result.title === 'string' && { title: result.title }) }
      })
    },
  }
}
