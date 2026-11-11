import { createServer, validateHeaderValue, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import {
  AgentSession, SessionSubmitError, Sessions, SessionStore, SessionReadError, SessionWriteError, ToolRuntime, createTools, createWebTools,
  type SessionPersistence, type SessionSubscriptionEvent, type WebProvider,
} from '@agent-learning/coding-agent'
import { Credentials, loadOrCreateBrowserSecret } from '@agent-learning/credentials'
import { createModelStream, discoverModels } from '@agent-learning/model'
import { pickDirectory, type DirectoryPicker } from '../directory-picker.js'
import { Workspaces, WorkspaceBindingError } from '../workspaces.js'
import { WebSettings } from '../web-settings.js'
import { createTavilyProvider } from '../web-providers.js'
import { BrowserAuth, trustedRequest } from './browser-auth.js'
import type { ClientFrame, ServerFrame, StartSessionAccepted, StartSessionRequest } from './protocol.js'

type SessionTarget = {
  subscribe(signal: AbortSignal): AsyncIterable<SessionSubscriptionEvent>
} & Partial<Pick<AgentSession, 'submit' | 'abort' | 'close'>>

type Notification = Exclude<ServerFrame, { subscriptionId: string }>['type']

const siRoot = fileURLToPath(new URL('../../../../', import.meta.url))

export type WebServerOptions = {
  port?: number
  webRoot?: string
  browserSecretPath?: string
  modelAuthPath?: string
  devOrigin?: `http://127.0.0.1:${number}`
  workspacePath?: string
  sessionPath?: string
  webSettingsPath?: string
  globalContextDirectory?: string
  directoryPicker?: DirectoryPicker
  webProviders?: WebProvider[]
  createSession?: (resolveDirectory: () => Promise<string>, persistence?: SessionPersistence) => SessionTarget
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
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && !!value.trim()
}
async function messageInput(req: IncomingMessage, target: 'sessionId' | 'workspaceId') {
  const value = await readJson(req)
  const targetLabel = target === 'sessionId' ? '会话' : '工作区'
  const targetId = value && typeof value === 'object' ? (value as Record<string, unknown>)[target] : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
    || !validId(targetId)
    || !('text' in value) || typeof value.text !== 'string' || !value.text.trim()
    || !('modelId' in value) || typeof value.modelId !== 'string'
    || !('clientMessageId' in value) || !validId(value.clientMessageId)) {
    throw new InputError(400, `请提交原文、模型、有效临时编号和${targetLabel}编号`)
  }
  return { targetId, message: { clientMessageId: value.clientMessageId, modelId: value.modelId, text: value.text } }
}
function validFrame(value: unknown): value is ClientFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<ClientFrame>
  return validId(frame.subscriptionId) && (frame.type === 'unsubscribe' || (frame.type === 'subscribe' && validId(frame.sessionId)))
}

export class WebServer {
  private sessions!: Sessions<SessionTarget>
  private store?: SessionStore
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
  private selection?: AbortController
  private stopWatching?: () => void

