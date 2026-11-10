import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { addWorkspace, authorize, expectBrowserStorage, freeVitePort, emptySnapshot, httpStatus, observe, openSession, ready, saveKey, seedSession, startBackend, startVite, stop, wsStatus } from './test-utils'
import { startModelServer } from './model-server'

for (const mode of ['node', 'vite'] as const) {
  test(`${mode} 阶段三 SDK 流式对话、历史与生成恢复`, async ({ page, context }, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agent-learning-stage3-e2e-'))
    const secretPath = join(temporary, 'browser-auth.json')
    const modelPath = join(temporary, 'auth.json')
    const provider = await startModelServer()
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined
    let vite: ChildProcess | undefined
    const vitePort = mode === 'vite' ? await freeVitePort() : undefined
    try {
      backend = await startBackend(secretPath, 0, provider.baseURL, vitePort)
      const port = Number(new URL(backend.result.url).port)
      if (mode === 'vite') vite = await startVite(port, vitePort!)
      const origin = mode === 'node' ? backend.result.url : `http://127.0.0.1:${vitePort}`
      const observed = observe(page)
      await authorize(page, mode === 'node' ? backend.result.authUrl : backend.result.devAuthUrl)
      const workspaceId = await addWorkspace(page)
      await seedSession(page, observed, workspaceId)
      await saveKey(page, 'controlled-stage3-key')

      const editor = page.getByRole('textbox', { name: '消息', exact: true })
      const send = page.getByRole('button', { name: '发送', exact: true })
      const messages = page.getByRole('region', { name: '消息列表' })
      const original = '  第一轮原文\n保留空格与换行  '
      await editor.fill(original)
      await expect(send).toBeEnabled()
      const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages')
      await send.click()
      expect((await accepted).status()).toBe(202)
      await expect(editor).toHaveText('')
      await expect(editor).toBeFocused()
      await expect.poll(() => provider.exchanges.length).toBe(1)
      const first = provider.exchanges[0]!
      expect(first.path).toBe('/v1/chat/completions')
      expect(first.authorized).toBe(true)
      expect(first.body).toMatchObject({ model: 'deepseek-flash', stream: true, thinking: { type: 'enabled' }, reasoning_effort: 'high' })
      expect(first.body.tools).toHaveLength(8)
      expect(first.body.messages).toEqual([expect.objectContaining({ role: 'system', content: expect.stringContaining('工作目录') }), { role: 'user', content: original }])
      first.delta({ role: 'assistant', reasoning_content: '先分析原文。' })
      first.delta({ content: '**第一段**已经到达。' })
      await expect(messages).toContainText('第一段已经到达。')
      await expect(messages.getByRole('listitem')).toHaveCount(2)
      await expect.poll(() => observed.updates.some(({ update }) => update.change.type === 'model' && update.change.event.type === 'text_delta')).toBe(true)
      expect(observed.updates.some(({ update }) => update.change.type === 'model' && update.change.event.type === 'done')).toBe(false)
      await editor.fill('生成期间编辑的草稿')
      await editor.press('Enter')
      await expect(editor).toHaveText('生成期间编辑的草稿')
      await expect(page.getByRole('button', { name: '中止', exact: true })).toBeEnabled()

      const second = await context.newPage()
      const otherObserved = observe(second)
      await second.goto(origin)
      await ready(second, otherObserved, 0, false)
      await expect(second.getByRole('region', { name: '消息列表' })).toContainText('第一段已经到达。')
      await second.getByRole('textbox', { name: '消息', exact: true }).fill('另一个页面的草稿')
      await expect(second.getByRole('button', { name: '中止', exact: true })).toBeEnabled()
      const running = otherObserved.snapshots.at(-1)!.snapshot.running
      expect(running?.kind).toBe('task')
      if (running?.kind !== 'task') throw new Error('当前运行应为普通任务')
      expect(otherObserved.snapshots.at(-1)!.snapshot.activeContent).toContainEqual({ messageId: running!.assistantMessageId, contentIndex: 1, type: 'text' })

      const beforeReload = observed.snapshots.length
      await page.reload()
      await ready(page, observed, beforeReload, false)
      await expect(editor).toHaveText('另一个页面的草稿')
      await expect(messages).toContainText('第一段已经到达。')
      expect(observed.snapshots.at(-1)!.snapshot.running).toEqual(running)
      await editor.fill('断线期间保留的新草稿')
      await expect(page.getByRole('button', { name: '中止', exact: true })).toBeEnabled()
      await context.setOffline(true)
      await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'disconnected')
      first.delta({ content: '离线时继续生成的第二段。' })
      const beforeOnline = observed.snapshots.length
      await context.setOffline(false)
      await ready(page, observed, beforeOnline, false)
      await expect(messages).toContainText('第一段已经到达。离线时继续生成的第二段。')
      await expect(second.getByRole('region', { name: '消息列表' })).toContainText('离线时继续生成的第二段。')
      expect(observed.snapshots.at(-1)!.snapshot.running).toEqual(running)
      await expect(editor).toHaveText('断线期间保留的新草稿')
      await expect(page.getByRole('button', { name: '中止', exact: true })).toBeEnabled()
      expect(provider.exchanges).toHaveLength(1)
      expect(observed.submissions).toEqual(['POST'])
      expect(otherObserved.submissions).toEqual([])

      first.finish()
      await expect(send).toBeEnabled()
      await expect.poll(() => otherObserved.updates.some(({ update }) => update.change.type === 'model' && update.change.event.type === 'done')).toBe(true)
      await expect(messages.getByRole('listitem')).toHaveCount(2)
      await editor.fill('第二轮请沿用前面的内容')
      await send.click()
      await expect.poll(() => provider.exchanges.length).toBe(2)
      const next = provider.exchanges[1]!
      expect(next.body.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
      expect(next.body.messages.slice(1).map(message => message.content)).toEqual([original, '**第一段**已经到达。离线时继续生成的第二段。', '第二轮请沿用前面的内容'])
      next.delta({ role: 'assistant', content: '第二轮已收到历史。' })
      next.finish()
      await expect(messages).toContainText('第二轮已收到历史。')
      await expect(messages.getByRole('listitem')).toHaveCount(4)
      await editor.fill('后端重启期间仍保留的草稿')
      await expect(send).toBeEnabled()
      await page.screenshot({ path: testInfo.outputPath(`${mode}-stage3-chat.png`), fullPage: true })

      const oldSession = observed.snapshots.at(-1)!.sessionId
      await stop(backend.child, 'SIGKILL')
      await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'disconnected')
      backend = await startBackend(secretPath, port, provider.baseURL, vitePort)
      await expect(page.getByRole('alert')).toHaveText('之前打开的会话已不可用，请选择或新建会话。')
      await expect(page.getByRole('button', { name: '会话 1', exact: true })).toHaveCount(0)
      expect(await seedSession(page, observed, workspaceId)).not.toBe(oldSession)
      await expect(messages.getByRole('listitem')).toHaveCount(0)
      await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveText('DeepSeek Flash')
      await expect(editor).toHaveText('')
      await expect(send).toBeDisabled()
      expect(JSON.parse(await readFile(modelPath, 'utf8')).deepseek.key).toBe('controlled-stage3-key')
      expect(provider.exchanges).toHaveLength(2)
      expect(observed.submissions).toEqual(['POST', 'POST'])
      expect(otherObserved.submissions).toEqual([])
      await second.close()
    } finally {
      await Promise.allSettled([context.setOffline(false), stop(vite), stop(backend?.child), provider.close()])
      await rm(temporary, { recursive: true, force: true })
    }
  })
}

