import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { addWorkspace, authorize, freeVitePort, observe, ready, saveKey, startBackend, startVite, stop } from './test-utils'
import { startModelServer } from './model-server'

for (const mode of ['node', 'vite'] as const) {
  test(`${mode} 网页主动中止保留部分回复与草稿，关闭模型连接并继续发送`, async ({ page }, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agent-feature5-e2e-'))
    const provider = await startModelServer()
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined
    let vite: ChildProcess | undefined
    try {
      const vitePort = mode === 'vite' ? await freeVitePort() : undefined
      backend = await startBackend(join(temporary, 'browser-auth.json'), 0, provider.baseURL, vitePort)
      if (vitePort) vite = await startVite(Number(new URL(backend.result.url).port), vitePort)
      const observed = observe(page)
      await authorize(page, mode === 'node' ? backend.result.authUrl : backend.result.devAuthUrl)
      await ready(page, observed)
      await addWorkspace(page)
      await saveKey(page, 'controlled-stage3-key')
      const editor = page.getByRole('textbox', { name: '消息', exact: true })
      const originalEditor = await editor.elementHandle()
      const send = page.getByRole('button', { name: '发送', exact: true })
      await editor.fill('开始生成')
      await send.click()
      await expect.poll(() => provider.exchanges.length).toBe(1)
      provider.exchanges[0]!.delta({ content: '已经生成的部分内容。' })
      await expect(page.locator('.assistant-message')).toContainText('已经生成的部分内容。')
      await editor.fill('停止时保留的新草稿')
      const receipt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/abort')
      await page.getByRole('button', { name: '中止', exact: true }).click()
      const response = await receipt
      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({ handled: true })
      await expect.poll(() => provider.exchanges[0]!.closed).toBe(true)
      await expect(page.locator('.assistant-message')).toContainText('已取消')
      await expect(page.locator('.assistant-message')).toContainText('已经生成的部分内容。')
      await expect(send).toBeEnabled()
      await expect(editor).toHaveText('停止时保留的新草稿')
      expect(await editor.evaluate((element, original) => element === original, originalEditor)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${mode}-feature5-abort.png`), fullPage: true })
      await send.click()
      await expect.poll(() => provider.exchanges.length).toBe(2)
      expect(provider.exchanges[1]!.body.messages.map(message => message.role)).toEqual(['system', 'user', 'user'])
      provider.exchanges[1]!.delta({ content: '中止后继续成功。' })
      provider.exchanges[1]!.finish()
      await expect(page.locator('.assistant-message').last()).toContainText('中止后继续成功。')
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    } finally {
      await stop(vite)
      await stop(backend?.child)
      await provider.close()
      await rm(temporary, { recursive: true, force: true })
    }
  })
}
