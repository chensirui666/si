import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import WebSocket from 'ws'
import { WebServer } from '../src/webserver/index.js'
import { AgentSession, SessionStore, SessionWriteError, SessionReadError, type SessionSubscriptionEvent, type ConversationSnapshot, type SessionSummary } from '@agent-learning/coding-agent'
import { createModelStream, type ModelContext, type AssistantMessage, type ModelEvent } from '@agent-learning/model'

vi.mock('node:fs/promises', { spy: true })

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(stat).mockReset(); for (const close of cleanups.splice(0).reverse()) await close() })
async function setup(options: Partial<ConstructorParameters<typeof WebServer>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-server-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const webRoot = join(dir, 'web')
  await mkdir(join(webRoot, 'assets'), { recursive: true })
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><h1>聊天</h1>')
  await writeFile(join(webRoot, 'assets/app.js'), 'console.log("app")')
  const workspace = await realpath(await mkdir(join(dir, 'workspace')).then(() => join(dir, 'workspace')))
  const config = { port: 0, webRoot, globalContextDirectory: join(dir, 'global-context'), workspacePath: join(dir, 'private/workspaces.json'),
    webSettingsPath: join(dir, 'private/settings.json'), ...(!options.createSession && { sessionPath: join(dir, 'private/sessions.sqlite') }), directoryPicker: async () => workspace, browserSecretPath: join(dir, 'private/browser-auth.json'), modelAuthPath: join(dir, 'private/auth.json'), ...options }
  const server = new WebServer(config)
  const started = await server.start()
  cleanups.push(() => server.close())
  return { server, ...started, config, workspace }
}
function http(url: string, headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request(url, { headers, method }, res => {
      let text = ''
      res.setEncoding('utf8').on('data', chunk => { text += chunk }).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }))
    })
    req.on('error', reject).end(body)
  })
}
async function cookie(url: string) {
  const response = await http(url)
  expect(response.status).toBe(303)
  return response.headers['set-cookie']![0]!.split(';')[0]!
}
async function connect(url: string, credentials: string, extra: Record<string, string> = {}, autoPong = true) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events', { headers: { Cookie: credentials, ...extra }, autoPong })
  cleanups.push(async () => { socket.terminate() })
  await once(socket, 'open')
  return socket
}
function nextConversationFrame(socket: WebSocket) {
  return new Promise<any>(resolve => {
    const receive = (data: WebSocket.RawData) => {
      const frame = JSON.parse(String(data))
      if (frame.type.endsWith('_changed')) return
      socket.off('message', receive)
      resolve(frame)
    }
    socket.on('message', receive)
  })
}
async function rejectedHandshake(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events', { headers })
    socket.on('unexpected-response', (_, res) => { const status = res.statusCode!; res.resume(); socket.terminate(); resolve(status) })
    socket.on('open', () => { socket.terminate(); reject(new Error('unexpected open')) })
    socket.on('error', () => {})
  })
}
const empty = { seq: 0, messages: [], running: null, activeContent: [], compactions: [], contextUsage: null }

describe('主动中止入口', () => {
  it('沿用来源、授权和 JSON 校验；无效请求不交付 Agent', async () => {
    const abort = vi.fn(async () => true)
    const app = await setup({ createSession: () => ({ ...controlledAgent(), abort }) })
    const auth = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, auth)
    const url = app.url + '/api/abort'
    const headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const body = JSON.stringify({ sessionId, runId: 'user-1' })
    expect((await http(url, { 'Content-Type': 'application/json' }, 'POST', body)).status).toBe(401)
    for (const invalid of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }]) {
      expect((await http(url, { ...headers, ...invalid }, 'POST', body)).status).toBe(403)
    }
    expect((await http(url, { Cookie: auth }, 'POST', body)).status).toBe(415)
    expect((await http(url, headers, 'POST', 'x'.repeat(65537))).status).toBe(413)
    const malformed = [{ runId: 0 }, { runId: ' ' }, { runId: 'x'.repeat(129) }, { runId: 'u', extra: true }, { runId: 'u', sessionId: ' ' }]
    for (const value of ['{', 'null', '[]', '{}', ...malformed.map(input => JSON.stringify({ sessionId, ...input }))]) {
      expect((await http(url, headers, 'POST', value)).status).toBe(400)
    }
    expect(abort).not.toHaveBeenCalled()
  })

  it.each([true, false])('等待指定运行收尾后返回同一目标和 handled=%s，无需模型或目录可用', async handled => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const abort = vi.fn(async () => { entered.resolve(); await release.promise; return handled })
    const app = await setup({ createSession: () => ({ ...controlledAgent(), abort }) })
    const auth = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, auth)
    const headers = { Cookie: auth, 'Content-Type': 'application/json' }
    let returned = false
    const pending = http(app.url + '/api/abort', headers, 'POST', JSON.stringify({ sessionId, runId: 'old-user' })).then(value => { returned = true; return value })
    await entered.promise
    expect(returned).toBe(false)
    expect(abort).toHaveBeenCalledExactlyOnceWith('old-user')
    release.resolve()
    const result = await pending
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text)).toEqual({ sessionId, runId: 'old-user', handled })
  })

  it('未装配中止返回 503，内部错误脱敏', async () => {
    const agent = { ...controlledAgent(), abort: undefined as undefined | (() => Promise<boolean>) }
    const app = await setup({ createSession: () => agent })
    const auth = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, auth)
    const headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const send = () => http(app.url + '/api/abort', headers, 'POST', JSON.stringify({ sessionId, runId: 'user-1' }))
    expect((await send()).status).toBe(503)
    agent.abort = async () => { throw new Error('private-api-key') }
    const result = await send()
    expect(result.status).toBe(500)
    expect(result.text).not.toContain('private-api-key')
  })

  it('HTTP 与订阅断开后已交付的中止仍收尾，重新订阅恢复实际结果', async () => {
    const started = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const agent = new AgentSession({ resolveDirectory: async () => app.workspace, stream: (model, _context, options) => ({
      result: () => new Promise(() => {}),
      async *[Symbol.asyncIterator]() {
        const partial = { role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'pending' as const, timestamp: 1 }
        yield { type: 'start' as const, partial }
        started.resolve()
        if (!options!.signal!.aborted) await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }))
        entered.resolve()
        try { yield { type: 'error' as const, reason: 'aborted' as const, error: { ...partial, stopReason: 'aborted' as const } } }
        finally { await release.promise }
      },
    }) })
    const app = await setup({ createSession: () => agent })
    const auth = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, auth)
    const accepted = await agent.submit({ clientMessageId: 'local', modelId: 'deepseek-flash', text: 'stop me' })
    const socket = await connect(app.url, auth)
    const first = nextConversationFrame(socket)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'first' }))
    expect((await first).snapshot.running).not.toBeNull()
    await started.promise
    const req = request(app.url + '/api/abort', { method: 'POST', headers: { Cookie: auth, 'Content-Type': 'application/json' } })
    req.on('error', () => {})
    req.end(JSON.stringify({ sessionId, runId: accepted.kind === 'message' ? accepted.userMessageId : accepted.compactionId }))
    await entered.promise
    req.destroy()
    socket.terminate()
    release.resolve()
    await vi.waitFor(async () => {
      const controller = new AbortController()
      const state = (await agent.subscribe(controller.signal).next()).value
      controller.abort()
      expect(state).toMatchObject({ snapshot: { running: null } })
    })
    const restored = await connect(app.url, auth)
    const next = nextConversationFrame(restored)
    restored.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'restored' }))
    expect((await next).snapshot).toMatchObject({ running: null, messages: [{}, { message: { stopReason: 'aborted' } }] })
  })
})
function controlledAgent() {
  const active = new Set<AbortSignal>()
  return {
    active,
    subscribe(signal: AbortSignal): AsyncIterable<SessionSubscriptionEvent> {
      active.add(signal)
      signal.addEventListener('abort', () => active.delete(signal), { once: true })
      return (async function* () {
        try {
          yield { type: 'snapshot' as const, snapshot: structuredClone(empty) }
          yield { type: 'update' as const, update: { seq: 1, change: { type: 'accepted' as const, user: { id: 'u1', message: { role: 'user' as const, content: '受控', timestamp: 1 } }, running: { kind: 'task', runId: 'u1', assistantMessageId: 'a1', phase: 'model', activeTools: [] } } } }
          await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
        } finally { active.delete(signal) }
      })()
    },
  }
}

describe('Cookie 交换与重启', () => {
  it('303 清理链接、正确 Cookie 属性、有效访问不续期且密钥不泄露', async () => {
    const app = await setup()
    const response = await http(app.authUrl)
    expect(response.status).toBe(303)
    expect(response.headers.location).toBe('./')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    const setCookie = response.headers['set-cookie']![0]!
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Max-Age=2592000')
    expect(setCookie).not.toContain('Secure')
    const credentials = setCookie.split(';')[0]!
    const page = await http(app.url, { Cookie: credentials })
    expect(page.status).toBe(200)
    expect(page.text).toContain('聊天')
    expect(page.headers['set-cookie']).toBeUndefined()
    const secret = JSON.parse(await readFile(app.config.browserSecretPath, 'utf8')).secret
    expect(setCookie + response.text + page.text).not.toContain(secret)
    expect((await http(app.authUrl)).status).toBe(303)
    expect((await http(app.url + '/assets/app.js', { Cookie: credentials })).status).toBe(200)
    expect((await http(app.url + '/assets/app.js')).status).toBe(401)
    expect((await http(app.url + '/api/messages', { Cookie: credentials })).status).toBe(404)
  })
  it('未授权、篡改、过期和未来签发时间均拒绝，不为已建立 WS 添加到期关闭', async () => {
    let now = 100000
    const app = await setup({ now: () => now })
    expect((await http(app.url)).status).toBe(401)
    expect((await http(app.url + '/?token=wrong')).status).toBe(401)
    const credentials = await cookie(app.authUrl)
    expect((await http(app.url, { Cookie: credentials + 'x' })).status).toBe(401)
    now--
    expect((await http(app.url, { Cookie: credentials })).status).toBe(401)
    now++
    const sessionId = await pickSession(app.url, credentials)
    const socket = await connect(app.url, credentials)
    now += 30 * 86400000
    expect((await http(app.url, { Cookie: credentials })).status).toBe(401)
    expect(await rejectedHandshake(app.url, { Cookie: credentials })).toBe(401)
    const next = nextConversationFrame(socket)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'after-expiry' }))
    expect((await next).snapshot).toEqual(empty)
  })
  it('同密钥同地址重启 Cookie 可用，启动令牌更新，换密钥重启后 Cookie 失效', async () => {
    const app = await setup()
    const credentials = await cookie(app.authUrl)
    const port = new URL(app.url).port
    await app.server.close()
    const second = new WebServer({ ...app.config, port: Number(port) })
    cleanups.push(() => second.close())
    const restarted = await second.start()
    expect(restarted.authUrl).not.toBe(app.authUrl)
    expect((await http(restarted.url, { Cookie: credentials })).status).toBe(200)
    expect((await http(app.authUrl)).status).toBe(401)
    await second.close()
    await writeFile(app.config.browserSecretPath, JSON.stringify({ version: 1, secret: randomBytes(32).toString('base64url') }), { mode: 0o600 })
    const third = new WebServer({ ...app.config, port: Number(port) })
    cleanups.push(() => third.close())
    const changed = await third.start()
    expect((await http(changed.url, { Cookie: credentials })).status).toBe(401)
  })
  it('Cookie 名称和值均绑定地址端口', async () => {
    const first = await setup()
    const second = await setup({ browserSecretPath: first.config.browserSecretPath })
    const a = await cookie(first.authUrl)
    const b = await cookie(second.authUrl)
    expect(a.split('=')[0]).not.toBe(b.split('=')[0])
    expect((await http(second.url, { Cookie: a })).status).toBe(401)
    expect((await http(second.url, { Cookie: b.split('=')[0] + '=' + a.slice(a.indexOf('=') + 1) })).status).toBe(401)
  })
})

