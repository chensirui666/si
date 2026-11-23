import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import type { ScheduledRunView, ScheduleView, SessionSummary } from '@agent-learning/server/protocol'
import { expect, test, type Page } from './chinese-fixture'
import { readLiveKey } from './live-key'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, openSession, saveKey, seedSession, startBackend, stop } from './test-utils'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function useControlledServer(at: string) {
  const originalTimezone = process.env.TZ
  const temporary = await mkdtemp(join(tmpdir(), 'agent-schedules-e2e-'))
  const provider = await startModelServer()
  let now = Date.parse(at)
  let server: WebServer | undefined
  async function start(timezone: string, port = 0) {
    await server?.close()
    process.env.TZ = timezone
    server = new WebServer({
      port, now: () => now,
      directoryPicker: async () => temporary,
      browserSecretPath: join(temporary, 'browser-auth.json'),
      sessionPath: join(temporary, 'sessions.sqlite'),
      modelAuthPath: join(temporary, 'auth.json'),
      workspacePath: join(temporary, 'workspaces.json'),
      webSettingsPath: join(temporary, 'settings.json'),
      skillHome: join(temporary, 'skills'),
      globalContextDirectory: join(temporary, 'context'),
      modelOptions: { baseURL: provider.baseURL },
    })
    return server.start()
  }
  return {
    provider, start,
    async scanAt(at: string) {
      now = Date.parse(at)
      await server!.scanScheduledTasks()
    },
    async close() {
      if (originalTimezone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimezone
      await provider.close()
      await server?.close()
      await rm(temporary, { recursive: true, force: true })
    },
  }
}

async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(new URL(path, page.url()).href)
  expect(response.ok()).toBe(true)
  return response.json()
}

async function schedules(page: Page) {
  return (await api<{ schedules: ScheduleView[] }>(page, '/api/schedules')).schedules
}

async function runs(page: Page, id: string) {
  return (await api<{ runs: ScheduledRunView[] }>(page, '/api/schedules/' + id + '/runs')).runs
}

function sessionRow(page: Page, id: string) {
  return page.locator('.workspace-conversation[data-session-id="' + id + '"]')
}

function alarm(page: Page, id: string) {
  return sessionRow(page, id).locator('.workspace-conversation-alarm')
}

async function startChat(page: Page, url: string, key: string, observed: ReturnType<typeof observe>) {
  await authorize(page, url)
  const workspaceId = await addWorkspace(page)
  const sessionId = await seedSession(page, observed, workspaceId)
  await saveKey(page, key)
  return { workspaceId, sessionId }
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/messages')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await response).status()).toBe(202)
}

