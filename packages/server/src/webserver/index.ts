import { createServer, validateHeaderValue, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import {
  AgentSession, SessionSubmitError, Sessions, SessionStore, SessionReadError, SessionWriteError, ToolRuntime, createTools, createWebTools, discoverSkills, isPermissionMode, loadExtensions,
  AttachmentInputError, SessionAttachments, ATTACHMENT_TTL_MS, MAX_ATTACHMENT_UPLOAD_BYTES,
  McpManager, McpSettingsError, MemoryStore, MemoryStoreError,
  type AttachmentScope, type ScheduledRun, type ScheduledSubmission, type ConversationMessage, type ExtensionEntry, type PermissionMode, type SessionPersistence, type SessionSubscriptionEvent, type WebProvider,
} from '@agent-learning/coding-agent'
import { Credentials, loadOrCreateBrowserSecret } from '@agent-learning/credentials'
import { createModelStream, defaultSelection, discoverModels, isModelProvider, type AssistantMessage, type ModelSelection, type ToolCall } from '@agent-learning/model'
import { pickDirectory, type DirectoryPicker } from '../directory-picker.js'
import { Workspaces, WorkspaceBindingError } from '../workspaces.js'
import { WebSettings } from '../web-settings.js'
import { Schedules, ScheduleError } from '../schedules.js'
import { ScheduleRunner } from '../schedule-runner.js'
import { isSettingsObject, readSettingsFile, updateSettingsFile } from '../settings-file.js'
import { createTavilyProvider } from '../web-providers.js'
import { BrowserAuth, trustedRequest } from './browser-auth.js'
import { finishMcpOAuth, handleMcpSettings, isMcpOAuthCallback, isMcpSettingsPath, mcpClientMetadataDocuments } from './mcp.js'
import { MemorySettings } from './memory.js'
import type { DeleteMemoryEntryView, MemorySettingsView, ProjectMemoriesView, UserMemoryView } from './protocol.js'
import type { BashJobsView, StopBashJobResult, ClientFrame, ConversationMessage as BrowserMessage, LanguageSettings, PermissionSettings, SessionPermission, ServerFrame, StartSessionResult, StartSessionRequest, WorkspaceSkills } from './protocol.js'

type SessionTarget = {
  subscribe(signal: AbortSignal): AsyncIterable<SessionSubscriptionEvent>
} & Partial<Pick<AgentSession, 'submit' | 'abort' | 'close' | 'initialize' | 'selectModel' | 'selectPermissionMode' | 'reviewPlan' | 'getScheduledSettings' | 'submitScheduled'>>

type Notification = Exclude<ServerFrame, { subscriptionId: string }>['type']

function visibleToolCall({ thoughtSignature: _signature, namespace: _namespace, ...call }: ToolCall): ToolCall {
  return call
}

function visibleAssistant({ providerThinkingLevel: _effort, ...message }: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.map(block => {
    if (block.type === 'toolCall') return visibleToolCall(block)
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.redacted ? '' : block.thinking }
    return { type: 'text', text: block.text }
  }) }
}

function browserMessage({ message, skillInvocation, references, ...stored }: ConversationMessage): BrowserMessage {
  const entry = { ...stored, ...(references && { references: references.map(({ sourceSessionId, label }) => ({ sourceSessionId, label })) }) }
  if (skillInvocation) {
    const { name, source, status } = skillInvocation
    return { ...entry, message, skillInvocation: status === 'loaded'
      ? { name, source, status } : { name, source, status, reason: skillInvocation.reason } }
  }
  if (message.role === 'assistant') return { ...entry, message: visibleAssistant(message) }
  if (message.role !== 'toolResult' || !message.content.some(block => block.type === 'image')) return { ...entry, message }
  return { ...entry, message: { ...message, content: message.content.filter(block => block.type === 'text') } }
}

type BrowserEvent = Omit<Extract<ServerFrame, { type: 'snapshot' }>, 'sessionId' | 'subscriptionId'>
  | Omit<Extract<ServerFrame, { type: 'update' }>, 'sessionId' | 'subscriptionId'>