describe('阶段二模型配置', () => {
  it('授权查询、保存、替换和删除均返回无 Key 的本地发现', async () => {
    const app = await setup()
    const headers = { Cookie: await cookie(app.authUrl), Origin: app.url, 'Content-Type': 'application/json' }
    const missing = await http(app.url + '/api/models', headers)
    expect(missing.status).toBe(200)
    expect(JSON.parse(missing.text)).toEqual({ models: [], deepseek: { state: 'missing' } })
    for (const apiKey of ['stage2-first-fake-key', 'stage2-replacement-fake-key']) {
      const response = await http(app.url + '/api/providers/deepseek', headers, 'PUT', JSON.stringify({ apiKey }))
      expect(response.status).toBe(200)
      expect(JSON.parse(response.text)).toMatchObject({ models: [{ id: 'deepseek-flash', provider: 'deepseek' }], deepseek: { state: 'configured' } })
      expect(response.text).not.toContain(apiKey)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(JSON.parse(await readFile(app.config.modelAuthPath, 'utf8')).deepseek.key).toBe(apiKey)
    }
    const removed = await http(app.url + '/api/providers/deepseek', headers, 'DELETE')
    expect(removed.status).toBe(200)
    expect(JSON.parse(removed.text)).toEqual({ models: [], deepseek: { state: 'missing' } })
    expect(JSON.parse(await readFile(app.config.modelAuthPath, 'utf8'))).toEqual({})
  })
  it('未授权、跨站和非法输入均拒绝，不能写文件或泄露正文', async () => {
    const app = await setup()
    const url = app.url + '/api/providers/deepseek'
    const secret = 'stage2-never-expose-this'
    const body = JSON.stringify({ apiKey: secret })
    expect((await http(url, { 'Content-Type': 'application/json' }, 'PUT', body)).status).toBe(401)
    const headers = { Cookie: await cookie(app.authUrl), 'Content-Type': 'application/json' }
    expect((await http(url, { ...headers, Origin: 'https://untrusted.invalid' }, 'PUT', body)).status).toBe(403)
    expect((await http(url, { ...headers, Origin: 'null' }, 'DELETE')).status).toBe(403)
    for (const value of ['{', '{}', '[]', 'null', '{"apiKey":23}', JSON.stringify({ apiKey: secret, path: '/tmp/elsewhere' }), JSON.stringify({ apiKey: 'bad\r\nheader' })]) {
      const response = await http(url, headers, 'PUT', value)
      expect(response.status).toBe(400)
      expect(response.text).not.toContain(secret)
    }
    expect((await http(url, { ...headers, 'Content-Type': 'text/plain' }, 'PUT', body)).status).toBe(415)
    expect((await http(url, headers, 'PUT', JSON.stringify({ apiKey: secret.repeat(4000) }))).status).toBe(413)
    await expect(readFile(app.config.modelAuthPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await http(app.url + '/api/models')).status).toBe(401)
  })
  it('坏模型文件仍能授权和打开设置，更新失败保留原文件并脱敏', async () => {
    const app = await setup()
    const original = '{bad-json-stage2-private-value'
    await writeFile(app.config.modelAuthPath, original, { mode: 0o600 })
    const headers = { Cookie: await cookie(app.authUrl), 'Content-Type': 'application/json' }
    expect((await http(app.url, headers)).status).toBe(200)
    const models = await http(app.url + '/api/models', headers)
    expect(JSON.parse(models.text)).toMatchObject({ models: [], deepseek: { state: 'error' } })
    for (const method of ['PUT', 'DELETE']) {
      const response = await http(app.url + '/api/providers/deepseek', headers, method, method === 'PUT' ? '{"apiKey":"new-fake-key"}' : undefined)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.text).not.toContain(original)
      expect(response.text).not.toContain('new-fake-key')
      expect(await readFile(app.config.modelAuthPath, 'utf8')).toBe(original)
    }
  })
  it('成功配置和外部变化通知所有连接，不更改对话序号，关闭后可重启', async () => {
    const app = await setup()
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    const a = await connect(app.url, credentials)
    const b = await connect(app.url, credentials)
    const frames: any[][] = [[], []]
    for (const [index, socket] of [a, b].entries()) {
      socket.on('message', value => frames[index]!.push(JSON.parse(String(value))))
      socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: `models-${index}` }))
    }
    await vi.waitFor(() => expect(frames.every(list => list.some(frame => frame.type === 'snapshot'))).toBe(true))
    const counts = frames.map(list => list.filter(frame => frame.type === 'models_changed').length)
    const headers = { Cookie: credentials, 'Content-Type': 'application/json' }
    expect((await http(app.url + '/api/providers/deepseek', headers, 'PUT', '{"apiKey":"notification-fake-key"}')).status).toBe(200)
    await vi.waitFor(() => expect(frames.every((list, index) => list.filter(frame => frame.type === 'models_changed').length > counts[index]!)).toBe(true))
    const before = frames.map(list => list.filter(frame => frame.type === 'models_changed').length)
    await writeFile(app.config.modelAuthPath, '{invalid external data', { mode: 0o600 })
    await vi.waitFor(() => expect(frames.every((list, index) => list.filter(frame => frame.type === 'models_changed').length > before[index]!)).toBe(true), { timeout: 5000 })
    expect(JSON.parse((await http(app.url + '/api/models', headers)).text).deepseek.state).toBe('error')
    for (const list of frames) {
      expect(list.filter(frame => frame.type === 'snapshot').map(frame => frame.snapshot.seq)).toEqual([0])
      expect(list.some(frame => frame.type === 'update')).toBe(false)
      expect(JSON.stringify(list)).not.toContain('notification-fake-key')
    }
    await app.server.close()
    const restarted = new WebServer({ ...app.config, port: Number(new URL(app.url).port) })
    cleanups.push(() => restarted.close())
    await restarted.start()
    expect(JSON.parse((await http(app.url + '/api/models', headers)).text).deepseek.state).toBe('error')
  })
})

describe('目标来源拒绝与握手授权', () => {
  it('Host/Origin/显式跨站同样保护 HTTP 和 WS，Origin 缺失不免授权', async () => {
    const app = await setup()
    const credentials = await cookie(app.authUrl)
    for (const headers of [{ Host: 'attacker.test' }, { Host: '127.0.0.1:1' }, { Origin: 'null' }, { Origin: 'https://attacker.test' }, { Origin: app.url + '/bad' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      expect((await http(app.url, { Cookie: credentials, ...headers })).status).toBe(403)
      expect(await rejectedHandshake(app.url, { Cookie: credentials, ...headers })).toBe(403)
    }
    expect(await rejectedHandshake(app.url, {})).toBe(401)
    const socket = await connect(app.url, credentials, { Origin: app.url })
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect((await http(app.url, { Cookie: credentials, 'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'https' })).status).toBe(200)
  })
  it('开发授权依据保留的 Vite Host/Origin，拒绝不一致来源', async () => {
    const app = await setup({ devOrigin: 'http://127.0.0.1:5173' })
    const response = await http(app.authUrl, { Host: '127.0.0.1:5173' })
    expect(response.status).toBe(303)
    const credentials = response.headers['set-cookie']![0]!.split(';')[0]!
    const headers = { Host: '127.0.0.1:5173', Origin: 'http://127.0.0.1:5173', Cookie: credentials }
    const socket = await connect(app.url, credentials, headers)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(await rejectedHandshake(app.url, { ...headers, Origin: app.url })).toBe(403)
    expect((await http(app.url, { Cookie: credentials })).status).toBe(401)
  })
  it('路径穿越不能读取页面目录以外内容，缺失页面不伪装成功', async () => {
    const app = await setup()
    const credentials = await cookie(app.authUrl)
    expect((await http(app.url + '/%2e%2e%2fprivate/browser-auth.json', { Cookie: credentials })).status).toBe(404)
    expect((await http(app.url + '/missing.js', { Cookie: credentials })).status).toBe(404)
    await rm(join(app.config.webRoot, 'index.html'))
    expect((await http(app.url, { Cookie: credentials })).status).toBe(404)
  })
})

describe('会话订阅转发与清理', () => {
  it('握手不订阅，目标编号收到真实空快照，多页面共享会话', async () => {
    const app = await setup()
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    for (const subscriptionId of ['one', 'two']) {
      const socket = await connect(app.url, credentials)
      const next = nextConversationFrame(socket)
      socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId }))
      expect(await next).toEqual({ type: 'snapshot', sessionId, subscriptionId, snapshot: empty })
    }
  })
  it('受控源先快照后更新，替换/取消只释放所属订阅和连接', async () => {
    const agent = controlledAgent()
    const app = await setup({ createSession: () => agent })
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    const socket = await connect(app.url, credentials)
    const other = await connect(app.url, credentials)
    expect(agent.active.size).toBe(0)
    const frames: any[] = []
    socket.on('message', data => { const frame = JSON.parse(String(data)); if (!frame.type.endsWith('_changed')) frames.push(frame) })
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'old' }))
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames.map(frame => frame.type)).toEqual(['snapshot', 'update'])
    expect(frames[1].update.seq).toBe(1)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'new' }))
    other.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'other' }))
    await vi.waitFor(() => expect(agent.active.size).toBe(2))
    await vi.waitFor(() => expect(frames).toHaveLength(4))
    expect(frames.slice(2).map(frame => frame.subscriptionId)).toEqual(['new', 'new'])
    socket.send(JSON.stringify({ type: 'unsubscribe', subscriptionId: 'old' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(agent.active.size).toBe(2)
    socket.send(JSON.stringify({ type: 'unsubscribe', subscriptionId: 'new' }))
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    other.close()
    await vi.waitFor(() => expect(agent.active.size).toBe(0))
  })
  it.each(['{', '{"type":"subscribe","subscriptionId":""}', '{"type":"subscribe","subscriptionId":2}', '{"type":"subscribe","subscriptionId":"missing-target"}', '{"type":"unknown"}'])('非法帧 %s 关闭所属连接且释放订阅', async frame => {
    const agent = controlledAgent()
    const app = await setup({ createSession: () => agent })
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    const bad = await connect(app.url, credentials)
    const good = await connect(app.url, credentials)
    bad.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'bad' }))
    good.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'good' }))
    await vi.waitFor(() => expect(agent.active.size).toBe(2))
    const closed = once(bad, 'close')
    bad.send(frame)
    expect((await closed)[0]).toBe(1008)
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    expect(good.readyState).toBe(WebSocket.OPEN)
  })
  it('发送失败只清理所属连接与订阅', async () => {
    const agent = controlledAgent()
    const app = await setup({ createSession: () => agent })
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    const failed = await connect(app.url, credentials)
    const good = await connect(app.url, credentials)
    const original = WebSocket.prototype.send
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function(this: WebSocket, data: any, ...args: any[]) {
      const frame = JSON.parse(String(data))
      if (frame.type === 'snapshot' && frame.subscriptionId === 'fail') {
        const callback = args.at(-1)
        callback(new Error('controlled send failure'))
        return
      }
      return original.call(this, data, ...args as [any])
    } as any)
    const closed = once(failed, 'close')
    failed.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'fail' }))
    good.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'good' }))
    await closed
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    expect(good.readyState).toBe(WebSocket.OPEN)
  })
  it('发送缓冲超限只清理慢连接，其他页面仍可订阅', async () => {
    const agent = controlledAgent()
    const app = await setup({ createSession: () => agent })
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    const slow = await connect(app.url, credentials)
    const good = await connect(app.url, credentials)
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValueOnce(1024 * 1024 + 1)
    const closed = once(slow, 'close')
    slow.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'slow' }))
    await closed
    const next = nextConversationFrame(good)
    good.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'good' }))
    expect((await next).snapshot).toEqual(empty)
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    expect(good.readyState).toBe(WebSocket.OPEN)
  })
  it('旧订阅取消后延迟报错不能关闭替换的新订阅', async () => {
    let calls = 0
    let failOld!: () => void
    const agent = {
      subscribe(signal: AbortSignal): AsyncIterable<SessionSubscriptionEvent> {
        const old = ++calls === 1
        return (async function* () {
          yield { type: 'snapshot' as const, snapshot: structuredClone(empty) }
          if (old) { await new Promise<void>(resolve => { failOld = resolve }); throw new Error('old failure') }
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        })()
      },
    }
    const app = await setup({ createSession: () => agent })
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    const socket = await connect(app.url, credentials)
    const frames: any[] = []
    socket.on('message', data => { const frame = JSON.parse(String(data)); if (!frame.type.endsWith('_changed')) frames.push(frame) })
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'old' }))
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'new' }))
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    failOld()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(frames[1].subscriptionId).toBe('new')
  })
  it('心跳两次无响应清理失活连接，close 清理剩余连接订阅和定时器', async () => {
    const agent = controlledAgent()
    let heartbeat: (() => void) | undefined
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, milliseconds: number) => {
      expect(milliseconds).toBe(2000)
      heartbeat = callback
      return { unref() {} } as any
    }) as any)
    const app = await setup({ createSession: () => agent })
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    const socket = await connect(app.url, credentials, {}, false)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'heart' }))
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    heartbeat!()
    heartbeat!()
    const closed = once(socket, 'close')
    heartbeat!()
    await closed
    await vi.waitFor(() => expect(agent.active.size).toBe(0))
    const live = await connect(app.url, credentials)
    live.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'live' }))
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    const liveClosed = once(live, 'close')
    await app.server.close()
    await liveClosed
    expect(agent.active.size).toBe(0)
    expect(clear).toHaveBeenCalled()
    interval.mockRestore()
  })
  it('非法帧关闭中的对端不回应时 close 仍立即释放全部连接', async () => {
    const agent = controlledAgent()
    const app = await setup({ createSession: () => agent })
    const credentials = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, credentials)
    const socket = await connect(app.url, credentials)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'paused' }))
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    socket.pause()
    socket.send('{')
    await vi.waitFor(() => expect(agent.active.size).toBe(0))
    const closing = app.server.close()
    const promptly = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150))])
    try { expect(promptly).toBe(true) } finally { socket.terminate(); await closing }
  })
  it('未完成 HTTP 请求不会阻止正常退出', async () => {
    const app = await setup()
    const socket = connectTcp(Number(new URL(app.url).port), '127.0.0.1')
    await once(socket, 'connect')
    socket.write('GET / HTTP/1.1\r\nHost: ' + new URL(app.url).host + '\r\n')
    const closed = once(socket, 'close')
    const closing = app.server.close()
    const promptly = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150))])
    try { expect(promptly).toBe(true) } finally { socket.destroy(); await closing; await closed }
  })
  it('端口冲突启动失败、签名初始化失败均安全清理', async () => {
    const app = await setup()
    const conflict = new WebServer({ ...app.config, port: Number(new URL(app.url).port), sessionPath: app.config.sessionPath + '.other' })
    await expect(conflict.start()).rejects.toThrow(/启动|占用|listen|EADDRINUSE/)
    await conflict.close()
    const old = await readFile(app.config.browserSecretPath)
    await writeFile(app.config.browserSecretPath, 'bad-json')
    const invalid = new WebServer({ ...app.config, port: 0 })
    await expect(invalid.start()).rejects.toThrow()
    await invalid.close()
    expect(await readFile(app.config.browserSecretPath, 'utf8')).toBe('bad-json')
    await writeFile(app.config.browserSecretPath, old)
    expect((await http(app.url, { Cookie: await cookie(app.authUrl) })).status).toBe(200)
  })
})

