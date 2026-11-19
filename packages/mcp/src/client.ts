import { AsyncLocalStorage } from 'node:async_hooks'
import {
  McpAbortError, McpAuthRequiredError, McpClient as PiClient, McpError, McpHttpError, McpSessionExpiredError,
  StreamableHttpTransport, type CallToolResult, type McpFetch, type Tool,
} from '@earendil-works/pi-mcp'
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from '@earendil-works/pi-mcp/oauth'
import { oauthAuthProvider, type McpSignInOptions } from './oauth.js'

const DEFAULT_TIMEOUT_MS = 30_000

export interface McpClientOptions {
  url: string
  token?: string
  oauth?: McpSignInOptions
  onChallenge?: (challenge: OAuthChallenge) => void
  timeoutMs?: number
  fetch?: McpFetch
}

interface CallOptions {
  signal?: AbortSignal
  beforeSend?: () => void
}

interface CallAttempt {
  beforeSend?: () => void
  signal: AbortSignal
  sent: boolean
  status?: number
  sessionExpired?: boolean
  networkFailed?: boolean
}

export class McpOutcomeUnknownError extends Error {
  constructor() {
    super('The remote MCP tool result is unknown')
    this.name = 'McpOutcomeUnknownError'
  }
}

export class McpRequestFailedError extends Error {
  constructor(message = 'The remote MCP tool request failed') {
    super(message)
    this.name = 'McpRequestFailedError'
  }
}

class HttpTransport extends StreamableHttpTransport {
  private closing?: Promise<void>

  override close(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => super.close())
    return this.closing
  }
}

export class McpClient {
  private readonly client: PiClient
  private readonly transport: HttpTransport
  private readonly calls = new AsyncLocalStorage<CallAttempt>()
  private readonly timeoutMs: number
  private readonly authProvider?: ReturnType<typeof oauthAuthProvider>
  private closing?: Promise<void>

