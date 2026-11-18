import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, openSession, ready, saveKey, startBackend, stop } from './test-utils'

const picker = (page: Page) => page.getByRole('combobox', { name: '模型', exact: true })
const effort = (page: Page) => page.getByRole('combobox', { name: '推理强度', exact: true })
const editor = (page: Page) => page.getByRole('textbox', { name: '消息', exact: true })
const send = (page: Page) => page.getByRole('button', { name: '发送', exact: true })

async function choose(page: Page, model: string) {
  await picker(page).click()
  const menu = page.getByRole('dialog', { name: '选择模型' })
  await menu.getByRole('searchbox').fill(model)
  await menu.getByRole('button', { name: model, exact: true }).click()
  await expect(picker(page)).toHaveText(model)
}

test('Feature 1 配置两家提供方、运行中预选、跨页同步、过期草稿和重启恢复', async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-model-selection-'))
  const secret = join(directory, 'browser-auth.json')
  const model = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(secret, 0, model.baseURL)
    const origin = backend.result.url
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await writeFile(join(directory, 'note.txt'), '本机工具实际返回的内容')
    const workspaceId = await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    await settings.getByRole('button', { name: '添加提供方' }).click()
    await settings.getByRole('combobox', { name: '提供方', exact: true }).click()
    await expect(page.getByRole('option', { name: 'DeepSeek', exact: true })).toHaveCount(0)
    await page.getByRole('option', { name: 'Moonshot AI CN', exact: true }).click()
    const key = settings.getByLabel('API Key', { exact: true })
    const save = settings.getByRole('button', { name: '保存', exact: true })
    await key.fill('controlled-moonshot-key')
    const originalAuth = await readFile(join(directory, 'auth.json'), 'utf8')
    await chmod(directory, 0o500)
    try {
      await save.click()
      await expect(settings.getByRole('alert')).toContainText('Credential directory')
      await expect(key).toHaveValue('controlled-moonshot-key')
      expect(await readFile(join(directory, 'auth.json'), 'utf8')).toBe(originalAuth)
    } finally { await chmod(directory, 0o700) }
    await save.click()
    await expect(settings).toContainText('已保存在本机')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    const moonshot = settings.locator('.provider-row').filter({ hasText: 'Moonshot AI CN' })
    await moonshot.getByRole('button', { name: '编辑', exact: true }).click()
    await key.fill('controlled-moonshot-replacement')
    await save.click()
    await expect(key).toHaveCount(0)
    await page.keyboard.press('Escape')

    await picker(page).click()
    const menu = page.getByRole('dialog', { name: '选择模型' })
    await expect(menu.getByRole('group', { name: 'DeepSeek' })).toBeVisible()
    await expect(menu.getByRole('group', { name: 'Moonshot AI CN' })).toBeVisible()
    await page.keyboard.press('Escape')
    expect(model.exchanges).toHaveLength(0)

    await effort(page).click()
    await page.getByRole('option', { name: '低', exact: true }).click()
    await expect(effort(page)).toHaveText('低')
    await expect(page.locator('.workspace-conversation[data-session-id]')).toHaveCount(0)
    await editor(page).fill('第一条消息')
    await send(page).click()
    await expect.poll(() => model.exchanges.length).toBe(1)
    expect(model.exchanges[0].authorized).toBe(true)
    expect(model.exchanges[0].body).toMatchObject({ model: 'deepseek-flash', reasoning_effort: 'low' })
    await expect(page.getByRole('button', { name: '第一条消息', exact: true })).toBeVisible()

    const second = await context.newPage()
    const other = observe(second)
    await second.goto(origin)
    await ready(second, other, 0, false)
    const sessionId = other.snapshots.at(-1)!.sessionId
    expect(other.snapshots.at(-1)?.snapshot.modelSelection).toEqual({ provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'low' })
    await editor(second).fill('另一页的草稿')
    await choose(page, 'Kimi K3')
    await expect(picker(second)).toHaveText('Kimi K3')
    await expect(effort(second)).toHaveText('低')
    await expect(editor(second)).toHaveText('另一页的草稿')
    await expect(page.getByText('本次任务使用 DeepSeek Flash · 低')).toBeVisible()
    await editor(page).fill('本页的草稿')
    await editor(page).press('Enter')
    await expect(editor(page)).toHaveText('本页的草稿')
    expect(model.exchanges).toHaveLength(1)
    const busy = await page.request.post(origin + '/api/messages', { data: {
      sessionId, provider: 'moonshotai-cn', modelId: 'kimi-k3', reasoningEffort: 'low', clientMessageId: 'busy', text: '并发',
    } })
    expect(busy.status()).toBe(409)
    model.exchanges[0].delta({ tool_calls: [{ index: 0, id: 'read-first', type: 'function', function: { name: 'read', arguments: '{"path":"note.txt"}' } }] })
    model.exchanges[0].finish('tool_calls')
    await expect.poll(() => model.exchanges.length).toBe(2)
    expect(model.exchanges[1].body).toMatchObject({ model: 'deepseek-flash', reasoning_effort: 'low' })
    expect(model.exchanges[1].body.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('本机工具实际返回的内容') })
    model.exchanges[1].delta({ content: '原模型已完成' })
    model.exchanges[1].finish()
    await expect(send(second)).toBeEnabled()

    let intercepted = false
    await second.route('**/api/messages', async route => {
      if (!intercepted) {
        intercepted = true
        const changed = await page.request.put(origin + '/api/model-selection', { data: {
          sessionId, provider: 'moonshotai-cn', modelId: 'kimi-k3', reasoningEffort: 'high',
        } })
        expect(changed.status()).toBe(200)
        await editor(page).fill('本页同步后的新草稿')
        await expect.poll(() => page.evaluate(id => localStorage.getItem('agent-learning:draft:' + id), sessionId)).toBe('本页同步后的新草稿')
      }
      await route.continue()
    })
    await send(second).click()
    await expect(second.getByText('模型设置已更新，请确认后再发送。')).toBeVisible()
    await expect(editor(second)).toHaveText('另一页的草稿')
    await expect(effort(second)).toHaveText('高')
    await expect(editor(page)).toHaveText('本页同步后的新草稿')
    expect(await page.evaluate(id => localStorage.getItem('agent-learning:draft:' + id), sessionId)).toBe('本页同步后的新草稿')
    expect(model.exchanges).toHaveLength(2)
    await send(second).click()
    await expect.poll(() => model.exchanges.length).toBe(3)
    expect(await page.evaluate(id => localStorage.getItem('agent-learning:draft:' + id), sessionId)).toBe('本页同步后的新草稿')
    expect(model.exchanges[2].authorization).toBe('Bearer controlled-moonshot-replacement')
    expect(model.exchanges[2].body).toMatchObject({ model: 'kimi-k3', reasoning_effort: 'high' })
    model.exchanges[2].delta({ content: '新模型已接续' })
    model.exchanges[2].finish()
    await expect(second.getByText('新模型已接续')).toBeVisible()

    model.rejectHistory()
    await editor(second).fill('服务商拒绝历史')
    await send(second).click()
    await expect(second.getByText('回复失败 · 模型服务拒绝了请求，请检查请求参数')).toBeVisible()
    await expect(second.locator('[data-run-status="failed"]').last()).toBeVisible()
    await expect(second.getByText('新模型已接续')).toBeVisible()
    expect(model.rejected).toBe(1)
    await second.close()

    const created = await page.request.post(origin + '/api/sessions', { data: { workspaceId } })
    expect(created.status()).toBe(201)
    const independent = await created.json()
    const savedIndependent = await page.request.put(origin + '/api/model-selection', { data: {
      sessionId: independent.id, provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'high',
    } })
    expect(savedIndependent.status()).toBe(200)
    const updatedDefault = await page.request.put(origin + '/api/model-selection', { data: {
      sessionId, provider: 'moonshotai-cn', modelId: 'kimi-k3', reasoningEffort: 'low',
    } })
    expect(updatedDefault.status()).toBe(200)
    await stop(backend.child)
    backend = await startBackend(secret, Number(new URL(origin).port), model.baseURL)
    const beforeReload = observed.snapshots.length
    await page.reload()
    await ready(page, observed, beforeReload, false)
    const restored = observed.snapshots.at(-1)!
    expect(restored.snapshot.modelSelection).toMatchObject({ modelId: 'kimi-k3', reasoningEffort: 'low' })
    await expect(picker(page)).toHaveText('Kimi K3')
    const restoredIndependent = await openSession(page, observed, independent.id)
    expect(restoredIndependent.snapshot.modelSelection).toMatchObject({ modelId: 'deepseek-flash', reasoningEffort: 'high' })
    await page.locator('.sidebar-new-session').click()
    await expect(picker(page)).toHaveText('Kimi K3')
    expect(model.exchanges).toHaveLength(3)
    await openSession(page, observed, sessionId)
    await stop(backend.child)
    const { SessionStore } = await import('@agent-learning/coding-agent')
    const store = SessionStore.open(join(directory, 'sessions.sqlite'))
    try {
      store.saveModelSelection({ provider: 'google', modelId: 'gemini-3.5-flash-lite', reasoningEffort: 'medium' }, sessionId)
    } finally { store.close() }
    backend = await startBackend(secret, Number(new URL(origin).port), model.baseURL)
    const beforeLegacyReload = observed.snapshots.length
    await page.reload()
    await ready(page, observed, beforeLegacyReload, false)
    expect(observed.snapshots.at(-1)?.snapshot.modelSelection?.modelId).toBe('gemini-3.5-flash-lite')
    await expect(page.getByText('新模型已接续')).toBeVisible()
    await expect(picker(page)).toHaveText('重新选择模型')
    await expect(page.getByText('当前模型不可用，请重新选择。')).toBeVisible()
    await editor(page).fill('切回后继续')
    await expect(send(page)).toBeDisabled()
    await choose(page, 'DeepSeek Flash')
    await expect(send(page)).toBeEnabled()
    await send(page).click()
    await expect.poll(() => model.exchanges.length).toBe(4)
    expect(model.exchanges[3].body.model).toBe('deepseek-flash')
    model.exchanges[3].delta({ content: '重选后继续成功' })
    model.exchanges[3].finish()
    await expect(page.getByText('重选后继续成功')).toBeVisible()
  } finally {
    await Promise.allSettled([stop(backend?.child), model.close()])
    await rm(directory, { recursive: true, force: true })
  }
})