  constructor(private readonly options: WebServerOptions = {}) {
    this.credentials = new Credentials(options.modelAuthPath)
    this.workspaces = new Workspaces(options.workspacePath)
    this.webSettings = new WebSettings(options.webProviders ?? [createTavilyProvider(this.credentials)], this.credentials, options.webSettingsPath)
  }
  private createSessions() {
    const runtime = new ToolRuntime()
    const webTools = createWebTools(this.webSettings, runtime)
    const stream = createModelStream(this.credentials, this.options.modelOptions)
    return new Sessions<SessionTarget>({
      resolveDirectory: id => this.workspaces.resolveDirectory(id),
      store: this.store,
      createSession: this.options.createSession ?? ((resolveDirectory, persistence) => new AgentSession({
        resolveDirectory, persistence, stream, tools: cwd => createTools(runtime, webTools, cwd), compaction: this.options.compaction,
        globalContextDirectory: this.options.globalContextDirectory ?? join(homedir(), '.agent-learning'),
        documentationRoot: existsSync(resolve(siRoot, 'README.md')) && existsSync(resolve(siRoot, 'web/README.md')) ? siRoot : undefined,
      })),
      closeTools: () => runtime.close(),
      onStarted: () => this.notify('sessions_changed'),
    })
  }
  async start(): Promise<{ url: string; authUrl: string; devAuthUrl?: string }> {
    if (this.server) throw new Error('服务已经启动')
    if (this.closing) await this.closing
    const secret = await loadOrCreateBrowserSecret(this.options.browserSecretPath)
    if (this.server) throw new Error('服务已经启动')
    this.auth = new BrowserAuth(secret, this.options.now)
    this.closing = undefined
    if (!this.options.createSession || this.options.sessionPath) {
      this.store = SessionStore.open(this.options.sessionPath ?? join(homedir(), '.agent-learning', 'sessions.sqlite'))
    }
    try { this.sessions = this.createSessions() }
    catch (error) { this.store?.close(); this.store = undefined; throw error }
    const server = this.server = createServer((req, res) => { void this.handleHttp(req, res).catch(() => {
      if (!res.headersSent) this.respond(res, 500, '服务暂时不可用')
      else res.destroy()
    }) })
    const ws = this.ws = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
    server.on('upgrade', (req, socket, head) => {
      if (this.closing) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
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
    if (this.closing) { this.json(res, 503, { error: '服务正在关闭' }); return }
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
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      try { this.json(res, 200, { sessions: this.sessions.list() }) }
      catch (error) { this.sessionError(res, error, '无法读取会话列表，请重试') }
      return
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      try {
        const input = await readJson(req)
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || !('workspaceId' in input) || !validId(input.workspaceId)) throw new InputError(400, '请仅提交有效的工作区编号')
        const session = await this.sessions.create(input.workspaceId)
        this.json(res, 201, session)
        this.notify('sessions_changed')
      } catch (error) {
        this.sessionError(res, error, '暂时无法新建会话')
      }
      return
    }
    if (url.pathname === '/api/sessions/start' && req.method === 'POST') {
      try {
        const { targetId: workspaceId, message } = await messageInput(req, 'workspaceId')
        const input: StartSessionRequest = { workspaceId, ...message }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.clientMessageId)) {
          throw new InputError(400, '首次发送需要有效的 UUID 临时编号')
        }
        const { session, accepted } = await this.sessions.start(input, target => this.submit(target, message))
        const response: StartSessionAccepted = { session, accepted: { ...accepted, sessionId: session.id } }
        this.json(res, 202, response)
      } catch (error) {
        this.sessionError(res, error, '暂时无法发送首条消息')
      }
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
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
          || !('sessionId' in input) || !validId(input.sessionId) || !('runId' in input) || !validId(input.runId)) {
          throw new InputError(400, '请提交有效的会话编号和运行编号')
        }
        const session = this.target(input.sessionId)
        if (!session.abort) throw new InputError(503, '当前中止服务不可用')
        const handled = await session.abort(input.runId)
        this.json(res, 200, { sessionId: input.sessionId, runId: input.runId, handled })
      } catch (error) {
        this.json(res, error instanceof InputError ? error.status : 500,
          { error: error instanceof InputError ? error.message : '中止暂时不可用，请重新同步对话后重试' })
      }
      return
    }
    if (url.pathname === '/api/messages' && req.method === 'POST') {
      try {
        const { targetId: sessionId, message } = await messageInput(req, 'sessionId')
        const accepted = await this.submit(this.target(sessionId), message)
        this.json(res, 202, { ...accepted, sessionId })
      } catch (error) {
        this.sessionError(res, error, '提交暂时不可用')
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
  private target(id: string): SessionTarget {
    if (this.closing) throw new InputError(503, '服务正在关闭')
    const session = this.sessions.get(id)
    if (!session) throw new InputError(404, '会话已不可用')
    return session
  }
  private submit(session: SessionTarget, message: Parameters<AgentSession['submit']>[0]) {
    if (!session.submit) throw new InputError(503, '当前生成服务不可用')
    return session.submit(message)
  }
  private sessionError(res: ServerResponse, error: unknown, fallback: string) {
    if (error instanceof WorkspaceBindingError) {
      this.notify('workspaces_changed')
      this.json(res, 409, { error: error.message })
    } else if (error instanceof SessionSubmitError) {
      this.json(res, { invalid: 400, busy: 409, closed: 503 }[error.code], { error: error.message })
    } else if (error instanceof SessionWriteError) {
      this.json(res, error.reason === 'unconfirmed' ? 500 : 507, {
        error: error.message, code: error.reason === 'unconfirmed' ? 'save_unconfirmed' : 'save_rejected',
      })
    } else if (error instanceof SessionReadError) {
      this.json(res, 500, { error: error.message })
    } else if (error instanceof InputError) {
      this.json(res, error.status, { error: error.message })
    } else this.json(res, 500, { error: fallback })
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
        const picked = await this.workspaces.register(path)
        if (!res.destroyed) this.json(res, 200, { cancelled: false, ...picked })
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
  private readonly notifications = new Map<WebSocket, Set<Notification>>()
  private send(client: WebSocket, frame: ServerFrame, signal?: AbortSignal): Promise<void> {
    const pending = (this.sends.get(client) ?? Promise.resolve()).then(() => new Promise<void>((done, reject) => {
      if (signal?.aborted) { done(); return }
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > maxBufferedBytes) { reject(new Error('Connection unavailable')); return }
      if (!('subscriptionId' in frame)) {
        const notifications = this.notifications.get(client)
        notifications?.delete(frame.type)
        if (!notifications?.size) this.notifications.delete(client)
      }
      client.send(JSON.stringify(frame), error => error ? reject(error) : done())
    }))
    this.sends.set(client, pending)
    return pending
  }
  private notify(type: Notification) {
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
      if (client.readyState !== WebSocket.OPEN) return
      let frame: unknown
      try { frame = binary ? undefined : JSON.parse(data.toString()) } catch { frame = undefined }
      if (!validFrame(frame)) { cleanup(); client.close(1008, 'Invalid subscription frame'); return }
      if (frame.type === 'unsubscribe') {
        if (current?.id === frame.subscriptionId) cancel()
        return
      }
      cancel()
      const subscription = current = { id: frame.subscriptionId, controller: new AbortController() }
      const { sessionId } = frame
      const signal = subscription.controller.signal
      const send = async (event: SessionSubscriptionEvent | { type: 'subscription_error'; error: string }) => {
        try { await this.send(client, { ...event, sessionId, subscriptionId: subscription.id }, signal) }
        catch { cleanup(); client.terminate() }
      }
      void (async () => {
        try {
          await this.sends.get(client)
          if (signal.aborted) return
          const session = this.sessions.get(sessionId)
          if (!session) { await send({ type: 'subscription_error', error: '会话已不可用' }); return }
          for await (const event of session.subscribe(signal)) {
            if (signal.aborted) break
            await send(event)
          }
        } catch (error) {
          if (!signal.aborted && error instanceof SessionReadError) await send({ type: 'subscription_error', error: error.message })
          else if (!signal.aborted) { cleanup(); client.close(1011, 'Subscription unavailable') }
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
      try { await this.sessions?.close() }
      finally {
        this.store?.close()
        this.store = undefined
        if (ws) await new Promise<void>(done => ws.close(() => done()))
        if (server?.listening) await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections() })
      }
    })()
    return this.closing
  }
}
