import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { BashJobsView, StartSessionAccepted } from '@agent-learning/server/protocol'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, freeVitePort, saveKey, startBackend, startVite, stop } from './test-utils'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

for (const mode of ['node', 'vite'] as const) test(`${mode} 后台任务卡片跟随会话，等待停止回执后保留空卡片`, async ({ page }) => {
  page.setDefaultTimeout(8000)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-background-e2e-'))
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  let vite: Awaited<ReturnType<typeof startVite>> | undefined
  const lateList = gate(), releaseList = gate(), listReturned = gate()
  const stopped = gate(), releaseStop = gate()
  const natural = 'while [[ ! -f finish-a ]]; do sleep 0.03; done # NATURAL_A'
  const manual = 'echo "$$" > stop-a.pid; exec sleep 60 # STOP_A'
  const other = 'echo "$$" > keep-b.pid; exec sleep 60 # KEEP_B'
  try {
    const vitePort = mode === 'vite' ? await freeVitePort() : undefined
    backend = await startBackend(join(temporary, 'browser-auth.json'), 0, provider.baseURL, vitePort)
    if (vitePort) vite = await startVite(Number(new URL(backend.result.url).port), vitePort)
    await authorize(page, mode === 'node' ? backend.result.authUrl : backend.result.devAuthUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const start = async (label: string, commands: string[]) => {
      const index = provider.exchanges.length
      await page.getByRole('button', { name: '新会话', exact: true }).click()
      await page.getByRole('textbox', { name: '消息', exact: true }).fill(label)
      const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/start')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const { session } = await (await accepted).json() as StartSessionAccepted
      await expect.poll(() => provider.exchanges.length).toBe(index + 1)
      provider.exchanges[index]!.delta({ tool_calls: commands.map((command, i) => ({
        index: i, id: label + '-' + i, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, background: true, timeout: 60 }) },
      })) })
      provider.exchanges[index]!.finish('tool_calls')
      await expect.poll(() => provider.exchanges.length).toBe(index + 2)
      const receipts = provider.exchanges[index + 1]!.body.messages.filter(message => message.role === 'tool')
      expect(receipts.map(message => JSON.parse(message.content).command).sort()).toEqual([...commands].sort())
      provider.exchanges[index + 1]!.delta({ content: label + ' 已启动' })
      provider.exchanges[index + 1]!.finish()
      await expect(page.getByRole('region', { name: '消息列表' })).toContainText(label + ' 已启动')
      return session
    }
    const a = await start('A', [natural, manual])
    const b = await start('B', [other])
    const switchTo = (name: string) => page.getByRole('button', { name, exact: true }).click()
    const jobsPath = (id: string) => '/api/sessions/' + id + '/jobs'
    let holdA = false
    let requested = 0
    await page.route('**/api/sessions/*/jobs', async route => {
      requested++
      if (!holdA || new URL(route.request().url()).pathname !== jobsPath(a.id)) { await route.continue(); return }
      holdA = false
      const response = await route.fetch()
      lateList.resolve()
      await releaseList.promise
      await route.fulfill({ response }).catch(() => {})
      listReturned.resolve()
    })

    await switchTo(a.name)
    const trigger = page.getByRole('button', { name: '后台任务', exact: true })
    const panel = page.getByRole('region', { name: '后台任务', exact: true })
    await trigger.click()
    await expect(panel.getByRole('listitem')).toHaveCount(2)
    holdA = true
    await lateList.promise
    await switchTo(b.name)
    await expect(panel).toContainText('KEEP_B')
    await expect(panel.getByRole('listitem')).toHaveCount(1)
    await expect(panel).not.toContainText('STOP_A')
    releaseList.resolve()
    await listReturned.promise
    await expect(panel).toContainText('KEEP_B')
    await expect(panel).not.toContainText('STOP_A')

    await switchTo(a.name)
    await expect(panel.getByRole('listitem')).toHaveCount(2)
    await trigger.click()
    await expect(panel).toHaveCount(0)
    const closedAt = requested
    await page.waitForTimeout(1200)
    expect(requested).toBe(closedAt)
    await trigger.click()
    await expect(panel.getByRole('listitem')).toHaveCount(2)
    await writeFile(join(temporary, 'finish-a'), '')
    await expect(panel.getByRole('listitem')).toHaveCount(1)
    await expect(panel).toContainText('STOP_A')
    await expect(panel).not.toContainText('NATURAL_A')

    const nextModel = provider.exchanges.length
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('继续工作')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => provider.exchanges.length).toBe(nextModel + 1)
    await expect(page.locator('.chat-header').getByRole('status')).toHaveText('正在生成回答…')

    let stopAttempts = 0
    await page.route('**/api/sessions/*/jobs/*/stop', async route => {
      if (++stopAttempts === 1) { await route.abort(); return }
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      stopped.resolve()
      await releaseStop.promise
      await route.fulfill({ response })
    })
    const stopButton = panel.getByRole('button', { name: '停止', exact: true })
    const retryRead = page.waitForResponse(response => new URL(response.url()).pathname === jobsPath(a.id))
    await stopButton.click()
    expect((await (await retryRead).json() as BashJobsView).jobs).toHaveLength(1)
    await expect(stopButton).toBeEnabled()
    await stopButton.click()
    await stopped.promise
    const confirmedList = await page.waitForResponse(response => new URL(response.url()).pathname === jobsPath(a.id))
    expect((await confirmedList.json() as BashJobsView).jobs).toEqual([])
    await expect(panel.getByRole('button', { name: '正在停止', exact: true })).toBeDisabled()
    await expect(panel).toContainText('STOP_A')
    const stoppedPid = Number(await readFile(join(temporary, 'stop-a.pid'), 'utf8'))
    expect(() => process.kill(stoppedPid, 0)).toThrow(/ESRCH/)
    releaseStop.resolve()
    await expect(panel.getByRole('listitem')).toHaveCount(0)
    await expect(panel).toBeEmpty()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.chat-header').getByRole('status')).toHaveText('正在生成回答…')
    provider.exchanges[nextModel]!.finish()
    const survivingPid = Number(await readFile(join(temporary, 'keep-b.pid'), 'utf8'))
    expect(() => process.kill(survivingPid, 0)).not.toThrow()

    await switchTo(b.name)
    await expect(panel).toContainText('KEEP_B')
    await page.reload()
    await expect(panel).toHaveCount(0)
    await trigger.click()
    await expect(panel).toContainText('KEEP_B')
  } finally {
    releaseList.resolve()
    releaseStop.resolve()
    await stop(vite)
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})
