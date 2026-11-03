import { fork, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { WebSocket } from 'ws'

const webDirectory = fileURLToPath(new URL('../..', import.meta.url))
const fixturePath = fileURLToPath(new URL('./server-fixture.mjs', import.meta.url))
const vitePath = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js')
const devUrl = 'http://127.0.0.1:5173'
const emptySnapshot = { seq: 0, messages: [], running: null, activeContent: [] }

type Started = { url: string; authUrl: string; devAuthUrl: string }
type FixtureMessage = { type: 'started'; result: Started } | { type: 'error' }

async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill(signal)
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { await exited } finally { clearTimeout(deadline) }
}

function waitForStart(child: ChildProcess): Promise<Started> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(), 10_000)
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', message)
      child.off('error', fail)
      child.off('exit', fail)
    }
    const fail = () => { cleanup(); reject(new Error('测试后端未能启动；请先运行根 npm run build')) }
    const message = (data: unknown) => {
      const value = data as FixtureMessage
      if (value.type === 'started') { cleanup(); resolve(value.result) }
      else if (value.type === 'error') fail()
    }
    child.on('message', message)
    child.once('error', fail)
    child.once('exit', fail)
  })
}

async function startBackend(secretPath: string, port = 0) {
  const child = fork(fixturePath, [String(port), secretPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  try { return { child, result: await waitForStart(child) } }
  catch (error) { await stop(child); throw error }
}

function httpStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, timeout: 3000 }, res => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.once('error', () => reject(new Error('本地 HTTP 请求失败')))
    req.once('timeout', () => req.destroy())
    req.end()
  })
}

function wsStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace(/^http/, 'ws') + '/api/events', { headers, handshakeTimeout: 3000 })
    let responded = false
    socket.once('unexpected-response', (_req, res) => {
      responded = true
      res.resume()
      socket.terminate()
      resolve(res.statusCode ?? 0)
    })
    socket.once('open', () => { responded = true; socket.close(); resolve(101) })
    socket.on('error', () => { if (!responded) reject(new Error('本地 WebSocket 握手失败')) })
  })
}

function observe(page: Page) {
  const snapshots: { subscriptionId: string; snapshot: unknown }[] = []
  let closed = 0
  const submissions: string[] = []
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/messages') submissions.push(req.method()) })
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/events') return
    socket.on('close', () => { closed++ })
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload))
        if (frame.type === 'snapshot') snapshots.push({ subscriptionId: frame.subscriptionId, snapshot: frame.snapshot })
      } catch { /* 非 JSON 帧由真实网页处理。 */ }
    })
  })
  return { snapshots, submissions, get closed() { return closed } }
}

async function ready(page: Page, observed: ReturnType<typeof observe>, after = 0) {
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready')
  await expect(page.getByRole('status')).toHaveText('对话已同步，发送暂未开放')
  await expect.poll(() => observed.snapshots.length).toBeGreaterThan(after)
  expect(observed.snapshots.at(-1)?.snapshot).toEqual(emptySnapshot)
}

