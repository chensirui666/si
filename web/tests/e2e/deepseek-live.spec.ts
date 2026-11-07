import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import { expect, test, type Page } from '@playwright/test'
import { parseLiveKey, readLiveKey } from './live-key'
import { addWorkspace, authorize, observe, ready, saveKey, startBackend, stop } from './test-utils'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('真实模型凭据文件解析只接收明确的 DeepSeek 变量', () => {
  expect(parseLiveKey('OTHER=ignore\nDEEPSEEK=example-key\n')).toBe('example-key')
  expect(parseLiveKey('export DEEPSEEK_API_KEY="replacement-key" # local\n')).toBe('replacement-key')
  expect(parseLiveKey("DEEPSEEK='quoted-key'\n")).toBe('quoted-key')
  expect(() => parseLiveKey('OTHER=ignore\n')).toThrow('需要非空')
  expect(() => parseLiveKey('DEEPSEEK=""\n')).toThrow('需要非空')
})

test('真实 DeepSeek 设置、两轮历史、流式进度与无效 Key 恢复', async ({ page, context }) => {
  test.setTimeout(600_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE；默认测试不读取真实用户凭据')
  let key = await readLiveKey(keyFile!)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-learning-deepseek-live-'))
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(temporary, 'browser-auth.json'))
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await ready(page, observed)
    await addWorkspace(page)
    await saveKey(page, key)
    expect(JSON.parse(await readFile(join(temporary, 'auth.json'), 'utf8')).deepseek.key === key).toBe(true)
    expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} })

    const code = `memo-${randomUUID().slice(0, 8)}`
    const first = await complete(page, observed, `请记住口令 ${code}。只回答“记住了”，不要复述口令。`)
    expect(first.message.stopReason).toBe('stop')
    expect(first.sawTextBeforeTerminal).toBe(true)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toContainText('记住了')
    const second = await complete(page, observed, '上一条我告诉你的口令是什么？只回答口令。')
    expect(textOf(second.message)).toContain(code)
    expect(second.sawTextBeforeTerminal).toBe(true)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toContainText(code)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem')).toHaveCount(4)

    await saveKey(page, 'invalid-stage3-live-key')
    expect(JSON.parse(await readFile(join(temporary, 'auth.json'), 'utf8')).deepseek.key === 'invalid-stage3-live-key').toBe(true)
    const failed = await complete(page, observed, '只回答“验证无效凭据”。', true)
    expect(failed.message.stopReason).toBe('error')
    expect(Boolean(failed.message.errorMessage)).toBe(true)
    const failureText = await page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last().innerText()
    expect(/失败|错误|无效|认证|401|authentication/i.test(failureText)).toBe(true)
    await saveKey(page, key)
    const recovered = await complete(page, observed, '只回答“恢复成功”。')
    expect(textOf(recovered.message)).toContain('恢复成功')
    expect(recovered.message.stopReason).toBe('stop')
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toContainText('恢复成功')
    expect(observed.submissions).toEqual(['POST', 'POST', 'POST', 'POST'])
    expect(observed.updates.filter(({ update }) => update.change.type === 'accepted')).toHaveLength(4)
  } finally {
    key = ''
    await Promise.allSettled([context.clearCookies(), stop(backend?.child)])
    await rm(temporary, { recursive: true, force: true })
  }
})

async function complete(page: Page, observed: ReturnType<typeof observe>, prompt: string, expectFailure = false) {
  const before = observed.updates.length
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill(prompt)
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeEnabled()
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages')
  await send.click()
  expect((await accepted).status()).toBe(202)
  await expect(editor).toHaveText('')
  await expect.poll(() => observed.updates.slice(before).some(({ update }) => update.change.type === 'task' && !update.change.running), { timeout: 150_000 }).toBe(true)
  const frames = observed.updates.slice(before).flatMap(({ update }) => update.change.type === 'model' ? [update.change.event] : [])
  const terminal = [...frames].reverse().find(frame => frame.type === 'done' || frame.type === 'error')!
  if (terminal.type !== 'done' && terminal.type !== 'error') throw new Error('没有收到最终模型回复')
  expect(terminal.type).toBe(expectFailure ? 'error' : 'done')
  const message = terminal.type === 'done' ? terminal.message : terminal.error
  const text = textOf(message)
  if (!expectFailure) {
    expect(text.length).toBeGreaterThan(0)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toBeVisible()
  }
  await editor.fill('下一轮仍可发送的草稿')
  await expect(send).toBeEnabled()
  const delta = frames.findIndex(frame => frame.type === 'text_delta' && frame.delta.length > 0)
  return { message, sawTextBeforeTerminal: delta >= 0 && delta < frames.indexOf(terminal) }
}

function textOf(message: { content: { type: string; text?: string }[] }) {
  return message.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
}

test('真实 DeepSeek 生成中止保留内容和草稿，同一对话可继续', async ({ page, context }) => {
  test.setTimeout(450_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  let key = await readLiveKey(keyFile!)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature5-live-'))
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(temporary, 'browser-auth.json'))
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await ready(page, observed)
    await addWorkspace(page)
    await saveKey(page, key)
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    await editor.fill('不要使用工具。请从1开始依次写到1000，每个数字单独一行并附上中文读法，不要省略或汇总。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => observed.updates.some(({ update }) => update.change.type === 'model' && update.change.event.type === 'text_delta'), { timeout: 150_000 }).toBe(true)
    await editor.fill('中止后保留的草稿')
    const receipt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/abort')
    await page.getByRole('button', { name: '中止', exact: true }).click()
    expect((await receipt).status()).toBe(200)
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    const terminals = observed.updates.flatMap(({ update }) => update.change.type === 'model' && update.change.event.type === 'error' ? [update.change.event] : [])
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.reason).toBe('aborted')
    expect(textOf(terminals[0]!.error).length).toBeGreaterThan(0)
    await expect(editor).toHaveText('中止后保留的草稿')
    const next = await complete(page, observed, '不要使用工具。只回答“中止后继续成功”。')
    expect(textOf(next.message)).toContain('中止后继续成功')
  } finally {
    key = ''
    await Promise.allSettled([context.clearCookies(), stop(backend?.child)])
    await rm(temporary, { recursive: true, force: true })
  }
})

