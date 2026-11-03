import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { Agent } from '@agent-learning/agent'
import { loadOrCreateBrowserSecret } from '@agent-learning/credentials'
import { BrowserAuth, trustedRequest } from './browser-auth.js'
import type { ClientFrame, ServerFrame } from './protocol.js'

export type WebServerOptions = {
  port?: number
  webRoot?: string
  browserSecretPath?: string
  devOrigin?: 'http://127.0.0.1:5173'
  agent?: Pick<Agent, 'subscribe'>
  now?: () => number
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' }
function validFrame(value: unknown): value is ClientFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<ClientFrame>
  return (frame.type === 'subscribe' || frame.type === 'unsubscribe')
    && typeof frame.subscriptionId === 'string' && frame.subscriptionId.trim().length > 0 && frame.subscriptionId.length <= 128
}

export class WebServer {
  private readonly agent: Pick<Agent, 'subscribe'>
  private server?: Server
  private ws?: WebSocketServer
  private heartbeat?: ReturnType<typeof setInterval>
  private origins = new Set<string>()
  private auth?: BrowserAuth
  private readonly disposers = new Map<WebSocket, () => void>()
  private closing?: Promise<void>

  constructor(private readonly options: WebServerOptions = {}) {
    this.agent = options.agent ?? new Agent()
  }
  async start(): Promise<{ url: string; authUrl: string; devAuthUrl?: string }> {
    if (this.server) throw new Error('服务已经启动')
    const secret = await loadOrCreateBrowserSecret(this.options.browserSecretPath)
    this.auth = new BrowserAuth(secret, this.options.now)
    this.closing = undefined
    const server = this.server = createServer((req, res) => { void this.handleHttp(req, res).catch(() => {
      if (!res.headersSent) this.respond(res, 500, '服务暂时不可用')
      else res.destroy()
    }) })
    const ws = this.ws = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
    server.on('upgrade', (req, socket, head) => {
      const status = this.admit(req)
      if (status !== 200 || req.url !== '/api/events') {
        const code = status === 200 ? 404 : status
        socket.end(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
        return
      }
      ws.handleUpgrade(req, socket, head, client => this.connect(client))
    })
    try {
      await new Promise<void>((done, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(this.options.port ?? 3000, '127.0.0.1', () => { server.off('error', onError); done() })
      })
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      this.origins = new Set([url])
      if (this.options.devOrigin) this.origins.add(this.options.devOrigin)
      this.heartbeat = setInterval(() => {
        for (const client of ws.clients) {
          const state = this.missedPongs.get(client) ?? 0
          if (state >= 2) { this.disposers.get(client)?.(); client.terminate(); continue }
          this.missedPongs.set(client, state + 1)
          client.ping(undefined, undefined, error => { if (error) { this.disposers.get(client)?.(); client.terminate() } })
        }
      }, 2000)
      this.heartbeat.unref()
      return { url, authUrl: this.auth.authenticatedUrl(url), ...(this.options.devOrigin ? { devAuthUrl: this.auth.authenticatedUrl(this.options.devOrigin + '/auth') } : {}) }
    } catch (error) {
      await this.close()
      throw new Error('服务启动失败：请检查端口是否被占用', { cause: error })
    }
  }
  private admit(req: IncomingMessage): number {
    if (!trustedRequest(req.headers, this.origins)) return 403
    return this.auth!.authenticated(req.headers.host!, req.headers.cookie) ? 200 : 401
  }
  private respond(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-type': 'text/plain; charset=utf-8', ...headers })
    res.end(text)
  }
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!trustedRequest(req.headers, this.origins)) { this.respond(res, 403, '访问地址或来源不可信'); return }
    const url = new URL(req.url ?? '/', 'http://local.invalid')
    const tokens = url.searchParams.getAll('token')
    if (url.pathname === '/' && req.method === 'GET' && tokens.length) {
      if (tokens.length === 1 && this.auth!.matchesToken(tokens[0]!)) {
        this.respond(res, 303, '', { location: './', 'set-cookie': this.auth!.issue(req.headers.host!) })
        return
      }
      if (this.admit(req) === 200) { this.respond(res, 303, '', { location: './' }); return }
    }
    if (this.admit(req) !== 200) { this.respond(res, 401, '需要网页授权，请重新打开终端中的启动链接。'); return }
    if (!['GET', 'HEAD'].includes(req.method ?? '') || url.pathname.startsWith('/api/')) { this.respond(res, 404, '未找到'); return }
    try {
      const root = await realpath(this.options.webRoot ?? fileURLToPath(new URL('../../../../web/dist/', import.meta.url)))
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const filename = await realpath(resolve(root, '.' + relative))
      if (!filename.startsWith(root + sep) || !(await stat(filename)).isFile()) { this.respond(res, 404, '未找到'); return }
      const content = await readFile(filename)
      res.writeHead(200, { 'content-type': mime[extname(filename)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch { this.respond(res, 404, '未找到页面或资源，请先运行 npm run build。') }
  }
  private readonly missedPongs = new Map<WebSocket, number>()
  private connect(client: WebSocket) {
    let current: { id: string; controller: AbortController } | undefined
    const cancel = () => { current?.controller.abort(); current = undefined }
    const cleanup = () => { cancel(); this.disposers.delete(client); this.missedPongs.delete(client) }
    this.disposers.set(client, cleanup)
    this.missedPongs.set(client, 0)
    client.on('pong', () => this.missedPongs.set(client, 0))
    client.on('close', cleanup)
    client.on('error', () => { cleanup(); client.terminate() })
    client.on('message', (data, binary) => {
      let frame: unknown
      try { frame = binary ? undefined : JSON.parse(data.toString()) } catch { frame = undefined }
      if (!validFrame(frame)) { cleanup(); client.close(1008, 'Invalid subscription frame'); return }
      if (frame.type === 'unsubscribe') {
        if (current?.id === frame.subscriptionId) cancel()
        return
      }
      cancel()
      const subscription = current = { id: frame.subscriptionId, controller: new AbortController() }
      void (async () => {
        try {
          for await (const event of this.agent.subscribe(subscription.controller.signal)) {
            if (current !== subscription || subscription.controller.signal.aborted) break
            const outgoing: ServerFrame = { ...event, subscriptionId: subscription.id }
            if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 1024 * 1024) { cleanup(); client.terminate(); break }
            client.send(JSON.stringify(outgoing), error => { if (error) { cleanup(); client.terminate() } })
          }
        } catch {
          if (current === subscription && !subscription.controller.signal.aborted) { cleanup(); client.close(1011, 'Subscription unavailable') }
        }
      })()
    })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = undefined
      for (const cleanup of this.disposers.values()) cleanup()
      for (const client of this.ws?.clients ?? []) client.terminate()
      this.missedPongs.clear()
      const server = this.server
      const ws = this.ws
      this.server = undefined
      this.ws = undefined
      if (ws) await new Promise<void>(done => ws.close(() => done()))
      if (server?.listening) await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections() })
    })()
    return this.closing
  }
}