function browserEvent(event: SessionSubscriptionEvent): BrowserEvent {
  if (event.type === 'snapshot') {
    return { ...event, snapshot: { ...event.snapshot, messages: event.snapshot.messages.map(browserMessage) } }
  }
  const { change } = event.update
  if (change.type === 'accepted') {
    return { ...event, update: { ...event.update, change: { ...change, user: browserMessage(change.user) } } }
  }
  if (change.type === 'task') {
    return { ...event, update: { ...event.update, change: change.message
      ? { ...change, message: browserMessage(change.message) } : change } }
  }
  if (change.type !== 'model') return { ...event, update: { ...event.update, change } }
  const frame = change.event
  const visible = frame.type === 'done' || frame.type === 'replace' ? { ...frame, message: visibleAssistant(frame.message) }
    : frame.type === 'error' ? { ...frame, error: visibleAssistant(frame.error) }
    : frame.type === 'toolcall_end' ? { ...frame, toolCall: visibleToolCall(frame.toolCall) } : frame
  return { ...event, update: { ...event.update, change: { ...change, event: visible } } }
}

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
  memoryDirectory?: string
  globalContextDirectory?: string
  mcpConfigDirectory?: string
  mcpClientMetadataBaseUrl?: string
  skillHome?: string
  extensionsDirectory?: string
  directoryPicker?: DirectoryPicker
  webProviders?: WebProvider[]
  createSession?: (resolveDirectory: () => Promise<string>, persistence?: SessionPersistence, permissionMode?: PermissionMode) => SessionTarget
  modelOptions?: Parameters<typeof createModelStream>[1]
  compaction?: { triggerTokens: number; keepRecentTokens: number }
  now?: () => number
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' }
const maxBufferedBytes = 1024 * 1024
const memoryErrorStatus: Partial<Record<string, number>> = {
  version_conflict: 409, capacity_exceeded: 422, invalid_request: 400,
}
class InputError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    req.resume()
    throw new InputError(415, '请使用 JSON 提交请求')
  }
  const bytes = await readBody(req, 64 * 1024, '请求过大')
  try { return JSON.parse(bytes.toString('utf8')) }
  catch { throw new InputError(400, '请求必须是有效 JSON') }
}
async function readBody(req: IncomingMessage, limit: number, message: string): Promise<Buffer> {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new InputError(413, message) }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) { req.resume(); throw new InputError(413, message) }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
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
function checkedPathId(segment: string): string {
  let id: string
  try { id = decodeURIComponent(segment) }
  catch { throw new InputError(400, '编号无效') }
  if (!validId(id)) throw new InputError(400, '编号无效')
  return id
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function sourceIds(value: unknown, validate: (id: string) => boolean): string[] {
  if (!Array.isArray(value) || !value.every(id => validId(id) && validate(id))) {
    throw new InputError(400, '附件或会话引用编号无效')
  }
  return [...new Set(value as string[])]
}
async function messageInput(req: IncomingMessage, target: 'sessionId' | 'workspaceId') {
  const value = await readJson(req)
  const targetLabel = target === 'sessionId' ? '会话' : '工作区'
  const targetId = value && typeof value === 'object' ? (value as Record<string, unknown>)[target] : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => ![target, 'text', 'modelId', 'provider', 'reasoningEffort', 'clientMessageId', 'attachmentIds', 'referenceSessionIds'].includes(key)
    && !(target === 'workspaceId' && ['permissionMode', 'draftSessionId'].includes(key)))
    || !validId(targetId)
    || !('text' in value) || typeof value.text !== 'string'
    || !('modelId' in value) || !validId(value.modelId)
    || ('provider' in value && !validId(value.provider))
    || ('reasoningEffort' in value && (!('provider' in value) || !validId(value.reasoningEffort)))
    || !('clientMessageId' in value) || !validId(value.clientMessageId)) {
    throw new InputError(400, `请提交原文、模型、有效临时编号和${targetLabel}编号`)
  }
  const permissionMode = 'permissionMode' in value ? value.permissionMode : undefined
  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) throw new InputError(400, '权限模式无效')
  const draftSessionId = 'draftSessionId' in value ? value.draftSessionId : undefined
  if (draftSessionId !== undefined && (typeof draftSessionId !== 'string' || !uuid.test(draftSessionId))) throw new InputError(400, '草稿会话编号无效')
  const attachmentIds = 'attachmentIds' in value ? sourceIds(value.attachmentIds, id => uuid.test(id)) : []
  const referenceSessionIds = 'referenceSessionIds' in value ? sourceIds(value.referenceSessionIds, () => true) : []
  if (!value.text.trim() && !attachmentIds.length) throw new InputError(400, '请填写原文或添加附件')
  return { targetId, permissionMode, draftSessionId, message: { clientMessageId: value.clientMessageId, modelId: value.modelId, text: value.text,
    ...(attachmentIds.length && { attachmentIds }), ...(referenceSessionIds.length && { referenceSessionIds }),
    ...('provider' in value && { provider: value.provider as string }),
    ...('reasoningEffort' in value && { reasoningEffort: value.reasoningEffort as ModelSelection['reasoningEffort'] }), } }
}
function validFrame(value: unknown): value is ClientFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<ClientFrame>
  return validId(frame.subscriptionId) && (frame.type === 'unsubscribe' || (frame.type === 'subscribe' && validId(frame.sessionId)))
}

export class WebServer {
  private sessions!: Sessions<SessionTarget>
  private runtime!: ToolRuntime
  private store?: SessionStore
  private schedules?: Schedules
  private scheduleRunner?: ScheduleRunner
  private server?: Server
  private ws?: WebSocketServer
  private heartbeat?: ReturnType<typeof setInterval>
  private origins = new Set<string>()
  private listenOrigin?: string
  private auth?: BrowserAuth
  private readonly disposers = new Map<WebSocket, () => void>()
  private closing?: Promise<void>
  private readonly credentials: Credentials
  private readonly workspaces: Workspaces
  private readonly sessionPath: string
  private readonly attachments: SessionAttachments
  private attachmentCleanup?: ReturnType<typeof setInterval>
  private readonly memorySettings: MemorySettings
  private readonly memoryStore: MemoryStore
  private readonly webSettings: WebSettings
  private selection?: AbortController
  private stopWatching?: () => void
  private mcp?: McpManager
  private stopWatchingMcp?: () => void

