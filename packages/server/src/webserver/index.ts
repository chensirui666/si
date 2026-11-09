import { createServer, validateHeaderValue, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { Agent, AgentSubmitError } from '@agent-learning/agent'
import { Credentials, loadOrCreateBrowserSecret } from '@agent-learning/credentials'
import { createModelStream, discoverModels } from '@agent-learning/model'
import { pickDirectory, type DirectoryPicker } from '../directory-picker.js'
import { Workspaces, WorkspaceBindingError } from '../workspaces.js'
import { WebSettings } from '../web-settings.js'
import { createTavilyProvider, type WebProvider } from '../web-providers.js'
import { createWebTools } from '../web-tools.js'
import { createTools } from '../tools.js'
import { ToolRuntime } from '../tool-runtime.js'
import { BrowserAuth, trustedRequest } from './browser-auth.js'
import type { ClientFrame, ServerFrame, SubmitMessageRequest } from './protocol.js'

export type WebServerOptions = {
  port?: number
  webRoot?: string
  browserSecretPath?: string
  modelAuthPath?: string
  devOrigin?: `http://127.0.0.1:${number}`
  workspacePath?: string
  webSettingsPath?: string
  directoryPicker?: DirectoryPicker
  webProviders?: WebProvider[]
  agent?: Pick<Agent, 'subscribe'> & Partial<Pick<Agent, 'submit' | 'abort' | 'close'>>
  modelOptions?: Parameters<typeof createModelStream>[1]
  compaction?: { triggerTokens: number; keepRecentTokens: number }
  now?: () => number
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' }
const maxBufferedBytes = 1024 * 1024
class InputError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    req.resume()
    throw new InputError(415, '请使用 JSON 提交请求')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 64 * 1024) { req.resume(); throw new InputError(413, '请求过大') }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new InputError(400, '请求必须是有效 JSON') }
}
async function providerKey(req: IncomingMessage): Promise<string> {
  const value = await readJson(req)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !('apiKey' in value) || typeof value.apiKey !== 'string') throw new InputError(400, '请仅提交 apiKey 字符串')
  return value.apiKey
}
async function messageInput(req: IncomingMessage): Promise<SubmitMessageRequest> {
  const value = await readJson(req)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
    || !('workspaceId' in value) || typeof value.workspaceId !== 'string' || !value.workspaceId.trim() || value.workspaceId.length > 128
    || !('text' in value) || typeof value.text !== 'string' || !value.text.trim()
    || !('modelId' in value) || typeof value.modelId !== 'string'
    || !('clientMessageId' in value) || typeof value.clientMessageId !== 'string'
    || !value.clientMessageId.trim() || value.clientMessageId.length > 128) {
    throw new InputError(400, '请提交原文、模型、有效临时编号和工作区编号')
  }
  return value as SubmitMessageRequest
}
function validFrame(value: unknown): value is ClientFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<ClientFrame>
  return (frame.type === 'subscribe' || frame.type === 'unsubscribe')
    && typeof frame.subscriptionId === 'string' && frame.subscriptionId.trim().length > 0 && frame.subscriptionId.length <= 128
}

export class WebServer {
  private readonly agent: Pick<Agent, 'subscribe'> & Partial<Pick<Agent, 'submit' | 'abort' | 'close'>>
  private server?: Server
  private ws?: WebSocketServer
  private heartbeat?: ReturnType<typeof setInterval>
  private origins = new Set<string>()
  private auth?: BrowserAuth
  private readonly disposers = new Map<WebSocket, () => void>()
  private closing?: Promise<void>
  private readonly credentials: Credentials
  private readonly workspaces: Workspaces
  private readonly webSettings: WebSettings
  private readonly toolRuntime = new ToolRuntime()
  private selection?: AbortController
  private stopWatching?: () => void

