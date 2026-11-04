import { fork, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConversationSnapshot, ConversationUpdate } from '@agent-learning/agent'
import { expect, type Page } from '@playwright/test'
import { WebSocket } from 'ws'

const webDirectory = fileURLToPath(new URL('../..', import.meta.url))
const fixturePath = fileURLToPath(new URL('./server-fixture.mjs', import.meta.url))
const vitePath = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js')
export const devUrl = 'http://127.0.0.1:5173'
export const emptySnapshot = { seq: 0, messages: [], running: null, activeContent: [] }

type Started = { url: string; authUrl: string; devAuthUrl: string }

export async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill(signal)
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { await exited } finally { clearTimeout(deadline) }
}

export function waitForStart(child: ChildProcess): Promise<Started> {
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
      const value = data as { type: string; result: Started }
      if (value.type === 'started') { cleanup(); resolve(value.result) }
      else if (value.type === 'error') fail()
    }
    child.on('message', message)
    child.once('error', fail)
    child.once('exit', fail)
  })
}

export async function startBackend(secretPath: string, port = 0, modelBaseURL = '') {
  const child = fork(fixturePath, [String(port), secretPath], {
    env: { ...process.env, AGENT_LEARNING_E2E_MODEL_BASE_URL: modelBaseURL },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  try { return { child, result: await waitForStart(child) } }
  catch (error) { await stop(child); throw error }
}

export async function startVite(port: number) {
  const child = spawn(process.execPath, [vitePath], {
    cwd: webDirectory,
    env: { ...process.env, AGENT_LEARNING_SERVER_PORT: String(port) },
    stdio: 'ignore',
  })
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error('Vite 未启动；请检查 5173 端口和配置')
      return httpStatus(devUrl + '/@vite/client').catch(() => 0)
    }, { timeout: 10_000 }).toBe(200)
    return child
  } catch (error) { await stop(child); throw error }
}

export function httpStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
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

export function wsStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
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

export function observe(page: Page) {
  const snapshots: { subscriptionId: string; snapshot: ConversationSnapshot }[] = []
  const updates: { subscriptionId: string; update: ConversationUpdate }[] = []
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
        if (frame.type === 'update') updates.push({ subscriptionId: frame.subscriptionId, update: frame.update })
      } catch { /* 非 JSON 帧由真实网页处理。 */ }
    })
  })
  return { snapshots, updates, submissions, get closed() { return closed } }
}

export async function ready(page: Page, observed: ReturnType<typeof observe>, after = 0, empty = true) {
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready')
  await expect.poll(() => observed.snapshots.length).toBeGreaterThan(after)
  if (empty) expect(observed.snapshots.at(-1)?.snapshot).toEqual(emptySnapshot)
}

export async function saveKey(page: Page, key: string) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  if (await dialog.getByRole('button', { name: '编辑', exact: true }).count()) {
    await dialog.getByRole('button', { name: '编辑', exact: true }).click()
  } else {
    await dialog.getByRole('button', { name: '添加提供方', exact: true }).click()
    await dialog.getByRole('button', { name: 'DeepSeek', exact: true }).click()
  }
  try { await dialog.getByLabel('API Key', { exact: true }).fill(key) }
  catch { throw new Error('API Key 输入失败，内容已省略') }
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toContainText('已保存在本机')
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveText('DeepSeek Flash')
}

export async function authorize(page: Page, url: string) {
  try { await page.goto(url) }
  catch { throw new Error('授权导航失败，临时令牌已省略') }
}
