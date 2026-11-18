import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, saveKey, startBackend, stop } from './test-utils'

test('21/22 临时标题和聊天并行，正式标题更新侧栏和当前引用列表，超时保留临时标题', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-title-'))
  const provider = await startModelServer({ deferTitles: true })
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(directory, 'browser-auth.json'), 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    const sidebar = page.locator('.workspace-conversation[data-session-id]')
    const firstPrompt = '帮我排查服务为什么启动失败'
    const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/start')
    await editor.fill(firstPrompt)
    await send.click()
    const response = await received
    expect(response.status()).toBe(202)
    const started = await response.json()
    expect(started.session.name).toBe(firstPrompt)
    await expect(sidebar.filter({ hasText: firstPrompt })).toBeVisible()
    await expect.poll(() => provider.titleExchanges.length).toBe(1)
    const title = provider.titleExchanges[0]!
    expect(title.body).toMatchObject({
      model: 'deepseek-flash', thinking: { type: 'disabled' },
      messages: [{ role: 'system', content: expect.stringContaining('会话标题生成器') }, { role: 'user', content: firstPrompt }],
    })
    expect(title.body.reasoning_effort).toBeUndefined()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    provider.exchanges[0]!.delta({ content: '请先查看服务启动日志。' })
    provider.exchanges[0]!.finish()
    await expect(page.getByText('请先查看服务启动日志。', { exact: true })).toBeVisible()
    await expect.poll(() => observed.updates.at(-1)?.update.run?.status).toBe('completed')
    await page.locator('.sidebar-new-session').click()
    await editor.fill('@')
    const reference = page.getByRole('option', { name: 'Session · ' + firstPrompt, exact: true })
    await expect(reference).toBeVisible()
    title.delta({ content: '排查服务启动失败' })
    title.finish()
    await expect(sidebar.filter({ hasText: /^排查服务启动失败$/ })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Session · 排查服务启动失败', exact: true })).toBeVisible()
    const replay = await page.request.post(backend.result.url + '/api/sessions/start', { data: response.request().postDataJSON() })
    expect(await replay.json()).toEqual(started)
    const fallback = '另一条需要保留的临时标题'
    await editor.fill(fallback)
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(2)
    provider.exchanges[1]!.delta({ content: '已处理另一个问题。' })
    provider.exchanges[1]!.finish()
    await expect(page.getByText('已处理另一个问题。', { exact: true })).toBeVisible()
    await expect.poll(() => provider.titleExchanges[1]?.closed, { timeout: 12_000 }).toBe(true)
    await expect(sidebar.filter({ hasText: fallback })).toBeVisible()
    await page.reload()
    await expect(sidebar.filter({ hasText: fallback })).toBeVisible()
    expect(provider.titleExchanges).toHaveLength(2)
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(directory, { recursive: true, force: true })
  }
})