  constructor(private readonly options: WebServerOptions = {}) {
    this.credentials = new Credentials(options.modelAuthPath)
    this.workspaces = new Workspaces(options.workspacePath)
    this.webSettings = new WebSettings(options.webProviders ?? [createTavilyProvider(this.credentials)], this.credentials, options.webSettingsPath)
    this.agent = options.agent ?? new Agent({
      stream: createModelStream(this.credentials, options.modelOptions),
      tools: createTools(this.toolRuntime, createWebTools(this.webSettings, this.toolRuntime)),
      compaction: options.compaction,
    })
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
      this.stopWatching = this.credentials.watch(() => {
        this.notify('models_changed')
        this.notify('web_settings_changed')
      })
      this.heartbeat = setInterval(() => {
        for (const client of ws.clients) {
          const state = this.missedPongs.get(client) ?? 0
          if (state >= 2 || client.bufferedAmount > maxBufferedBytes) { this.disposers.get(client)?.(); client.terminate(); continue }
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
    if (url.pathname === '/api/models' && req.method === 'GET') {
      this.respond(res, 200, JSON.stringify(await discoverModels(this.credentials)), { 'content-type': 'application/json; charset=utf-8' })
      return
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      try { this.json(res, 200, await this.workspaces.view()) }
      catch { this.json(res, 500, { error: '无法读取工作区登记，请检查本机配置文件。' }) }
      return
    }
    if (url.pathname === '/api/workspaces/pick' && req.method === 'POST') {
      await this.pick(req, res)
      return
    }
    const webProvider = /^\/api\/web\/providers\/([a-z][a-z0-9-]*)$/.exec(url.pathname)?.[1]
    if ((url.pathname === '/api/web/settings' && (req.method === 'GET' || req.method === 'PUT'))
      || (webProvider && (req.method === 'PUT' || req.method === 'DELETE'))) {
      await this.handleWebSettings(req, res, webProvider)
      return
    }
    if (url.pathname === '/api/abort' && req.method === 'POST') {
      try {
        const input = await readJson(req)
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || !('runId' in input) || typeof input.runId !== 'string' || !input.runId.trim() || input.runId.length > 128) {
          throw new InputError(400, '请仅提交有效的运行编号')
        }
        if (!this.agent.abort) throw new InputError(503, '当前中止服务不可用')
        const handled = await this.agent.abort(input.runId)
        this.json(res, 200, { runId: input.runId, handled })
      } catch (error) {
        this.json(res, error instanceof InputError ? error.status : 500,
          { error: error instanceof InputError ? error.message : '中止暂时不可用，请重新同步对话后重试' })
      }
      return
    }
    if (url.pathname === '/api/messages' && req.method === 'POST') {
      try {
        const input = await messageInput(req)
        if (!this.agent.submit) throw new InputError(503, '当前生成服务不可用')
        const { workspaceId, ...message } = input
        const cwd = await this.workspaces.resolveBoundDirectory(workspaceId)
        const accepted = await this.agent.submit({ ...message, cwd })
        this.respond(res, 202, JSON.stringify(accepted), { 'content-type': 'application/json; charset=utf-8' })
      } catch (error) {
        if (error instanceof WorkspaceBindingError) {
          this.notify('workspaces_changed')
          this.json(res, 409, { error: error.message })
          return
        }
        const status = error instanceof InputError || error instanceof AgentSubmitError ? error.status : 500
        const message = error instanceof InputError || error instanceof AgentSubmitError ? error.message : '提交暂时不可用'
        this.respond(res, status, JSON.stringify({ error: message }), { 'content-type': 'application/json; charset=utf-8' })
      }
      return
    }
    if (url.pathname === '/api/providers/deepseek' && (req.method === 'PUT' || req.method === 'DELETE')) {
      try {
        if (req.method === 'PUT') {
          await this.credentials.saveApiKey('deepseek', await this.readKey(req))
        } else await this.credentials.deleteApiKey('deepseek')
        const discovery = await discoverModels(this.credentials)
        this.respond(res, 200, JSON.stringify(discovery), { 'content-type': 'application/json; charset=utf-8' })
        this.notify('models_changed')
      } catch (error) {
        const status = error instanceof InputError ? error.status : 500
        const message = error instanceof Error ? error.message : '本地凭据更新失败'
        this.respond(res, status, JSON.stringify({ error: message }), { 'content-type': 'application/json; charset=utf-8' })
      }
      return
    }
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
  private json(res: ServerResponse, status: number, payload: unknown) {
    this.respond(res, status, JSON.stringify(payload), { 'content-type': 'application/json; charset=utf-8' })
  }

  private async readKey(req: IncomingMessage): Promise<string> {
    const key = await providerKey(req)
    if (!key.trim()) throw new InputError(400, 'API Key 须非空且可用于认证头')
    try { validateHeaderValue('Authorization', `Bearer ${key}`) }
    catch { throw new InputError(400, 'API Key 须非空且可用于认证头') }
    return key
  }

  private async pick(req: IncomingMessage, res: ServerResponse) {
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) {
      req.resume()
      this.json(res, 400, { error: '请选择文件夹，无需提交路径或其他数据。' })
      return
    }
    if (this.selection || this.closing) {
      this.json(res, 409, { error: '文件夹选择当前不可用，请稍后重试。' })
      return
    }
    const controller = this.selection = new AbortController()
    const disconnect = () => controller.abort()
    res.once('close', disconnect)
    try {
      const path = await (this.options.directoryPicker ?? pickDirectory)(controller.signal)
      if (controller.signal.aborted) return
      if (path === null) this.json(res, 200, { cancelled: true })
      else {
        const view = await this.workspaces.register(path)
        if (!res.destroyed) this.json(res, 200, { cancelled: false, view })
        this.notify('workspaces_changed')
      }
    } catch (error) {
      if (!controller.signal.aborted) this.json(res, error instanceof WorkspaceBindingError ? 400 : 500,
        { error: error instanceof WorkspaceBindingError ? error.message : '无法选择或保存工作区，请检查本机选择框及工作区配置。' })
    } finally {
      res.off('close', disconnect)
      this.selection = undefined
    }
  }

  private async handleWebSettings(req: IncomingMessage, res: ServerResponse, providerId?: string) {
    try {
      if (providerId) {
        if (!this.webSettings.hasProvider(providerId)) throw new InputError(404, '没有此网页服务商。')
        if (req.method === 'PUT') await this.credentials.saveApiKey(providerId, await this.readKey(req))
        else await this.credentials.deleteApiKey(providerId)
      } else if (req.method === 'PUT') {
        const selection = await readJson(req)
        if (!this.webSettings.validSelection(selection)) throw new InputError(400, '请选择支持对应能力的网页服务商。')
        await this.webSettings.save(selection)
      }
      if (req.method !== 'GET') this.notify('web_settings_changed')
      this.json(res, 200, await this.webSettings.view())
    } catch (error) {
      this.json(res, error instanceof InputError ? error.status : 500, {
        error: error instanceof InputError ? error.message : '无法读取或更新网页工具设置，请检查本机配置文件及权限。',
      })
    }
  }

  private readonly missedPongs = new Map<WebSocket, number>()
  private readonly sends = new Map<WebSocket, Promise<void>>()
  private readonly notifications = new Map<WebSocket, Set<'models_changed' | 'workspaces_changed' | 'web_settings_changed'>>()
  private send(client: WebSocket, frame: ServerFrame): Promise<void> {
    const pending = (this.sends.get(client) ?? Promise.resolve()).then(() => new Promise<void>((done, reject) => {
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > maxBufferedBytes) { reject(new Error('Connection unavailable')); return }
      if (frame.type === 'models_changed' || frame.type === 'workspaces_changed' || frame.type === 'web_settings_changed') {
        const notifications = this.notifications.get(client)
        notifications?.delete(frame.type)
        if (!notifications?.size) this.notifications.delete(client)
      }
      client.send(JSON.stringify(frame), error => error ? reject(error) : done())
    }))
    this.sends.set(client, pending)
    return pending
  }
  private notify(type: 'models_changed' | 'workspaces_changed' | 'web_settings_changed') {
    for (const client of this.ws?.clients ?? []) {
      const pending = this.notifications.get(client) ?? new Set()
      if (pending.has(type)) continue
      pending.add(type)
      this.notifications.set(client, pending)
      // Notifications only request a refresh; coalesce each kind while a frame is pending.
      void this.send(client, { type }).catch(() => { this.disposers.get(client)?.(); client.terminate() })
    }
  }
  private connect(client: WebSocket) {
    let current: { id: string; controller: AbortController } | undefined
    const cancel = () => { current?.controller.abort(); current = undefined }
    const cleanup = () => { cancel(); this.disposers.delete(client); this.missedPongs.delete(client); this.sends.delete(client); this.notifications.delete(client) }
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
          await this.sends.get(client)
          if (current !== subscription || subscription.controller.signal.aborted) return
          for await (const event of this.agent.subscribe(subscription.controller.signal)) {
            if (current !== subscription || subscription.controller.signal.aborted) break
            const outgoing: ServerFrame = { ...event, subscriptionId: subscription.id }
            try { await this.send(client, outgoing) }
            catch { cleanup(); client.terminate(); break }
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
      this.selection?.abort()
      this.stopWatching?.()
      this.stopWatching = undefined
      for (const cleanup of this.disposers.values()) cleanup()
      for (const client of this.ws?.clients ?? []) client.terminate()
      this.missedPongs.clear()
      const server = this.server
      const ws = this.ws
      this.server = undefined
      this.ws = undefined
      await this.agent.close?.()
      await this.toolRuntime.close()
      if (ws) await new Promise<void>(done => ws.close(() => done()))
      if (server?.listening) await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections() })
    })()
    return this.closing
  }
}
