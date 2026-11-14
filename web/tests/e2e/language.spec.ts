import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { authorize, freeVitePort, observe, startBackend, startVite, stop } from './test-utils'
import { startModelServer } from './model-server'

test.use({ locale: 'zh-CN' })

function pauseResponse() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

for (const mode of ['node', 'vite'] as const) {
  test(`${mode}: defaults to English and restores a saved language across restarts`, async ({ page, browser }) => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-language-'))
    const secret = join(directory, 'browser-auth.json')
    const filename = join(directory, 'settings.json')
    const old = { web: { searchProvider: 'tavily', fetchProvider: 'tavily' } }
    const vitePort = mode === 'vite' ? await freeVitePort() : undefined
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined
    let vite: Awaited<ReturnType<typeof startVite>> | undefined
    let other: Awaited<ReturnType<typeof browser.newContext>> | undefined
    try {
      await writeFile(filename, JSON.stringify(old), { mode: 0o600 })
      backend = await startBackend(secret, 0, '', vitePort)
      const port = Number(new URL(backend.result.url).port)
      if (vitePort) vite = await startVite(port, vitePort)
      await authorize(page, vitePort ? backend.result.devAuthUrl : backend.result.authUrl)
      await expect(page).toHaveTitle('Chat · Agent Learning')
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      expect(await readFile(filename, 'utf8')).toBe(JSON.stringify(old))
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('button', { name: 'General', exact: true })).toHaveAttribute('aria-current', 'true')
      const select = page.getByRole('combobox', { name: 'Language' })
      await expect(select).toHaveText('English')
      await select.press('Enter')
      await expect(page.getByRole('option')).toHaveCount(2)
      await expect(page.getByRole('option', { name: 'English' })).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByRole('option', { name: '简体中文' })).toBeFocused()
      const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/language') && response.request().method() === 'PUT', { timeout: 5000 })
      await page.keyboard.press('Enter')
      expect((await saved).status()).toBe(200)
      await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
      await expect(page.getByRole('combobox', { name: '语言' })).toHaveText('简体中文')
      await expect(page.getByRole('combobox', { name: '语言' })).toBeFocused()
      expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ ...old, locale: { preference: 'zh-CN' } })
      await page.reload()
      await expect(page).toHaveTitle('聊天 · Agent Learning')

      await stop(backend.child)
      backend = await startBackend(secret, port, '', vitePort)
      other = await browser.newContext({ locale: 'en-US', viewport: { width: 360, height: 700 } })
      const second = await other.newPage()
      await second.addInitScript(() => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.chat-page')) return
          document.documentElement.dataset.firstChatLanguage = document.documentElement.lang
          observer.disconnect()
        })
        observer.observe(document, { childList: true, subtree: true })
      })
      await authorize(second, vitePort ? backend.result.devAuthUrl : backend.result.authUrl)
      await expect(second.locator('html')).toHaveAttribute('data-first-chat-language', 'zh-CN')
      await second.getByRole('button', { name: '展开侧边栏' }).click()
      await second.getByRole('button', { name: '设置', exact: true }).click()
      await second.getByRole('combobox', { name: '语言' }).click()
      await second.getByRole('option', { name: 'English' }).click()
      await expect(second.getByRole('combobox', { name: 'Language' })).toBeEnabled()
      await expect(second).toHaveTitle('Chat · Agent Learning')
      await second.getByRole('button', { name: 'Web Tools' }).click()
      await expect(second.getByRole('combobox', { name: 'Web search' })).toBeInViewport({ ratio: 1 })
      await second.getByRole('button', { name: 'Models', exact: true }).click()
      await expect(second.getByRole('button', { name: 'Add provider' })).toBeInViewport({ ratio: 1 })
      expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ ...old, locale: { preference: 'en' } })
    } finally {
      await other?.close()
      await stop(vite)
      await stop(backend?.child)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('a slow language read opens in English and can be retried in settings', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-language-timeout-'))
  const backend = await startBackend(join(directory, 'browser-auth.json'))
  const pending = pauseResponse()
  try {
    let reads = 0
    await page.route('**/api/settings/language', async route => {
      if (++reads === 1) {
        await pending.promise
        await route.abort().catch(() => {})
      } else await route.fulfill({ json: { language: 'zh-CN' } })
    })
    await authorize(page, backend.result.authUrl)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Could not load the saved language.')
    pending.release()
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('combobox', { name: '语言' })).toHaveText('简体中文')
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(reads).toBe(2)
  } finally {
    pending.release()
    await stop(backend.child)
    await rm(directory, { recursive: true, force: true })
  }
})

