import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { addWorkspace, authorize, freeVitePort, observe, saveKey, seedSession, startBackend, startVite, stop } from './test-utils'
import { startModelServer } from './model-server'

for (const mode of ['node', 'vite'] as const) {
  test(`E1 ${mode} 连续读取、并行回填，刷新后中止等待命令并继续`, async ({ page }, testInfo) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agent-feature6-e2e-'))
    const provider = await startModelServer()
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined
    let vite: ChildProcess | undefined
    try {
      await Promise.all([
        writeFile(join(temporary, 'index.txt'), '详情在 note.txt 和 status.txt'),
        writeFile(join(temporary, 'note.txt'), '项目名称：青禾'),
        writeFile(join(temporary, 'status.txt'), '状态：测试中'),
      ])
      const port = mode === 'vite' ? await freeVitePort() : undefined
      backend = await startBackend(join(temporary, 'browser-auth.json'), 0, provider.baseURL, port)
      if (port) vite = await startVite(Number(new URL(backend.result.url).port), port)
      const observed = observe(page)
      await authorize(page, mode === 'node' ? backend.result.authUrl : backend.result.devAuthUrl)
      await seedSession(page, observed, await addWorkspace(page))
      await saveKey(page, 'controlled-stage3-key')
      const editor = page.getByRole('textbox', { name: '消息', exact: true })
      await editor.fill('找到项目名称和状态，然后运行一条等待命令')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => provider.exchanges.length).toBe(1)
      const tools = (index: number, calls: { name: string; args: object }[]) => {
        provider.exchanges[index]!.delta({ tool_calls: calls.map((call, i) => ({ index: i, id: `read-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) })
        provider.exchanges[index]!.finish('tool_calls')
      }
      tools(0, [{ name: 'read', args: { path: 'index.txt' } }])
      await expect.poll(() => provider.exchanges.length).toBe(2)
      expect(provider.exchanges[1]!.body.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('详情在 note.txt 和 status.txt') })
      tools(1, [{ name: 'read', args: { path: 'note.txt' } }, { name: 'read', args: { path: 'status.txt' } }])
      await expect.poll(() => provider.exchanges.length).toBe(3)
      expect(provider.exchanges[2]!.body.messages.slice(-2)).toMatchObject([{ role: 'tool', content: '项目名称：青禾' }, { role: 'tool', content: '状态：测试中' }])
      expect(provider.exchanges.every(exchange => Array.isArray(exchange.body.tools) && exchange.body.tools.length === 8)).toBe(true)
      tools(2, [{ name: 'bash', args: { command: 'printf 等待中; echo started >> launches.txt; sleep 30', timeout: 60 } }])
      await expect.poll(async () => readFile(join(temporary, 'launches.txt'), 'utf8').catch(() => '')).toBe('started\n')
      await expect(page.locator('.tool-status').last()).toHaveText('运行中')
      await page.reload()
      await expect(page.locator('.tool-status')).toHaveText(['成功', '成功', '成功', '运行中'])
      expect(provider.exchanges).toHaveLength(3)
      expect(observed.submissions).toEqual(['POST'])
      expect(await readFile(join(temporary, 'launches.txt'), 'utf8')).toBe('started\n')
      await editor.fill('停止后保留的草稿')
      await page.getByRole('button', { name: '中止', exact: true }).click()
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
      await expect(editor).toHaveText('停止后保留的草稿')
      await expect(page.locator('.tool-status')).toHaveText(['成功', '成功', '成功', '已停止'])
      expect(provider.exchanges).toHaveLength(3)
      await page.getByText('执行过程', { exact: true }).click()
      await page.locator('.tool-block').last().locator('summary').click()
      await expect(page.locator('.tool-result').last()).toContainText('等待中')
      await page.screenshot({ path: testInfo.outputPath(`${mode}-feature6-stopped.png`), fullPage: true })
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => provider.exchanges.length).toBe(4)
      provider.exchanges[3]!.delta({ content: '停止后继续成功' })
      provider.exchanges[3]!.finish()
      await expect(page.locator('.assistant-message').last()).toContainText('停止后继续成功')
      expect(await readFile(join(temporary, 'launches.txt'), 'utf8')).toBe('started\n')
    } finally {
      await stop(vite)
      await stop(backend?.child)
      await provider.close()
      await rm(temporary, { recursive: true, force: true })
    }
  })
}
