import type { McpManager } from '@agent-learning/coding-agent'
import { isSettingsObject } from '../settings-file.js'

const serversPath = '/api/mcp/servers'
const callbackPath = '/api/mcp/oauth/callback'

export function mcpClientMetadataDocuments(baseUrl: string | undefined) {
  if (!baseUrl) return
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('MCP 公开客户端身份文件必须位于 HTTPS 地址。')
  }
  return {
    baseUrl: base.href,
    listsRedirectUrl(redirect: string) {
      const url = new URL(redirect)
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === callbackPath
        && !url.username && !url.password && !url.search && !url.hash
    },
  }
}

export function isMcpSettingsPath(path: string) {
  return path === serversPath || path.startsWith(`${serversPath}/`)
}

export function isMcpOAuthCallback(path: string) {
  return path === callbackPath || path.startsWith(`${callbackPath}/`) && /^(?:\/[A-Za-z0-9_-]+)+$/.test(path.slice(callbackPath.length))
}

export async function finishMcpOAuth(manager: McpManager, { pathname, searchParams }: URL): Promise<boolean> {
  const keys = [...searchParams.keys()]
  if (new Set(keys).size !== keys.length || !searchParams.get('state') || searchParams.has('code') === searchParams.has('error')
    || !(searchParams.get('code') || searchParams.get('error'))) return false
  try { return await manager.finishOAuth(pathname, searchParams) }
  catch { return false }
}

export async function handleMcpSettings(manager: McpManager, origin: string, pathname: string, method: string | undefined,
  readJson: () => Promise<unknown>): Promise<{ status: number; body?: unknown }> {
  if (pathname === serversPath && method === 'GET') return { status: 200, body: { servers: manager.listServers() } }
  if (pathname === serversPath && method === 'POST') return { status: 201, body: await manager.saveServer(await readJson()) }

  const [id, action, attemptId, extra] = pathname.slice(serversPath.length + 1).split('/')
  if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id) && extra === undefined) {
    if (action === undefined && method === 'PUT') return { status: 200, body: await manager.saveServer(await readJson(), id) }
    if (action === undefined && method === 'DELETE') return { status: 200, body: await manager.removeServer(id) }
    if (attemptId === undefined) {
      if (action === 'connect' && method === 'POST') return { status: 200, body: await manager.connectServer(id) }
      if (action === 'reconnect' && method === 'POST') return { status: 200, body: await manager.reconnectServer(id) }
      if (action === 'oauth' && method === 'POST') {
        return { status: 200, body: await manager.startOAuth(id, new URL(callbackPath, origin).href) }
      }
      if (action === 'enabled' && method === 'PUT') {
        const input = await readJson()
        if (!isSettingsObject(input) || Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') {
          return { status: 400, body: { error: '请提交有效的 MCP 服务启停状态。' } }
        }
        return { status: 200, body: await manager.setEnabled(id, input.enabled) }
      }
    }
    if (action === 'oauth' && method === 'DELETE' && attemptId && /^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) {
      await manager.cancelOAuth(id, attemptId)
      return { status: 204 }
    }
  }
  return { status: 404, body: { error: '未找到 MCP 设置入口。' } }
}