for (const mode of ['node', 'vite'] as const) {
  test(`${mode} 实际授权、空快照与恢复`, async ({ page, context }, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agent-learning-stage1-e2e-'))
    const secretPath = join(temporary, 'browser-auth.json')
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined
    let vite: ChildProcess | undefined
    try {
      backend = await startBackend(secretPath)
      const port = Number(new URL(backend.result.url).port)
      if (mode === 'vite') {
        vite = spawn(process.execPath, [vitePath], {
          cwd: webDirectory,
          env: { ...process.env, AGENT_LEARNING_SERVER_PORT: String(port) },
          stdio: 'ignore',
        })
        await expect.poll(async () => {
          if (vite!.exitCode !== null) throw new Error('Vite 未启动；请检查 5173 端口和配置')
          return httpStatus(devUrl + '/@vite/client').catch(() => 0)
        }, { timeout: 10_000 }).toBe(200)
      }
      const origin = mode === 'node' ? backend.result.url : devUrl
      const authUrl = mode === 'node' ? backend.result.authUrl : backend.result.devAuthUrl

      expect(await httpStatus(origin + (mode === 'node' ? '/' : '/auth'))).toBe(401)
      expect(await httpStatus(origin + '/api/events')).toBe(401)
      expect(await wsStatus(origin, { Origin: origin })).toBe(401)
      expect(await httpStatus(authUrl, { Origin: 'https://untrusted.invalid' })).toBe(403)

      const observed = observe(page)
      let redirects = 0
      page.on('response', response => {
        if (new URL(response.url()).searchParams.has('token') && response.status() === 303) redirects++
      })
      try { await page.goto(authUrl) } catch { throw new Error('授权导航失败，临时令牌已省略') }
      await ready(page, observed)
      expect(redirects).toBe(1)
      const cleanUrl = new URL(page.url())
      expect(cleanUrl.origin).toBe(origin)
      expect(cleanUrl.pathname).toBe('/')
      expect(cleanUrl.searchParams.has('token')).toBe(false)

      const cookies = await context.cookies(origin)
      const cookie = cookies.find(value => value.name.startsWith('agent-auth-'))
      expect(Boolean(cookie)).toBe(true)
      if (!cookie) throw new Error('没有收到网页授权 Cookie')
      expect({ httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path }).toEqual({ httpOnly: true, sameSite: 'Strict', path: '/' })
      const payload = JSON.parse(Buffer.from(cookie.value.split('.')[1]!, 'base64url').toString())
      expect(payload.authority).toBe(new URL(origin).host)
      expect(payload.expiresAt - payload.issuedAt).toBe(30 * 86400000)
      const headers = { Cookie: `${cookie.name}=${cookie.value}`, Origin: origin }
      expect(await httpStatus(origin + '/api/events', headers)).toBe(404)
      const rejectedHeaders: Record<string, string>[] = [
        { Origin: 'https://untrusted.invalid' },
        { Origin: 'null' },
        { Host: '127.0.0.1:1' },
        { 'Sec-Fetch-Site': 'cross-site' },
      ]
      for (const extra of rejectedHeaders) {
        expect(await httpStatus(origin + '/api/events', { ...headers, ...extra })).toBe(403)
      }
      expect(await wsStatus(origin, { ...headers, Origin: 'https://untrusted.invalid' })).toBe(403)

      const editor = page.getByRole('textbox', { name: '消息', exact: true })
      const messages = page.getByRole('region', { name: '消息列表' })
      await editor.fill('阶段一草稿')
      await editor.press('Enter')
      await expect(editor).toHaveText('阶段一草稿')
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
      await expect(messages.getByRole('listitem')).toHaveCount(0)

      const second = await context.newPage()
      const secondObserved = observe(second)
      await second.goto(origin)
      await ready(second, secondObserved)
      await expect(second.getByRole('textbox', { name: '消息', exact: true })).toHaveText('')
      await second.close()

      const beforeReload = observed.snapshots.length
      await page.reload()
      await ready(page, observed, beforeReload)
      await expect(editor).toHaveText('')
      await editor.fill('联网恢复前的草稿')
      await context.setOffline(true)
      await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'disconnected')
      await editor.fill('离线期间继续编辑的草稿')
      await expect(editor).toBeFocused()
      const beforeOnline = observed.snapshots.length
      await context.setOffline(false)
      await ready(page, observed, beforeOnline)
      await expect(editor).toHaveText('离线期间继续编辑的草稿')
      await expect(editor).toBeFocused()

      const beforeDisconnect = observed.snapshots.length
      const beforeClosed = observed.closed
      const listeningAgain = waitForStart(backend.child)
      backend.child.send({ type: 'restart-listener' })
      await listeningAgain
      await ready(page, observed, beforeDisconnect)
      expect(observed.closed).toBeGreaterThan(beforeClosed)
      await expect(editor).toHaveText('离线期间继续编辑的草稿')
      expect(observed.snapshots.at(-1)?.subscriptionId === observed.snapshots[beforeDisconnect - 1]?.subscriptionId).toBe(false)

      const beforeRestart = observed.snapshots.length
      await stop(backend.child, 'SIGKILL')
      await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'disconnected')
      await editor.fill('后端重启期间的草稿')
      backend = await startBackend(secretPath, port)
      await ready(page, observed, beforeRestart)
      await expect(editor).toHaveText('后端重启期间的草稿')
      await expect(editor).toBeFocused()
      expect(await httpStatus(origin + '/api/events', headers)).toBe(404)
      expect((await context.cookies(origin)).find(value => value.name === cookie.name)?.value === cookie.value).toBe(true)
      expect(observed.submissions).toEqual([])
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
      await expect(messages.getByRole('listitem')).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath(`${mode}-ready.png`), fullPage: true })
    } finally {
      await Promise.allSettled([context.setOffline(false), stop(vite), stop(backend?.child)])
      await rm(temporary, { recursive: true, force: true })
    }
  })
}
