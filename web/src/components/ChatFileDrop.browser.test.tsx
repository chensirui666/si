import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/experimental-ct-react'
import sharp from 'sharp'
import { ChatPageHarness } from '../test/ChatPageHarness'

const limits = '支持图片和文本文件，每个最大 50 MiB'

test('从访达拖入的文件归到当前会话草稿，混入的文件夹得到提示', async ({ mount, page }, info) => {
  const directory = info.outputPath('folder.txt')
  const file = info.outputPath('notes.md')
  await mkdir(directory, { recursive: true })
  await writeFile(file, '待讨论')
  const uploads: string[] = []
  await page.route('**/api/attachments?**', async route => {
    const request = route.request()
    uploads.push(decodeURIComponent(request.headers()['x-attachment-name']))
    expect(new URL(request.url()).searchParams.get('sessionId')).toBe('session-a')
    expect(request.postData()).toBe('待讨论')
    await route.fulfill({ json: { id: 'one', name: 'notes.md', mediaType: 'text/plain', size: 9 } })
  })
  await mount(<ChatPageHarness modelConfigured />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill('尚未发送')
  // 黑色底片能区分实际合成的半透明遮罩与 Chromium 顶层绘制的不透明白底。
  await page.addStyleTag({ content: 'body::before { content: ""; position: fixed; top: 100px; left: 100px; width: 100px; height: 100px; z-index: 999; background: black; pointer-events: none }' })
  const cdp = await page.context().newCDPSession(page)
  const drag = { x: 45, y: 50, data: { items: [], files: [file, directory], dragOperationsMask: 1 } }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...drag })
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...drag })
  const overlay = page.locator('.chat-file-drop')
  await expect(overlay.getByText('拖动文件到此处即可添加')).toBeVisible()
  await expect(overlay.getByText(limits)).toBeVisible()
  await expect(overlay.locator('img[alt=""]')).toBeVisible()
  await expect.poll(() => overlay.locator('img').evaluate(image =>
    image instanceof HTMLImageElement && image.naturalWidth > 0)).toBe(true)
  await expect(overlay).toHaveCSS('backdrop-filter', 'blur(10px)')
  await expect(overlay).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.7)')
  const pixel = await page.screenshot({ clip: { x: 150, y: 150, width: 1, height: 1 }, animations: 'disabled' })
  const [red, green, blue] = await sharp(pixel).removeAlpha().raw().toBuffer()
  expect([green, blue]).toEqual([red, red])
  expect(red).toBeGreaterThanOrEqual(177)
  expect(red).toBeLessThanOrEqual(181)
  expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize()! })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...drag })
  await expect(overlay).toHaveCount(0)
  await expect(page.getByRole('group', { name: '待发送附件' }).getByText('notes.md')).toBeVisible()
  await expect(page.getByText('暂不支持文件夹，请拖入其中的文件。')).toBeVisible()
  await expect(editor).toHaveText('尚未发送')
  expect(uploads).toEqual(['notes.md'])
})

test('在页面内移动文件时提示保持可见，拖出窗口和取消时立即收起', async ({ mount, page }) => {
  await mount(<ChatPageHarness modelConfigured />)
  const fileData = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['hi'], 'notes.md'))
    return data
  })
  const body = page.locator('body')
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const overlay = page.locator('.chat-file-drop')
  const menu = page.getByRole('menu', { name: '添加', exact: true })
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(menu).toBeVisible()
  const inside = { dataTransfer: fileData, clientX: 100, clientY: 100 }
  await body.dispatchEvent('dragenter', inside)
  await editor.dispatchEvent('dragenter', inside)
  await editor.dispatchEvent('dragleave', inside)
  await expect(overlay).toBeVisible()
  await expect(menu).toBeHidden()
  await editor.dispatchEvent('dragenter', inside)
  await body.dispatchEvent('dragleave', { ...inside, clientX: 0 })
  await expect(overlay).toHaveCount(0)
  await expect(menu).toBeVisible()
  await body.dispatchEvent('dragenter', inside)
  await expect(overlay).toBeVisible()
  await expect(menu).toBeHidden()
  await body.dispatchEvent('dragend', inside)
  await expect(overlay).toHaveCount(0)
  await expect(menu).toBeVisible()
  await body.dispatchEvent('dragenter', inside)
  await expect(overlay).toBeVisible()
  await page.mouse.move(220, 180)
  await expect(overlay).toHaveCount(0)
  await expect(menu).toBeVisible()
  await body.dispatchEvent('dragenter', inside)
  await expect(overlay).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(page.getByRole('group', { name: '待发送附件' })).toHaveCount(0)
})

test('拖动普通文字进输入框时由浏览器插入正文', async ({ mount, page }) => {
  await mount(<ChatPageHarness modelConfigured />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.focus()
  const box = (await editor.boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  const drag = { x: box.x + 4, y: box.y + box.height / 2, data: {
    items: [{ mimeType: 'text/plain', data: '拖入的正文' }], dragOperationsMask: 1,
  } }
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await cdp.send('Input.dispatchDragEvent', { type, ...drag })
  }
  await expect(editor).toHaveText('拖入的正文')
  await expect(page.getByRole('group', { name: '待发送附件' })).toHaveCount(0)
})

test('无可用工作区时拖入文件会提示，并拦住浏览器打开文件', async ({ mount, page }) => {
  await mount(<ChatPageHarness />)
  const fileData = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['hi'], 'notes.md'))
    return data
  })
  await page.locator('body').dispatchEvent('dragenter', { dataTransfer: fileData })
  await expect(page.getByText('当前无法添加附件')).toBeVisible()
  await expect(page.locator('.chat-file-drop img[alt=""]')).toBeVisible()
  await expect(page.getByText(limits)).toHaveCount(0)
  const prevented = await page.evaluate(data => !document.body.dispatchEvent(
    new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
  ), fileData)
  expect(prevented).toBe(true)
  await expect(page.getByText('当前无法添加附件')).toHaveCount(0)
  await expect(page.getByRole('group', { name: '待发送附件' })).toHaveCount(0)
})