for (const mode of ['node', 'vite'] as const) {
  test(`${mode} 阶段二配置、重启与多页面`, async ({ page, context }, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agent-learning-stage2-e2e-'))
    const secretPath = join(temporary, 'browser-auth.json')
    const modelPath = join(temporary, 'auth.json')
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined
    let vite: ChildProcess | undefined
    const vitePort = mode === 'vite' ? await freeVitePort() : undefined
    try {
      backend = await startBackend(secretPath, 0, '', vitePort)
      const port = Number(new URL(backend.result.url).port)
      if (mode === 'vite') {
        vite = await startVite(port, vitePort!)
      }
      const origin = mode === 'node' ? backend.result.url : `http://127.0.0.1:${vitePort}`
      const observed = observe(page)
      try { await page.goto(mode === 'node' ? backend.result.authUrl : backend.result.devAuthUrl) }
      catch { throw new Error('阶段二授权导航失败，临时令牌已省略') }
      const workspaceId = await addWorkspace(page)
      const sessionId = await seedSession(page, observed, workspaceId)
      const model = page.getByRole('combobox', { name: '模型', exact: true })
      await expect(model).toHaveText('无可用模型')
      const editor = page.getByRole('textbox', { name: '消息', exact: true })
      await editor.fill('设置变化期间保留的草稿')
      const second = await context.newPage()
      const otherObserved = observe(second)
      await second.goto(origin)
      await ready(second, otherObserved)
      const otherModel = second.getByRole('combobox', { name: '模型', exact: true })
      await expect(otherModel).toHaveText('无可用模型')

      const settings = page.getByRole('button', { name: '设置', exact: true })
      const dialog = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.click()
      await dialog.getByRole('button', { name: '模型', exact: true }).click()
      await dialog.getByRole('button', { name: '添加提供方', exact: true }).click()
      await dialog.getByRole('button', { name: 'DeepSeek', exact: true }).click()
      const keyInput = dialog.getByLabel('API Key', { exact: true })
      await expect(keyInput).toHaveAttribute('type', 'password')
      await keyInput.fill('stage2-e2e-first-fake-key')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog).toContainText('已保存在本机')
      await expect(keyInput).toHaveValue('')
      await expect(otherModel).toHaveText('DeepSeek Flash')
      expect(JSON.parse(await readFile(modelPath, 'utf8')).deepseek.key).toBe('stage2-e2e-first-fake-key')
      await expectBrowserStorage(page, sessionId, workspaceId, { [sessionId]: '设置变化期间保留的草稿' })
      await keyInput.fill('stage2-e2e-replacement-fake-key')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(keyInput).toHaveValue('')
      expect(JSON.parse(await readFile(modelPath, 'utf8')).deepseek.key).toBe('stage2-e2e-replacement-fake-key')
      await keyInput.fill('stage2-e2e-unsaved-fake-key')
      await page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
      await expect(settings).toBeFocused()
      await expect(editor).toHaveText('设置变化期间保留的草稿')
      await expect(model).toHaveText('DeepSeek Flash')
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
      await settings.click()
      await dialog.getByRole('button', { name: '编辑', exact: true }).click()
      await expect(keyInput).toHaveValue('')
      await page.screenshot({ path: testInfo.outputPath(`${mode}-settings.png`), fullPage: true })
      await page.keyboard.press('Escape')

      await stop(backend.child, 'SIGKILL')
      await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'disconnected')
      backend = await startBackend(secretPath, port, '', vitePort)
      await expect(page.getByRole('button', { name: '会话 1', exact: true })).toHaveCount(0)
      await expect(second.getByRole('alert')).toHaveText('之前打开的会话已不可用，请选择或新建会话。')
      const createdSession = await seedSession(page, observed, workspaceId)
      expect((await openSession(second, otherObserved, '会话 1')).sessionId).toBe(createdSession)
      await expect(model).toHaveText('DeepSeek Flash')
      await expect(otherModel).toHaveText('DeepSeek Flash')
      await settings.click()
      await dialog.getByRole('button', { name: '编辑', exact: true }).click()
      await dialog.getByRole('button', { name: '删除 API Key', exact: true }).click()
      await expect(dialog).toContainText('已删除本机配置')
      await expect(otherModel).toHaveText('无可用模型')
      expect(JSON.parse(await readFile(modelPath, 'utf8'))).toEqual({})
      await page.keyboard.press('Escape')
      await expect(model).toHaveText('无可用模型')

      await writeFile(modelPath, '{invalid-stage2-external-file', { mode: 0o600 })
      await expect(page.getByRole('alert')).toContainText(/配置|JSON|credential/i)
      await expect(second.getByRole('alert')).toContainText(/配置|JSON|credential/i)
      await settings.click()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: '添加提供方', exact: true }).click()
      await dialog.getByRole('button', { name: 'DeepSeek', exact: true }).click()
      await keyInput.fill('stage2-e2e-cannot-overwrite-bad-file')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog.getByRole('alert').last()).toBeVisible()
      expect(await readFile(modelPath, 'utf8')).toBe('{invalid-stage2-external-file')
      await page.keyboard.press('Escape')
      await writeFile(modelPath, '{}', { mode: 0o600 })
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(second.getByRole('alert')).toHaveCount(0)
      await expect(editor).toHaveText('')
      expect(observed.snapshots.every(frame => JSON.stringify(frame.snapshot) === JSON.stringify(emptySnapshot))).toBe(true)
      expect(observed.submissions).toEqual([])
      expect(otherObserved.submissions).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`${mode}-stage2-ready.png`), fullPage: true })
      await page.setViewportSize({ width: 390, height: 700 })
      await settings.click()
      await expect(dialog).toBeInViewport({ ratio: 1 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${mode}-settings-narrow.png`), fullPage: true })
      await second.close()
    } finally {
      await Promise.allSettled([stop(vite), stop(backend?.child)])
      await rm(temporary, { recursive: true, force: true })
    }
  })
}

for (const mode of ['node', 'vite'] as const) {
  test(`${mode} 实际授权、空快照与恢复`, async ({ page, context }, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agent-learning-stage1-e2e-'))
    const secretPath = join(temporary, 'browser-auth.json')
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined
    let vite: ChildProcess | undefined
    const vitePort = mode === 'vite' ? await freeVitePort() : undefined
    try {
      backend = await startBackend(secretPath, 0, '', vitePort)
      const port = Number(new URL(backend.result.url).port)
      if (mode === 'vite') {
        vite = await startVite(port, vitePort!)
      }
      const origin = mode === 'node' ? backend.result.url : `http://127.0.0.1:${vitePort}`
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

      expect(observed.snapshots).toHaveLength(0)
      const workspaceId = await addWorkspace(page)
      const sessionId = await seedSession(page, observed, workspaceId)
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
      await expect(second.getByRole('textbox', { name: '消息', exact: true })).toHaveText('阶段一草稿')
      await second.close()

      const beforeReload = observed.snapshots.length
      await page.reload()
      await ready(page, observed, beforeReload)
      await expect(editor).toHaveText('阶段一草稿')
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

      expect(observed.snapshots.at(-1)?.sessionId).toBe(sessionId)
      expect(observed.snapshots.at(-1)?.subscriptionId).not.toBe(observed.snapshots[beforeOnline - 1]?.subscriptionId)
      await stop(backend.child, 'SIGKILL')
      await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'disconnected')
      await editor.fill('后端重启期间的草稿')
      backend = await startBackend(secretPath, port, '', vitePort)
      await expect(page.getByRole('button', { name: '会话 1', exact: true })).toHaveCount(0)
      expect(await seedSession(page, observed, workspaceId)).not.toBe(sessionId)
      await expect(editor).toHaveText('')
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