  constructor(options: McpClientOptions) {
    const { oauth, token, onChallenge } = options
    const url = new URL(options.url)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
      throw new Error('MCP server URL must be HTTPS or HTTP on loopback')
    }
    if (oauth && new URL(oauth.serverUrl).href !== url.href) throw new Error('MCP OAuth resource must match the server URL')

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.client = new PiClient({ name: 'agent-learning', version: '0.1.0', requestTimeoutMs: this.timeoutMs })
    const authProvider = oauth && oauthAuthProvider({ ...oauth, fetch: oauth.fetch ?? options.fetch }, onChallenge)
    this.authProvider = authProvider
    this.transport = new HttpTransport({
      url,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      reconnect: { maxRetries: 0 },
      authProvider: authProvider && {
        token: authProvider.token,
        onUnauthorized: async context => {
          await authProvider.onUnauthorized?.(context)
          if (this.calls.getStore()?.sent) throw new McpRequestFailedError('The MCP server rejected this request before credentials were refreshed')
        },
      },
      fetch: (input, init) => this.fetch(options.fetch ?? globalThis.fetch, url, input, init),
    })
    this.transport.onError(() => this.disconnect())
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport)
  }

  get instructions(): string | undefined {
    return this.client.instructions?.trim() || undefined
  }

  onToolsChanged(listener: () => void): () => void {
    return this.client.onNotification('notifications/tools/list_changed', listener)
  }

  async listTools(): Promise<Tool[]> {
    const tools = await this.client.listTools()
    const names = new Set<string>()
    for (const tool of tools) {
      if (!tool.name || names.has(tool.name) ||
        (tool.description !== undefined && typeof tool.description !== 'string') ||
        (tool.title !== undefined && typeof tool.title !== 'string')) {
        throw new Error('The MCP server returned an invalid tool definition')
      }
      names.add(tool.name)
    }
    return tools
  }

  onClose(listener: () => void): () => void {
    return this.client.onClose(listener)
  }

  close(): Promise<void> {
    // The close event is synchronous. Establish the shared promise before notifying listeners.
    this.closing ??= Promise.resolve().then(async () => {
      const refresh = this.authProvider?.settle()
      await this.client.close()
      await Promise.all([this.transport.close(), refresh])
    })
    return this.closing
  }

  async callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallToolResult> {
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const attempt: CallAttempt = { beforeSend: options.beforeSend, signal, sent: false }
    return this.calls.run(attempt, async () => {
      try {
        const result = await this.client.callTool(name, args, { signal })
        if (!result.content.every(isContentBlock) || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
          throw new McpOutcomeUnknownError()
        }
        return result
      } catch (error) {
        if (!attempt.sent || error instanceof McpAuthRequiredError ||
          error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpRequestFailedError) throw error
        if (error instanceof McpSessionExpiredError && attempt.sessionExpired) throw error
        if (attempt.networkFailed || (error instanceof TypeError && !signal.aborted)) this.disconnect()
        if (isExplicitFailure(error, attempt.status)) {
          throw new McpRequestFailedError()
        }
        throw new McpOutcomeUnknownError()
      } finally {
        controller.abort()
      }
    })
  }

  private async fetch(network: McpFetch, url: URL, input: string | URL, init?: RequestInit): Promise<Response> {
    const target = new URL(input)
    const method = init?.method
    const isRpc = method === 'POST' && new Headers(init?.headers).get('content-type') === 'application/json'
    if (target.href !== url.href) {
      throw new Error('MCP request does not match the configured server URL')
    }
    const message = isRpc && typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : undefined
    const attempt = message?.method === 'tools/call' ? this.calls.getStore() : undefined
    let signal = init?.signal
    if (attempt) {
      if (attempt.sent) throw new McpRequestFailedError('The MCP tool request has already been sent')
      if (this.closing || attempt.signal.aborted || signal?.aborted) throw new McpAbortError()
      attempt.beforeSend?.()
      if (this.closing || attempt.signal.aborted) throw new McpAbortError()
      attempt.sent = true
      signal = signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal
    } else if (message?.method === 'notifications/initialized') {
      const timeout = AbortSignal.timeout(this.timeoutMs)
      signal = signal ? AbortSignal.any([signal, timeout]) : timeout
    }
    try {
      const response = await network(target, { ...init, signal, redirect: 'error' })
      if (attempt) {
        const session = new Headers(init?.headers).get('mcp-session-id')
        attempt.status = response.status
        attempt.sessionExpired = response.status === 404 && session !== null && /^[!-~]+$/.test(session)
      }
      return response
    } catch (error) {
      if (attempt && !signal?.aborted) attempt.networkFailed = true
      throw error
    }
  }

  private disconnect(): void {
    void this.close().catch(() => {})
  }
}

function isContentBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('type' in value)) return false
  switch (value.type) {
    case 'text': return 'text' in value && typeof value.text === 'string'
    case 'image':
    case 'audio': return 'data' in value && typeof value.data === 'string' && 'mimeType' in value && typeof value.mimeType === 'string'
    case 'resource_link': return 'uri' in value && typeof value.uri === 'string' && 'name' in value && typeof value.name === 'string'
    case 'resource': {
      const resource = 'resource' in value ? value.resource : undefined
      return !!resource && typeof resource === 'object' && 'uri' in resource && typeof resource.uri === 'string'
        && (!('mimeType' in resource) || typeof resource.mimeType === 'string')
        && ('text' in resource ? typeof resource.text === 'string' : 'blob' in resource && typeof resource.blob === 'string')
    }
    default: return typeof value.type === 'string'
  }
}

function isExplicitFailure(error: unknown, status: number | undefined): boolean {
  if (status === 401 || status === 403) return true
  if (error instanceof McpError) {
    // Pi uses a synthetic JSON-RPC error when an SSE response ends before its result.
    return !error.message.startsWith('MCP response stream failed:') && error.message !== 'Invalid MCP tools/call result'
  }
  return error instanceof McpHttpError && status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
}