for (const outcome of ['rejected', 'saved', 'unchanged', 'unavailable'] as const) {
  test(`language save recovery: ${outcome}`, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-language-recovery-'))
    const backend = await startBackend(join(directory, 'browser-auth.json'))
    const pending = pauseResponse()
    try {
      let reads = 0
      const selections: unknown[] = []
      await page.route('**/api/settings/language', async route => {
        if (route.request().method() === 'GET') {
          reads++
          if (reads > 1 && outcome === 'unavailable') await route.abort()
          else await route.fulfill({ json: { language: reads > 1 && outcome === 'saved' ? 'zh-CN' : 'en' } })
        } else {
          selections.push(route.request().postDataJSON())
          if (selections.length > 1) await route.fulfill({ json: { language: 'zh-CN' } })
          else {
            await pending.promise
            if (outcome === 'rejected') await route.fulfill({ status: 400 })
            else if (outcome === 'unavailable') await route.fulfill({ status: 500, json: { error: 'Settings file is not writable.' } })
            else await route.abort()
          }
        }
      })
      await authorize(page, backend.result.authUrl)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('combobox', { name: 'Language' }).click()
      await page.getByRole('option', { name: '简体中文' }).click()
      await expect(page.getByRole('combobox', { name: '语言' })).toBeDisabled()
      await expect(page.getByRole('combobox', { name: '语言' })).toBeFocused()
      await expect(page).toHaveTitle('聊天 · Agent Learning')
      await expect(page.getByRole('textbox', { name: '消息', includeHidden: true })).toHaveAttribute('aria-placeholder', '输入消息…')
      pending.release()
      if (outcome === 'saved') {
        await expect(page.getByRole('combobox', { name: '语言' })).toBeEnabled()
        await expect(page.getByRole('alert')).toHaveCount(0)
      } else {
        const language = page.getByRole('combobox', { name: 'Language' })
        await expect(language).toBeEnabled()
        await expect(page.getByRole('alert')).toHaveText(outcome === 'rejected'
          ? 'Could not save the language. Try again.'
          : 'Could not confirm the language was saved. Try again.' + (outcome === 'unavailable' ? ' · Settings file is not writable.' : ''))
      }
      expect(reads).toBe(outcome === 'rejected' ? 1 : 2)
      expect(selections).toEqual([{ language: 'zh-CN' }])
      if (outcome === 'unavailable') {
        await page.getByRole('combobox', { name: 'Language' }).click()
        await page.getByRole('option', { name: '简体中文' }).click()
        await expect(page.getByRole('combobox', { name: '语言' })).toBeEnabled()
        await expect(page.getByRole('alert')).toHaveCount(0)
      }
    } finally {
      pending.release()
      await stop(backend.child)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('language changes while a response is streaming without reopening the chat', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-language-stream-'))
  const model = await startModelServer()
  const backend = await startBackend(join(directory, 'browser-auth.json'), 0, model.baseURL)
  try {
    await writeFile(join(directory, 'auth.json'), JSON.stringify({ deepseek: { key: 'controlled-stage3-key', type: 'api_key' } }), { mode: 0o600 })
    const events = observe(page)
    await authorize(page, backend.result.authUrl)
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).click()
    await page.getByRole('option', { name: 'Add workspace…' }).click()
    const editor = page.getByRole('textbox', { name: 'Message' })
    await editor.fill('请保留这段原文')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => model.exchanges.length).toBe(1)
    const stream = model.exchanges[0]!
    stream.delta({ role: 'assistant', content: '第一段回复。' })
    await expect(page.getByRole('region', { name: 'Messages' })).toContainText('第一段回复。')
    const chat = page.locator('[data-session-id]')
    const session = await chat.getAttribute('data-session-id')
    await editor.fill('  draft\n第二行  ')
    const closed = events.closed
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('combobox', { name: 'Language' }).click()
    await page.getByRole('option', { name: '简体中文' }).click()
    await expect(page.getByRole('combobox', { name: '语言' })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '中止', exact: true })).toBeEnabled()
    await expect(chat).toHaveAttribute('data-session-id', session!)
    await expect(page.getByRole('textbox', { name: '消息' })).toHaveJSProperty('innerText', '  draft\n第二行  ')
    stream.delta({ content: '第二段回复。' })
    stream.finish()
    const messages = page.getByRole('region', { name: '消息列表' })
    await expect(messages).toContainText('请保留这段原文')
    await expect(messages).toContainText('第一段回复。第二段回复。')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    expect(model.exchanges).toHaveLength(1)
    expect(events.closed).toBe(closed)
  } finally {
    await stop(backend.child)
    await model.close()
    await rm(directory, { recursive: true, force: true })
  }
})
