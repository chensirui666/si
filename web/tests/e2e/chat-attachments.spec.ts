import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { expect, test } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, ready, saveKey, startBackend, stop } from './test-utils'

test('04/08/11 模型只收到保留的图片，重启后仍可打开原图和重读文本', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-attachments-'))
  const secret = join(directory, 'browser-auth.json')
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC'
  const original = Buffer.from(screenshot, 'base64')
  const note = '服务已启动，运行编号 3817。\n'
  const conversations = () => provider.exchanges.filter(exchange => Array.isArray(exchange.body.tools) && exchange.body.tools.length)
  let removedId: string | undefined
  let releaseUpload!: () => void
  const uploadReleased = new Promise<void>(resolve => { releaseUpload = resolve })
  try {
    backend = await startBackend(secret, 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    await page.route('**/api/attachments?**', async route => {
      if (route.request().headers()['x-attachment-name'] !== 'removed.png') return route.continue()
      const response = await route.fetch()
      expect(response.status()).toBe(201)
      removedId = (await response.json()).id
      await uploadReleased
      await route.fulfill({ response }).catch(() => undefined)
    })
    await page.locator('input[type=file]').setInputFiles({ name: 'removed.png', mimeType: 'image/png', buffer: original })
    await expect.poll(() => removedId).toBeTruthy()
    await page.getByRole('button', { name: '移除 removed.png', exact: true }).click()
    releaseUpload()
    await expect(page.getByAltText('removed.png')).toHaveCount(0)
    const largeScreenshot = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 2400
      canvas.height = 1200
      const context = canvas.getContext('2d')!
      context.fillStyle = '#cfe0e8'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const texture = context.createImageData(canvas.width, 160)
      let step = 508
      for (let i = 0; i < texture.data.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
          step = (Math.imul(step, 1664525) + 1013904223) >>> 0
          texture.data[i + channel] = step >>> 24
        }
        texture.data[i + 3] = 255
      }
      context.putImageData(texture, 0, 0)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const largeOriginal = Buffer.from(largeScreenshot, 'base64')
    expect(largeOriginal.length).toBeGreaterThan(512 * 1024)
    const uploadResponses: number[] = []
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/attachments' && response.request().method() === 'POST'
        && response.request().headers()['x-attachment-name'] !== 'removed.png') {
        uploadResponses.push(response.status())
      }
    })
    await page.locator('input[type=file]').setInputFiles([
      { name: '小图.png', mimeType: 'image/png', buffer: original },
      { name: '大原图.png', mimeType: 'image/png', buffer: largeOriginal },
      { name: '启动日志.txt', mimeType: 'text/plain', buffer: Buffer.from(note) },
    ])
    await expect.poll(() => uploadResponses).toEqual([201, 201, 201])
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    await input.fill('请保存这张图和日志。')
    await send.click()
    await expect.poll(() => conversations().length).toBe(1)
    const first = conversations()[0]!
    expect(JSON.stringify(first.body)).not.toContain(removedId)
    expect(JSON.stringify(first.body)).not.toContain('removed.png')
    const user = first.body.messages.filter(message => message.role === 'user').at(-1)
    const smallURL = `data:image/png;base64,${screenshot}`
    const urls = Array.isArray(user?.content) ? user.content.flatMap(block => block.type === 'image_url' ? [block.image_url.url] : []) : []
    expect(urls).toHaveLength(2)
    expect(urls).toContain(smallURL)
    const scaled = urls.find(url => url !== smallURL)!
    expect(scaled.split(',')[1].length).toBeLessThanOrEqual(512 * 1024)
    const longest = await page.evaluate(async source => {
      const image = new Image()
      image.src = source
      await image.decode()
      return Math.max(image.naturalWidth, image.naturalHeight)
    }, scaled)
    expect(longest).toBeLessThanOrEqual(2000)
    const text = Array.isArray(user?.content) ? user.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : ''
    const descriptor = text.split('\n').find(line => line.startsWith('{') && line.includes('启动日志.txt'))!
    const { path: notePath } = JSON.parse(descriptor)
    first.delta({ content: '已收到原图和日志。' })
    first.finish()
    await expect.poll(() => observed.updates.at(-1)?.update.run?.status).toBe('completed')

    const port = Number(new URL(backend.result.url).port)
    await stop(backend.child)
    backend = await startBackend(secret, port, provider.baseURL)
    const before = observed.snapshots.length
    await page.reload()
    await ready(page, observed, before, false)
    expect(observed.snapshots.at(-1)?.snapshot.messages[0]?.attachments?.map(item => item.name))
      .toEqual(['小图.png', '大原图.png', '启动日志.txt'])
    await expect(page.getByText('已收到原图和日志。', { exact: true })).toBeVisible()
    const history = page.getByRole('group', { name: '已发送附件' })
    const screenshotLink = history.getByRole('link', { name: '大原图.png', exact: true })
    const noteLink = history.getByRole('link', { name: /启动日志\.txt/ })
    await expect(screenshotLink).toBeVisible()
    await expect(noteLink).toBeVisible()
    const preview = page.context().waitForEvent('page')
    await noteLink.click()
    const notePreview = await preview
    await expect(notePreview.locator('body')).toHaveText(note.trim())
    await notePreview.close()
    const openImage = page.context().waitForEvent('page')
    await screenshotLink.click()
    const imagePreview = await openImage
    await expect.poll(() => imagePreview.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(2400)
    const image = await page.request.get(imagePreview.url())
    expect(image.headers()['content-type']).toBe('image/png')
    expect((await image.body()).equals(largeOriginal)).toBe(true)
    await imagePreview.close()
    expect(JSON.stringify(observed.snapshots.at(-1))).not.toContain(screenshot)

    await input.fill('请重读刚才的日志。')
    await send.click()
    await expect.poll(() => conversations().length).toBe(2)
    conversations()[1]!.delta({ tool_calls: [{ index: 0, id: 'reread-upload', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: notePath }) } }] })
    conversations()[1]!.finish('tool_calls')
    await expect.poll(() => conversations().length).toBe(3)
    const reread = conversations()[2]!
    expect(reread.body.messages).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'reread-upload', content: note,
    }))
    reread.delta({ content: '日志重读完成。' })
    reread.finish()
    await expect(page.getByText('日志重读完成。', { exact: true })).toBeVisible()
  } finally {
    releaseUpload()
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(directory, { recursive: true, force: true })
  }
})

