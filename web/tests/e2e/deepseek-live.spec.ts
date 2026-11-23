import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebServer } from '@agent-learning/server'
import { expect, test, type Page } from './chinese-fixture'
import { parseLiveKey, readLiveKey } from './live-key'
import { expectBrowserStorage, addWorkspace, authorize, observe, saveKey, seedSession, startBackend, stop } from './test-utils'

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
    const workspaceId = await addWorkspace(page)
    const sessionId = await seedSession(page, observed, workspaceId)
    await saveKey(page, key)
    expect(JSON.parse(await readFile(join(temporary, 'auth.json'), 'utf8')).deepseek.key === key).toBe(true)
    await expectBrowserStorage(page, sessionId, workspaceId)

    const code = `memo-${randomUUID().slice(0, 8)}`
    const first = await complete(page, observed, `请记住口令 ${code}。只回答“记住了”，不要复述口令。`)
    expect(first.message.stopReason).toBe('stop')
    expect(first.sawTextBeforeTerminal).toBe(true)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toContainText(textOf(first.message).trim())
    const second = await complete(page, observed, '上一条我告诉你的口令是什么？只回答口令。')
    expect(textOf(second.message)).toContain(code)
    expect(second.sawTextBeforeTerminal).toBe(true)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toContainText(code)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem')).toHaveCount(4)

    await saveKey(page, 'invalid-stage3-live-key')
    expect(JSON.parse(await readFile(join(temporary, 'auth.json'), 'utf8')).deepseek.key === 'invalid-stage3-live-key').toBe(true)
    const recoveryPrompt = '只回答“恢复成功”。'
    const failed = await complete(page, observed, recoveryPrompt, true)
    expect(failed.message.stopReason).toBe('error')
    expect(Boolean(failed.message.errorMessage)).toBe(true)
    const failureText = await page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last().innerText()
    expect(/失败|错误|无效|认证|401|authentication/i.test(failureText)).toBe(true)
    await saveKey(page, key)
    const recovered = await complete(page, observed, recoveryPrompt)
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