describe('消息提交与模型生命周期', () => {
  const baseMessage = { clientMessageId: 'local-http', modelId: 'deepseek-flash', text: '  原文\n保留  ' }

  it('提交沿用授权和来源校验，拒绝无效输入，不写正式消息', async () => {
    const app = await setup()
    const auth = await cookie(app.authUrl)
    const headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const sessionId = await pickSession(app.url, auth)
    const message = { ...baseMessage, sessionId }
    expect((await http(app.url + '/api/messages', {}, 'POST', JSON.stringify(message))).status).toBe(401)
    expect((await http(app.url + '/api/messages', { ...headers, Origin: 'https://evil.invalid' }, 'POST', JSON.stringify(message))).status).toBe(403)
    expect((await http(app.url + '/api/messages', { Cookie: auth }, 'POST', JSON.stringify(message))).status).toBe(415)
    for (const body of ['{', 'null', '{}', JSON.stringify({ ...message, extra: true }), JSON.stringify({ ...message, text: ' \n ' }), JSON.stringify({ ...message, modelId: 'unknown' }), JSON.stringify({ ...message, clientMessageId: 'x'.repeat(129) })]) {
      expect((await http(app.url + '/api/messages', headers, 'POST', body)).status).toBe(400)
    }
    expect((await http(app.url + '/api/messages', headers, 'POST', JSON.stringify({ ...message, text: 'x'.repeat(65536) }))).status).toBe(413)
    const socket = await connect(app.url, auth)
    const first = nextConversationFrame(socket)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'after-rejects' }))
    expect((await first).snapshot).toEqual(empty)
  })

  it('凭据未配置也先回执，随后形成正式失败回复并释放忙碌', async () => {
    const app = await setup()
    const auth = await cookie(app.authUrl)
    const sessionId = await pickSession(app.url, auth)
    const response = await http(app.url + '/api/messages', { Cookie: auth, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ ...baseMessage, sessionId }))
    expect(response.status).toBe(202)
    expect(JSON.parse(response.text)).toMatchObject({ clientMessageId: 'local-http', userMessageId: expect.any(String), acceptedSeq: 1 })
    let snapshot!: ConversationSnapshot
    await vi.waitFor(async () => {
      snapshot = await serverSnapshot(app.url, auth, sessionId)
      expect(snapshot.running).toBeNull()
      expect(snapshot.messages).toHaveLength(2)
    })
    expect(snapshot.messages[0].message.content).toBe('  原文\n保留  ')
    expect(snapshot.messages[1].message).toMatchObject({ role: 'assistant', stopReason: 'error' })
  })

  it('真实 SDK 流跨断线继续，重订阅恢复同一进度；关闭服务取消当前调用', async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined
    let calls = 0, aborted = false
    const send = (delta: object, finish_reason: string | null = null) => upstream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'response-1', model: 'provider-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`))
    const controlledFetch: typeof fetch = async (_url, init) => {
      calls++
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer controlled-server-key')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'deepseek-flash', stream: true })
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        upstream = controller
        init?.signal?.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('cancelled', 'AbortError')) }, { once: true })
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const app = await setup({ modelOptions: { fetch: controlledFetch } })
    const auth = await cookie(app.authUrl)
    const headers = { Cookie: auth, 'Content-Type': 'application/json' }
    expect((await http(app.url + '/api/providers/deepseek', headers, 'PUT', JSON.stringify({ apiKey: 'controlled-server-key' }))).status).toBe(200)
    const sessionId = await pickSession(app.url, auth)
    const socket = await connect(app.url, auth)
    const frames: any[] = []
    socket.on('message', data => frames.push(JSON.parse(String(data))))
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'live' }))
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'snapshot')).toBe(true))
    const message = { ...baseMessage, sessionId }
    const response = await http(app.url + '/api/messages', headers, 'POST', JSON.stringify(message))
    expect(response.status).toBe(202)
    await vi.waitFor(() => expect(calls).toBe(1))
    const duplicate = await http(app.url + '/api/messages', headers, 'POST', JSON.stringify(message))
    expect(duplicate.status).toBe(202)
    expect(JSON.parse(duplicate.text)).toEqual(JSON.parse(response.text))
    expect((await http(app.url + '/api/messages', headers, 'POST', JSON.stringify({ ...message, text: 'different' }))).status).toBe(409)
    expect(calls).toBe(1)
    send({ reasoning_content: '想一想' })
    send({ content: 'A' })
    await vi.waitFor(() => expect(frames.some(frame => frame.update?.change.event?.type === 'text_delta')).toBe(true))
    socket.close()
    await once(socket, 'close')
    expect(aborted).toBe(false)
    send({ content: 'B' })
    const restored = await connect(app.url, auth)
    const first = nextConversationFrame(restored)
    restored.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'restored' }))
    const snapshot = (await first).snapshot
    expect(snapshot.running?.runId).toBe(JSON.parse(response.text).userMessageId)
    expect(snapshot.messages[1].message.content).toEqual([{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: 'AB' }])
    expect(calls).toBe(1)
    await app.server.close()
    expect(aborted).toBe(true)
  })
})

it('3 MiB 原始历史快照写完后继续交付紧随增量和配置通知', async () => {
  const longText = 'x'.repeat(3 * 1024 * 1024)
  const snapshot: ConversationSnapshot = {
    ...empty, seq: 1,
    messages: [{ id: 'u-large', message: { role: 'user', content: longText, timestamp: 1 } }],
    compactions: [{ id: 'compact-large', trigger: 'manual', startedAt: 0, status: 'success', finishedAt: 1,
      summary: 'earlier summary', firstKeptMessageId: 'u-large', contextLastMessageId: 'u-large', estimatedBefore: 1_000_000, estimatedAfter: 800_000 }],
  }
  const agent = {
    async *subscribe(signal: AbortSignal): AsyncIterable<SessionSubscriptionEvent> {
      yield { type: 'snapshot', snapshot }
      yield { type: 'update', update: { seq: 2, change: { type: 'task', running: null } } }
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
  }
  const app = await setup({ createSession: () => agent })
  const auth = await cookie(app.authUrl)
  const sessionId = await pickSession(app.url, auth)
  const socket = await connect(app.url, auth)
  const frames: any[] = []
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'large' }))
  await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'snapshot' || frame.type === 'update')).toHaveLength(2))
  expect(frames[0].snapshot.messages[0].message.content).toBe(longText)
  expect(frames[0].snapshot.compactions).toEqual(snapshot.compactions)
  expect(frames[1]).toMatchObject({ type: 'update', subscriptionId: 'large', update: { seq: 2 } })
  expect(socket.readyState).toBe(WebSocket.OPEN)
  const headers = { Cookie: auth, 'Content-Type': 'application/json' }
  expect((await http(app.url + '/api/providers/deepseek', headers, 'PUT', '{"apiKey":"large-snapshot-key"}')).status).toBe(200)
  await vi.waitFor(() => expect(frames.some(frame => frame.type === 'models_changed')).toBe(true))
})