test('10 同轮图片超过 24 MB 时提示减少，正文和附件全部留在草稿', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-attachments-budget-'))
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(directory, 'browser-auth.json'), 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const png = await sharp(randomBytes(600 * 215 * 3), { raw: { width: 600, height: 215, channels: 3 } }).png().toBuffer()
    const bytesPerImage = png.toString('base64').length
    expect(bytesPerImage).toBeLessThanOrEqual(512 * 1024)
    const count = Math.floor(24_000_000 / bytesPerImage) + 1
    const uploadStatuses: number[] = []
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/attachments' && response.request().method() === 'POST') {
        uploadStatuses.push(response.status())
      }
    })
    await page.locator('input[type=file]').setInputFiles(Array.from({ length: count }, (_, index) => ({
      name: `截图-${index + 1}.png`, mimeType: 'image/png', buffer: png,
    })))
    await expect.poll(() => uploadStatuses.length, { timeout: 45_000 }).toBe(count)
    expect(uploadStatuses).toEqual(Array(count).fill(201))
    const text = '请核对这些截图里的内容。'
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill(text)
    const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/sessions/start')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const rejected = await response
    expect(rejected.status()).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('请减少图片') })
    await expect(page.getByText(/请减少图片/)).toBeVisible()
    await expect(input).toHaveText(text)
    await expect(page.getByRole('group', { name: '待发送附件' }).getByRole('img')).toHaveCount(count)
    expect(observed.updates.some(({ update }) => update.change.type === 'accepted')).toBe(false)
    expect(provider.exchanges).toHaveLength(0)
    console.log('聊天附件 10 验收', { count, encodedBytes: count * bytesPerImage, receivedRequests: provider.exchanges.length })
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(directory, { recursive: true, force: true })
  }
})

test('另一个标签页先转正扩展草稿时，附件改用新草稿归属后仍可发送', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-rebound-upload-'))
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(directory, 'browser-auth.json'), 0, provider.baseURL)
    const url = backend.result.url
    await authorize(page, backend.result.authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const oldScope = await page.evaluate(id => {
      const draft = crypto.randomUUID()
      sessionStorage.setItem('agent-learning:extension-draft:' + id, draft)
      return draft
    }, workspaceId)
    const getUpload = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/attachments')
    const initialUpload = getUpload()
    await page.locator('input[type=file]').setInputFiles({
      name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('正文来自这个标签页。'),
    })
    const uploaded = await initialUpload
    expect(uploaded.status()).toBe(201)
    expect(new URL(uploaded.url()).searchParams.get('draftSessionId')).toBe(oldScope)
    const selection = { provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'high' }
    const otherTab = await page.request.post(url + '/api/sessions/start', { data: {
      ...selection, workspaceId, clientMessageId: crypto.randomUUID(), draftSessionId: oldScope, text: '另一页的首条消息',
    } })
    expect(otherTab.status()).toBe(202)
    await expect(page.locator(`.workspace-conversation[data-session-id="${oldScope}"]`)).toBeVisible()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    provider.exchanges[0]!.delta({ content: '另一页已完成。' })
    provider.exchanges[0]!.finish()

    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    await editor.fill('请读这个标签页的文件')
    const replacement = getUpload()
    await send.click()
    const uploadedAgain = await replacement
    expect(uploadedAgain.status()).toBe(201)
    const newScope = new URL(uploadedAgain.url()).searchParams.get('draftSessionId')
    expect(newScope).toBeTruthy()
    expect(newScope).not.toBe(oldScope)
    expect(provider.exchanges).toHaveLength(1)
    await expect(editor).toHaveText('请读这个标签页的文件')
    const started = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/start')
    await send.click()
    expect((await started).status()).toBe(202)
    await expect.poll(() => provider.exchanges.length).toBe(2)
    expect(provider.exchanges[1]!.body.messages.at(-1)?.content).toContain('notes.txt')
    provider.exchanges[1]!.delta({ content: '收到本页文件。' })
    provider.exchanges[1]!.finish()
    await expect(page.getByText('收到本页文件。', { exact: true })).toBeVisible()
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(directory, { recursive: true, force: true })
  }
})