async function controlledCall(provider: Awaited<ReturnType<typeof startModelServer>>, index: number, name: string, args: object) {
  await expect.poll(() => provider.exchanges.length).toBeGreaterThan(index)
  provider.exchanges[index]!.delta({ tool_calls: [{
    index: 0, id: name + '-' + index, type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] })
  provider.exchanges[index]!.finish('tool_calls')
  await expect.poll(() => provider.exchanges.length).toBeGreaterThan(index + 1)
  return provider.exchanges[index + 1]!
}

async function reply(page: Page, exchange: Awaited<ReturnType<typeof controlledCall>>, text = '已安排重复定时任务。') {
  exchange.delta({ content: text })
  exchange.finish()
  await expect(page.getByRole('region', { name: '消息列表' })).toContainText(text)
  await expect(page.getByRole('button', { name: '中止', exact: true })).toHaveCount(0)
}

function taskRow(page: Page, sessionId: string) {
  return page.locator(`.schedule-row[data-task-session-id="${sessionId}"]`)
}

async function manage(page: Page, sessionId?: string) {
  const sidebar = page.getByRole('combobox', { name: '内容区', exact: true })
  if ((await sidebar.textContent())?.trim() !== '定时任务') {
    await sidebar.click()
    await page.getByRole('option', { name: '定时任务', exact: true }).click()
  }
  await expect(page.getByRole('navigation', { name: '定时任务', exact: true })).toBeVisible()
  if (sessionId) await taskRow(page, sessionId).locator('.schedule-list-button').click()
}

async function taskAction(page: Page, sessionId: string, action: string) {
  await taskRow(page, sessionId).getByRole('button', { name: /^管理定时任务/ }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

async function patch(page: Page, id: string, data: object) {
  const url = new URL('/api/schedules/' + id, page.url())
  return page.request.patch(url.href, { data, headers: { Origin: url.origin } })
}

async function sessions(page: Page) {
  return (await api<{ sessions: SessionSummary[] }>(page, '/api/sessions')).sessions
}

test('定时任务表单只发送新会话的首条消息，等待模型保存计划', async ({ page }) => {
  const fixture = await useControlledServer('2026-11-21T04:00:00Z')
  const prompt = '汇总工作区本周的提交'
  try {
    const { authUrl } = await fixture.start('Asia/Shanghai')
    const { workspaceId, sessionId: originalId } = await startChat(page, authUrl, 'controlled-stage3-key', observe(page))
    await page.getByLabel('新会话', { exact: true }).click()
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留普通会话草稿')
    await manage(page)
    await expect(page.getByRole('navigation', { name: '工作区' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '安排任务' })).toBeVisible()
    const groups = page.getByRole('navigation', { name: '定时任务', exact: true }).getByRole('heading', { level: 2 })
    await expect(groups).toHaveText(['已开启', '已暂停'])

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置定时任务' })
    await expect(dialog.getByRole('button', { name: '创建', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await dialog.getByLabel('任务说明', { exact: true }).fill(prompt)
    const project = dialog.getByRole('combobox', { name: '项目', exact: true })
    await project.click()
    await expect(page.getByRole('option', { name: '添加工作区…', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(project).toBeFocused()
    await dialog.getByRole('combobox', { name: '重复频率', exact: true }).click()
    await page.getByRole('option', { name: '每周', exact: true }).click()
    const friday = dialog.getByRole('button', { name: '周五', exact: true })
    await friday.click()
    await expect(friday).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByRole('combobox', { name: '时间', exact: true }).click()
    await page.getByRole('option', { name: '17:30', exact: true }).click()
    const requests: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path.startsWith('/api/')) requests.push(path)
    })
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    await expect(dialog).toBeHidden()
    const chat = page.locator('.chat-page')
    await expect(chat).toHaveAttribute('data-session-id', /.+/)
    const sessionId = await chat.getAttribute('data-session-id')
    expect(sessionId).not.toBe(originalId)
    expect(requests).toEqual(['/api/sessions/start'])
    const messages = page.getByRole('region', { name: '消息列表' })
    await expect(messages).toContainText(prompt)
    await expect(messages).toContainText('每周五 17:30')
    expect(await schedules(page)).toEqual([])

    const schedule = { kind: 'weekly', weekdays: [5], time: '17:30' }
    const continuation = await controlledCall(fixture.provider, 0, 'cronjob_manage', { action: 'create', prompt, schedule })
    await reply(page, continuation)
    expect(await schedules(page)).toMatchObject([{ sessionId, workspaceId, prompt, schedule, status: 'enabled' }])
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    await editor.fill('这条任务会话的草稿')
    await sessionRow(page, originalId).click()
    await manage(page, sessionId!)
    await expect(chat).toHaveAttribute('data-session-id', sessionId!)
    await expect(taskRow(page, sessionId!).locator('.schedule-list-button')).toHaveAttribute('aria-current', 'true')
    await expect(messages).toContainText('已安排重复定时任务。')
    await expect(editor).toHaveText('这条任务会话的草稿')

    const saved = await schedules(page)
    const section = page.getByRole('combobox', { name: '内容区', exact: true })
    await section.click()
    await page.getByRole('option', { name: '首页', exact: true }).click()
    await sessionRow(page, originalId).click()
    await manage(page)
    await expect(chat).toHaveAttribute('data-session-id', sessionId!)
    await expect(editor).toHaveText('这条任务会话的草稿')
    const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/messages')
    await taskAction(page, sessionId!, '立即运行')
    expect((await sent).postDataJSON()).toMatchObject({ sessionId, text: prompt })
    await expect(chat).toHaveAttribute('data-session-id', sessionId!)
    await expect(messages.getByText(prompt, { exact: true })).toBeVisible()
    await expect(editor).toHaveText('这条任务会话的草稿')
    await expect.poll(() => fixture.provider.exchanges.length).toBe(3)
    await taskAction(page, sessionId!, '立即运行')
    await expect(page.getByRole('alert').filter({ hasText: '无法立即运行' })).toBeVisible()
    expect(fixture.provider.exchanges).toHaveLength(3)
    await reply(page, fixture.provider.exchanges[2]!, '本次立即运行完成。')
    expect(await schedules(page)).toEqual(saved)
    expect(await runs(page, saved[0]!.id)).toEqual([])

    await section.click()
    await page.getByRole('option', { name: '首页', exact: true }).click()
    await sessionRow(page, sessionId!).click()
    await expect(messages).toContainText('本次立即运行完成。')
    await expect(editor).toHaveText('这条任务会话的草稿')
    await page.getByLabel('新会话', { exact: true }).click()
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveText('保留普通会话草稿')
  } finally {
    await fixture.close()
  }
})

test('定时任务首条消息未确认时，刷新后重试同一请求', async ({ page }) => {
  const fixture = await useControlledServer('2026-11-21T04:00:00Z')
  const prompt = '整理项目的待办事项'
  try {
    const { authUrl } = await fixture.start('Asia/Shanghai')
    await startChat(page, authUrl, 'controlled-stage3-key', observe(page))
    const attempts: unknown[] = []
    await page.route('**/api/sessions/start', route => {
      attempts.push(route.request().postDataJSON())
      return attempts.length === 1 ? route.abort() : route.continue()
    })
    await manage(page)
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置定时任务' })
    await dialog.getByLabel('任务说明', { exact: true }).fill(prompt)
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    const retry = page.getByRole('button', { name: '重试首次发送', exact: true })
    await expect(dialog.getByRole('button', { name: '重试首次发送', exact: true })).toBeVisible()
    await page.reload()
    await retry.click()
    await expect.poll(() => fixture.provider.exchanges.length).toBe(1)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    await reply(page, fixture.provider.exchanges[0]!, '请确认要登记的项目内容。')
    await expect(page.getByRole('region', { name: '消息列表' })).toContainText(prompt)
    expect(await schedules(page)).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('01 聊天只在创建工具保存后显示新计划、实际时间和闹钟', async ({ page }) => {
  const fixture = await useControlledServer('2026-11-21T04:00:00Z')
  const prompt = '汇总本周的 Git 提交'
  const schedule = { kind: 'weekly', weekdays: [5], time: '17:00' }
  const observed = observe(page)
  try {
    const { authUrl } = await fixture.start('Asia/Shanghai')
    const { workspaceId, sessionId } = await startChat(page, authUrl, 'controlled-stage3-key', observed)
    await send(page, '每周五 17:00 在这里汇总本周的 Git 提交')
    await expect.poll(() => fixture.provider.exchanges.length).toBe(1)
    const declared = fixture.provider.exchanges[0]!.body.tools as { function: { name: string; parameters: unknown } }[]
    expect(declared.find(tool => tool.function.name === 'cronjob_manage')).toBeDefined()
    expect(JSON.stringify(declared.find(tool => tool.function.name === 'cronjob_manage')?.function.parameters)).not.toContain('timezone')
    await expect(page.getByRole('region', { name: '消息列表' })).toContainText('每周五 17:00')
    expect(await schedules(page)).toEqual([])
    await expect(alarm(page, sessionId)).toHaveCount(0)
    await manage(page)

    const continuation = await controlledCall(fixture.provider, 0, 'cronjob_manage', { action: 'create', prompt, schedule })
    await expect(taskRow(page, sessionId)).toBeVisible()
    await expect(page.getByText(/11\s*月\s*27\s*日.*17:00.*每周五/)).toBeVisible()
    const [saved] = await schedules(page)
    expect(saved).toMatchObject({
      sessionId, workspaceId, prompt, schedule, timezone: 'Asia/Shanghai', sessionMode: 'reuse',
      status: 'enabled', nextRunAt: Date.parse('2026-11-27T09:00:00Z'),
    })
    const result = continuation.body.messages.find(message => message.role === 'tool')
    expect(String(result?.content)).toContain(saved!.id)
    expect((await sessions(page)).find(session => session.id === sessionId)?.hasScheduledTask).toBe(true)
    expect(await runs(page, saved!.id)).toEqual([])

    await manage(page, sessionId)
    await reply(page, continuation)
    await page.getByRole('combobox', { name: '内容区', exact: true }).click()
    await page.getByRole('option', { name: '首页', exact: true }).click()
    await expect(alarm(page, sessionId)).toBeVisible()
    await expect(sessionRow(page, sessionId)).toHaveAccessibleDescription('有重复定时任务')
    await fixture.scanAt('2026-11-27T08:59:59Z')
    expect(await runs(page, saved!.id)).toEqual([])
    expect(fixture.provider.exchanges).toHaveLength(2)
  } finally {
    await fixture.close()
  }
})

test('23–24 编辑说明保留下次时间，切换服务时区后仍按保存的时区改日程', async ({ page, context }) => {
  const fixture = await useControlledServer('2026-11-22T16:30:00Z')
  const prompt = '整理项目进展'
  const updatedPrompt = '整理项目进展并列出风险'
  const observed = observe(page)
  try {
    const boot = await fixture.start('Asia/Shanghai')
    const { workspaceId, sessionId } = await startChat(page, boot.authUrl, 'controlled-stage3-key', observed)
    await send(page, '每天 9 点在这里整理项目进展')
    await reply(page, await controlledCall(fixture.provider, 0, 'cronjob_manage', {
      action: 'create', prompt, schedule: { kind: 'daily', time: '09:00' },
    }))
    const [saved] = await schedules(page)
    expect(saved?.nextRunAt).toBe(Date.parse('2026-11-23T01:00:00Z'))

    const reboot = await fixture.start('America/New_York', Number(new URL(boot.url).port))
    await authorize(page, reboot.authUrl)
    await expect(alarm(page, sessionId)).toBeVisible()
    const other = await context.newPage()
    await other.goto(reboot.url)
    await manage(other)
    await expect(taskRow(other, sessionId)).toBeVisible()
    await manage(page, sessionId)
    await taskAction(page, sessionId, '编辑')
    const project = page.getByLabel('项目', { exact: true })
    await expect(project).toHaveJSProperty('readOnly', true)
    await expect(page.getByText('北京时间', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: '时间', exact: true })).toHaveText('09:00')

    const editing = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/schedules/' + saved!.id)
    await page.getByLabel('任务说明', { exact: true }).fill(updatedPrompt)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    expect((await editing).postDataJSON()).toEqual({ action: 'update', prompt: updatedPrompt })
    expect(await schedules(page)).toEqual([{ ...saved, prompt: updatedPrompt }])
    expect((await patch(page, saved!.id, { action: 'update', workspaceId: 'other-project' })).ok()).toBe(false)
    expect((await patch(page, saved!.id, { action: 'update', schedule: { kind: 'daily', time: '25:00' } })).ok()).toBe(false)
    expect(await schedules(page)).toEqual([{ ...saved, prompt: updatedPrompt }])

    await taskAction(page, sessionId, '编辑')
    await expect(page.getByLabel('任务说明', { exact: true })).toHaveValue(updatedPrompt)
    const changing = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/schedules/' + saved!.id)
    await page.getByRole('combobox', { name: '时间', exact: true }).click()
    await page.getByRole('option', { name: '自定义时间…', exact: true }).click()
    await page.getByLabel('自定义时间', { exact: true }).fill('10:07')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    expect((await changing).postDataJSON()).toEqual({ action: 'update', schedule: { kind: 'daily', time: '10:07' } })
    await expect(other.getByText(/11\s*月\s*23\s*日.*10:07/)).toBeVisible()
    expect(await schedules(page)).toEqual([{
      ...saved, workspaceId, timezone: 'Asia/Shanghai', prompt: updatedPrompt,
      schedule: { kind: 'daily', time: '10:07' }, nextRunAt: Date.parse('2026-11-23T02:07:00Z'),
    }])

    await fixture.scanAt('2026-11-23T01:00:00Z')
    expect(await runs(page, saved!.id)).toEqual([])
    expect(fixture.provider.exchanges).toHaveLength(2)
    await fixture.scanAt('2026-11-23T02:07:00Z')
    await expect.poll(() => fixture.provider.exchanges.length).toBe(3)
    expect(fixture.provider.exchanges[2]!.body.messages.at(-1)?.content).toEqual(expect.stringContaining(updatedPrompt))
    fixture.provider.exchanges[2]!.delta({ content: '定时整理完成。' })
    fixture.provider.exchanges[2]!.finish()
    await expect.poll(async () => (await runs(page, saved!.id))[0]?.runStatus).toBe('completed')

    await taskAction(page, sessionId, '编辑')
    await expect(page.getByRole('combobox', { name: '时间', exact: true })).toHaveText('10:07')
    await page.getByRole('combobox', { name: '重复频率', exact: true }).click()
    await page.getByRole('option', { name: '工作日', exact: true }).click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await schedules(page))[0]?.schedule).toEqual({ kind: 'weekdays', time: '10:07' })
  } finally {
    await fixture.close()
  }
})

test('26–29 暂停期间不补跑，执行目标决定闹钟，删除保留原会话与执行结果', async ({ page, context }) => {
  const fixture = await useControlledServer('2026-11-21T00:00:00Z')
  const prompt = '每天记录项目提醒'
  const observed = observe(page)
  try {
    const boot = await fixture.start('Asia/Shanghai')
    const { sessionId } = await startChat(page, boot.authUrl, 'controlled-stage3-key', observed)
    await send(page, '每天 09:00 在这里记录项目提醒')
    await reply(page, await controlledCall(fixture.provider, 0, 'cronjob_manage', {
      action: 'create', prompt, schedule: { kind: 'daily', time: '09:00' },
    }))
    const [saved] = await schedules(page)
    const other = await context.newPage()
    const otherObserved = observe(other)
    await other.goto(boot.url)
    await expect(alarm(other, sessionId)).toBeVisible()

    await manage(page, sessionId)
    await taskAction(page, sessionId, '暂停')
    const selectedTask = (group: string) => page.getByRole('region', { name: group, exact: true })
      .locator(`.schedule-row[data-task-session-id="${sessionId}"] .schedule-list-button`)
    await expect(selectedTask('已暂停')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.chat-page')).toHaveAttribute('data-session-id', sessionId)
    await expect(alarm(other, sessionId)).toHaveCount(0)
    expect((await schedules(page))[0]).toMatchObject({ status: 'paused', nextRunAt: null })
    await fixture.scanAt('2026-11-23T01:45:00Z')
    expect(await runs(page, saved!.id)).toEqual([])
    expect(fixture.provider.exchanges).toHaveLength(2)
    await taskAction(page, sessionId, '恢复')
    await expect(selectedTask('已开启')).toHaveAttribute('aria-current', 'true')
    await expect(alarm(other, sessionId)).toBeVisible()
    expect((await schedules(page))[0]?.nextRunAt).toBe(Date.parse('2026-11-24T01:00:00Z'))

    const editMode = async (useNew: boolean) => {
      await taskAction(page, sessionId, '编辑')
      const setting = page.getByRole('switch', { name: '每次运行时都开启新会话', exact: true })
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      await setting.setChecked(useNew)
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(async () => (await schedules(page))[0]?.sessionMode).toBe(useNew ? 'new' : 'reuse')
    }
    await editMode(true)
    await expect(alarm(other, sessionId)).toHaveCount(0)
    await editMode(false)
    await expect(alarm(other, sessionId)).toBeVisible()
    await editMode(true)

    await fixture.scanAt('2026-11-24T01:00:00Z')
    const continuation = await controlledCall(fixture.provider, 2, 'write', { path: 'schedule-proof.txt', content: '定时写入成功' })
    await expect.poll(async () => (await runs(page, saved!.id))[0]?.runStatus).toBe('running')
    continuation.delta({ content: '本轮已记录项目提醒。' })
    continuation.finish()
    await expect.poll(async () => (await runs(page, saved!.id))[0]?.runStatus).toBe('completed')
    const [executed] = await runs(page, saved!.id)
    expect(executed?.sessionId).toBeTruthy()
    expect(executed?.sessionId).not.toBe(sessionId)
    await expect(sessionRow(other, executed!.sessionId!)).toBeVisible()
    await expect(alarm(other, executed!.sessionId!)).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: '定时任务', exact: true })).toBeVisible()
    await expect(page.locator('.chat-page')).toHaveAttribute('data-session-id', sessionId)
    await taskAction(page, sessionId, '删除')
    await page.getByRole('dialog', { name: '删除定时任务' }).getByRole('button', { name: '删除', exact: true }).click()
    await expect(selectedTask('已开启')).toHaveCount(0)
    await expect.poll(() => schedules(page)).toEqual([])
    const ids = (await sessions(page)).map(session => session.id)
    expect(ids).toEqual(expect.arrayContaining([sessionId, executed!.sessionId]))
    await expect(alarm(other, sessionId)).toHaveCount(0)

    await fixture.scanAt('2026-11-25T01:00:00Z')
    expect(fixture.provider.exchanges).toHaveLength(4)
    const restored = await openSession(other, otherObserved, executed!.sessionId!)
    await expect(other.getByRole('region', { name: '消息列表' })).toContainText('本轮已记录项目提醒。')
    expect(restored.snapshot.messages.some(entry =>
      entry.message.role === 'toolResult' && entry.message.toolName === 'write' && !entry.message.isError)).toBe(true)
    await openSession(other, otherObserved, sessionId)
    await expect(other.getByRole('region', { name: '消息列表' })).toContainText('已安排重复定时任务。')
    await send(other, '重新安排每天 09:00 记录项目提醒')
    await reply(other, await controlledCall(fixture.provider, 4, 'cronjob_manage', {
      action: 'create', prompt, schedule: { kind: 'daily', time: '09:00' },
    }))
    expect((await schedules(other))[0]?.id).not.toBe(saved?.id)
  } finally {
    await fixture.close()
  }
})

test('11 真实模型、真实时钟下关页并重启服务后触发一次', async ({ page, context }, info) => {
  test.setTimeout(600_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const temporary = await mkdtemp(join(tmpdir(), 'agent-schedules-live-'))
  const secret = join(temporary, 'browser-auth.json')
  const output = join(temporary, 'repeat.txt')
  const marker = 'schedule-' + randomUUID()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(secret)
    const initial = observe(page)
    const { workspaceId, sessionId } = await startChat(page, backend.result.authUrl, await readLiveKey(keyFile!), initial)
    await send(page, '这条会话用来验证项目定时任务。请只回复“准备好了”。')
    await expect.poll(() => initial.updates.at(-1)?.update.run?.status, { timeout: 60_000 }).toBe('completed')
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    const due = Math.floor(Date.now() / 60_000) * 60_000 + 240_000
    const time = timeFormat.format(due)
    const work = '使用 write 工具把标识 ' + marker + ' 原样写入项目根目录的 repeat.txt。'
    await send(page, '请用 cronjob_manage 安排一个重复任务，每天当地时间 ' + time
      + ' 在这个会话执行。定时执行指令为：' + work
      + ' 本轮只保存计划并根据工具回执告知时间，等到点才写文件。')
    await expect.poll(async () => (await schedules(page)).length, { timeout: 75_000 }).toBe(1)
    const [saved] = await schedules(page)
    expect(saved).toMatchObject({
      sessionId, workspaceId, timezone, nextRunAt: due, schedule: { kind: 'daily', time }, sessionMode: 'reuse',
    })
    expect(saved!.prompt).toContain(marker)
    await expect(alarm(page, sessionId)).toBeVisible()
    await expect(page.getByRole('button', { name: '中止', exact: true })).toHaveCount(0, { timeout: 60_000 })
    const original = (await sessions(page)).find(session => session.id === sessionId)!
    await expect(sessionRow(page, sessionId)).toContainText(original.name)
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })

    const port = Number(new URL(backend.result.url).port)
    await page.close()
    await stop(backend.child)
    backend = await startBackend(secret, port)
    expect(Date.now()).toBeLessThan(due)
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect.poll(async () => (await readFile(output, 'utf8').catch(() => '')).replace(/\r?\n$/u, ''), {
      timeout: 420_000, intervals: [1000, 3000, 5000],
    }).toBe(marker)

    const reopened = await context.newPage()
    const observed = observe(reopened)
    await authorize(reopened, backend.result.authUrl)
    await expect(alarm(reopened, sessionId)).toBeVisible()
    await expect(sessionRow(reopened, sessionId)).toContainText(original.name)
    await expect.poll(async () => (await runs(reopened, saved!.id))[0]?.runStatus, { timeout: 90_000 }).toBe('completed')
    const executions = await runs(reopened, saved!.id)
    expect(executions).toHaveLength(1)
    const [execution] = executions
    expect(execution).toMatchObject({ sessionId, status: 'accepted', scheduledAt: due })
    expect(execution!.acceptedAt).toBeGreaterThanOrEqual(due)
    const [next] = await schedules(reopened)
    expect(next?.id).toBe(saved!.id)
    expect(timeFormat.format(next!.nextRunAt!)).toBe(time)
    const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    const followingDay = new Date(Date.parse(localDay.format(due) + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)
    expect(localDay.format(next!.nextRunAt!)).toBe(followingDay)

    await manage(reopened, sessionId)
    await expect.poll(() => observed.snapshots.at(-1)?.sessionId).toBe(sessionId)
    const messages = observed.snapshots.at(-1)!.snapshot.messages
    expect(messages.find(entry => entry.id === execution!.runId)?.message.role).toBe('user')
    expect(messages.filter(entry => entry.clientMessageId === execution!.id)).toHaveLength(1)
    const actualWrite = messages.find(entry =>
      entry.message.role === 'toolResult' && entry.message.toolName === 'write' && !entry.message.isError)
    expect(actualWrite).toBeDefined()
    await reopened.reload()
    await expect(alarm(reopened, sessionId)).toBeVisible()
    expect((await schedules(reopened))[0]?.id).toBe(saved!.id)
    await info.attach('scheduled-task-evidence', {
      contentType: 'application/json', body: JSON.stringify({
        planId: saved!.id, executionId: execution!.id, scheduledAt: due, acceptedAt: execution!.acceptedAt,
        sessionId, userMessageId: execution!.runId, toolResultId: actualWrite!.id,
        wroteExpectedMarker: true, nextRunAt: next!.nextRunAt, timezone,
      }, null, 2),
    })
  } finally {
    await Promise.allSettled([context.clearCookies(), stop(backend?.child)])
    await rm(temporary, { recursive: true, force: true })
  }
})