  constructor(private readonly options: WebServerOptions = {}) {
    this.credentials = new Credentials(options.modelAuthPath)
    const appData = options.globalContextDirectory ?? (options.webSettingsPath ? dirname(options.webSettingsPath) : join(homedir(), '.agent-learning'))
    this.memoryStore = new MemoryStore(options.memoryDirectory ?? join(appData, 'memory'), options.now)
    this.memorySettings = new MemorySettings(options.webSettingsPath)
    this.workspaces = new Workspaces(options.workspacePath)
    this.sessionPath = options.sessionPath ?? join(homedir(), '.agent-learning', 'sessions.sqlite')
    this.attachments = new SessionAttachments(resolve(this.sessionPath + '.files', 'attachments'))
    this.webSettings = new WebSettings(options.webProviders ?? [createTavilyProvider(this.credentials)], this.credentials, options.webSettingsPath)
  }
  private createSessions(extensions: readonly ExtensionEntry[]) {
    const runtime = this.runtime = new ToolRuntime()
    const webTools = createWebTools(this.webSettings, runtime)
    const stream = createModelStream(this.credentials, this.options.modelOptions)
    return new Sessions<SessionTarget>({
      resolveDirectory: id => this.workspaces.resolveDirectory(id),
      store: this.store,
      getDefaultPermissionMode: () => this.readDefaultPermissionMode(),
      createSession: this.options.createSession ?? ((resolveDirectory, persistence, permissionMode, sessionId) => new AgentSession({
        resolveDirectory, persistence, permissionMode, sessionId, extensions, stream, discoverModels: () => this.modelDiscovery(), tools: cwd => createTools(runtime, webTools, cwd, persistence?.summary.id ?? sessionId), compaction: this.options.compaction,
        mcp: this.mcp,
        memory: {
          store: this.memoryStore,
          settings: () => this.memorySettings.read(true),
        },
        ...(this.schedules && { manageSchedule: (owner, input) => {
          if (!this.schedules) throw new InputError(503, '定时任务服务暂时不可用')
          return this.schedules.manageFromChat(owner, input)
        } }),
        onScheduledRunFinished: id => this.scheduleRunner?.finished(id),
        titleStream: stream, onTitleChanged: () => this.notify('sessions_changed'), attachments: this.attachments,
        referenceDirectory: resolve(this.sessionPath + '.files', 'references'),
        isWorkspaceRegistered: id => this.workspaces.isRegistered(id),
        resolveWorkspaceDirectory: id => this.workspaces.resolveDirectory(id),
        globalContextDirectory: this.options.globalContextDirectory ?? join(homedir(), '.agent-learning'),
        skillHome: this.options.skillHome,
        documentationRoot: existsSync(resolve(siRoot, 'README.md')) && existsSync(resolve(siRoot, 'web/README.md')) ? siRoot : undefined,
      })),
      closeTools: () => runtime.close(),
      onStarted: () => this.notify('sessions_changed'),
    })
  }
  async start(): Promise<{ url: string; authUrl: string; devAuthUrl?: string }> {
    if (this.closing) await this.closing
    if (this.server) throw new Error('服务已经启动')
    const secret = await loadOrCreateBrowserSecret(this.options.browserSecretPath)
    const extensions = this.options.createSession ? [] : await loadExtensions(this.options.extensionsDirectory
      ?? join(this.options.globalContextDirectory ?? join(homedir(), '.agent-learning'), 'extensions'),
    (path, error) => console.error('个人扩展加载失败', path, error))
    if (this.server) throw new Error('服务已经启动')
    this.auth = new BrowserAuth(secret, this.options.now)
    this.closing = undefined
    if (!this.options.createSession || this.options.sessionPath) {
      this.store = SessionStore.open(this.sessionPath)
      this.schedules = new Schedules(this.store, this.options.now ?? Date.now, () => this.notify('sessions_changed'))
    }
    try { this.sessions = this.createSessions(extensions) }
    catch (error) { this.store?.close(); this.store = undefined; throw error }
    if (this.store) {
      void this.pruneAttachments(this.store).catch(() => undefined)
      this.attachmentCleanup = setInterval(() => {
        if (this.store) void this.pruneAttachments(this.store).catch(() => undefined)
      }, 60 * 60 * 1000)
      this.attachmentCleanup.unref()
    }
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
      const { mcpConfigDirectory, modelAuthPath } = this.options
      const configDirectory = mcpConfigDirectory ?? (modelAuthPath ? dirname(resolve(modelAuthPath)) : join(homedir(), '.agent-learning'))
      const mcp = this.mcp = new McpManager(configDirectory, mcpClientMetadataDocuments(this.options.mcpClientMetadataBaseUrl))
      const stopChanges = mcp.subscribe(() => this.notify('mcp_settings_changed'))
      const stopCatalog = mcp.subscribeToolCatalog(catalog => this.store?.reconcileMcpToolLoads(catalog))
      this.stopWatchingMcp = () => { stopCatalog(); stopChanges() }
      await mcp.start()
      if (this.server !== server) throw new Error('服务启动已取消')
      this.listenOrigin = url
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
      if (this.store) {
        this.scheduleRunner = new ScheduleRunner({
          store: this.store.schedules, now: this.options.now ?? Date.now,
          prepare: run => this.prepareScheduled(run), submit: (run, signal) => this.submitScheduled(run, signal),
          changed: () => this.notify('sessions_changed'),
          report: error => console.error('定时任务扫描失败', error),
        })
        await this.scheduleRunner.start()
      }
      if (this.server !== server) throw new Error('服务启动已取消')
      return { url, authUrl: this.auth.authenticatedUrl(url), ...(this.options.devOrigin ? { devAuthUrl: this.auth.authenticatedUrl(this.options.devOrigin + '/auth') } : {}) }
    } catch (error) {
      if (this.server === server) await this.close()
      throw new Error('服务启动失败：请检查端口是否被占用', { cause: error })
    }
  }
  scanScheduledTasks(): Promise<void> {
    return this.scheduleRunner?.scan() ?? Promise.resolve()
  }

  private async prepareScheduled(run: ScheduledRun): Promise<ScheduledSubmission> {
    const submission = run.submission
    if (!submission) throw new Error('定时任务缺少提交内容')
    if (submission.modelSelection && submission.permissionMode) return submission

    const reuse = submission.sessionId !== run.id
    const target = reuse ? this.sessions.get(submission.sessionId) : undefined
    if (reuse && !target?.getScheduledSettings) throw new InputError(404, '原会话已不可用')
    const settings = target?.getScheduledSettings?.()
    const modelSelection = settings?.modelSelection ?? (await this.modelDiscovery()).defaultSelection
    if (!modelSelection) throw new InputError(400, '没有可用模型，请先配置模型')
    const permissionMode = settings?.permissionMode ?? await this.readDefaultPermissionMode()
    return { ...submission, modelSelection, permissionMode }
  }

  private async submitScheduled(run: ScheduledRun, signal: AbortSignal) {
    const submission = run.submission
    if (!submission?.modelSelection) throw new InputError(400, '定时任务缺少模型选择')
    const { workspaceId, sessionId, modelSelection, permissionMode, text } = submission
    const input = { ...modelSelection, text, clientMessageId: run.id }
    const submit = (target: SessionTarget, firstPermission?: PermissionMode) => {
      if (!target.submitScheduled) throw new InputError(503, '当前会话不支持定时执行')
      return target.submitScheduled({ ...input, ...(firstPermission && { permissionMode: firstPermission }) }, signal)
    }
    if (sessionId === run.id) {
      const result = await this.sessions.start({ ...input, workspaceId, permissionMode }, target => submit(target, permissionMode), true)
      if (!('session' in result)) throw new InputError(409, '会话未接收定时任务')
      return
    }
    const target = this.sessions.get(sessionId)
    if (!target) throw new InputError(404, '原会话已不可用')
    const result = await submit(target)
    if (result.kind === 'handled') throw new InputError(409, '会话未接收定时任务')
  }

  private admit(req: IncomingMessage): number {
    if (!trustedRequest(req.headers, this.origins)) return 403
    return this.auth!.authenticated(req.headers.host!, req.headers.cookie) ? 200 : 401
  }
  private respond(res: ServerResponse, status: number, text: string | Buffer, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-type': 'text/plain; charset=utf-8', ...headers })
    res.end(text)
  }
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? '/'
    if (req.method === 'GET' && isMcpOAuthCallback(target.split('?', 1)[0])) {
      if (!this.listenOrigin || this.listenOrigin !== `http://${req.headers.host}`) { this.respond(res, 403, '访问地址不可信'); return }
      const ok = !!this.mcp && !this.closing && await finishMcpOAuth(this.mcp, new URL(target, this.listenOrigin))
      this.respond(res, ok ? 200 : 400, ok ? 'MCP 授权成功。请返回设置查看连接状态。' : 'MCP 授权未完成。请返回设置重试。')
      return
    }
    if (!trustedRequest(req.headers, this.origins)) { this.respond(res, 403, '访问地址或来源不可信'); return }
    const url = new URL(target, 'http://local.invalid')
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
    if (this.mcp && this.listenOrigin && isMcpSettingsPath(url.pathname)) {
      try {
        const result = await handleMcpSettings(this.mcp, this.listenOrigin, url.pathname, req.method, () => readJson(req))
        if (result.status === 204) this.respond(res, 204, '')
        else this.json(res, result.status, result.body)
      } catch (error) {
        if (error instanceof McpSettingsError) this.json(res, error.statusCode, { error: error.message })
        else this.sessionError(res, error, '无法读取或更新 MCP 设置，请检查本机配置后重试。')
      }
      return
    }
    const scheduleRoute = /^\/api\/schedules\/([^/]+)(\/runs)?$/.exec(url.pathname)
    if ((url.pathname === '/api/schedules' && req.method === 'GET') ||
      (scheduleRoute && (scheduleRoute[2] ? req.method === 'GET' : req.method === 'PATCH' || req.method === 'DELETE'))) {
      try {
        const schedules = this.schedules
        if (!schedules) throw new InputError(503, '定时任务服务暂时不可用')
        if (!scheduleRoute) this.json(res, 200, { schedules: schedules.list() })
        else {
          const id = checkedPathId(scheduleRoute[1]!)
          if (scheduleRoute[2]) this.json(res, 200, { runs: schedules.runs(id) })
          else if (req.method === 'PATCH') this.json(res, 200, { schedule: schedules.edit(id, await readJson(req)) })
          else { schedules.remove(id); this.respond(res, 204, '') }
        }
      } catch (error) { this.sessionError(res, error, '定时任务请求失败，请重试') }
      return
    }
    if (url.pathname === '/api/models' && req.method === 'GET') {
      try { this.json(res, 200, await this.modelDiscovery()) }
      catch (error) { this.sessionError(res, error, '无法读取模型选择') }
      return
    }
    if (url.pathname === '/api/model-selection' && req.method === 'PUT') {
      try {
        const value = await readJson(req)
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some(key => !['provider', 'modelId', 'reasoningEffort', 'sessionId'].includes(key))
          || !('provider' in value) || !validId(value.provider) || !('modelId' in value) || !validId(value.modelId)
          || ('sessionId' in value && !validId(value.sessionId))) {
          throw new InputError(400, '请提交有效的模型选择')
        }
        const { models } = await discoverModels(this.credentials)
        const model = models.find(item => item.id === value.modelId && item.provider === value.provider)
        if (!model) throw new InputError(400, '当前模型不可用，请重新选择')
        const effort = 'reasoningEffort' in value ? value.reasoningEffort : undefined
        if (model.reasoningEfforts ? !model.reasoningEfforts.some(level => level === effort) : effort !== undefined) {
          throw new InputError(400, '所选模型不支持此推理强度')
        }
        const selection: ModelSelection = { provider: model.provider, modelId: model.id,
          ...(effort !== undefined && { reasoningEffort: effort as ModelSelection['reasoningEffort'] }) }
        const id = 'sessionId' in value ? value.sessionId as string : undefined
        if (!await this.sessions.selectModel(selection, id)) throw new InputError(404, '会话已不可用')
        this.json(res, 200, selection)
        this.notify('models_changed')
      } catch (error) { this.sessionError(res, error, '无法保存模型选择') }
      return
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      try { this.json(res, 200, await this.workspaces.view()) }
      catch { this.json(res, 500, { error: '无法读取工作区登记，请检查本机配置文件。' }) }
      return
    }
    const skillWorkspace = /^\/api\/workspaces\/([^/]+)\/skills$/.exec(url.pathname)?.[1]
    if (skillWorkspace && req.method === 'GET') {
      try {
        const id = decodeURIComponent(skillWorkspace)
        if (!validId(id)) throw new InputError(400, '工作区编号无效')
        const cwd = await this.workspaces.resolveDirectory(id)
        const { complete, skills } = await discoverSkills(cwd, { applicationRoot: siRoot, home: this.options.skillHome })
        this.json(res, 200, { complete, skills: skills.map(({ path: _path, ...skill }) => skill) } satisfies WorkspaceSkills)
      } catch (error) { this.sessionError(res, error, '无法查询 Skill 目录，请重试。') }
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
        if (!isSettingsObject(input) || Object.keys(input).some(key => key !== 'workspaceId' && key !== 'permissionMode')
          || !validId(input.workspaceId)) throw new InputError(400, '请提交有效的工作区编号')
        const permissionMode = input.permissionMode
        if (permissionMode !== undefined && !isPermissionMode(permissionMode)) throw new InputError(400, '权限模式无效')
        const session = await this.sessions.create(input.workspaceId, permissionMode)
        this.json(res, 201, session)
        this.notify('sessions_changed')
      } catch (error) {
        this.sessionError(res, error, '暂时无法新建会话')
      }
      return
    }
    if ((url.pathname === '/api/attachments' && req.method === 'POST')
      || (url.pathname.startsWith('/api/attachments/') && req.method === 'GET')) {
      await this.handleAttachment(req, res, url)
      return
    }
    if (url.pathname === '/api/sessions/start' && req.method === 'POST') {
      try {
        const { targetId: workspaceId, message, permissionMode, draftSessionId } = await messageInput(req, 'workspaceId')
        const input: StartSessionRequest = { workspaceId, ...message, ...(draftSessionId && { draftSessionId }), ...(permissionMode !== undefined && { permissionMode }) }
        if (!uuid.test(input.clientMessageId)) {
          throw new InputError(400, '首次发送需要有效的 UUID 临时编号')
        }
        const result = await this.sessions.start(input, target => this.submit(target, { ...message, ...(permissionMode !== undefined && { permissionMode }) }))
        const response: StartSessionResult = 'session' in result
          ? { session: result.session, accepted: { ...result.accepted, sessionId: result.session.id } } : result
        this.json(res, 202, response)
      } catch (error) {
        this.sessionError(res, error, '暂时无法发送首条消息')
      }
      return
    }
    const jobsRoute = /^\/api\/sessions\/([^/]+)\/jobs(?:\/([^/]+)\/stop)?$/.exec(url.pathname)
    if (jobsRoute && req.method === (jobsRoute[2] ? 'POST' : 'GET')) {
      try {
        const sessionId = checkedPathId(jobsRoute[1]!)
        const jobId = jobsRoute[2] && checkedPathId(jobsRoute[2])
        this.target(sessionId)
        if (jobId) {
          const job = await this.runtime.stopJob(sessionId, jobId)
          if (!job) throw new InputError(404, '后台任务记录不可用')
          this.json(res, 200, { sessionId, job } satisfies StopBashJobResult)
        } else this.json(res, 200, { sessionId, jobs: this.runtime.listRunningJobs(sessionId) } satisfies BashJobsView)
      } catch (error) { this.sessionError(res, error, '后台任务请求失败，请重试') }
      return
    }
    const permissionSession = /^\/api\/sessions\/([^/]+)\/permission$/.exec(url.pathname)?.[1]
    const reviewSession = /^\/api\/sessions\/([^/]+)\/plan\/review$/.exec(url.pathname)?.[1]
    if (reviewSession && req.method === 'POST') {
      try {
        const id = checkedPathId(reviewSession)
        const input = await readJson(req)
        if (!isSettingsObject(input) || Object.keys(input).length !== 2 || !validId(input.planId)
          || (input.action !== 'approve' && input.action !== 'discuss')) throw new InputError(400, '请提交有效的计划和评审动作')
        const target = this.target(id)
        if (!target.reviewPlan) throw new InputError(503, '当前会话不支持计划评审')
        const result = await target.reviewPlan(input.planId, input.action)
        if ('plan' in result) this.json(res, 200, result)
        else this.json(res, 202, { ...result, sessionId: id })
      } catch (error) { this.sessionError(res, error, '暂时无法提交计划评审') }
      return
    }
    if (permissionSession && req.method === 'PUT') {
      try {
        let id: string
        try { id = decodeURIComponent(permissionSession) }
        catch { throw new InputError(400, '会话编号无效') }
        if (!validId(id)) throw new InputError(400, '会话编号无效')
        const value = await readJson(req)
        if (!isSettingsObject(value) || Object.keys(value).length !== 1 || !isPermissionMode(value.permissionMode)) {
          throw new InputError(400, '权限模式无效')
        }
        const session = this.target(id)
        if (!session.selectPermissionMode) throw new InputError(503, '当前会话无法切换权限')
        session.selectPermissionMode(value.permissionMode)
        this.json(res, 200, { permissionMode: value.permissionMode } satisfies SessionPermission)
      } catch (error) { this.sessionError(res, error, '无法保存会话权限') }
      return
    }
    if (url.pathname === '/api/settings/permission' && (req.method === 'GET' || req.method === 'PUT')) {
      await this.handlePermissionSettings(req, res)
      return
    }
    if (url.pathname === '/api/settings/language' && (req.method === 'GET' || req.method === 'PUT')) {
      await this.handleLanguageSettings(req, res)
      return
    }
    const memoryEntry = /^\/api\/memory\/projects\/([^/]+)\/entries\/([^/]+)$/.exec(url.pathname)
    if (((url.pathname === '/api/settings/memory' || url.pathname === '/api/memory/user')
      && (req.method === 'GET' || req.method === 'PUT'))
      || (url.pathname === '/api/memory/projects' && req.method === 'GET')
      || (memoryEntry && req.method === 'DELETE')) {
      await this.handleMemory(req, res, url.pathname, memoryEntry)
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
    const provider = /^\/api\/providers\/([a-z][a-z0-9-]*)$/.exec(url.pathname)?.[1]
    if (provider && isModelProvider(provider) && (req.method === 'PUT' || req.method === 'DELETE')) {
      try {
        if (req.method === 'PUT') {
          await this.credentials.saveApiKey(provider, await this.readKey(req))
        } else await this.credentials.deleteApiKey(provider)
        this.json(res, 200, await this.modelDiscovery())
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
  private async modelDiscovery() {
    const discovery = await discoverModels(this.credentials)
    const first = discovery.models.find(model => model.provider === 'deepseek' && model.id === 'deepseek-flash') ?? discovery.models[0]
    const selection = this.store?.getDefaultSelection() ?? (first && defaultSelection(first))
    return { ...discovery, ...(selection && { defaultSelection: selection }) }
  }
  private target(id: string): SessionTarget {
    if (this.closing) throw new InputError(503, '服务正在关闭')
    const session = this.sessions.get(id)
    if (!session) throw new InputError(404, '会话已不可用')
    return session
  }
  private async handleAttachment(req: IncomingMessage, res: ServerResponse, url: URL) {
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    try {
      const store = this.store
      if (!store || this.closing) throw new InputError(503, '附件服务暂时不可用')
      if (req.method === 'GET') {
        const id = checkedPathId(url.pathname.slice('/api/attachments/'.length))
        const saved = uuid.test(id) ? store.sentAttachment(id) : undefined
        if (!saved || !await this.workspaces.isRegistered(saved.workspaceId)) throw new InputError(404, '附件已不可用')
        const bytes = await this.attachments.read(saved.id, controller.signal)
        this.respond(res, 200, bytes, {
          'content-type': saved.mediaType === 'text/plain' ? 'text/plain; charset=utf-8' : saved.mediaType,
          'content-security-policy': "default-src 'none'; sandbox",
        })
        return
      }
      const sessionId = url.searchParams.get('sessionId')
      const workspaceId = url.searchParams.get('workspaceId')
      const draftSessionId = url.searchParams.get('draftSessionId')
      let scope: AttachmentScope
      if (validId(sessionId) && workspaceId === null && draftSessionId === null) {
        const owner = this.sessions.list().find(session => session.id === sessionId)
        if (!owner) throw new InputError(404, '会话已不可用')
        await this.workspaces.resolveDirectory(owner.workspaceId)
        scope = { sessionId }
      } else if (sessionId === null && validId(workspaceId) && draftSessionId && uuid.test(draftSessionId)) {
        await this.workspaces.resolveDirectory(workspaceId)
        scope = { workspaceId, draftSessionId }
      } else throw new InputError(400, '请指定附件所属的会话或工作区草稿')
      const header = req.headers['x-attachment-name']
      let name = ''
      try { if (typeof header === 'string') name = decodeURIComponent(header) }
      catch { throw new InputError(400, '文件名无效') }
      if (!name.trim()) throw new InputError(400, '文件名无效')
      const bytes = await readBody(req, MAX_ATTACHMENT_UPLOAD_BYTES, '单个附件最多 50 MiB。')
      const staged = await this.attachments.upload(scope, name, bytes, controller.signal)
      try {
        controller.signal.throwIfAborted()
        if (this.closing || this.store !== store) throw new InputError(503, '附件服务暂时不可用')
        store.registerAttachment(staged)
      } catch (error) {
        await this.attachments.remove(staged.id).catch(() => undefined)
        throw error
      }
      const { scope: _scope, uploadedAt: _uploadedAt, ...attachment } = staged
      this.json(res, 201, attachment)
    } catch (error) {
      req.resume()
      if (!res.destroyed) this.sessionError(res, error, '无法处理附件，请重试')
    }
  }
  private async pruneAttachments(store: SessionStore) {
    const cutoff = Date.now() - ATTACHMENT_TTL_MS
    for (const id of store.expiredAttachments(cutoff)) {
      if (this.store !== store || this.closing) break
      try {
        await this.attachments.remove(id)
        if (this.store === store && !this.closing) store.forgetExpiredAttachment(id, cutoff)
      } catch { /* Retry expired files during the next cleanup. */ }
    }
    await this.attachments.removeUnregistered(cutoff, id => this.store !== store || !!this.closing || store.hasAttachment(id))
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
      this.json(res, { invalid: 400, busy: 409, closed: 503, model_selection_changed: 409 }[error.code], {
        error: error.message, ...(error.code === 'model_selection_changed' && { code: error.code }),
      })
    } else if (error instanceof SessionWriteError) {
      this.json(res, error.reason === 'unconfirmed' ? 500 : 507, {
        error: error.message, code: error.reason === 'unconfirmed' ? 'save_unconfirmed' : 'save_rejected',
      })
    } else if (error instanceof SessionReadError) {
      this.json(res, 500, { error: error.message })
    } else if (error instanceof InputError || error instanceof ScheduleError) {
      this.json(res, error.status, { error: error.message })
    } else if (error instanceof AttachmentInputError) {
      this.json(res, 400, { error: error.message })
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

  private async readDefaultPermissionMode(): Promise<PermissionMode> {
    const { defaultPermissionMode = 'normal' } = await readSettingsFile(this.options.webSettingsPath)
    if (!isPermissionMode(defaultPermissionMode)) throw new Error('默认权限设置无效')
    return defaultPermissionMode
  }

  private async handlePermissionSettings(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method === 'GET') {
        this.json(res, 200, { defaultPermissionMode: await this.readDefaultPermissionMode() } satisfies PermissionSettings)
        return
      }
      const value = await readJson(req)
      if (!isSettingsObject(value) || Object.keys(value).length !== 1 || !isPermissionMode(value.defaultPermissionMode)) {
        throw new InputError(400, '默认权限模式无效')
      }
      const { defaultPermissionMode } = value
      await updateSettingsFile(this.options.webSettingsPath, file => { file.defaultPermissionMode = defaultPermissionMode })
      this.json(res, 200, { defaultPermissionMode } satisfies PermissionSettings)
      this.notify('permission_settings_changed')
    } catch (error) { this.sessionError(res, error, '无法读取或保存默认权限，请检查本机设置文件。') }
  }

  private async handleLanguageSettings(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method === 'GET') {
        const { locale } = await readSettingsFile(this.options.webSettingsPath)
        const language = isSettingsObject(locale) && locale.preference === 'zh-CN' ? 'zh-CN' : 'en'
        this.json(res, 200, { language } satisfies LanguageSettings)
        return
      }
      const value = await readJson(req)
      if (!isSettingsObject(value) || Object.keys(value).length !== 1 || (value.language !== 'en' && value.language !== 'zh-CN')) {
        throw new InputError(400, '请选择英文或简体中文。')
      }
      const { language } = value
      await updateSettingsFile(this.options.webSettingsPath, file => {
        file.locale = { ...(isSettingsObject(file.locale) ? file.locale : {}), preference: language }
      })
      this.json(res, 200, { language } satisfies LanguageSettings)
    } catch (error) {
      this.json(res, error instanceof InputError ? error.status : 500, {
        error: error instanceof InputError ? error.message : '无法读取或保存语言设置，请检查本机设置文件及权限。',
      })
    }
  }

  private async handleMemory(req: IncomingMessage, res: ServerResponse, pathname: string, entry: RegExpExecArray | null) {
    try {
      if (pathname === '/api/settings/memory') {
        if (req.method === 'GET') {
          const { enabled } = await this.memorySettings.read()
          this.json(res, 200, { memoryEnabled: enabled } satisfies MemorySettingsView)
        } else {
          const value = await readJson(req)
          if (!isSettingsObject(value) || Object.keys(value).length !== 1 || typeof value.memoryEnabled !== 'boolean') {
            throw new InputError(400, '请提交有效的记忆开关。')
          }
          const { enabled } = await this.memorySettings.save(value.memoryEnabled)
          this.json(res, 200, { memoryEnabled: enabled } satisfies MemorySettingsView)
        }
      } else if (pathname === '/api/memory/projects') {
        this.json(res, 200, { projects: await this.memoryStore.listProjects() } satisfies ProjectMemoriesView)
      } else if (req.method === 'GET') {
        const { markdown, revision } = await this.memoryStore.readUser()
        this.json(res, 200, { markdown, revision } satisfies UserMemoryView)
      } else {
        const value = await readJson(req)
        if (!isSettingsObject(value) || typeof value.expectedRevision !== 'number'
          || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
          throw new InputError(400, '请提交有效的记忆版本。')
        }
        if (entry) {
          if (Object.keys(value).length !== 1) throw new InputError(400, '请仅提交记忆版本。')
          const project = await this.memoryStore.deleteProjectEntry(checkedPathId(entry[1]!), checkedPathId(entry[2]!), value.expectedRevision)
          this.json(res, 200, { project } satisfies DeleteMemoryEntryView)
        } else {
          if (Object.keys(value).length !== 2 || typeof value.markdown !== 'string') {
            throw new InputError(400, '请提交 Markdown 正文和记忆版本。')
          }
          const { markdown, revision } = await this.memoryStore.saveUser(value.markdown, value.expectedRevision)
          this.json(res, 200, { markdown, revision } satisfies UserMemoryView)
        }
      }
    } catch (error) {
      if (error instanceof MemoryStoreError) {
        const status = memoryErrorStatus[error.code]
        if (status) { this.json(res, status, { code: error.code, error: error.message }); return }
      }
      this.sessionError(res, error, '无法读取或更新本机记忆。')
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
      const send = async (event: BrowserEvent | { type: 'subscription_error'; error: string }) => {
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
            await send(browserEvent(event))
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
      await this.scheduleRunner?.stop()
      this.scheduleRunner = undefined
      this.schedules = undefined
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = undefined
      if (this.attachmentCleanup) clearInterval(this.attachmentCleanup)
      this.attachmentCleanup = undefined
      this.selection?.abort()
      this.stopWatching?.()
      this.stopWatching = undefined
      this.stopWatchingMcp?.()
      this.stopWatchingMcp = undefined
      this.listenOrigin = undefined
      for (const cleanup of this.disposers.values()) cleanup()
      for (const client of this.ws?.clients ?? []) client.terminate()
      this.missedPongs.clear()
      const server = this.server
      const ws = this.ws
      this.server = undefined
      this.ws = undefined
      const mcp = this.mcp
      this.mcp = undefined
      try {
        const results = await Promise.allSettled([this.sessions?.close(), mcp?.close()])
        const failure = results.find(result => result.status === 'rejected')
        if (failure) throw failure.reason
      }
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
