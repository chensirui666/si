import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import type { SessionList, StartSessionAccepted, StartSessionRequest, WorkspacePick } from '@agent-learning/server/protocol'
import { expect, test } from '@playwright/test'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, expectBrowserStorage, observe, openSession, ready, saveKey, startBackend, stop } from './test-utils'

test('未发送的新会话共用一份草稿，首次发送使用最后选中的工作区', async ({ page }) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature8-first-send-'))
  const provider = await startModelServer()
  const folders = ['workspace-a', 'workspace-b'].map(name => join(temporary, name))
  const server = new WebServer({
    port: 0, sessionPath: join(temporary, 'sessions.sqlite'),
    globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'),
    modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'),
    webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { baseURL: provider.baseURL },
    directoryPicker: async () => folders.shift() ?? null,
  })
  try {
    await Promise.all(folders.map(async (folder, index) => {
      await mkdir(folder)
      await writeFile(join(folder, 'answer.txt'), `来自工作区 ${index + 1}`)
    }))
    const { url, authUrl } = await server.start()
    const sessionWrites: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path.startsWith('/api/sessions')) sessionWrites.push(path)
    })
    const listSessions = async () => {
      const response = await page.request.get(url + '/api/sessions')
      expect(response.status()).toBe(200)
      return ((await response.json()) as SessionList).sessions
    }
    await authorize(page, authUrl)
    const workspaceA = await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const heading = page.getByRole('heading', { name: 'SI', exact: true })
    const workspace = page.getByRole('combobox', { name: '工作区', exact: true })
    const newConversation = page.getByRole('button', { name: '新会话', exact: true })
    const draftRow = page.getByRole('button', { name: '未发送的新会话', exact: true })
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    const draft = '  读取 answer.txt\n保留原文  '
    await expect(heading).toBeVisible()
    await expect(workspace).toHaveValue(workspaceA)
    await editor.fill(draft)
    await newConversation.click()
    await newConversation.click()

    const picked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspaces/pick')
    await workspace.selectOption({ label: '添加工作区…' })
    const result: WorkspacePick = await (await picked).json()
    if (result.cancelled) throw new Error('第二个测试工作区未选中')
    const workspaceB = result.workspaceId
    await expect(workspace).toHaveValue(workspaceB)
    await page.getByRole('group', { name: 'workspace-a', exact: true }).getByRole('button', { name: '新建会话', exact: true }).click()
    await expect(workspace).toHaveValue(workspaceA)
    await workspace.selectOption(workspaceB)
    await expect(draftRow).toHaveCount(1)
    await expect(draftRow).toHaveText('新会话')
    await expect.poll(() => editor.evaluate(el => Array.from(el.children, node => node.textContent).join('\n'))).toBe(draft)
    expect(sessionWrites).toEqual([])
    expect(await listSessions()).toEqual([])
    expect(provider.exchanges).toHaveLength(0)

    await page.reload()
    await expect(workspace).toHaveValue(workspaceB)
    await expect.poll(() => editor.evaluate(el => Array.from(el.children, node => node.textContent).join('\n'))).toBe(draft)
    const receipt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/start')
    await send.click()
    const response = await receipt
    expect(response.status()).toBe(202)
    const request: StartSessionRequest = response.request().postDataJSON()
    expect(request).toEqual({ workspaceId: workspaceB, clientMessageId: expect.any(String), modelId: 'deepseek-flash', text: draft })
    const { session }: StartSessionAccepted = await response.json()
    expect(session).toMatchObject({ id: request.clientMessageId, workspaceId: workspaceB, name: '会话 1' })
    expect(await listSessions()).toEqual([session])
    await expect(page.getByRole('group', { name: 'workspace-b', exact: true }).getByRole('button', { name: '会话 1', exact: true })).toBeVisible()
    await expect(heading).toHaveCount(0)
    await expect(draftRow).toHaveCount(0)
    await expect(editor).toHaveText('')

    await expect.poll(() => provider.exchanges.length).toBe(1)
    const first = provider.exchanges[0]!
    expect(first.body.messages.at(-1)).toEqual({ role: 'user', content: draft })
    first.delta({ tool_calls: [{ index: 0, id: 'read-answer', type: 'function', function: { name: 'read', arguments: '{"path":"answer.txt"}' } }] })
    first.finish('tool_calls')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    const next = provider.exchanges[1]!
    expect(next.body.messages.at(-1)).toMatchObject({ role: 'tool', content: '来自工作区 2' })
    next.delta({ content: '已读取第二个工作区的文件。' })
    next.finish()
    await expect(page.getByRole('region', { name: '消息列表' })).toContainText('已读取第二个工作区的文件。')
    expect(sessionWrites).toEqual(['/api/sessions/start'])
    await expect.poll(() => page.evaluate(() => localStorage.getItem('agent-learning:draft:new-session'))).toBeNull()
    await expectBrowserStorage(page, session.id, workspaceB)
  } finally {
    await Promise.allSettled([server.close(), provider.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

test('首次发送的回执丢失后，刷新可找回已经开始的同一段会话', async ({ page }) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature8-first-send-recovery-'))
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(temporary, 'browser-auth.json'), 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const original = '只发送一次的首条消息'
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    await editor.fill(original)

    let allowList = false
    await page.route('**/api/sessions', route => allowList ? route.continue() : route.abort())
    const accepted: StartSessionAccepted[] = []
    await page.route('**/api/sessions/start', async route => {
      const response = await route.fetch()
      expect(response.status()).toBe(202)
      accepted.push(await response.json())
      await route.abort()
    })
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '重试首次发送', exact: true })).toBeVisible()
    await expect(editor).toHaveText(original)
    expect(accepted).toHaveLength(1)
    await expect.poll(() => provider.exchanges.length).toBe(1)

    allowList = true
    await page.reload()
    await ready(page, observed, 0, false)
    const sessionId = accepted[0]!.session.id
    expect(observed.snapshots.at(-1)?.sessionId).toBe(sessionId)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').first()).toHaveText(original)
    await expect(editor).toHaveText('')
    await expectBrowserStorage(page, sessionId, workspaceId)
    expect(accepted).toHaveLength(1)
    expect(provider.exchanges).toHaveLength(1)
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Feature8 运行中的会话可切换、并行与独立中止，重开页面恢复草稿', async ({ context, page }, testInfo) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature8-sessions-'))
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(temporary, 'browser-auth.json'), 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    const abort = page.getByRole('button', { name: '中止', exact: true })
    const messages = page.getByRole('region', { name: '消息列表' })
    await editor.fill('A 任务')
    await send.click()
    await ready(page, observed, 0, false)
    const a = observed.snapshots.at(-1)!.sessionId
    await expect.poll(() => provider.exchanges.length).toBe(1)
    const first = provider.exchanges[0]!
    first.delta({ role: 'assistant', content: 'A 已输出。' })
    await expect(messages).toContainText('A 已输出。')
    await editor.fill('  A 的下一条\n保留原文  ')
    const otherPage = await context.newPage()
    const other = observe(otherPage)
    await otherPage.goto(backend.result.url)
    await ready(otherPage, other, 0, false)
    expect(other.snapshots.at(-1)?.sessionId).toBe(a)
    await page.getByRole('button', { name: '新会话', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'SI', exact: true })).toBeVisible()
    await expect(editor).toHaveText('')
    const beforeStart = observed.snapshots.length
    await editor.fill('B 任务')
    await send.click()
    await ready(page, observed, beforeStart, false)
    const b = observed.snapshots.at(-1)!.sessionId
    expect(b).not.toBe(a)
    await expect.poll(() => provider.exchanges.length).toBe(2)
    const second = provider.exchanges[1]!
    second.delta({ role: 'assistant', content: 'B 已输出。' })
    await expect(messages).toContainText('B 已输出。')
    await editor.fill('B 的下一条')
    await expect(otherPage.locator('[data-session-id]')).toHaveAttribute('data-session-id', a)
    const beforeOtherReload = other.snapshots.length
    await otherPage.reload()
    await ready(otherPage, other, beforeOtherReload, false)
    expect(other.snapshots.at(-1)?.sessionId).toBe(b)
    await expect(otherPage.getByRole('textbox', { name: '消息', exact: true })).toHaveText('B 的下一条')
    await otherPage.close()
    expect(first.closed).toBe(false)
    expect(second.closed).toBe(false)
    expect(first.body.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['A 任务'])
    expect(second.body.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['B 任务'])
    const snapshot = await openSession(page, observed, '会话 1')
    expect(snapshot.sessionId).toBe(a)
    const runA = snapshot.snapshot.running?.runId
    expect(runA).toBeDefined()
    await expect(messages).toContainText('A 已输出。')
    await expect(messages).not.toContainText('B 已输出。')
    expect(provider.exchanges).toHaveLength(2)
    await expect(editor).toHaveText(/A 的下一条\s*保留原文/)
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/abort')
    await abort.click()
    expect(await (await response).json()).toEqual({ sessionId: a, runId: runA, handled: true })
    await expect.poll(() => first.closed).toBe(true)
    expect(second.closed).toBe(false)
    await expect(messages).toContainText('A 已输出。')
    await expect(send).toBeEnabled()
    const bRunning = await openSession(page, observed, '会话 2')
    expect(bRunning.sessionId).toBe(b)
    const runB = bRunning.snapshot.running?.runId
    expect(runB).toBeDefined()
    await expect(editor).toHaveText('B 的下一条')
    await expectBrowserStorage(page, b, workspaceId, { [a]: '  A 的下一条\n保留原文  ', [b]: 'B 的下一条' })
    await page.close()
    const reopened = await context.newPage()
    const restored = observe(reopened)
    await reopened.goto(backend.result.url)
    await ready(reopened, restored, 0, false)
    expect(restored.snapshots.at(-1)).toMatchObject({ sessionId: b, snapshot: { running: { runId: runB } } })
    await expect(reopened.getByRole('textbox', { name: '消息', exact: true })).toHaveText('B 的下一条')
    second.delta({ content: '切换后继续。' })
    second.finish()
    await expect(reopened.getByRole('region', { name: '消息列表' })).toContainText('B 已输出。切换后继续。')
    await expect(reopened.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    const aRestored = await openSession(reopened, restored, '会话 1')
    expect(aRestored.snapshot.running).toBeNull()
    const aDraft = reopened.getByRole('textbox', { name: '消息', exact: true })
    await expect.poll(() => aDraft.evaluate(el => Array.from(el.children, node => node.textContent).join('\n'))).toBe('  A 的下一条\n保留原文  ')
    await expect(reopened.getByRole('region', { name: '消息列表' })).toContainText('A 已输出。')
    expect(provider.exchanges).toHaveLength(2)
    await testInfo.attach('feature8-parallel-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({ a, b, runA, runB, bothRunningBeforeAbort: true, aAborted: true, bCompleted: true, bRestoredAfterReopen: true }),
    })
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Feature10 22/23/25：服务正常重启后从侧栏回看，由用户主动续聊', async ({ page }) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature10-restart-'))
  const secret = join(temporary, 'browser-auth.json')
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(secret, 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, 'controlled-feature10-key')
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    const list = page.getByRole('region', { name: '消息列表' })
    await editor.fill('记住代号青禾')
    await send.click()
    await ready(page, observed, 0, false)
    const { sessionId } = observed.snapshots.at(-1)!
    await expect.poll(() => provider.exchanges.length).toBe(1)
    provider.exchanges[0]!.delta({ content: '已记住青禾' })
    provider.exchanges[0]!.finish()
    await expect(list).toContainText('已记住青禾')
    await expect.poll(() => observed.updates.at(-1)?.update.run?.status).toBe('completed')

    const port = Number(new URL(backend.result.url).port)
    await stop(backend.child)
    expect(backend.child.exitCode).toBe(0)
    backend = await startBackend(secret, port, provider.baseURL)
    const before = observed.snapshots.length
    await page.reload()
    await ready(page, observed, before, false)
    await page.getByRole('button', { name: '新会话', exact: true }).click()
    const restored = await openSession(page, observed, '会话 1')
    expect(restored.sessionId).toBe(sessionId)
    expect(restored.snapshot.runs).toMatchObject([{ status: 'completed' }])
    await expect(list.locator('.message-text, .markdown-text')).toHaveText(['记住代号青禾', '已记住青禾'])
    expect(provider.exchanges).toHaveLength(1)
    const sessions = await (await page.request.get(backend.result.url + '/api/sessions')).json() as SessionList
    expect(sessions.sessions).toMatchObject([{ id: sessionId, workspaceId }])

    await editor.fill('刚才的代号是什么？')
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(2)
    const resumed = provider.exchanges[1]!
    expect(resumed.body.messages.slice(1)).toMatchObject([
      { role: 'user', content: '记住代号青禾' },
      { role: 'assistant', content: '已记住青禾' },
      { role: 'user', content: '刚才的代号是什么？' },
    ])
    resumed.delta({ content: '代号是青禾' })
    resumed.finish()
    await expect(list).toContainText('代号是青禾')
    await expect.poll(() => observed.updates.at(-1)?.update.run?.status).toBe('completed')
    expect(observed.updates.at(-1)?.sessionId).toBe(sessionId)
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Feature10 18/19/24/26：强制结束进程后只恢复已保存工具结果，接续时核对外部状态', async ({ page }) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature10-crash-'))
  const secret = join(temporary, 'browser-auth.json')
  const release = join(temporary, 'release-crash-test')
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    await writeFile(join(temporary, 'note.txt'), '已记录的结果 A')
    backend = await startBackend(secret, 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-feature10-key')
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    await editor.fill('读取 A，然后执行 B')
    await send.click()
    await ready(page, observed, 0, false)
    const { sessionId } = observed.snapshots.at(-1)!
    await expect.poll(() => provider.exchanges.length).toBe(1)
    const call = (index: number, id: string, name: string, args: object) => ({
      index, id, type: 'function', function: { name, arguments: JSON.stringify(args) },
    })
    provider.exchanges[0]!.delta({ tool_calls: [call(0, 'A', 'read', { path: 'note.txt' })] })
    provider.exchanges[0]!.finish('tool_calls')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    const second = provider.exchanges[1]!
    expect(second.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'A', content: '已记录的结果 A' })
    second.delta({ tool_calls: [call(0, 'B', 'bash', {
      command: "printf changed > effect.txt; while [ ! -e release-crash-test ]; do sleep 0.05; done",
    })] })
    second.finish('tool_calls')
    await expect.poll(() => readFile(join(temporary, 'effect.txt'), 'utf8').catch(() => '')).toBe('changed')
    await expect(startBackend(secret, 0, provider.baseURL)).rejects.toThrow('会话库已被占用')
    await expect(page.getByRole('button', { name: '中止', exact: true })).toBeEnabled()

    const port = Number(new URL(backend.result.url).port)
    await stop(backend.child, 'SIGKILL')
    expect(backend.child.signalCode).toBe('SIGKILL')
    await writeFile(release, '')
    backend = await startBackend(secret, port, provider.baseURL)
    const before = observed.snapshots.length
    await page.reload()
    await ready(page, observed, before, false)
    const restored = observed.snapshots.at(-1)!
    expect(restored.sessionId).toBe(sessionId)
    expect(restored.snapshot.running).toBeNull()
    expect(restored.snapshot.runs).toMatchObject([{ status: 'interrupted' }])
    expect(restored.snapshot.messages.filter(entry => entry.message.role === 'toolResult')).toMatchObject([{ message: { toolCallId: 'A' } }])
    await expect(page.getByText('已中断', { exact: true })).toBeVisible()
    const process = page.locator('.process-group')
    await process.locator(':scope > summary').click()
    await expect(process.locator('.tool-status')).toHaveText(['成功', '结果未知'])
    expect(provider.exchanges).toHaveLength(2)

    await editor.fill('请继续')
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(3)
    const resumed = provider.exchanges[2]!
    expect(resumed.body.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'A', content: '已记录的结果 A' }))
    expect(resumed.body.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'B',
      content: expect.stringMatching(/结果未知.*外部状态可能已经改变.*先检查当前状态/) }))
    resumed.delta({ content: '先核对文件当前内容' })
    resumed.finish()
    await expect(page.getByRole('region', { name: '消息列表' })).toContainText('先核对文件当前内容')
    await expect.poll(() => observed.updates.at(-1)?.update.run?.status).toBe('completed')
    const count = observed.snapshots.length
    await page.reload()
    await ready(page, observed, count, false)
    expect(observed.snapshots.at(-1)?.snapshot.messages.filter(entry => entry.message.role === 'toolResult')).toHaveLength(1)
    expect(provider.exchanges).toHaveLength(3)
  } finally {
    await writeFile(release, '')
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})
