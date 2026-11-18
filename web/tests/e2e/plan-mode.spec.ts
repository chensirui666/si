import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import { expect, test } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, ready, saveKey, startBackend, stop } from './test-utils'

test('计划 25/27/28/30：从新草稿规划，重启恢复，继续讨论并确认同一执行轮', async ({ page }) => {
  const temporary = await mkdtemp(join(tmpdir(), 'si-planning-browser-'))
  const workspace = join(temporary, 'workspace')
  const provider = await startModelServer()
  const options = {
    port: 0,
    sessionPath: join(temporary, 'sessions.sqlite'),
    browserSecretPath: join(temporary, 'browser-auth.json'),
    modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'),
    webSettingsPath: join(temporary, 'settings.json'),
    skillHome: temporary,
    globalContextDirectory: join(temporary, 'project-context'),
    directoryPicker: async () => workspace,
    modelOptions: { baseURL: provider.baseURL },
  }
  const server = new WebServer(options)
  let restarted: WebServer | undefined
  try {
    await mkdir(workspace)
    const { url, authUrl } = await server.start()
    const observed = observe(page)
    await authorize(page, authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const chat = page.locator('.chat-page')
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    const messages = page.getByRole('region', { name: '消息列表' })
    const card = page.getByRole('region', { name: '待确认计划' })
    const planMode = page.getByRole('button', { name: '退出计划模式', exact: true })
    const create = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/sessions' && response.request().method() === 'POST')
    await editor.fill('/plan')
    await expect(editor).toHaveText('/plan')
    await expect(send).toBeEnabled()
    await send.click()
    expect((await create).status()).toBe(201)
    await expect(planMode).toBeVisible()
    const sessionId = await chat.getAttribute('data-session-id')
    expect(sessionId).toBeTruthy()
    expect(provider.exchanges).toHaveLength(0)

    const sendText = async (text: string) => {
      await editor.fill(text)
      await expect(send).toBeEnabled()
      await send.click()
    }
    const toolNames = (index: number) => (provider.exchanges[index]?.body.tools as { function: { name: string } }[])
      .map(tool => tool.function.name)
    const plans = () => observed.updates.flatMap(({ sessionId: id, update }) =>
      id === sessionId && update.change.type === 'plan' && update.change.plan?.state === 'review' ? [update.change.plan] : [])

    await sendText('规划服务启动排查。')
    await expect.poll(() => provider.exchanges.length).toBe(1)
    expect(toolNames(0)).toEqual(expect.arrayContaining(['read', 'bash']))
    expect(toolNames(0)).not.toContain('write')
    const first = provider.exchanges[0]!
    first.delta({ content: 'Plan:\n1. 查看日志' })
    await expect(messages).toContainText('查看日志')
    await expect(card).toHaveCount(0)
    first.delta({ content: '\n2. 检查启动设置' })
    first.finish()
    await expect(card.getByRole('listitem')).toHaveText(['查看日志', '检查启动设置'])
    await expect(card.getByRole('button')).toHaveCount(2)
    await expect(card.getByRole('button', { name: '确认执行', exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: '去聊天里说', exact: true })).toBeVisible()
    await expect.poll(() => plans().length).toBe(1)
    const original = plans()[0]

    const snapshotsBefore = observed.snapshots.length
    await server.close()
    restarted = new WebServer({ ...options, port: Number(new URL(url).port) })
    const resumed = await restarted.start()
    await authorize(page, resumed.authUrl)
    await ready(page, observed, snapshotsBefore, false)
    await expect(chat).toHaveAttribute('data-session-id', sessionId!)
    await expect(planMode).toBeVisible()
    await expect(card.getByRole('listitem')).toHaveText(original!.steps)
    expect(observed.snapshots.at(-1)?.snapshot.plan).toEqual(original)
    expect(provider.exchanges).toHaveLength(1)

    await card.getByRole('button', { name: '去聊天里说', exact: true }).click()
    await expect(card).toBeHidden()
    await expect(planMode).toBeVisible()
    await expect(editor).toBeFocused()
    await expect(messages).toContainText('检查启动设置')
    await sendText('请先复现，再检查设置。')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    expect(toolNames(1)).not.toContain('edit')
    const second = provider.exchanges[1]!
    const acceptedPlan = 'Plan:\n1. 复现启动失败\n2. 检查启动设置'
    second.delta({ content: acceptedPlan })
    second.finish()
    await expect(card.getByRole('listitem')).toHaveText(['复现启动失败', '检查启动设置'])
    await expect.poll(() => plans().length).toBe(2)
    const current = plans()[1]
    expect(current?.assistantMessageId).not.toBe(original?.assistantMessageId)

    const route = `/api/sessions/${sessionId}/plan/review`
    const approved = page.waitForResponse(response => new URL(response.url()).pathname === route)
    await card.getByRole('button', { name: '确认执行', exact: true }).click()
    expect((await approved).status()).toBe(202)
    const clientMessageId = `plan:${current!.assistantMessageId}`
    const execution = () => observed.updates.find(({ sessionId: id, update: { change } }) =>
      id === sessionId && change.type === 'accepted' && change.user.clientMessageId === clientMessageId)
    await expect.poll(execution).toBeTruthy()
    const originalExecution = execution()!.update
    if (originalExecution.change.type !== 'accepted') throw new Error('缺少执行轮接收事件')
    const retry = await page.request.post(url + route, {
      headers: { Origin: url }, data: { planId: current!.assistantMessageId, action: 'approve' },
    })
    expect(retry.status()).toBe(202)
    expect(await retry.json()).toEqual({
      kind: 'message', sessionId, clientMessageId, userMessageId: originalExecution.change.user.id, acceptedSeq: originalExecution.seq,
    })
    await expect(card).toBeHidden()
    await expect(planMode).toBeHidden()
    await expect.poll(() => provider.exchanges.length).toBe(3)
    expect(toolNames(2)).toContain('write')
    expect(provider.exchanges[2]?.body.messages.at(-1)).toMatchObject({
      role: 'user', content: expect.stringContaining(acceptedPlan),
    })
    provider.exchanges[2]!.delta({ content: '方案已执行完毕。' })
    provider.exchanges[2]!.finish()
    await expect(messages).toContainText('方案已执行完毕。')
    expect(provider.exchanges).toHaveLength(3)
  } finally {
    await Promise.allSettled([server.close(), restarted?.close(), provider.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

test('拖放附件随计划任务提交，运行中退出在同一任务的下一次模型调用生效', async ({ page }) => {
  const workspace = await mkdtemp(join(tmpdir(), 'si-plan-switch-'))
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(workspace, 'browser-auth.json'), 0, provider.baseURL)
    await authorize(page, backend.result.authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const add = page.getByRole('button', { name: '添加', exact: true })
    const chip = page.getByRole('button', { name: '退出计划模式', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    const menu = page.getByRole('menu', { name: '添加' })
    await add.click()
    await expect(menu.getByRole('menuitem')).toHaveCount(2)
    const chooser = page.waitForEvent('filechooser')
    await menu.getByRole('menuitem', { name: '添加文件' }).click()
    await (await chooser).setFiles({ name: 'menu.txt', mimeType: 'text/plain', buffer: Buffer.from('菜单附件') })
    const uploaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/attachments' && r.request().headers()['x-attachment-name'] === 'drag.txt')
    await page.evaluate(() => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File(['拖放附件'], 'drag.txt', { type: 'text/plain' }))
      document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }))
      document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    })
    expect((await uploaded).status()).toBe(201)
    const task = '规划首页，先检查两个附件。'
    await editor.fill(task)
    await add.click()
    await menu.getByRole('menuitem', { name: /计划模式/ }).click()
    await expect(editor).toContainText(task)
    await expect(chip).toBeHidden()
    await expect(send).toBeEnabled()
    await send.click()
    await expect(chip).toBeEnabled()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    const first = provider.exchanges[0]!
    const toolsFor = (index: number) => (provider.exchanges[index]!.body.tools as { function: { name: string } }[]).map(tool => tool.function.name)
    expect(toolsFor(0)).not.toContain('write')
    const input = JSON.stringify(first.body.messages.at(-1))
    for (const text of [task, 'drag.txt', 'menu.txt']) expect(input).toContain(text)
    expect(input).not.toContain('/plan ')
    const reviews: string[] = []
    page.on('request', r => { if (r.url().endsWith('/plan/review')) reviews.push(r.url()) })
    await editor.fill('下一条消息的草稿')
    const off = page.waitForResponse(r => new URL(r.url()).pathname === '/api/messages' && r.request().postDataJSON()?.text === '/plan off')
    await chip.click()
    expect((await off).status()).toBe(202)
    await expect(chip).toBeHidden()
    await expect(editor).toHaveText('下一条消息的草稿')
    expect(provider.exchanges).toHaveLength(1)
    const write = (index: number, path: string) => {
      const exchange = provider.exchanges[index]!
      exchange.delta({ tool_calls: [{ index: 0, id: 'call-' + index, type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ path, content: '已验证' }) } }] })
      exchange.finish('tool_calls')
    }
    // Model output can name a tool even when it was absent from the advertised set.
    write(0, 'blocked.txt')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    await expect(readFile(join(workspace, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(toolsFor(1)).toContain('write')
    write(1, 'allowed.txt')
    await expect.poll(() => provider.exchanges.length).toBe(3)
    expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('已验证')
    provider.exchanges[2]!.delta({ content: '本次任务已结束。' })
    provider.exchanges[2]!.finish()
    await expect(page.getByRole('region', { name: '消息列表' })).toContainText('本次任务已结束。')
    expect(reviews).toHaveLength(0)

    await editor.fill('/plan 再拟一份计划')
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(4)
    provider.exchanges[3]!.delta({ content: 'Plan:\n1. 调研首页\n2. 优化标题' })
    provider.exchanges[3]!.finish()
    const review = page.getByRole('region', { name: '待确认计划' })
    await expect(review).toBeVisible()
    await chip.click()
    await expect(review).toBeHidden()
    await expect(chip).toBeHidden()
    await page.reload()
    await expect(page.getByRole('region', { name: '消息列表' })).toContainText('优化标题')
    await expect(chip).toBeHidden()
    expect(provider.exchanges).toHaveLength(4)
    expect(reviews).toHaveLength(0)
  } finally {
    if (backend) await stop(backend.child)
    await provider.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
