import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocketRoute } from '@playwright/test'
import { test, expect, type Page } from './chinese-fixture'
import { addWorkspace, authorize, observe, ready, saveKey, seedSession, startBackend, stop } from './test-utils'
import { startModelServer } from './model-server'

const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
const detail = (page: Page) => page.locator('[data-run-detail]').last()
const answer = (page: Page) => page.locator('.assistant-message').last()

async function setup(page: Page) {
  const dir = await mkdtemp(join(tmpdir(), 'model-recovery-'))
  const provider = await startModelServer()
  const secret = join(dir, 'browser-auth.json')
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  let observed = observe(page)
  const close = async () => {
    await stop(backend?.child)
    await provider.close()
    await rm(dir, { recursive: true, force: true })
  }
  try {
    backend = await startBackend(secret, 0, provider.baseURL, undefined, true)
    await authorize(page, backend.result.authUrl)
    await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, 'controlled-stage3-key')
    return {
      dir, provider, close, get observed() { return observed }, url: backend.result.url,
      async tick(ms: number) {
        const child = backend!.child
        await new Promise<void>((resolve, reject) => {
          const receive = (value: unknown) => {
            if ((value as { type?: string })?.type !== 'modelClockAdvanced') return
            child.off('message', receive)
            resolve()
          }
          child.on('message', receive)
          child.send({ type: 'advanceModelClock', ms }, error => {
            if (!error) return
            child.off('message', receive)
            reject(error)
          })
        })
      },
      async restart() {
        const port = Number(new URL(backend!.result.url).port)
        await stop(backend!.child, 'SIGKILL')
        backend = await startBackend(secret, port, provider.baseURL, undefined, true)
        observed = observe(page)
        await page.reload()
        await ready(page, observed, 0, false)
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

test('断线后读取同一轮最新重试，收到新正文才替换旧片段', async ({ page }) => {
  let socket: WebSocketRoute | undefined
  let upstream: WebSocketRoute | undefined
  let block = false
  await page.routeWebSocket('**/api/events', route => {
    if (block) { void route.close(); return }
    socket = route
    upstream = route.connectToServer()
  })
  const app = await setup(page)
  try {
    const count = () => app.provider.exchanges.length
    await send(page, '开始模型恢复')
    await expect.poll(count).toBe(1)
    app.provider.exchanges[0].delta({ content: '旧片段' })
    await expect(answer(page)).toContainText('旧片段')
    app.provider.exchanges[0].end()
    await expect(detail(page)).toContainText('第 1/5 次重试 · 上次回复未完成')
    const run = app.observed.updates.find(entry => entry.update.run?.status === 'running')!.update.run!.id
    await app.tick(2_000)
    await expect.poll(count).toBe(2)
    await expect(detail(page)).toHaveText('正在重试 · 第 1/5 次 · 上次回复未完成')
    app.provider.exchanges[1].delta({ reasoning_content: '先准备新回复' })
    await expect(answer(page)).toContainText('旧片段')
    await expect(answer(page)).not.toContainText('先准备新回复')
    app.provider.exchanges[1].end()
    await expect(detail(page)).toContainText('第 2/5 次重试')
    block = true
    await socket!.close()
    await upstream!.close()
    await expect(page.getByText('连接已断开，正在重试…')).toBeVisible()
    await expect(detail(page)).toHaveCount(0)
    await app.tick(3_000)
    await expect.poll(count).toBe(3)
    app.provider.exchanges[2].end()
    await expect.poll(() => app.provider.exchanges[2].closed).toBe(true)
    block = false
    const after = app.observed.snapshots.length
    await ready(page, app.observed, after, false)
    await expect(detail(page)).toContainText('第 3/5 次重试')
    expect(app.observed.snapshots.at(-1)?.snapshot.running).toMatchObject({ runId: run, retry: { attempt: 3 } })
    expect(count()).toBe(3)
    await app.tick(5_000)
    await expect.poll(count).toBe(4)
    const replacement = app.provider.exchanges[3]
    replacement.delta({ content: '新正文' })
    await expect(answer(page)).toContainText('新正文')
    await expect(answer(page)).not.toContainText('旧片段')
    await expect(detail(page)).toHaveCount(0)
    const update = app.observed.updates.find(entry => entry.update.change.type === 'model' && entry.update.change.event.type === 'replace')
    expect(update?.update.change).toMatchObject({ event: { runId: run, message: { content: [{ type: 'text', text: '新正文' }] } } })
    replacement.finish()
    await expect.poll(() => app.observed.updates.at(-1)?.update.run).toMatchObject({ id: run, status: 'completed' })
  } finally { await app.close() }
})

test('120 秒等待和已发出的重试都可中止', async ({ page }) => {
  const app = await setup(page)
  const count = () => app.provider.exchanges.length + app.provider.rejected
  const abort = async () => {
    await page.getByRole('button', { name: '中止', exact: true }).click()
    await expect(detail(page)).toHaveText('已停止 · 本轮已取消')
    await expect.poll(() => app.observed.updates.at(-1)?.update.run?.status).toBe('aborted')
  }
  try {
    app.provider.rejectOnce({ status: 429, retryAfter: '120' })
    await send(page, '等待时停止')
    await expect(detail(page)).toContainText('模型服务限制了请求')
    await app.tick(61_000)
    expect(count()).toBe(1)
    await abort()
    await app.tick(60_000)
    expect(count()).toBe(1)

    app.provider.rejectOnce({ status: 418 })
    await send(page, '发出后停止')
    await expect(detail(page)).toContainText('模型请求异常（HTTP 418）')
    await app.tick(2_000)
    await expect(detail(page)).toHaveText('正在重试 · 第 1/5 次')
    await expect.poll(count).toBe(3)
    await abort()
    await expect.poll(() => app.provider.exchanges[0].closed).toBe(true)
    await app.tick(60_000)
    expect(count()).toBe(3)
  } finally { await app.close() }
})

test('HTTP 418 在一秒后用同一输入恢复原轮，明确配额耗尽直接结束', async ({ page }) => {
  const app = await setup(page)
  const count = () => app.provider.exchanges.length + app.provider.rejected
  try {
    app.provider.rejectOnce({ status: 418 })
    await send(page, '暂时请求失败')
    await expect(detail(page)).toHaveText('模型请求异常（HTTP 418） · 1 秒后进行第 1/5 次重试')
    const run = app.observed.updates.find(entry => entry.update.run?.status === 'running')!.update.run!.id
    await app.tick(999)
    expect(count()).toBe(1)
    await app.tick(1)
    await expect.poll(count).toBe(2)
    expect(app.provider.exchanges[0].body).toEqual(app.provider.rejectedBodies[0])
    app.provider.exchanges[0].delta({ content: '原轮恢复成功' })
    app.provider.exchanges[0].finish()
    await expect(answer(page)).toContainText('原轮恢复成功')
    await expect.poll(() => app.observed.updates.at(-1)?.update.run).toMatchObject({ id: run, status: 'completed' })

    app.provider.rejectOnce({ status: 429, code: 'insufficient_quota', retryAfter: '60' })
    await send(page, '配额耗尽')
    await expect(detail(page)).toHaveText('回复失败 · 模型服务配额已用尽，请检查账户额度')
    await expect.poll(() => app.observed.updates.at(-1)?.update.run).toMatchObject({ status: 'failed' })
    await app.tick(120_000)
    expect(count()).toBe(3)
  } finally { await app.close() }
})

test('5 次重试保留已写文件和工具回填，刷新保留失败原因，换模型可继续', async ({ page }) => {
  const app = await setup(page)
  const { exchanges } = app.provider
  const count = () => exchanges.length
  try {
    await send(page, '写文件')
    await expect.poll(count).toBe(1)
    exchanges[0].delta({ content: '未完成的旧正文' })
    exchanges[0].end()
    await expect(detail(page)).toContainText('第 1/5 次重试')
    await app.tick(2_000)
    await expect.poll(count).toBe(2)
    exchanges[1].delta({ tool_calls: [{ index: 0, id: 'only-write', type: 'function', function: {
      name: 'write', arguments: '{"path":"only.txt","content":"written once"}',
    } }] })
    await expect(answer(page)).toContainText('未完成的旧正文')
    expect(count()).toBe(2)
    exchanges[1].finish('tool_calls')
    await expect.poll(count).toBe(3)
    await expect(answer(page)).not.toContainText('未完成的旧正文')
    expect(await readFile(join(app.dir, 'only.txt'), 'utf8')).toBe('written once')
    for (let i = 0; i < 6; i++) {
      const attempt = exchanges[2 + i]
      expect(attempt.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'only-write' })
      expect(attempt.body.messages).toEqual(exchanges[2].body.messages)
      attempt.delta({ content: '失败片段' })
      attempt.end()
      if (i < 5) {
        await expect(detail(page)).toContainText(`第 ${i + 1}/5 次重试`)
        await app.tick(20_000)
        await expect.poll(count).toBe(4 + i)
      }
    }
    await expect(detail(page)).toHaveText('回复失败 · 模型回复中断，已重试 5 次')
    const failed = app.observed.updates.find(entry => entry.update.run?.status === 'failed')!.update.run!
    expect(count()).toBe(8)
    const preceding = app.observed.snapshots.length
    await page.reload()
    await ready(page, app.observed, preceding, false)
    await expect(detail(page)).toHaveText('回复失败 · 模型回复中断，已重试 5 次')
    const snapshot = app.observed.snapshots.at(-1)!.snapshot
    expect(snapshot.runs).toContainEqual(expect.objectContaining({ id: failed.id, status: 'failed', modelId: 'deepseek-flash' }))
    expect(snapshot.messages.filter(entry => entry.message.role === 'toolResult')).toHaveLength(1)
    expect(await readFile(join(app.dir, 'only.txt'), 'utf8')).toBe('written once')

    expect((await page.request.put(app.url + '/api/providers/moonshotai-cn', {
      headers: { Origin: app.url }, data: { apiKey: 'controlled-moonshot-test-key' },
    })).ok()).toBe(true)
    await page.getByRole('combobox', { name: '模型', exact: true }).click()
    const menu = page.getByRole('dialog', { name: '选择模型' })
    await menu.getByRole('searchbox').fill('Kimi K3')
    await menu.getByRole('button', { name: 'Kimi K3', exact: true }).click()
    await send(page, '继续')
    await expect.poll(count).toBe(9)
    const continued = exchanges[8]
    expect(continued.body.model).toBe('kimi-k3')
    expect(continued.body.messages.some(message => message.role === 'tool')).toBe(true)
    expect(JSON.stringify(continued.body)).not.toContain('失败片段')
    continued.delta({ content: '继续成功' })
    continued.finish()
    await expect(answer(page)).toContainText('继续成功')
    await expect.poll(() => app.observed.updates.at(-1)?.update.run).toMatchObject({ modelId: 'kimi-k3', status: 'completed' })
    expect(app.observed.updates.at(-1)?.update.run?.id).not.toBe(failed.id)
  } finally { await app.close() }
})

test('服务进程在重试等待中退出，历史已中断且保留工具结果', async ({ page }) => {
  const app = await setup(page)
  try {
    await send(page, '写入后中断')
    await expect.poll(() => app.provider.exchanges.length).toBe(1)
    app.provider.exchanges[0].delta({ tool_calls: [{ index: 0, id: 'write-before-exit', type: 'function', function: {
      name: 'write', arguments: '{"path":"durable.txt","content":"durable"}',
    } }] })
    app.provider.exchanges[0].finish('tool_calls')
    await expect.poll(() => app.provider.exchanges.length).toBe(2)
    app.provider.exchanges[1].end()
    await expect(detail(page)).toContainText('第 1/5 次重试')
    await app.restart()
    const state = app.observed.snapshots.at(-1)!.snapshot
    expect(state.running).toBeNull()
    expect(state.runs?.at(-1)?.status).toBe('interrupted')
    expect(state.messages.at(-1)?.message).toMatchObject({ role: 'toolResult', toolCallId: 'write-before-exit' })
    await expect(answer(page).getByText('已中断', { exact: true })).toBeVisible()
    await expect(detail(page)).toHaveCount(0)
    expect(await readFile(join(app.dir, 'durable.txt'), 'utf8')).toBe('durable')
    await app.tick(120_000)
    expect(app.provider.exchanges).toHaveLength(2)
  } finally { await app.close() }
})