test('T1 live: 网页两次读取真实文件，显示工具结果且回答随文件变化', async ({ page, context }) => {
  test.setTimeout(450_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const temporary = await mkdtemp(join(tmpdir(), 'agent-learning-feature4-read-'))
  const cwd = join(temporary, 'workspace')
  const modelRequests: { messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string; content?: string }[]; tools?: unknown[] }[] = []
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd,
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => {
      modelRequests.push(JSON.parse(String(init?.body)))
      return globalThis.fetch(url, init)
    } },
  })
  try {
    await mkdir(cwd)
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await ready(page, observed)
    await addWorkspace(page)
    await saveKey(page, await readLiveKey(keyFile!))
    const messages = page.getByRole('region', { name: '消息列表' })
    for (const name of ['青禾', '白榆']) {
      await writeFile(join(cwd, 'note.txt'), `项目名称：${name}\n`)
      const before = modelRequests.length
      const result = await complete(page, observed, '请现在用 read 读取工作区的 note.txt，最后只回答文件里当前写的项目名称。每次重新读文件。')
      expect(textOf(result.message)).toContain(name)
      expect(modelRequests).toHaveLength(before + 2)
      expect(modelRequests[before]?.tools).toHaveLength(8)
      const followup = modelRequests[before + 1]!
      expect(followup.tools).toHaveLength(8)
      const call = followup.messages.at(-2)?.tool_calls?.[0]
      expect(call?.id).toBeTruthy()
      expect(followup.messages.at(-1)).toMatchObject({
        role: 'tool', tool_call_id: call?.id, content: expect.stringContaining(`项目名称：${name}`),
      })
      const lastProcess = messages.getByText('执行过程', { exact: true }).last()
      await lastProcess.click()
      const tool = messages.getByText(/读取.*note\.txt/).last()
      await expect(tool).toBeVisible()
      await tool.click()
      await expect(messages.getByText(`项目名称：${name}`, { exact: true }).last()).toBeVisible()
      await expect(messages.getByRole('listitem').last()).toContainText(name)
    }
  } finally {
    await Promise.allSettled([context.clearCookies(), server.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

for (const scenario of ['loop', 'write-once'] as const) test(`Feature6 live ${scenario}: 实际工具结果进入后续请求，每轮保留八种工具`, async ({ page, context }) => {
  test.setTimeout(450_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature6-live-'))
  const cwd = join(temporary, 'workspace')
  const requests: { messages: { role: string; content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]; tools?: unknown[] }[] = []
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd,
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => { requests.push(JSON.parse(String(init?.body))); return globalThis.fetch(url, init) } },
  })
  try {
    await mkdir(cwd)
    if (scenario === 'loop') await Promise.all([
      writeFile(join(cwd, 'index.txt'), '下一条线索在 note.txt'),
      writeFile(join(cwd, 'note.txt'), '项目名称：青禾'),
    ])
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await ready(page, observed)
    await addWorkspace(page)
    await saveKey(page, await readLiveKey(keyFile!))
    const result = await complete(page, observed, scenario === 'loop'
      ? '请根据 index.txt 的线索找到项目名称。请先用 read 读取 index.txt，再根据真实结果继续使用 read，最后只回答项目名称。'
      : '请用 write 把“项目名称：青禾”写入 note.txt，只写一次，然后直接回答“已保存”。')
    expect(requests.every(request => request.tools?.length === 8)).toBe(true)
    const actualResults = observed.updates.flatMap(({ update }) => update.change.type === 'task' && update.change.message?.message.role === 'toolResult' ? [update.change.message] : [])
    expect(actualResults.every(entry => entry.message.role === 'toolResult' && !entry.message.isError)).toBe(true)
    if (scenario === 'loop') {
      expect(textOf(result.message)).toContain('青禾')
      expect(requests).toHaveLength(3)
      expect(actualResults.map(entry => entry.message.role === 'toolResult' ? entry.message.toolName : '')).toEqual(['read', 'read'])
      expect(JSON.parse(requests[1]!.messages.at(-2)!.tool_calls![0]!.function.arguments).path).toBe('index.txt')
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('下一条线索在 note.txt') })
      expect(JSON.parse(requests[2]!.messages.at(-2)!.tool_calls![0]!.function.arguments).path).toBe('note.txt')
      expect(requests[2]!.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('项目名称：青禾') })
      expect(new Set(actualResults.map(entry => entry.toolCall?.assistantMessageId)).size).toBe(2)
    } else {
      expect(textOf(result.message)).toContain('已保存')
      expect(requests).toHaveLength(2)
      expect(actualResults).toHaveLength(1)
      expect(actualResults[0]!.message).toMatchObject({ toolName: 'write', isError: false })
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('项目名称：青禾')
      const call = requests[1]!.messages.at(-2)!.tool_calls![0]!
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: call.id, content: expect.stringContaining('note.txt') })
    }
  } finally {
    await Promise.allSettled([context.clearCookies(), server.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})