test('真实 DeepSeek 从原图读取并准确抄出缩图中的三段小字', async ({ page, context }) => {
  test.setTimeout(240_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const temporary = await mkdtemp(join(tmpdir(), 'agent-read-image-live-'))
  const cwd = join(temporary, 'workspace')
  const sessionPath = join(temporary, 'sessions.sqlite')
  const codes = Array.from({ length: 3 }, () => randomUUID().slice(0, 8).toUpperCase())
  type Part = { type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string }
  type Message = { role: string; tool_call_id?: string; tool_calls?: { id: string; function: { name: string } }[]; content: string | Part[] | null }
  const modelRequests: { model: string; messages: Message[] }[] = []
  const server = new WebServer({
    port: 0, sessionPath, directoryPicker: async () => cwd,
    skillHome: join(temporary, 'skill-home'), globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (!String(body.messages[0]?.content).startsWith('你是会话标题生成器。')) modelRequests.push(body)
      return globalThis.fetch(url, init)
    } },
  })
  try {
    const png = await page.evaluate(expected => {
      const canvas = document.createElement('canvas')
      canvas.width = 1800
      canvas.height = 3600
      const ctx = canvas.getContext('2d')!
      const background = ctx.createImageData(canvas.width, canvas.height)
      let state = 75
      function noise() {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return (state >>> 16) % 40
      }
      // The low-contrast background keeps the original large while the diagram remains legible.
      for (let pixel = 0; pixel < background.data.length; pixel += 4) {
        background.data[pixel] = 200 + noise()
        background.data[pixel + 1] = 210 + noise()
        background.data[pixel + 2] = 214 + noise()
        background.data[pixel + 3] = 255
      }
      ctx.putImageData(background, 0, 0)
      const stages = ['Receive request', 'Resolve workspace', 'Validate input', 'Execute tools',
        'Save tool result', 'Prepare context', 'Send model request', 'Return answer']
      stages.forEach((stage, index) => {
        const y = 235 + index * 400
        ctx.fillStyle = 'white'
        ctx.fillRect(360, y, 1080, 254)
        ctx.strokeStyle = '#20304a'
        ctx.lineWidth = 4
        ctx.strokeRect(360, y, 1080, 254)
        ctx.fillStyle = '#182235'
        ctx.font = 'bold 52px sans-serif'
        ctx.fillText(stage, 420, y + 90)
        if ([1, 4, 7].includes(index)) {
          ctx.font = '24px monospace'
          ctx.fillText(`VERIFY CODE  ${expected[(index - 1) / 3]}`, 420, y + 195)
        }
      })
      return canvas.toDataURL('image/png').split(',')[1]
    }, codes)
    const original = Buffer.from(png, 'base64')
    expect(original.length).toBeGreaterThan(4 * 1024 * 1024)
    await mkdir(cwd)
    const path = join(await realpath(cwd), 'screenshot.png')
    await writeFile(path, original)

    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, await readLiveKey(keyFile!))
    const answer = await complete(page, observed, '请只调用一次 read 打开 screenshot.png。直接从这次 read 返回的图片里，按从上到下逐字抄写每个 VERIFY CODE 后的八位字符，只输出三行。不要调用其他工具、裁剪或复查。')
    expect(answer.message.stopReason).toBe('stop')
    const transcribed = textOf(answer.message).match(/\b[A-Z0-9]{8}\b/g)
    expect(transcribed).toEqual(codes)
    const reads = observed.updates.flatMap(({ update }) => update.change.type === 'task' && update.change.message?.message.role === 'toolResult'
      ? [update.change.message.message] : [])
    expect(reads).toEqual([expect.objectContaining({ toolName: 'read', isError: false })])
    const request = modelRequests.find(({ messages }) => messages.some(({ content }) =>
      Array.isArray(content) && content.some(part => part.type === 'image_url')))!
    expect(request.model).toBe('deepseek-flash')
    const [assistant, tool, attachment] = request.messages.slice(-3)
    expect(assistant.tool_calls).toContainEqual(expect.objectContaining({ id: tool.tool_call_id, function: expect.objectContaining({ name: 'read' }) }))
    expect(tool).toMatchObject({ role: 'tool', content: expect.stringContaining(path) })
    expect(attachment.role).toBe('user')
    const urls = (attachment.content as Part[]).flatMap(part => part.type === 'image_url' ? [part.image_url.url] : [])
    expect(urls).toHaveLength(1)
    const dataURL = urls[0]
    const base64 = dataURL.split(',')[1]
    expect(base64.length).toBeLessThanOrEqual(512 * 1024)
    const dimensions = await page.evaluate(async src => {
      const image = new Image()
      image.src = src
      await image.decode()
      return { width: image.naturalWidth, height: image.naturalHeight }
    }, dataURL)
    expect(dimensions.height).toBeLessThanOrEqual(2000)
    expect(Math.abs(2 * dimensions.width - dimensions.height)).toBeLessThanOrEqual(1)
    expect((await readFile(path)).equals(original)).toBe(true)
    const card = page.locator('.tool-block').filter({ has: page.locator('summary', { hasText: 'screenshot.png' }) })
    await page.locator('.process-group > summary').click()
    await card.locator('summary').click()
    await expect(card.locator('.tool-result')).toContainText(path)
    await expect(card.locator('img')).toHaveCount(0)
    expect(JSON.stringify(observed.updates)).not.toContain(base64)

    await server.close()
    const db = new DatabaseSync(sessionPath, { readOnly: true })
    try {
      const row = db.prepare("SELECT data FROM messages WHERE json_extract(data, '$.message.toolCallId') = ?")
        .get(tool.tool_call_id!)?.data as string
      expect(row).not.toContain(base64)
      expect(JSON.parse(row)).toMatchObject({
        imageOmitted: true,
        message: { role: 'toolResult', isError: false, content: [{ type: 'text', text: expect.stringContaining(path) }] },
      })
    } finally { db.close() }
    console.log('Read 原图验收', { model: request.model, originalBytes: original.length, ...dimensions,
      format: dataURL.slice(5, dataURL.indexOf(';')), base64Bytes: base64.length, transcribed })
  } finally {
    await Promise.allSettled([context.clearCookies(), server.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

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
    await seedSession(page, observed, await addWorkspace(page))
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
    port: 0, sessionPath: join(temporary, 'sessions.sqlite'), directoryPicker: async () => cwd,
    skillHome: join(temporary, 'skill-home'), globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (!String(body.messages[0]?.content).startsWith('你是会话标题生成器。')) modelRequests.push(body)
      return globalThis.fetch(url, init)
    } },
  })
  try {
    await mkdir(cwd)
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, await readLiveKey(keyFile!))
    const messages = page.getByRole('region', { name: '消息列表' })
    for (const name of ['青禾', '白榆']) {
      await writeFile(join(cwd, 'note.txt'), `项目名称：${name}\n`)
      const before = modelRequests.length
      const result = await complete(page, observed, '本条消息只调用一次 read 读取工作区当前的 note.txt。收到这次工具结果后，直接回答其中的项目名称。')
      expect(textOf(result.message)).toContain(name)
      expect(modelRequests).toHaveLength(before + 2)
      expect(modelRequests[before]?.tools).toHaveLength(12)
      const followup = modelRequests[before + 1]!
      expect(followup.tools).toHaveLength(12)
      const call = followup.messages.at(-2)?.tool_calls?.[0]
      expect(call?.id).toBeTruthy()
      expect(followup.messages.at(-1)).toMatchObject({
        role: 'tool', tool_call_id: call?.id, content: expect.stringContaining(`项目名称：${name}`),
      })
      const lastProcess = messages.locator('.process-group > summary').last()
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

for (const scenario of ['loop', 'write-once'] as const) test(`Feature6 live ${scenario}: 实际工具结果进入后续请求，每轮保留完整工具集`, async ({ page, context }) => {
  test.setTimeout(450_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature6-live-'))
  const cwd = join(temporary, 'workspace')
  const requests: { messages: { role: string; content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]; tools?: unknown[] }[] = []
  const server = new WebServer({
    port: 0, sessionPath: join(temporary, 'sessions.sqlite'), directoryPicker: async () => cwd,
    skillHome: join(temporary, 'skill-home'), globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => { const body = JSON.parse(String(init?.body)); if (!String(body.messages[0]?.content).startsWith('你是会话标题生成器。')) requests.push(body); return globalThis.fetch(url, init) } },
  })
  try {
    await mkdir(cwd)
    if (scenario === 'loop') await Promise.all([
      writeFile(join(cwd, 'index.txt'), '下一条线索在 note.txt'),
      writeFile(join(cwd, 'note.txt'), '项目名称：青禾'),
    ])
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, await readLiveKey(keyFile!))
    const result = await complete(page, observed, scenario === 'loop'
      ? '请根据 index.txt 的线索找到项目名称。请先用 read 读取 index.txt，再根据真实结果继续使用 read，最后只回答项目名称。'
      : '已确认这是新建的空测试工作区，note.txt 不存在。请直接用 write 把“项目名称：青禾”写入 note.txt。本次只允许一次 write 调用，不使用其他工具，不检查目录或读取验证，收到写入结果后直接回答“已保存”。')
    expect(requests.every(request => request.tools?.length === 12)).toBe(true)
    const actualResults = observed.updates.flatMap(({ update }) => update.change.type === 'task' && update.change.message?.message.role === 'toolResult' ? [update.change.message] : [])
    expect(actualResults.every(entry => entry.message.role === 'toolResult' && !entry.message.isError)).toBe(true)
    if (scenario === 'loop') {
      expect(textOf(result.message)).toContain('青禾')
      expect(requests).toHaveLength(3)
      expect(actualResults.map(entry => entry.message.role === 'toolResult' ? entry.message.toolName : '')).toEqual(['read', 'read'])
      expect(await realpath(resolve(cwd, JSON.parse(requests[1]!.messages.at(-2)!.tool_calls![0]!.function.arguments).path))).toBe(await realpath(join(cwd, 'index.txt')))
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('下一条线索在 note.txt') })
      expect(await realpath(resolve(cwd, JSON.parse(requests[2]!.messages.at(-2)!.tool_calls![0]!.function.arguments).path))).toBe(await realpath(join(cwd, 'note.txt')))
      expect(requests[2]!.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('项目名称：青禾') })
      expect(new Set(actualResults.map(entry => entry.toolCall?.assistantMessageId)).size).toBe(2)
    } else {
      expect(textOf(result.message)).toContain('已保存')
      expect(requests).toHaveLength(2)
      expect(actualResults).toHaveLength(1)
      expect(actualResults[0]!.message).toMatchObject({ toolName: 'write', isError: false })
      const call = requests[1]!.messages.at(-2)!.tool_calls![0]!
      const { content } = JSON.parse(call.function.arguments)
      expect(content).toMatch(/^项目名称：青禾(?:\r?\n)?$/)
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe(content)
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: call.id, content: expect.stringContaining('note.txt') })
    }
  } finally {
    await Promise.allSettled([context.clearCookies(), server.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

test('里程碑 2 权限 14：真实 DeepSeek 从网页用只读工具列目录并读取文件', async ({ page }) => {
  test.setTimeout(180_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const temporary = await mkdtemp(join(tmpdir(), 'agent-permission-live-'))
  const cwd = join(temporary, 'workspace')
  const server = new WebServer({
    port: 0, sessionPath: join(temporary, 'sessions.sqlite'), directoryPicker: async () => cwd,
    skillHome: join(temporary, 'skill-home'), globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
  })
  try {
    const marker = 'permission-' + randomUUID().slice(0, 8)
    await mkdir(cwd)
    await writeFile(join(cwd, 'proof.txt'), marker)
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await addWorkspace(page)
    await saveKey(page, await readLiveKey(keyFile!))
    const permission = page.locator('.composer-actions').getByRole('combobox', { name: '权限' })
    await permission.click()
    await page.getByRole('option', { name: '只读', exact: true }).click()
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    await editor.fill('先用 ls 列出当前工作目录，再用 read 读取列表中的 proof.txt。最后只回答文件中的完整标记。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => observed.updates.some(({ update: { change } }) => change.type === 'task' && !change.running), { timeout: 120_000 }).toBe(true)
    await expect(permission).toHaveText('只读')
    const results = observed.updates.flatMap(({ update: { change } }) =>
      change.type === 'task' && change.message?.message.role === 'toolResult' ? [change.message.message] : [])
    expect(results.some(result => result.toolName === 'ls' && !result.isError && textOf(result).includes('proof.txt'))).toBe(true)
    expect(results.some(result => result.toolName === 'read' && !result.isError && textOf(result).includes(marker))).toBe(true)
    const terminal = [...observed.updates].reverse().find(({ update: { change } }) => change.type === 'model'
      && (change.event.type === 'done' || change.event.type === 'error'))?.update.change
    expect(terminal).toMatchObject({ type: 'model', event: { type: 'done', message: { model: 'deepseek-flash',
      content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining(marker) })]),
    } } })
    await expect(page.locator('.message-list')).toContainText(marker)
  } finally {
    await server.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