it('快照发送回调未完成时等待增量并合并重复通知', async () => {
  const app = await setup({ createSession: controlledAgent })
  const auth = await cookie(app.authUrl)
  const sessionId = await pickSession(app.url, auth)
  const socket = await connect(app.url, auth)
  const release = Promise.withResolvers<void>(), releaseNotification = Promise.withResolvers<void>()
  let firstNotification = false
  const original = WebSocket.prototype.send
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: any, ...args: any[]) {
    const frame = JSON.parse(String(data))
    if (frame.type === 'snapshot' && frame.subscriptionId === 'callback') {
      const callback = args.at(-1)
      args[args.length - 1] = (error?: Error) => { if (error) callback(error); else void release.promise.then(() => callback()) }
    } else if (frame.type === 'models_changed' && firstNotification) {
      firstNotification = false
      const callback = args.at(-1)
      args[args.length - 1] = (error?: Error) => { if (error) callback(error); else void releaseNotification.promise.then(() => callback()) }
    }
    return original.call(this, data, ...args as [any])
  } as any)
  const frames: any[] = []
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'callback' }))
  try {
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'snapshot')).toBe(true))
    firstNotification = true
    for (let index = 0; index < 100; index++) (app.server as unknown as { notify(type: string): void }).notify('models_changed')
    expect(frames.filter(frame => frame.type === 'update' || frame.type === 'models_changed')).toHaveLength(0)
    release.resolve()
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'models_changed')).toBe(true))
    expect(frames.filter(frame => frame.type === 'models_changed')).toHaveLength(1)
    ;(app.server as unknown as { notify(type: string): void }).notify('models_changed')
    releaseNotification.resolve()
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'models_changed')).toHaveLength(2))
    expect(frames.find(frame => frame.type === 'update').update.seq).toBe(1)
    expect(socket.readyState).toBe(WebSocket.OPEN)
  } finally { release.resolve(); releaseNotification.resolve() }
})

it('发送未完成时反复替换订阅只为最后一个订阅读取新快照', async () => {
  const agent = controlledAgent(), subscribe = vi.spyOn(agent, 'subscribe')
  const app = await setup({ createSession: () => agent })
  const auth = await cookie(app.authUrl)
  const sessionId = await pickSession(app.url, auth)
  const socket = await connect(app.url, auth)
  const release = Promise.withResolvers<void>(), original = WebSocket.prototype.send
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: any, ...args: any[]) {
    const frame = JSON.parse(String(data))
    if (frame.type === 'snapshot' && frame.subscriptionId === 'blocked') {
      const callback = args.at(-1)
      args[args.length - 1] = (error?: Error) => { if (error) callback(error); else void release.promise.then(() => callback()) }
    }
    return original.call(this, data, ...args as [any])
  } as any)
  const frames: any[] = []
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'blocked' }))
  try {
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'snapshot')).toBe(true))
    for (let index = 0; index < 100; index++) socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: `replacement-${index}` }))
    const pong = once(socket, 'pong')
    socket.ping('processed-replacements')
    await pong
    expect(subscribe).toHaveBeenCalledTimes(1)
    release.resolve()
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'snapshot' && frame.subscriptionId === 'replacement-99')).toBe(true))
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(socket.readyState).toBe(WebSocket.OPEN)
  } finally { release.resolve() }
})

async function serverSnapshot(url: string, auth: string, sessionId: string, subscriptionId = 'snapshot') {
  const socket = await connect(url, auth)
  const next = nextConversationFrame(socket)
  socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId }))
  const snapshot = (await next).snapshot as ConversationSnapshot
  socket.terminate()
  return snapshot
}

function summaryProvider() {
  let calls = 0, summaryCalls = 0, aborted = false
  let summary: ReadableStreamDefaultController<Uint8Array> | undefined
  const event = (content: string) => new TextEncoder().encode(`data: ${JSON.stringify({
    id: 'controlled-compaction', model: 'deepseek-flash', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
  })}\n\ndata: [DONE]\n\n`)
  const controlledFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (String(body.messages[0]?.content).startsWith('你负责整理对话摘要')) {
      summaryCalls++
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        summary = controller
        init?.signal?.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('cancelled', 'AbortError')) }, { once: true })
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    calls++
    return new Response(event('任务进展已记录。'), { headers: { 'content-type': 'text/event-stream' } })
  }
  return {
    fetch: controlledFetch,
    get calls() { return calls }, get summaryCalls() { return summaryCalls }, get aborted() { return aborted },
    finish(failed = false) {
      if (failed) summary!.error(new Error('controlled summary failure'))
      else { summary!.enqueue(event('项目青禾；仅修改临时工作区。')); summary!.close() }
    },
  }
}

describe('压缩的正式 HTTP/WS 生命周期', () => {
  it('没有可整理历史时返回独立命令回执和未执行记录，不新增聊天消息', async () => {
    const app = await setup()
    const auth = await cookie(app.authUrl), sessionId = await pickSession(app.url, auth)
    const response = await http(app.url + '/api/messages', { Cookie: auth, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({
      sessionId, clientMessageId: 'empty-compact', modelId: 'deepseek-flash', text: ' /compact\n',
    }))
    expect(response.status).toBe(202)
    const accepted = JSON.parse(response.text)
    expect(accepted).toMatchObject({ kind: 'compaction', clientMessageId: 'empty-compact', compactionId: expect.any(String) })
    expect(accepted.userMessageId).toBeUndefined()
    await vi.waitFor(async () => {
      const snapshot = await serverSnapshot(app.url, auth, sessionId)
      expect(snapshot.running).toBeNull()
      expect(snapshot.messages).toEqual([])
      expect(snapshot.compactions).toMatchObject([{ id: accepted.compactionId, status: 'skipped', clientMessageId: 'empty-compact' }])
    })
  })

  it.each(['success', 'failed', 'aborted'] as const)('断线后压缩 %s 的原始历史和结果可恢复，命令只执行一次', async outcome => {
    const provider = summaryProvider()
    const app = await setup({ compaction: { triggerTokens: 100_000, keepRecentTokens: 30 }, modelOptions: { fetch: provider.fetch } })
    const auth = await cookie(app.authUrl), headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const sessionId = await pickSession(app.url, auth)
    expect((await http(app.url + '/api/providers/deepseek', headers, 'PUT', '{"apiKey":"compaction-fixture-key"}')).status).toBe(200)
    const submit = (clientMessageId: string, text: string) => http(app.url + '/api/messages', headers, 'POST', JSON.stringify({
      sessionId, clientMessageId, modelId: 'deepseek-flash', text,
    }))
    for (let index = 0; index < 2; index++) {
      expect((await submit(`seed-${index}`, `项目青禾；仅修改临时工作区。${'earlier data '.repeat(300)}`)).status).toBe(202)
      await vi.waitFor(async () => expect((await serverSnapshot(app.url, auth, sessionId)).running).toBeNull())
    }
    const before = await serverSnapshot(app.url, auth, sessionId)
    const response = await submit('manual-compact', '/compact')
    expect(response.status).toBe(202)
    const accepted = JSON.parse(response.text)
    expect(accepted.kind).toBe('compaction')
    await vi.waitFor(() => expect(provider.summaryCalls).toBe(1))
    const socket = await connect(app.url, auth), first = nextConversationFrame(socket)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'during' }))
    expect((await first).snapshot).toMatchObject({ running: { kind: 'compaction', runId: accepted.compactionId }, compactions: [{ status: 'running' }] })
    expect((await submit('rejected-busy', '/compact')).status).toBe(409)
    socket.close()
    await once(socket, 'close')
    expect(provider.aborted).toBe(false)
    expect((await http(app.url + '/api/abort', headers, 'POST', JSON.stringify({ sessionId, runId: 'stale-id' }))).text).toContain('"handled":false')
    if (outcome === 'aborted') {
      const stopped = await http(app.url + '/api/abort', headers, 'POST', JSON.stringify({ sessionId, runId: accepted.compactionId }))
      expect(JSON.parse(stopped.text)).toEqual({ sessionId, runId: accepted.compactionId, handled: true })
    } else if (outcome === 'success') {
      const crossing = await connect(app.url, auth), frames: any[] = []
      crossing.on('message', data => { const frame = JSON.parse(String(data)); if (frame.type === 'snapshot' || frame.type === 'update') frames.push(frame) })
      crossing.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'commit-crossing' }))
      provider.finish()
      await vi.waitFor(() => expect(frames.some(frame => frame.snapshot?.compactions.some((record: any) => record.status === 'success')
        || frame.update?.change.type === 'compaction' && frame.update.change.record.status === 'success')).toBe(true))
      const sequences = frames.map(frame => frame.snapshot?.seq ?? frame.update.seq)
      for (let index = 1; index < sequences.length; index++) expect(sequences[index]).toBe(sequences[index - 1] + 1)
      crossing.terminate()
    } else provider.finish(true)
    let restored!: ConversationSnapshot
    await vi.waitFor(async () => {
      restored = await serverSnapshot(app.url, auth, sessionId, 'restored')
      expect(restored.running).toBeNull()
      expect(restored.compactions).toMatchObject([{ id: accepted.compactionId, status: outcome }])
    })
    expect(restored.messages).toEqual(before.messages)
    expect(restored.compactions).toHaveLength(1)
    expect(provider.summaryCalls).toBe(1)
    expect(provider.calls).toBe(2)
    expect(provider.aborted).toBe(outcome !== 'success')
    expect(restored.contextUsage?.breakdown).toBeDefined()
    if (outcome === 'success') {
      expect(restored.compactions[0]).toMatchObject({ summary: '项目青禾；仅修改临时工作区。', summaryUsage: { input: 200 } })
    }
  })

  it('真实暂停读取的连接超过缓冲阈值被清理，后台摘要仍成功且新连接可恢复大快照', async () => {
    let heartbeat!: () => void
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      heartbeat = callback
      return { unref() {} } as any
    }) as any)
    const provider = summaryProvider()
    const agent = new AgentSession({ resolveDirectory: async () => app.workspace, compaction: { triggerTokens: 100_000, keepRecentTokens: 30 },
      stream: createModelStream({ readApiKey: async () => 'compaction-fixture-key' }, { fetch: provider.fetch }) })
    const state = (agent as unknown as { state: ConversationSnapshot }).state
    state.messages.push(
      { id: 'old-large', message: { role: 'user', content: 'x'.repeat(3 * 1024 * 1024), timestamp: 1 } },
      { id: 'recent-user', message: { role: 'user', content: 'recent '.repeat(100), timestamp: 2 } },
    )
    const app = await setup({ createSession: () => agent })
    const auth = await cookie(app.authUrl), sessionId = await pickSession(app.url, auth)
    const accepted = await http(app.url + '/api/messages', { Cookie: auth, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({
      sessionId, modelId: 'deepseek-flash', clientMessageId: 'slow-compact', text: '/compact',
    }))
    expect(accepted.status).toBe(202)
    await vi.waitFor(() => expect(provider.summaryCalls).toBe(1))
    const slow = await connect(app.url, auth)
    slow.pause()
    slow.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'slow-large' }))
    const serverSocket = [...(app.server as unknown as { ws: import('ws').WebSocketServer }).ws.clients][0]
    await vi.waitFor(() => expect(serverSocket.bufferedAmount).toBeGreaterThan(1024 * 1024))
    heartbeat()
    await vi.waitFor(() => expect(serverSocket.readyState).toBe(WebSocket.CLOSED))
    slow.terminate()
    expect(provider.aborted).toBe(false)
    provider.finish()
    await vi.waitFor(() => expect(state.running).toBeNull())
    const restored = await serverSnapshot(app.url, auth, sessionId)
    expect(restored.messages[0].message.content).toBe('x'.repeat(3 * 1024 * 1024))
    expect(restored.compactions).toMatchObject([{ status: 'success' }])
    expect(provider.summaryCalls).toBe(1)
  })
})

