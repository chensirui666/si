import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import { expect, test, type Page } from './chinese-fixture'
import { readLiveKey } from './live-key'
import { addWorkspace, authorize, observe, saveKey, seedSession } from './test-utils'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

type RequestPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type RecordedMessage = {
  role: string
  content: string | RequestPart[] | null
  tool_call_id?: string
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}
type ChatRequest = { model: string; tools?: unknown[]; messages: RecordedMessage[] }
type Observed = ReturnType<typeof observe>

function editor(page: Page) {
  return page.getByRole('textbox', { name: '消息', exact: true })
}

function uploaded(page: Page) {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/api/attachments'
    && response.request().method() === 'POST')
}

async function useLiveChat(page: Page, keyFile: string, run: (observed: Observed, requests: ChatRequest[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-attachments-live-'))
  const cwd = join(directory, 'workspace')
  const requests: ChatRequest[] = []
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, sessionPath: join(directory, 'sessions.sqlite'),
    browserSecretPath: join(directory, 'browser-auth.json'), modelAuthPath: join(directory, 'auth.json'),
    workspacePath: join(directory, 'workspaces.json'), webSettingsPath: join(directory, 'settings.json'),
    skillHome: join(directory, 'skill-home'), globalContextDirectory: join(directory, 'global-context'),
    modelOptions: { fetch: async (url, init) => {
      const body: ChatRequest = JSON.parse(String(init?.body))
      if (body.tools?.length) requests.push(body)
      return globalThis.fetch(url, init)
    } },
  })
  try {
    await mkdir(cwd)
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, await readLiveKey(keyFile))
    await run(observed, requests)
  } finally {
    await Promise.allSettled([page.context().clearCookies(), server.close()])
    await rm(directory, { recursive: true, force: true })
  }
}

async function sendAttachment(page: Page, observed: Observed, name: string, prompt: string) {
  const start = observed.updates.length
  await editor(page).fill(prompt)
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeEnabled()
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages')
  await send.click()
  expect((await accepted).status()).toBe(202)
  await expect(editor(page)).toHaveText('')
  await expect(page.getByRole('group', { name: '已发送附件' }).getByText(name, { exact: true })
    .or(page.getByRole('group', { name: '已发送附件' }).getByAltText(name)).first()).toBeVisible()
  await expect.poll(() => observed.updates.slice(start).some(({ update }) =>
    update.change.type === 'task' && !update.change.running), { timeout: 150_000 }).toBe(true)
  const changes = observed.updates.slice(start).map(({ update }) => update.change)
  const terminal = changes.filter(change => change.type === 'model' && ['done', 'error'].includes(change.event.type)).at(-1)
  if (terminal?.type !== 'model' || terminal.event.type !== 'done') {
    throw new Error(terminal?.type === 'model' && terminal.event.type === 'error'
      ? terminal.event.error.errorMessage : '没有收到最终模型回复')
  }
  expect(terminal.event.message.stopReason).toBe('stop')
  const answer = terminal.event.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const results = changes.flatMap(change => change.type === 'task' && change.message?.message.role === 'toolResult'
    ? [change.message.message] : [])
  return { answer, results }
}

