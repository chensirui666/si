import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { WebServer } from '../src/webserver/index.js'
import type { Agent, AgentSubscriptionEvent } from '@agent-learning/agent'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
async function setup(options: Partial<ConstructorParameters<typeof WebServer>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-server-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const webRoot = join(dir, 'web')
  await mkdir(join(webRoot, 'assets'), { recursive: true })
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><h1>聊天</h1>')
  await writeFile(join(webRoot, 'assets/app.js'), 'console.log("app")')
  const config = { port: 0, webRoot, browserSecretPath: join(dir, 'private/browser-auth.json'), modelAuthPath: join(dir, 'private/auth.json'), ...options }
  const server = new WebServer(config)
  const started = await server.start()
  cleanups.push(() => server.close())
  return { server, ...started, config }
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
      if (frame.type === 'models_changed') return
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
const empty = { seq: 0, messages: [], running: null, activeContent: [] }
function controlledAgent() {
  const active = new Set<AbortSignal>()
  return {
    active,
    subscribe(signal: AbortSignal): AsyncIterable<AgentSubscriptionEvent> {
      active.add(signal)
      signal.addEventListener('abort', () => active.delete(signal), { once: true })
      return (async function* () {
        try {
          yield { type: 'snapshot' as const, snapshot: structuredClone(empty) }
          yield { type: 'update' as const, update: { seq: 1, change: { type: 'accepted' as const, user: { id: 'u1', message: { role: 'user' as const, content: '受控', timestamp: 1 } }, running: { userMessageId: 'u1', assistantMessageId: 'a1' } } } }
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
    const socket = await connect(app.url, credentials)
    now += 30 * 86400000
    expect((await http(app.url, { Cookie: credentials })).status).toBe(401)
    expect(await rejectedHandshake(app.url, { Cookie: credentials })).toBe(401)
    const next = nextConversationFrame(socket)
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'after-expiry' }))
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
    const a = await connect(app.url, credentials)
    const b = await connect(app.url, credentials)
    const frames: any[][] = [[], []]
    for (const [index, socket] of [a, b].entries()) {
      socket.on('message', value => frames[index]!.push(JSON.parse(String(value))))
      socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: `models-${index}` }))
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

describe('Agent 订阅转发与清理', () => {
  it('握手不订阅，当前编号收到真实空快照，多页面共享 Agent', async () => {
    const app = await setup()
    const credentials = await cookie(app.authUrl)
    for (const subscriptionId of ['one', 'two']) {
      const socket = await connect(app.url, credentials)
      const next = nextConversationFrame(socket)
      socket.send(JSON.stringify({ type: 'subscribe', subscriptionId }))
      expect(await next).toEqual({ type: 'snapshot', subscriptionId, snapshot: empty })
    }
  })
  it('受控源先快照后更新，替换/取消只释放所属订阅和连接', async () => {
    const agent = controlledAgent()
    const app = await setup({ agent })
    const credentials = await cookie(app.authUrl)
    const socket = await connect(app.url, credentials)
    const other = await connect(app.url, credentials)
    expect(agent.active.size).toBe(0)
    const frames: any[] = []
    socket.on('message', data => { const frame = JSON.parse(String(data)); if (frame.type !== 'models_changed') frames.push(frame) })
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'old' }))
    await vi.waitFor(() => expect(frames).toHaveLength(2))
    expect(frames.map(frame => frame.type)).toEqual(['snapshot', 'update'])
    expect(frames[1].update.seq).toBe(1)
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'new' }))
    other.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'other' }))
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
  it.each(['{', '{"type":"subscribe","subscriptionId":""}', '{"type":"subscribe","subscriptionId":2}', '{"type":"unknown"}'])('非法帧 %s 关闭所属连接且释放订阅', async frame => {
    const agent = controlledAgent()
    const app = await setup({ agent })
    const credentials = await cookie(app.authUrl)
    const bad = await connect(app.url, credentials)
    const good = await connect(app.url, credentials)
    bad.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'bad' }))
    good.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'good' }))
    await vi.waitFor(() => expect(agent.active.size).toBe(2))
    const closed = once(bad, 'close')
    bad.send(frame)
    expect((await closed)[0]).toBe(1008)
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    expect(good.readyState).toBe(WebSocket.OPEN)
  })
  it('发送失败只清理所属连接与订阅', async () => {
    const agent = controlledAgent()
    const app = await setup({ agent })
    const credentials = await cookie(app.authUrl)
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
    failed.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'fail' }))
    good.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'good' }))
    await closed
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    expect(good.readyState).toBe(WebSocket.OPEN)
  })
  it('发送缓冲超限只清理慢连接，其他页面仍可订阅', async () => {
    const agent = controlledAgent()
    const app = await setup({ agent })
    const credentials = await cookie(app.authUrl)
    const slow = await connect(app.url, credentials)
    const good = await connect(app.url, credentials)
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValueOnce(1024 * 1024 + 1)
    const closed = once(slow, 'close')
    slow.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'slow' }))
    await closed
    const next = nextConversationFrame(good)
    good.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'good' }))
    expect((await next).snapshot).toEqual(empty)
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    expect(good.readyState).toBe(WebSocket.OPEN)
  })
  it('旧订阅取消后延迟报错不能关闭替换的新订阅', async () => {
    let calls = 0
    let failOld!: () => void
    const agent = {
      subscribe(signal: AbortSignal): AsyncIterable<AgentSubscriptionEvent> {
        const old = ++calls === 1
        return (async function* () {
          yield { type: 'snapshot' as const, snapshot: structuredClone(empty) }
          if (old) { await new Promise<void>(resolve => { failOld = resolve }); throw new Error('old failure') }
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        })()
      },
    }
    const app = await setup({ agent })
    const socket = await connect(app.url, await cookie(app.authUrl))
    const frames: any[] = []
    socket.on('message', data => { const frame = JSON.parse(String(data)); if (frame.type !== 'models_changed') frames.push(frame) })
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'old' }))
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'new' }))
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
    const app = await setup({ agent })
    const credentials = await cookie(app.authUrl)
    const socket = await connect(app.url, credentials, {}, false)
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'heart' }))
    await vi.waitFor(() => expect(agent.active.size).toBe(1))
    heartbeat!()
    heartbeat!()
    const closed = once(socket, 'close')
    heartbeat!()
    await closed
    await vi.waitFor(() => expect(agent.active.size).toBe(0))
    const live = await connect(app.url, credentials)
    live.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'live' }))
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
    const app = await setup({ agent })
    const socket = await connect(app.url, await cookie(app.authUrl))
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'paused' }))
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
    const conflict = new WebServer({ ...app.config, port: Number(new URL(app.url).port) })
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
  const message = { clientMessageId: 'local-http', modelId: 'deepseek-flash', text: '  原文\n保留  ' }

  it('提交沿用授权和来源校验，拒绝无效输入，不写正式消息', async () => {
    const app = await setup()
    const auth = await cookie(app.authUrl)
    const headers = { Cookie: auth, 'Content-Type': 'application/json' }
    expect((await http(app.url + '/api/messages', {}, 'POST', JSON.stringify(message))).status).toBe(401)
    expect((await http(app.url + '/api/messages', { ...headers, Origin: 'https://evil.invalid' }, 'POST', JSON.stringify(message))).status).toBe(403)
    expect((await http(app.url + '/api/messages', { Cookie: auth }, 'POST', JSON.stringify(message))).status).toBe(415)
    for (const body of ['{', 'null', '{}', JSON.stringify({ ...message, extra: true }), JSON.stringify({ ...message, text: ' \n ' }), JSON.stringify({ ...message, modelId: 'unknown' }), JSON.stringify({ ...message, clientMessageId: 'x'.repeat(129) })]) {
      expect((await http(app.url + '/api/messages', headers, 'POST', body)).status).toBe(400)
    }
    expect((await http(app.url + '/api/messages', headers, 'POST', JSON.stringify({ ...message, text: 'x'.repeat(65536) }))).status).toBe(413)
    const socket = await connect(app.url, auth)
    const first = nextConversationFrame(socket)
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'after-rejects' }))
    expect((await first).snapshot).toEqual({ seq: 0, messages: [], running: null, activeContent: [] })
  })

  it('凭据未配置也先回执，随后形成正式失败回复并释放忙碌', async () => {
    const app = await setup()
    const auth = await cookie(app.authUrl)
    const response = await http(app.url + '/api/messages', { Cookie: auth, 'Content-Type': 'application/json' }, 'POST', JSON.stringify(message))
    expect(response.status).toBe(202)
    expect(JSON.parse(response.text)).toMatchObject({ clientMessageId: 'local-http', userMessageId: expect.any(String), acceptedSeq: 1 })
    const socket = await connect(app.url, auth)
    const frames: any[] = []
    socket.on('message', data => { frames.push(JSON.parse(String(data))) })
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'missing-key' }))
    await vi.waitFor(() => expect(frames.find(frame => frame.type === 'snapshot')?.snapshot.messages).toHaveLength(2))
    const snapshot = frames.find(frame => frame.type === 'snapshot').snapshot
    expect(snapshot.running).toBeNull()
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
    const socket = await connect(app.url, auth)
    const frames: any[] = []
    socket.on('message', data => frames.push(JSON.parse(String(data))))
    socket.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'live' }))
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'snapshot')).toBe(true))
    const response = await http(app.url + '/api/messages', headers, 'POST', JSON.stringify(message))
    expect(response.status).toBe(202)
    await vi.waitFor(() => expect(calls).toBe(1))
    expect((await http(app.url + '/api/messages', headers, 'POST', JSON.stringify(message))).status).toBe(409)
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
    restored.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'restored' }))
    const snapshot = (await first).snapshot
    expect(snapshot.running?.userMessageId).toBe(JSON.parse(response.text).userMessageId)
    expect(snapshot.messages[1].message.content).toEqual([{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: 'AB' }])
    expect(calls).toBe(1)
    await app.server.close()
    expect(aborted).toBe(true)
  })
})