async function pickWorkspace(url: string, auth: string) {
  const picked = await http(url + '/api/workspaces/pick', { Cookie: auth }, 'POST')
  expect(picked.status).toBe(200)
  return JSON.parse(picked.text).workspaceId as string
}

async function createSession(url: string, auth: string, workspaceId: string) {
  const response = await http(url + '/api/sessions', { Cookie: auth, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ workspaceId }))
  expect(response.status).toBe(201)
  return JSON.parse(response.text) as SessionSummary
}

async function pickSession(url: string, auth: string) {
  return (await createSession(url, auth, await pickWorkspace(url, auth))).id
}

it('取消不写入登记，旧登记兼容，符号链接复用目录，目录不可用时保留历史，重启恢复会话', async () => {
  let selected: string | null = null
  const requests: any[] = []
  const app = await setup({ directoryPicker: async () => selected, modelOptions: { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    const first = requests.length === 1
    const delta = first ? { tool_calls: [{ index: 0, id: 'write-1', type: 'function', function: { name: 'write', arguments: '{"path":"written.txt","content":"working-directory"}' } }] } : { content: '完成' }
    return new Response(`data: ${JSON.stringify({ id: 'controlled', choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  } } })
  const auth = await cookie(app.authUrl)
  const headers = { Cookie: auth, 'Content-Type': 'application/json' }
  const send = (sessionId?: string) => http(app.url + '/api/messages', headers, 'POST', JSON.stringify({ text: '写入', modelId: 'deepseek-flash', clientMessageId: randomUUID(), sessionId }))
  expect((await send()).status).toBe(400)
  expect((await send('unknown')).status).toBe(404)
  expect((await http(app.url + '/api/workspaces/pick', {}, 'POST')).status).toBe(401)
  const cancelled = await http(app.url + '/api/workspaces/pick', headers, 'POST')
  expect(JSON.parse(cancelled.text)).toEqual({ cancelled: true })
  await expect(readFile(app.config.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })

  const first = { id: 'old-workspace', path: app.workspace }
  await writeFile(app.config.workspacePath, JSON.stringify({ workspaces: [first], boundWorkspaceId: first.id }), { mode: 0o600 })
  selected = join(app.workspace, '..', 'alias')
  await symlink(app.workspace, selected)
  const duplicate = JSON.parse((await http(app.url + '/api/workspaces/pick', { Cookie: auth }, 'POST')).text)
  expect(duplicate).toMatchObject({ cancelled: false, workspaceId: first.id, created: false })
  const secondPath = join(app.workspace, '..', 'second')
  await mkdir(secondPath)
  selected = await realpath(secondPath)
  const added = JSON.parse((await http(app.url + '/api/workspaces/pick', { Cookie: auth }, 'POST')).text)
  expect(added).toMatchObject({ cancelled: false, workspaceId: expect.any(String), created: true })
  const second = { id: added.workspaceId, path: selected }
  const view = { workspaces: [{ ...first, name: 'workspace', available: true }, { ...second, name: 'second', available: true }] }
  expect(added.view).toEqual(view)
  expect(JSON.parse(await readFile(app.config.workspacePath, 'utf8'))).toEqual({ workspaces: [first, second] })
  expect(JSON.parse((await http(app.url + '/api/workspaces', headers)).text)).toEqual(view)

  const { stat: realStat } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const fixtureRoot = join(app.workspace, '..') + '/'
  vi.mocked(stat).mockImplementation((path, ...args) => {
    if (typeof path === 'string' && !path.startsWith(fixtureRoot) && /\/(?:AGENTS|CLAUDE)(?:\.override)?\.md$/i.test(path)) {
      return Promise.reject(Object.assign(new Error('fixture has no ancestor instructions'), { code: 'ENOENT' }))
    }
    return realStat(path, ...args)
  })
  const { id: sessionId } = await createSession(app.url, auth, first.id)
  expect((await http(app.url + '/api/providers/deepseek', headers, 'PUT', '{"apiKey":"test-key"}')).status).toBe(200)
  expect((await send(sessionId)).status).toBe(202)
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  expect(stat).toHaveBeenCalledWith('/AGENTS.override.md')
  const promptDocument = await readFile(new URL('../../../docs/prompts/systemPrompt.md', import.meta.url), 'utf8')
  const expectedPrompt = promptDocument.split('```text\n')[1].split('\n```')[0]
    .replaceAll('{{siRoot}}/', () => fileURLToPath(new URL('../../../', import.meta.url)))
    .replace('{{workspacePath}}', () => app.workspace)
  expect(requests[0].messages[0]).toEqual({ role: 'system', content: expectedPrompt })
  expect(requests[1].messages[0]).toEqual(requests[0].messages[0])
  expect(requests[0].tools).toHaveLength(8)
  expect(requests[1].tools).toHaveLength(8)
  expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'write-1' })
  expect(await readFile(join(app.workspace, 'written.txt'), 'utf8')).toBe('working-directory')
  let history!: ConversationSnapshot
  await vi.waitFor(async () => {
    history = await serverSnapshot(app.url, auth, sessionId)
    expect(history.running).toBeNull()
    expect(history.messages).toHaveLength(4)
  })
  await rm(app.workspace, { recursive: true })
  expect((await send(sessionId)).status).toBe(409)
  expect(requests).toHaveLength(2)
  expect(await serverSnapshot(app.url, auth, sessionId)).toEqual(history)
  expect(JSON.parse((await http(app.url + '/api/workspaces', headers)).text).workspaces[0]).toMatchObject({ id: first.id, available: false })

  await app.server.close()
  const restarted = new WebServer(app.config)
  cleanups.push(() => restarted.close())
  const next = await restarted.start()
  const newCookie = await cookie(next.authUrl)
  expect(JSON.parse((await http(next.url + '/api/workspaces', { Cookie: newCookie })).text)).toEqual({
    workspaces: view.workspaces.map(workspace => workspace.id === first.id ? { ...workspace, available: false } : workspace),
  })
  expect(JSON.parse((await http(next.url + '/api/sessions', { Cookie: newCookie })).text)).toEqual({ sessions: [expect.objectContaining({ id: sessionId, workspaceId: first.id })] })
  const socket = await connect(next.url, newCookie)
  const snapshot = nextConversationFrame(socket)
  socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'restarted' }))
  expect(await snapshot).toMatchObject({ type: 'snapshot', sessionId, subscriptionId: 'restarted',
    snapshot: { messages: history.messages, running: null, runs: [expect.objectContaining({ status: 'completed' })] } })
  const unavailable = await http(next.url + '/api/messages', { Cookie: newCookie, 'Content-Type': 'application/json' },
    'POST', JSON.stringify({ sessionId, text: '继续', modelId: 'deepseek-flash', clientMessageId: randomUUID() }))
  expect(unavailable.status).toBe(409)
  expect(requests).toHaveLength(2)
})

it('P1: saves capability choices independently of the shared Tavily credential and notifies without secrets', async () => {
  const app = await setup()
  const auth = await cookie(app.authUrl)
  const headers = { Cookie: auth, 'Content-Type': 'application/json' }
  const socket = await connect(app.url, auth)
  const frames: string[] = []
  socket.on('message', data => { frames.push(String(data)) })
  const settings = app.url + '/api/web/settings'
  const provider = app.url + '/api/web/providers/tavily'
  expect((await http(settings)).status).toBe(401)
  const defaults = { searchProvider: 'tavily', fetchProvider: 'tavily' }
  expect(JSON.parse((await http(settings, headers)).text)).toMatchObject({ ...defaults, providers: [{ id: 'tavily', capabilities: ['search', 'fetch'], status: { state: 'missing' } }] })
  expect((await http(settings, headers, 'PUT', '{"searchProvider":"unknown","fetchProvider":"tavily"}')).status).toBe(400)
  expect((await http(settings, headers, 'PUT', JSON.stringify(defaults))).status).toBe(200)
  expect(JSON.parse(await readFile(app.config.webSettingsPath, 'utf8'))).toEqual({ web: defaults })
  await http(app.url + '/api/providers/deepseek', headers, 'PUT', '{"apiKey":"model-test-key"}')
  for (const key of ['first-web-test-key', 'next-web-test-key']) {
    const saved = await http(provider, headers, 'PUT', JSON.stringify({ apiKey: key }))
    expect(saved.status).toBe(200)
    expect(saved.text).not.toContain(key)
    expect(JSON.parse(saved.text)).toMatchObject({ ...defaults, providers: [{ id: 'tavily', status: { state: 'configured' } }] })
  }
  expect(JSON.parse(await readFile(app.config.modelAuthPath, 'utf8'))).toMatchObject({ deepseek: { key: 'model-test-key' }, tavily: { key: 'next-web-test-key' } })
  expect(JSON.parse((await http(provider, headers, 'DELETE')).text)).toMatchObject({ ...defaults, providers: [{ id: 'tavily', status: { state: 'missing' } }] })
  expect(JSON.parse(await readFile(app.config.modelAuthPath, 'utf8'))).toEqual({ deepseek: { key: 'model-test-key', type: 'api_key' } })
  await vi.waitFor(() => expect(frames.some(frame => JSON.parse(frame).type === 'web_settings_changed')).toBe(true))
  expect(frames.join('')).not.toContain('test-key')
})

describe('首次发送', () => {
  it('接受原文后才列出会话，并发和完成后的重试只运行一次', async () => {
    const validating = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const stream = vi.fn<NonNullable<ConstructorParameters<typeof AgentSession>[0]['stream']>>((model) => ({
      result: async () => { throw new Error('unexpected result call') },
      async *[Symbol.asyncIterator]() {
        yield { type: 'done' as const, reason: 'stop' as const, message: {
          role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text' as const, text: '回复' }], stopReason: 'stop' as const, timestamp: 1,
        } }
      },
    }))
    const app = await setup({ createSession: resolveDirectory => new AgentSession({ stream, resolveDirectory: async () => {
      validating.resolve()
      await release.promise
      return resolveDirectory()
    } }) })
    const auth = await cookie(app.authUrl), headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const input = { workspaceId: await pickWorkspace(app.url, auth), clientMessageId: randomUUID(), modelId: 'deepseek-flash', text: '你好' }
    const start = (value = input) => http(app.url + '/api/sessions/start', headers, 'POST', JSON.stringify(value))
    const list = async () => JSON.parse((await http(app.url + '/api/sessions', headers)).text).sessions
    const socket = await connect(app.url, auth)
    const frames: any[] = []
    socket.on('message', data => frames.push(JSON.parse(String(data))))
    const first = start()
    // Race the validation gate against an early response so a missing route fails immediately.
    try {
      expect(await Promise.race([validating.promise.then(() => 'validating'), first.then(response => response.status)])).toBe('validating')
      const duplicate = start()
      expect(await list()).toEqual([])
      const notYet = nextConversationFrame(socket)
      socket.send(JSON.stringify({ type: 'subscribe', sessionId: input.clientMessageId, subscriptionId: 'pending' }))
      expect(await notYet).toMatchObject({ type: 'subscription_error' })
      expect(frames).not.toContainEqual({ type: 'sessions_changed' })
      expect((await start({ ...input, text: '不同的原文' })).status).toBe(409)
      release.resolve()

      const [a, b] = await Promise.all([first, duplicate])
      expect(a.status).toBe(202)
      expect(b.status).toBe(202)
      const accepted = JSON.parse(a.text)
      expect(accepted).toEqual({
        session: { id: input.clientMessageId, workspaceId: input.workspaceId, name: '会话 1', createdAt: expect.any(String) },
        accepted: { sessionId: input.clientMessageId, clientMessageId: input.clientMessageId, kind: 'message', userMessageId: expect.any(String), acceptedSeq: 1 },
      })
      expect(JSON.parse(b.text)).toEqual(accepted)
      await vi.waitFor(async () => {
        const snapshot = await serverSnapshot(app.url, auth, input.clientMessageId)
        expect(snapshot.messages).toMatchObject([
          { id: accepted.accepted.userMessageId, clientMessageId: input.clientMessageId, message: { role: 'user', content: '你好' } },
          { message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } },
        ])
      })
      const after = await start()
      expect(after.status).toBe(202)
      expect(JSON.parse(after.text)).toEqual(accepted)
      expect((await start({ ...input, modelId: 'deepseek-pro' })).status).toBe(409)
      expect((await start({ ...input, text: '/compact' })).status).toBe(409)
      expect(await list()).toEqual([accepted.session])
      expect(frames.filter(frame => frame.type === 'sessions_changed')).toHaveLength(1)
      expect(stream).toHaveBeenCalledTimes(1)
    } finally { release.resolve() }
  })

  it('关闭服务时停止尚未接受首条消息的会话', async () => {
    const validating = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const stream = vi.fn<NonNullable<ConstructorParameters<typeof AgentSession>[0]['stream']>>(() => { throw new Error('unexpected stream call') })
    const app = await setup({ createSession: resolveDirectory => new AgentSession({ stream, resolveDirectory: async () => {
      validating.resolve()
      await release.promise
      return resolveDirectory()
    } }) })
    const auth = await cookie(app.authUrl), headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const input = { workspaceId: await pickWorkspace(app.url, auth), clientMessageId: randomUUID(), modelId: 'deepseek-flash', text: '关闭前' }
    const first = http(app.url + '/api/sessions/start', headers, 'POST', JSON.stringify(input)).then(response => response.status, () => 'disconnected')
    try {
      expect(await Promise.race([validating.promise.then(() => 'validating'), first])).toBe('validating')
      await app.server.close()
      release.resolve()
      expect([503, 'disconnected']).toContain(await first)
      const reopened = await app.server.start()
      const reopenedCookie = await cookie(reopened.authUrl)
      expect(JSON.parse((await http(reopened.url + '/api/sessions', { Cookie: reopenedCookie })).text)).toEqual({ sessions: [] })
      expect(stream).not.toHaveBeenCalled()
    } finally { release.resolve() }
  })

  it('拒绝无效首条消息和不可用目录，不留下空会话', async () => {
    const app = await setup()
    const auth = await cookie(app.authUrl), headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const input = { workspaceId: await pickWorkspace(app.url, auth), clientMessageId: randomUUID(), modelId: 'deepseek-flash', text: '你好' }
    const start = (value: object) => http(app.url + '/api/sessions/start', headers, 'POST', JSON.stringify({ ...input, ...value }))
    for (const invalid of [{ text: ' /compact ' }, { text: '  ' }, { clientMessageId: 'invalid' }, { modelId: 'invalid' }, { extra: true }]) {
      expect((await start(invalid)).status).toBe(400)
    }
    expect((await start({ workspaceId: 'unknown' })).status).toBe(409)
    await rm(app.workspace, { recursive: true })
    expect((await start({})).status).toBe(409)
    expect(JSON.parse((await http(app.url + '/api/sessions', headers)).text)).toEqual({ sessions: [] })
  })
})

describe('会话路由', () => {
  it('列出同一工作区的两个独立会话，未知订阅后用原连接打开已知会话', async () => {
    const app = await setup()
    const auth = await cookie(app.authUrl)
    const headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const path = app.url + '/api/sessions'
    expect((await http(path)).status).toBe(401)
    expect((await http(path, { 'Content-Type': 'application/json' }, 'POST', '{}')).status).toBe(401)
    expect(JSON.parse((await http(path, headers)).text)).toEqual({ sessions: [] })
    for (const body of ['{}', '{"workspaceId":" "}', '{"workspaceId":"unknown","path":"/tmp"}']) {
      expect((await http(path, headers, 'POST', body)).status).toBe(400)
    }
    const picked = await http(app.url + '/api/workspaces/pick', { Cookie: auth }, 'POST')
    const { workspaceId } = JSON.parse(picked.text)
    expect((await http(path, headers, 'POST', '{"workspaceId":"absent"}')).status).toBe(409)
    const socket = await connect(app.url, auth)
    const notification = once(socket, 'message')
    const first = await http(path, headers, 'POST', JSON.stringify({ workspaceId }))
    expect(first.status).toBe(201)
    expect(JSON.parse(String((await notification)[0]))).toEqual({ type: 'sessions_changed' })
    const second = await http(path, headers, 'POST', JSON.stringify({ workspaceId }))
    expect(second.status).toBe(201)
    const a = JSON.parse(first.text), b = JSON.parse(second.text)
    expect(a).toMatchObject({ id: expect.any(String), workspaceId, name: '会话 1', createdAt: expect.any(String) })
    expect(b).toMatchObject({ id: expect.any(String), workspaceId, name: '会话 2', createdAt: expect.any(String) })
    expect(a.id).not.toBe(b.id)
    expect(JSON.parse((await http(path, headers)).text)).toEqual({ sessions: [a, b] })
    const subscribe = (sessionId: string, subscriptionId: string) => {
      const frame = nextConversationFrame(socket)
      socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId }))
      return frame
    }
    expect(await subscribe(a.id, 'open-a')).toEqual({ type: 'snapshot', sessionId: a.id, subscriptionId: 'open-a', snapshot: empty })
    expect(await subscribe('missing', 'unknown')).toMatchObject({ type: 'subscription_error', sessionId: 'missing', subscriptionId: 'unknown', error: expect.any(String) })
    expect(await subscribe(b.id, 'open-b')).toEqual({ type: 'snapshot', sessionId: b.id, subscriptionId: 'open-b', snapshot: empty })
  })
})

it('并行会话的相对路径和中止各自归属，另一会话继续完成', async () => {
  let selected = ''
  const requests = new Map<string, Array<{ role: string; content: string; tool_call_id?: string }[]>>()
  const pending = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const aborted = new Set<string>()
  const encoder = new TextEncoder()
  const reply = (delta: object, finish_reason: string | null) => encoder.encode(
    `data: ${JSON.stringify({ id: 'controlled-session', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
  )
  const controlledFetch: typeof fetch = async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body))
    const name = messages.find((message: { role: string }) => message.role === 'user').content as string
    const turns = requests.get(name) ?? []
    turns.push(messages)
    requests.set(name, turns)
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      pending.set(name, controller)
      init?.signal?.addEventListener('abort', () => {
        aborted.add(name)
        controller.error(new DOMException('cancelled', 'AbortError'))
      }, { once: true })
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const finish = (name: string, delta: object, reason: string) => {
    const target = pending.get(name)!
    target.enqueue(reply(delta, reason))
    target.enqueue(encoder.encode('data: [DONE]\n\n'))
    target.close()
  }
  const app = await setup({ directoryPicker: async () => selected, modelOptions: { fetch: controlledFetch } })
  const auth = await cookie(app.authUrl), headers = { Cookie: auth, 'Content-Type': 'application/json' }
  const post = (path: string, value: unknown) => http(app.url + path, headers, 'POST', JSON.stringify(value))
  const submit = (sessionId: string, text: string) => post('/api/messages', {
    sessionId, text, modelId: 'deepseek-flash', clientMessageId: 'shared-client-id',
  })
  expect((await http(app.url + '/api/providers/deepseek', headers, 'PUT', '{"apiKey":"session-fixture-key"}')).status).toBe(200)
  const aPath = app.workspace, bPath = join(app.workspace, '..', 'workspace-b')
  await mkdir(bPath)
  await Promise.all([writeFile(join(aPath, 'note.txt'), '青禾独有'), writeFile(join(bPath, 'note.txt'), '白榆独有')])
  selected = aPath
  const a = await pickSession(app.url, auth)
  const aResponse = await submit(a, '项目青禾')
  expect(aResponse.status).toBe(202)
  const { userMessageId: aRun } = JSON.parse(aResponse.text)
  expect(JSON.parse(aResponse.text)).toMatchObject({ sessionId: a, clientMessageId: 'shared-client-id' })
  await vi.waitFor(() => expect(pending.has('项目青禾')).toBe(true))
  const observer = await connect(app.url, auth)
  const observe = (sessionId: string) => {
    const frame = nextConversationFrame(observer)
    observer.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: sessionId }))
    return frame
  }
  expect(await observe(a)).toMatchObject({ type: 'snapshot', sessionId: a, snapshot: { running: { runId: aRun } } })

  selected = await realpath(bPath)
  const b = await pickSession(app.url, auth)
  expect(await observe(b)).toMatchObject({ type: 'snapshot', sessionId: b, snapshot: empty })
  const bResponse = await submit(b, '项目白榆')
  expect(bResponse.status).toBe(202)
  const { userMessageId: bRun } = JSON.parse(bResponse.text)
  expect(JSON.parse(bResponse.text)).toMatchObject({ sessionId: b, clientMessageId: 'shared-client-id' })
  await vi.waitFor(() => expect(pending.has('项目白榆')).toBe(true))
  const [aPending, bPending] = await Promise.all([serverSnapshot(app.url, auth, a), serverSnapshot(app.url, auth, b)])
  expect(aPending.running).toMatchObject({ runId: aRun })
  expect(bPending.running).toMatchObject({ runId: bRun })
  expect((await submit(a, '同一会话第二条')).status).toBe(409)
  expect((await submit('不存在', '不能投递')).status).toBe(404)
  expect((await post('/api/abort', { sessionId: '不存在', runId: aRun })).status).toBe(404)
  const mismatch = await post('/api/abort', { sessionId: b, runId: aRun })
  expect(JSON.parse(mismatch.text)).toEqual({ sessionId: b, runId: aRun, handled: false })
  expect(aborted.size).toBe(0)

  for (const name of ['项目白榆', '项目青禾']) {
    finish(name, { tool_calls: [{ index: 0, id: 'read-note', type: 'function', function: { name: 'read', arguments: '{"path":"note.txt"}' } }] }, 'tool_calls')
    await vi.waitFor(() => expect(requests.get(name)).toHaveLength(2))
  }
  await vi.waitFor(() => expect([...requests.values()].map(turns => turns.length)).toEqual([2, 2]))
  for (const [name, directory, ownResult, otherResult] of [
    ['项目青禾', aPath, '青禾独有', '白榆独有'],
    ['项目白榆', selected, '白榆独有', '青禾独有'],
  ] as const) {
    const [, followup] = requests.get(name)!
    expect(followup![0]!.content).toContain(directory)
    expect(followup!.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'read-note', content: expect.stringContaining(ownResult) })
    expect(JSON.stringify(followup)).not.toContain(otherResult)
  }
  pending.get('项目青禾')!.enqueue(reply({ content: '青禾进行中' }, null))
  await vi.waitFor(async () => expect((await serverSnapshot(app.url, auth, a)).messages.at(-1)?.message).toMatchObject({
    role: 'assistant', content: [{ type: 'text', text: '青禾进行中' }],
  }))
  const stopped = await post('/api/abort', { sessionId: a, runId: aRun })
  expect(JSON.parse(stopped.text)).toEqual({ sessionId: a, runId: aRun, handled: true })
  expect([...aborted]).toEqual(['项目青禾'])
  const aStopped = await serverSnapshot(app.url, auth, a)
  expect(aStopped.running).toBeNull()
  expect(aStopped.messages.at(-1)?.message).toMatchObject({
    role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: '青禾进行中' }],
  })
  expect((await serverSnapshot(app.url, auth, b)).running).toMatchObject({ runId: bRun })
  finish('项目白榆', { content: '白榆完成' }, 'stop')
  await vi.waitFor(async () => {
    const bDone = await serverSnapshot(app.url, auth, b)
    expect(bDone.running).toBeNull()
    expect(bDone.messages.at(-1)?.message).toMatchObject({
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '白榆完成' }],
    })
  })
})