test('Feature 1 小模型容量不足后，从同一网页用大模型压缩，再切回继续', async ({ page }) => {
  const { WebServer } = await import('@agent-learning/server')
  const { piModels } = await import('../../../packages/model/dist/catalog.js')
  const { createProvider } = await import('@earendil-works/pi-ai/models')
  const { moonshotaiCnProvider } = await import('@earendil-works/pi-ai/providers/moonshotai-cn')
  const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
  const original = moonshotaiCnProvider()
  const target = original.getModels().find(item => item.id === 'kimi-k3')!
  piModels.setProvider(createProvider({
    id: original.id, name: original.name, auth: original.auth, api: openAICompletionsApi(),
    models: [{ ...target, contextWindow: 2400, maxTokens: 128 }],
  }))
  const directory = await mkdtemp(join(tmpdir(), 'agent-model-capacity-'))
  const model = await startModelServer()
  const server = new WebServer({
    port: 0, directoryPicker: async () => directory, compaction: { triggerTokens: 5000, keepRecentTokens: 100 },
    workspacePath: join(directory, 'workspaces.json'), sessionPath: join(directory, 'sessions.sqlite'),
    browserSecretPath: join(directory, 'browser-auth.json'), modelAuthPath: join(directory, 'auth.json'),
    webSettingsPath: join(directory, 'settings.json'), skillHome: join(directory, 'skill-home'), globalContextDirectory: join(directory, 'global'),
    modelOptions: { baseURL: model.baseURL },
  })
  try {
    const { url, authUrl } = await server.start()
    const observed = observe(page)
    await authorize(page, authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const saved = await page.request.put(url + '/api/providers/moonshotai-cn', { data: { apiKey: 'controlled-test-key' } })
    expect(saved.status()).toBe(200)
    for (const index of [0, 1]) {
      await editor(page).fill('原有历史' + 'a'.repeat(3400))
      await send(page).click()
      await expect.poll(() => model.exchanges.length).toBe(index + 1)
      model.exchanges[index].delta({ content: '原回复' + 'b'.repeat(2200) })
      model.exchanges[index].finish()
      await expect(send(page)).toBeDisabled()
      await expect(page.getByRole('button', { name: '中止', exact: true })).toHaveCount(0)
    }
    await choose(page, 'Kimi K3')
    await editor(page).fill('请继续这个任务')
    await send(page).click()
    await expect(page.getByText('当前模型容量不足，无法继续这轮，请切换模型重新压缩。')).toBeVisible()
    await expect(page.getByText('摘要请求预计超出模型容量。')).toBeVisible()
    expect(model.exchanges).toHaveLength(2)

    await choose(page, 'DeepSeek Flash')
    await editor(page).fill('/')
    await page.getByRole('option', { name: /compact/ }).click()
    await expect(editor(page)).toHaveText('')
    await expect.poll(() => model.exchanges.length).toBe(3)
    expect(model.exchanges[2].body.model).toBe('deepseek-flash')
    model.exchanges[2].delta({ content: '已整理的原任务事实' })
    model.exchanges[2].finish()
    await expect(page.getByText('手动压缩 · 已完成')).toBeVisible()

    await choose(page, 'Kimi K3')
    await editor(page).fill('请使用已有摘要继续')
    await send(page).click()
    await expect.poll(() => model.exchanges.length).toBe(4)
    expect(model.exchanges[3].body.model).toBe('kimi-k3')
    expect(JSON.stringify(model.exchanges[3].body.messages)).toContain('已整理的原任务事实')
    model.exchanges[3].delta({ content: '已用小模型继续' })
    model.exchanges[3].finish()
    await expect(page.getByText('已用小模型继续')).toBeVisible()
    expect(observed.updates.some(({ update }) => update.run?.status === 'failed' && update.run.provider === 'moonshotai-cn')).toBe(true)
  } finally {
    piModels.setProvider(original)
    await Promise.allSettled([server.close(), model.close()])
    await rm(directory, { recursive: true, force: true })
  }
})