test('01 真实 DeepSeek 首轮收到粘贴的截图并抄出三段小字', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  await useLiveChat(page, keyFile!, async (observed, requests) => {
    const codes = Array.from({ length: 3 }, () => randomUUID().slice(0, 8).toUpperCase())
    const completion = uploaded(page)
    const screenshot = await editor(page).evaluate(async (element, expected) => {
      const canvas = document.createElement('canvas')
      canvas.width = 1120
      canvas.height = 620
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#e6edf2'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#243344'
      ctx.font = 'bold 34px sans-serif'
      ctx.fillText('Startup diagnostics', 70, 77)
      expected.forEach((code, index) => {
        const y = 126 + index * 150
        ctx.fillStyle = 'white'
        ctx.fillRect(60, y, 1000, 112)
        ctx.fillStyle = '#243344'
        ctx.font = 'bold 24px sans-serif'
        ctx.fillText(['Prepare workspace', 'Load configuration', 'Start service'][index], 90, y + 42)
        ctx.font = '19px monospace'
        ctx.fillText(`VERIFY CODE  ${code}`, 90, y + 80)
      })
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'))
      const clipboard = new DataTransfer()
      clipboard.items.add(new File([blob], 'startup-diagnostics.png', { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
    }, codes)
    await expect(page.getByRole('group', { name: '待发送附件' }).getByAltText('startup-diagnostics.png')).toBeVisible()
    expect((await completion).ok()).toBe(true)

    const prompt = '请直接看这条消息附带的截图，从上到下逐字抄写三个 VERIFY CODE 后的八位字符。只输出三行文字，不要调用任何工具。'
    const { answer, results } = await sendAttachment(page, observed, 'startup-diagnostics.png', prompt)
    const transcribed = answer.match(/\b[A-Z0-9]{8}\b/g)
    expect(transcribed).toEqual(codes)
    expect(results).toHaveLength(0)
    const first = requests[0]
    expect(first?.model).toBe('deepseek-flash')
    const user = first.messages.filter(message => message.role === 'user').at(-1)
    expect(user?.content).toEqual(expect.arrayContaining([
      { type: 'text', text: expect.stringContaining(prompt) },
      { type: 'image_url', image_url: { url: screenshot } },
    ]))
    const evidence = { model: first.model, requestRoles: first.messages.map(message => message.role),
      imageBytes: Buffer.from(screenshot.split(',')[1], 'base64').length,
      imageSha256: createHash('sha256').update(Buffer.from(screenshot.split(',')[1], 'base64')).digest('hex'),
      transcribed, answer }
    await testInfo.attach('01 首轮截图请求与模型回复', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
    console.log('聊天附件 01 验收', { model: evidence.model, imageBytes: evidence.imageBytes, transcribed })
  })
})

test('06 真实 DeepSeek 通过 read 读取文本附件中的故障码', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  await useLiveChat(page, keyFile!, async (observed, requests) => {
    const code = `AGL-${randomUUID().slice(0, 8).toUpperCase()}`
    const name = '启动日志.txt'
    const log = `启动失败。\n仅在此文件中记录的故障码：${code}\n`
    const completion = uploaded(page)
    const source = await mkdtemp(join(tmpdir(), 'si-drop-source-'))
    try {
      const file = join(source, name)
      await writeFile(file, log)
      const browser = await page.context().newCDPSession(page)
      const drag = { x: 600, y: 400, data: { items: [], files: [file], dragOperationsMask: 1 } }
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await browser.send('Input.dispatchDragEvent', { type, ...drag })
      }
      await completion
      await browser.detach()
    } finally {
      await rm(source, { recursive: true, force: true })
    }
    await expect(page.getByRole('group', { name: '待发送附件' }).getByText(name, { exact: true })).toBeVisible()
    expect((await completion).ok()).toBe(true)

    const { answer, results } = await sendAttachment(page, observed, name, '请调用 read 读取我附上的启动日志，只回复日志正文中的故障码。')
    expect(answer).toContain(code)
    const first = requests[0]
    expect(first?.model).toBe('deepseek-flash')
    const initialText = JSON.stringify(first.messages)
    expect(initialText).toContain(name)
    expect(initialText).not.toContain(code)
    const read = requests.flatMap(request => request.messages).flatMap(message => message.tool_calls ?? [])
      .find(call => call.function.name === 'read')
    expect(read).toBeDefined()
    const { path } = JSON.parse(read!.function.arguments)
    expect(initialText).toContain(path)
    expect(await readFile(path, 'utf8')).toBe(log)
    const returned = requests.flatMap(request => request.messages).find(message => message.tool_call_id === read!.id)
    expect(returned).toMatchObject({ role: 'tool', content: expect.stringContaining(code) })
    expect(results).toContainEqual(expect.objectContaining({ toolName: 'read', isError: false,
      content: [{ type: 'text', text: expect.stringContaining(code) }] }))
    await testInfo.attach('06 文本附件读取与模型回复', {
      body: JSON.stringify({ model: first.model, uploadedName: name, read, returned, answer }, null, 2),
      contentType: 'application/json',
    })
    console.log('聊天附件 06 验收', { model: first.model, tool: 'read', code })
  })
})