it('服务关闭同时停止两个会话并等待各自收尾', async () => {
  const tasks = Array.from({ length: 2 }, () => ({
    entered: Promise.withResolvers<void>(),
    cancelled: Promise.withResolvers<void>(),
    finish: Promise.withResolvers<void>(),
  }))
  let created = 0
  const app = await setup({
    createSession(resolveDirectory) {
      const task = tasks[created++]!
      return new AgentSession({ resolveDirectory, stream: (model, _context, options) => ({
        result: () => new Promise(() => {}),
        async *[Symbol.asyncIterator]() {
          const partial = { role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'pending' as const, timestamp: 1 }
          yield { type: 'start' as const, partial }
          const signal = options!.signal!
          task.entered.resolve()
          if (!signal.aborted) await once(signal, 'abort')
          task.cancelled.resolve()
          await task.finish.promise
          yield { type: 'error' as const, reason: 'aborted' as const, error: { ...partial, stopReason: 'aborted' as const } }
        },
      }) })
    },
  })
  const auth = await cookie(app.authUrl), headers = { Cookie: auth, 'Content-Type': 'application/json' }
  const workspaceId = await pickWorkspace(app.url, auth)
  const sessions = await Promise.all([createSession(app.url, auth, workspaceId), createSession(app.url, auth, workspaceId)])
  expect(sessions.map(session => session.name).sort()).toEqual(['会话 1', '会话 2'])
  try {
    const replies = await Promise.all(sessions.map(({ id: sessionId }) => http(app.url + '/api/messages', headers, 'POST', JSON.stringify({
      sessionId, clientMessageId: 'closing', modelId: 'deepseek-flash', text: '等待关闭',
    }))))
    expect(replies.map(reply => reply.status)).toEqual([202, 202])
    await Promise.all(tasks.map(task => task.entered.promise))
    let closed = false
    const closing = app.server.close().then(() => { closed = true })
    await Promise.all(tasks.map(task => task.cancelled.promise))
    expect(closed).toBe(false)
    const rejected = await http(app.url + '/api/sessions', headers, 'POST', JSON.stringify({ workspaceId }))
    expect(rejected.status).toBe(503)
    tasks[0]!.finish.resolve()
    await new Promise(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    tasks[1]!.finish.resolve()
    await closing
    expect(closed).toBe(true)
  } finally { for (const task of tasks) task.finish.resolve() }
})

it('首发按绑定工作区选说明，真实 edit 后续轮刷新，同目录的会话历史各自独立', async () => {
  type WireMessage = { role: string; content: string; tool_call_id?: string }
  const requests: WireMessage[][] = []
  let selected = ''
  const app = await setup({ directoryPicker: async () => selected, modelOptions: { fetch: async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)) as { messages: WireMessage[] }
    requests.push(messages)
    const edit = messages.at(-1)?.content === '首发 B'
    const delta = edit ? { tool_calls: [{ index: 0, id: 'edit-context', type: 'function', function: {
      name: 'edit', arguments: JSON.stringify({ path: 'AGENTS.md', edits: [{ oldText: '项目说明 B 旧版', newText: '项目说明 B 新版' }] }),
    } }] } : { content: '任务已完成' }
    return new Response(`data: ${JSON.stringify({ id: 'project-context', choices: [{ index: 0, delta, finish_reason: edit ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
  } } })
  const aPath = app.workspace, bPath = join(aPath, '..', 'workspace-b')
  await mkdir(bPath)
  await mkdir(app.config.globalContextDirectory)
  await Promise.all([
    writeFile(join(aPath, 'AGENTS.md'), '项目说明 A'),
    writeFile(join(bPath, 'AGENTS.md'), '项目说明 B 旧版'),
    writeFile(join(app.config.globalContextDirectory, 'AGENTS.md'), '测试全局说明'),
  ])
  const auth = await cookie(app.authUrl), headers = { Cookie: auth, 'Content-Type': 'application/json' }
  const post = (route: string, payload: object) => http(app.url + route, headers, 'POST', JSON.stringify(payload))
  expect((await http(app.url + '/api/providers/deepseek', headers, 'PUT', '{"apiKey":"test-key"}')).status).toBe(200)
  selected = aPath
  const a = await pickSession(app.url, auth)
  selected = bPath
  const workspaceId = await pickWorkspace(app.url, auth)
  const input = { modelId: 'deepseek-flash' }
  const first = await post('/api/sessions/start', { ...input, workspaceId, clientMessageId: randomUUID(), text: '首发 B' })
  expect(first.status).toBe(202)
  const { session: b } = JSON.parse(first.text) as { session: SessionSummary }
  expect(b.workspaceId).toBe(workspaceId)
  const idle = async (id: string, count: number) => {
    let result!: ConversationSnapshot
    await vi.waitFor(async () => {
      expect(requests).toHaveLength(count)
      result = await serverSnapshot(app.url, auth, id)
      expect(result.running).toBeNull()
    })
    return result
  }
  const afterEdit = await idle(b.id, 2)
  expect(afterEdit.messages).toContainEqual(expect.objectContaining({
    message: expect.objectContaining({ role: 'toolResult', toolCallId: 'edit-context', isError: false }),
  }))
  expect(await readFile(join(bPath, 'AGENTS.md'), 'utf8')).toBe('项目说明 B 新版')
  expect(requests[0][0].content).toContain('项目说明 B 旧版')
  expect(requests[0][0].content).not.toContain('项目说明 A')
  expect(requests[1][0].content).toContain('项目说明 B 新版')
  expect(requests[1][0].content).not.toContain('项目说明 B 旧版')
  expect(requests[1].at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'edit-context' })
  expect(requests[0][0].content.indexOf('测试全局说明')).toBeLessThan(requests[0][0].content.indexOf('项目说明 B 旧版'))
  expect(requests[0][0].content).toContain('测试全局说明')

  const submit = (sessionId: string, text: string) => post('/api/messages', { ...input, sessionId, clientMessageId: randomUUID(), text })
  expect((await submit(a, '会话 A 私有消息')).status).toBe(202)
  await idle(a, 3)
  expect(requests[2][0].content).toContain('项目说明 A')
  expect(requests[2][0].content).not.toContain('项目说明 B')
  const c = await createSession(app.url, auth, workspaceId)
  expect((await submit(c.id, '会话 C 私有消息')).status).toBe(202)
  await idle(c.id, 4)
  expect((await submit(b.id, '继续 B')).status).toBe(202)
  await idle(b.id, 5)
  expect((await submit(c.id, '继续 C')).status).toBe(202)
  await idle(c.id, 6)
  expect(requests[4][0]).toEqual(requests[5][0])
  expect(requests[4][0].content).toContain('项目说明 B 新版')
  expect(requests[4].filter(message => message.role === 'user').map(message => message.content)).toEqual(['首发 B', '继续 B'])
  expect(requests[5].filter(message => message.role === 'user').map(message => message.content)).toEqual(['会话 C 私有消息', '继续 C'])
})

describe('Feature 10 会话库', () => {
  const answer = [{ type: 'text', text: '已完成本轮' }] as const
  const modelId = 'deepseek-flash'
  type Write = Parameters<SessionStore['save']>[1]
  type Content = AssistantMessage['content']

  function controlledStream(reply: (context: ModelContext) => readonly Content[number][]) {
    const calls: ModelContext[] = []
    const stream: NonNullable<ConstructorParameters<typeof AgentSession>[0]['stream']> = (model, context) => {
      calls.push(structuredClone(context))
      const content = [...reply(context)]
      const stopReason = content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop'
      const message: AssistantMessage = { role: 'assistant', model: model.id, provider: model.provider, api: model.api,
        content, stopReason, timestamp: Date.now(), usage: { input: 120 } }
      return {
        result: async () => message,
        async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
          yield { type: 'start', partial: { ...message, stopReason: 'pending', content: [] } }
          yield { type: 'done', reason: stopReason, message }
        },
      }
    }
    return { stream, calls }
  }

  function writes(shouldFail: (data: Write) => boolean = () => false) {
    const original = SessionStore.prototype.save
    const saved: Write[] = []
    const attempted: Write[] = []
    let store!: SessionStore
    vi.spyOn(SessionStore.prototype, 'save').mockImplementation(function (this: SessionStore, id, data) {
      store = this
      attempted.push(structuredClone(data))
      if (shouldFail(data)) throw new SessionWriteError('storage-full')
      original.call(this, id, data)
      saved.push(structuredClone(data))
    })
    return { saved, attempted, load: (id: string) => store.loadSession(id) }
  }

  async function client(app: { url: string; authUrl: string }) {
    const auth = await cookie(app.authUrl)
    const headers = { Cookie: auth, 'Content-Type': 'application/json' }
    const post = (path: string, data: object) => http(app.url + path, headers, 'POST', JSON.stringify(data))
    return {
      auth,
      first: (workspaceId: string, text: string, clientMessageId = randomUUID()) => post('/api/sessions/start', { workspaceId, clientMessageId, modelId, text }),
      send: (sessionId: string, text: string, clientMessageId = randomUUID()) => post('/api/messages', { sessionId, clientMessageId, modelId, text }),
      abort: (sessionId: string, runId: string) => post('/api/abort', { sessionId, runId }),
      list: async () => JSON.parse((await http(app.url + '/api/sessions', headers)).text).sessions as SessionSummary[],
      snapshot: (id: string) => serverSnapshot(app.url, auth, id),
      idle: async (id: string) => {
        let snapshot!: ConversationSnapshot
        await vi.waitFor(async () => { snapshot = await serverSnapshot(app.url, auth, id); expect(snapshot.running).toBeNull() })
        return snapshot
      },
    }
  }

  it('01/03/04/05 先提交首发三项才调用模型，保存拒绝不启动，重启重试返回原回执和空会话', async () => {
    const storage = writes(data => data.run?.status === 'running' && data.run.text === '磁盘拒绝')
    const provider = controlledStream(() => {
      expect(storage.saved[0]).toMatchObject({
        summary: { id: expect.any(String) },
        run: { status: 'running' }, messages: [{ message: { role: 'user', content: '记住代号青禾' } }],
      })
      return answer
    })
    const dir = await mkdtemp(join(tmpdir(), 'feature10-retry-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const app = await setup({
      sessionPath: join(dir, 'sessions.sqlite'),
      createSession: (resolveDirectory, persistence) => new AgentSession({ resolveDirectory, persistence, stream: provider.stream }),
    })
    const ui = await client(app)
    const workspaceId = await pickWorkspace(app.url, ui.auth)
    const rejected = await ui.first(workspaceId, '磁盘拒绝')
    expect(rejected.status).toBe(507)
    expect(JSON.parse(rejected.text)).toMatchObject({ code: 'save_rejected' })
    expect(await ui.list()).toEqual([])
    expect(provider.calls).toHaveLength(0)
    const clientId = randomUUID()
    const first = await ui.first(workspaceId, '记住代号青禾', clientId)
    expect(first.status).toBe(202)
    const { session, accepted } = JSON.parse(first.text)
    expect(storage.load(clientId)?.runs[0]?.id).toBe(accepted.userMessageId)
    const settled = await ui.idle(session.id)
    expect(settled.runs?.[0]).toMatchObject({ status: 'completed' })
    const before = storage.load(session.id)
    expect((await ui.send(session.id, '磁盘拒绝')).status).toBe(507)
    expect(storage.load(session.id)).toEqual(before)
    expect(await ui.snapshot(session.id)).toEqual(settled)
    expect(provider.calls).toHaveLength(1)

    const emptySession = await createSession(app.url, ui.auth, workspaceId)
    await app.server.close()
    const restarted = new WebServer(app.config)
    cleanups.push(() => restarted.close())
    const reopened = await client(await restarted.start())
    expect(await reopened.list()).toEqual([session, emptySession])
    expect(await reopened.snapshot(emptySession.id)).toMatchObject({ messages: [], running: null })
    const replayed = await reopened.first(workspaceId, '记住代号青禾', clientId)
    expect(replayed.status).toBe(202)
    expect(JSON.parse(replayed.text)).toEqual(JSON.parse(first.text))
    expect((await reopened.first(workspaceId, '另一条原文', clientId)).status).toBe(409)
    expect((await reopened.snapshot(session.id)).messages).toEqual(settled.messages)
    expect(provider.calls).toHaveLength(1)
  })

  it.each(['tool-call', 'sequential', 'parallel', 'parallel-fail', 'tool-error', 'abort'] as const)(
    '06–10/13/16 工具保存关口与收尾 %s', async scenario => {
      const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
      const stopped = Promise.withResolvers<void>()
      const started: string[] = [], completed: string[] = []
      const calls = ['A', 'B', 'C'].map(id => ({ type: 'toolCall' as const, id, name: 'probe', arguments: { id } }))
      const provider = controlledStream(context => context.messages.at(-1)?.role === 'user' ? calls : answer)
      const storage = writes(data => {
        const message = data.messages?.[0]?.message
        return scenario === 'tool-call' && message?.role === 'assistant' && message.stopReason === 'toolUse'
          || (scenario === 'sequential' || scenario === 'parallel-fail') && message?.role === 'toolResult' && message.toolCallId === 'B'
      })
      const app = await setup({
        sessionPath: ':memory:',
        createSession: (resolveDirectory, persistence) => new AgentSession({
          resolveDirectory, persistence, stream: provider.stream,
          tools: cwd => [{
            name: 'probe', description: '验证工具写入时序', parameters: Type.Object({ id: Type.String() }),
            executionMode: scenario === 'sequential' ? 'sequential' : 'parallel',
            execute: async ({ id }, { signal }) => {
              signal.addEventListener('abort', () => stopped.resolve(), { once: true })
              const name = String(id)
              expect(storage.saved.some(data => data.messages?.[0]?.message.role === 'assistant')).toBe(true)
              started.push(name)
              await gates[['A', 'B', 'C'].indexOf(name)]!.promise
              if (scenario === 'tool-error' && name === 'A') throw new Error('文件不存在')
              await writeFile(join(cwd, name), '实际执行')
              completed.push(name)
              return name
            },
          }],
        }),
      })
      const ui = await client(app)
      const workspaceId = await pickWorkspace(app.url, ui.auth)
      try {
        const response = await ui.first(workspaceId, '执行三个工具')
        expect(response.status).toBe(202)
        const { session, accepted } = JSON.parse(response.text)
        const savedCalls = () => storage.load(session.id)?.messages.flatMap(({ message }) => message.role === 'toolResult' ? [message.toolCallId] : [])
        const socket = await connect(app.url, ui.auth)
        const notifications: string[] = []
        socket.on('message', data => {
          const message = JSON.parse(String(data)).update?.change?.message?.message
          if (message?.role === 'toolResult') notifications.push(message.toolCallId)
        })
        const subscribed = nextConversationFrame(socket)
        socket.send(JSON.stringify({ type: 'subscribe', sessionId: session.id, subscriptionId: 'tool-checkpoints' }))
        await subscribed
        if (scenario === 'tool-call') {
          const done = await ui.idle(session.id)
          expect(done.saveFailures).toEqual([expect.objectContaining({ stage: 'tool-call' })])
          expect(storage.load(session.id)?.messages).toHaveLength(1)
          expect(started).toEqual([])
          await expect(readFile(join(app.workspace, 'A'))).rejects.toMatchObject({ code: 'ENOENT' })
        } else if (scenario === 'sequential') {
          await vi.waitFor(() => expect(started).toEqual(['A']))
          gates[0]!.resolve()
          await vi.waitFor(() => expect(started).toEqual(['A', 'B']))
          expect(savedCalls()).toEqual(['A'])
          gates[1]!.resolve()
        } else {
          await vi.waitFor(() => expect(started).toEqual(['A', 'B', 'C']))
          gates[2]!.resolve()
          await vi.waitFor(() => expect(completed).toEqual(['C']))
          expect(savedCalls()).toEqual([])
          expect(notifications).toEqual([])
          expect((await ui.snapshot(session.id)).messages.map(entry => entry.message.role)).toEqual(['user', 'assistant'])
          if (scenario === 'abort') {
            const stop = ui.abort(session.id, accepted.userMessageId)
            await stopped.promise
            gates[0]!.resolve()
            gates[1]!.resolve()
            expect(JSON.parse((await stop).text).handled).toBe(true)
          } else {
            gates[0]!.resolve()
            gates[1]!.resolve()
          }
        }

        const snapshot = await ui.idle(session.id)
        const order = scenario === 'tool-call' ? [] : scenario === 'sequential' || scenario === 'parallel-fail' ? ['A'] : ['A', 'B', 'C']
        expect(savedCalls()).toEqual(order)
        await vi.waitFor(() => expect(notifications).toEqual(order))
        expect(provider.calls).toHaveLength(scenario === 'parallel' || scenario === 'tool-error' ? 2 : 1)
        if (scenario === 'abort') expect(snapshot.runs?.[0]?.status).toBe('aborted')
        if (scenario === 'sequential' || scenario === 'parallel-fail') {
          expect(snapshot.saveFailures).toEqual([{ runId: accepted.userMessageId, stage: 'tool-result', reason: 'storage-full',
            toolCall: { assistantMessageId: snapshot.messages[1]?.id, contentIndex: 1 } }])
          expect(snapshot.runs?.[0]?.status).toBe('failed')
          expect(await readFile(join(app.workspace, 'B'), 'utf8')).toBe('实际执行')
          expect(started.includes('C')).toBe(scenario === 'parallel-fail')
          expect((await ui.snapshot(session.id)).saveFailures).toEqual(snapshot.saveFailures)
        }
        if (scenario === 'tool-error') {
          expect(provider.calls[1]?.messages).toContainEqual(expect.objectContaining({ role: 'toolResult', toolCallId: 'A', isError: true,
            content: [{ type: 'text', text: '文件不存在' }] }))
        }
      } finally { for (const gate of gates) gate.resolve() }
    },
  )

  it.each([1, 2])('11/12 最终文字事务重试，模拟 %i 次写入失败', async failureCount => {
    let attempts = 0
    const storage = writes(data => data.messages?.[0]?.message.role === 'assistant' && ++attempts <= failureCount)
    const provider = controlledStream(() => answer)
    const app = await setup({
      sessionPath: ':memory:',
      createSession: (resolveDirectory, persistence) => new AgentSession({ resolveDirectory, persistence, stream: provider.stream }),
    })
    const ui = await client(app)
    const workspaceId = await pickWorkspace(app.url, ui.auth)
    const { session } = JSON.parse((await ui.first(workspaceId, '核对启动命令')).text)
    const snapshot = await ui.idle(session.id)
    expect(snapshot.messages.at(-1)?.message.content).toEqual(answer)
    expect(attempts).toBe(2)
    expect(provider.calls).toHaveLength(1)
    const history = storage.load(session.id)
    if (failureCount === 1) {
      expect(history?.messages).toHaveLength(2)
      expect(history?.runs[0].status).toBe('completed')
      expect(snapshot.saveFailures).toBeUndefined()
    } else {
      expect(history?.messages).toHaveLength(1)
      expect(history?.runs[0].status).toBe('running')
      expect(snapshot.saveFailures).toEqual([expect.objectContaining({ stage: 'answer' })])
      expect(snapshot.runs?.[0]?.status).toBe('failed')
    }
  })

  it('15 新摘要的写入失败不替换原摘要，也不影响下一轮使用原上下文', async () => {
    let failCompaction = false
    const storage = writes(data => failCompaction && data.compaction?.status === 'success')
    const provider = controlledStream(context => context.tools?.length || !context.systemPrompt?.startsWith('你负责整理')
      ? [{ type: 'text', text: '已记录。'.repeat(30) }] : [{ type: 'text', text: '旧事实是青禾。' }])
    const app = await setup({
      sessionPath: ':memory:',
      createSession: (resolveDirectory, persistence) => new AgentSession({ resolveDirectory, persistence, stream: provider.stream,
        compaction: { triggerTokens: 20_000, keepRecentTokens: 30 } }),
    })
    const ui = await client(app)
    const id = await pickSession(app.url, ui.auth)
    for (const prompt of ['旧事实青禾'.repeat(100), '第一段近期'.repeat(100), '/compact']) {
      expect((await ui.send(id, prompt)).status).toBe(202)
      await ui.idle(id)
    }
    const previous = storage.load(id)?.compactions[0]
    expect(previous).toMatchObject({ status: 'success' })
    expect((await ui.send(id, '另一段近期'.repeat(100))).status).toBe(202)
    await ui.idle(id)
    failCompaction = true
    expect((await ui.send(id, '/compact')).status).toBe(202)
    const failed = await ui.idle(id)
    expect(failed.saveFailures).toEqual([expect.objectContaining({ stage: 'compaction' })])
    expect(failed.compactions.map(record => record.status)).toEqual(['success', 'failed'])
    expect(storage.load(id)?.compactions[0]).toMatchObject({ id: previous?.id, status: 'success' })
    expect((await ui.send(id, '继续原会话')).status).toBe(202)
    await ui.idle(id)
    expect(provider.calls.at(-1)?.messages[0]).toMatchObject({ content: expect.stringContaining('旧事实是青禾。') })
  })

  it('28 历史读取失败只返回错误，重新订阅可取得同一段完整记录', async () => {
    const app = await setup()
    const ui = await client(app)
    const id = await pickSession(app.url, ui.auth)
    await app.server.close()
    const restarted = new WebServer(app.config)
    cleanups.push(() => restarted.close())
    const next = await restarted.start()
    const reopened = await client(next)
    expect((await reopened.list()).map(item => item.id)).toEqual([id])
    const load = vi.spyOn(SessionStore.prototype, 'loadSession')
    load.mockImplementationOnce(() => { throw new SessionReadError('无法读取完整会话历史，请重试') })
    const socket = await connect(next.url, reopened.auth)
    const first = nextConversationFrame(socket)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId: id, subscriptionId: 'failed-read' }))
    expect(await first).toEqual({ type: 'subscription_error', sessionId: id, subscriptionId: 'failed-read', error: '无法读取完整会话历史，请重试' })
    load.mockImplementationOnce(() => { throw new SessionReadError('无法读取完整会话历史，请重试') })
    expect((await reopened.send(id, '不能在半份历史上发送')).status).toBe(500)
    const second = nextConversationFrame(socket)
    socket.send(JSON.stringify({ type: 'subscribe', sessionId: id, subscriptionId: 'retry-read' }))
    expect(await second).toMatchObject({ type: 'snapshot', subscriptionId: 'retry-read', snapshot: { messages: [], running: null } })
  })
})
