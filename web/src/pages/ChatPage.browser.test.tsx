import { test, expect } from '@playwright/experimental-ct-react'
import type { StartSessionRequest } from '@agent-learning/server/protocol'
import { ChatPageHarness } from '../test/ChatPageHarness'
import { MessageInputHarness } from '../test/MessageInputHarness'
import { draftKey, newSessionDraft, recentSessionKey } from '../chat/drafts'
import { Button } from '../components/ui/button'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/settings/permission', route => route.fulfill({ json: { defaultPermissionMode: 'normal' } }))
  await page.route('**/api/web/settings', route => route.fulfill({
    json: {
      searchProvider: 'tavily', fetchProvider: 'tavily',
      providers: [{ id: 'tavily', name: 'Tavily', capabilities: ['search', 'fetch'], status: { state: 'missing' } }],
    },
  }))
})

test('连接切换、快照恢复和输入区增高时保留草稿、焦点与阅读位置', async ({ mount, page }) => {
  const history = Array.from({ length: 26 }, (_, i) => `旧消息 ${i}：${'用于验证独立滚动的内容。'.repeat(12)}`)
  await mount(<ChatPageHarness messages={history} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const list = page.getByRole('region', { name: '消息列表' })
  const scroll = page.locator('.chat-main')
  const items = list.getByRole('listitem')
  await expect(items).toHaveCount(26)
  expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  await scroll.evaluate(el => { el.scrollTop = 350 })
  const oldItem = items.nth(5)
  const oldTop = (await oldItem.boundingBox())!.y
  const readingPosition = await scroll.evaluate(el => el.scrollTop)
  const multiline = '多行草稿\n第二行\n\n第四行\n第五行\n最后一行'
  const before = await editor.boundingBox()
  await editor.fill(multiline)
  expect((await editor.boundingBox())!.height).toBeGreaterThan(before!.height + 90)
  expect(await scroll.evaluate(el => el.scrollTop)).toBeCloseTo(readingPosition, 0)
  expect((await oldItem.boundingBox())!.y).toBeCloseTo(oldTop, 0)
  for (const connection of ['disconnected', 'connecting', 'awaitingSnapshot', 'ready'] as const) {
    await page.evaluate(({ connection, history }) => {
      window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
        connection, slow: connection === 'awaitingSnapshot', error: null,
        snapshot: { seq: 1, messages: history.map((content, index) => ({ id: `history-${index}`, message: { role: 'user', content, timestamp: index } })), running: null, compactions: [], contextUsage: null, activeContent: [] },
      } }))
    }, { connection, history })
    await expect(page.locator('.chat-page')).toHaveAttribute('data-connection', connection)
    await expect(editor).toBeFocused()
    await editor.press('Enter')
    expect(await editor.textContent()).toBe(multiline)
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    expect(await scroll.evaluate(el => el.scrollTop)).toBeCloseTo(readingPosition, 0)
    expect((await oldItem.boundingBox())!.y).toBeCloseTo(oldTop, 0)
  }
  // fill('') 直接设置 DOM 选区后立刻 Delete，可能早于 Lexical 的选区同步。
  await editor.press('ControlOrMeta+a')
  await editor.press('Backspace')
  await expect(editor).toHaveText('')
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeCloseTo(before!.height, 0)
  expect(await scroll.evaluate(el => el.scrollTop)).toBeCloseTo(readingPosition, 0)
  await list.focus()
  const keyboardBefore = await scroll.evaluate(el => el.scrollTop)
  await list.press('PageDown')
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(keyboardBefore)
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(items.last()).toBeInViewport()
  const bottom = await scroll.evaluate(el => el.scrollTop)
  await page.evaluate(history => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', slow: false, error: null,
      snapshot: { seq: 2, messages: [...history, '新同步消息'].map((content, index) => ({ id: `history-${index}`, message: { role: 'user', content, timestamp: index } })), running: null, compactions: [], contextUsage: null, activeContent: [] },
    } }))
  }, history)
  await expect(items).toHaveCount(27)
  expect(await scroll.evaluate(el => el.scrollTop)).toBeCloseTo(bottom, 0)
  expect(await scroll.evaluate(el => el.scrollTop + el.clientHeight < el.scrollHeight)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
})

test('正文外的留白能滚动，消息到输入框上沿才被遮住', async ({ mount, page }) => {
  const messages = Array.from({ length: 30 }, (_, i) => `消息 ${i}\n第二行\n第三行`)
  await mount(<ChatPageHarness messages={messages} />)
  const workspace = (await page.locator('.chat-workspace').boundingBox())!
  const scroll = page.locator('.chat-main')
  const header = page.getByRole('heading', { name: '会话 1' })
  const headerBefore = await header.boundingBox()
  const composer = page.locator('.message-input')
  const input = (await composer.boundingBox())!
  const list = page.getByRole('region', { name: '消息列表' })
  const rows = list.getByRole('listitem')
  await expect(rows).toHaveCount(messages.length)
  const scrollBox = (await scroll.boundingBox())!
  expect(scrollBox.x).toBeCloseTo(workspace.x, 0)
  expect(scrollBox.x + scrollBox.width).toBeCloseTo(workspace.x + workspace.width, 0)
  const gutterX = (input.x + workspace.x) / 2
  await page.mouse.move(gutterX, input.y - 60)
  await page.mouse.wheel(0, 310)
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(100)
  expect(await header.boundingBox()).toEqual(headerBefore)
  expect(await composer.boundingBox()).toEqual(input)

  const row = rows.nth(10)
  const box = (await row.boundingBox())!
  await scroll.evaluate((el, delta) => { el.scrollTop += delta }, box.y + box.height / 2 - input.y)
  const edge = await row.evaluate((el, { x, y }) => ({
    above: el.contains(document.elementFromPoint(x, y - 2)),
    below: Boolean(document.elementFromPoint(x, y + 2)?.closest('.message-input')),
  }), { x: box.x + box.width / 2, y: input.y })
  expect(edge).toEqual({ above: true, below: true })
  const toBottom = page.getByRole('button', { name: '回到底部' })
  await expect(toBottom).toBeVisible()
  const jump = (await toBottom.boundingBox())!
  expect(jump.y + jump.height).toBeLessThan(input.y)
  expect(jump.x).toBeGreaterThan(input.x + input.width / 2)
  await toBottom.click()
  await expect(toBottom).toBeHidden()
  const last = (await rows.last().boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(input.y)
  expect(last.y).toBeGreaterThanOrEqual(scrollBox.y)
})

test('输入组件发送按钮随空白和有效草稿切换颜色，发送后恢复空白状态', async ({ mount, page }) => {
  await mount(<MessageInputHarness />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const expectEmptyButton = async () => {
    await expect(send).toBeDisabled()
    await expect(send).toHaveCSS('background-color', 'rgb(247, 247, 245)')
    await expect(send).toHaveCSS('color', 'rgb(112, 112, 112)')
    await expect(send).toHaveCSS('opacity', '1')
  }

  await expectEmptyButton()
  await expect(send).toHaveText('')
  await expect(send.locator('svg')).toBeVisible()
  await editor.fill('  \n\t  ')
  await expectEmptyButton()
  await editor.fill('有效消息')
  await expect(send).toBeEnabled()
  await expect(send).toHaveCSS('background-color', 'rgb(26, 26, 26)')
  await expect(send).toHaveCSS('color', 'rgb(255, 255, 255)')
  await send.click()
  await expect(page.getByLabel('已提交原文')).toHaveText('["有效消息"]')
  await expect(editor).toHaveText('')
  await expectEmptyButton()
})

test('白色页面的正文与输入框同轴，输入框两侧各宽出 16px', async ({ mount, page }) => {
  await mount(<ChatPageHarness messages={['正文消息']} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const list = page.getByRole('region', { name: '消息列表' })
  const composer = page.locator('.message-input')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.getByRole('heading', { name: '会话 1' })).toHaveCSS('font-size', '20px')
  await expect(page.getByRole('heading', { name: '会话 1' })).toHaveCSS('line-height', '28px')
  await expect(page.getByRole('heading', { name: '会话 1' })).toHaveCSS('font-weight', '600')
  await expect(editor).toHaveCSS('font-size', '14px')
  await expect(editor).toHaveCSS('line-height', '24px')
  await expect(editor).toHaveCSS('font-weight', '400')
  expect((await editor.boundingBox())!.height).toBeCloseTo(24, 0)
  const listBox = (await list.boundingBox())!
  const composerBox = (await composer.boundingBox())!
  expect(composerBox.width).toBeLessThanOrEqual(760)
  const workspaceBox = (await page.locator('.chat-workspace').boundingBox())!
  expect(composerBox.x + composerBox.width / 2).toBeCloseTo(workspaceBox.x + workspaceBox.width / 2, 0)
  expect(listBox.x - composerBox.x).toBeCloseTo(16, 0)
  expect(composerBox.x + composerBox.width - (listBox.x + listBox.width)).toBeCloseTo(16, 0)
  await expect(list.getByRole('listitem')).toHaveCSS('background-color', 'rgb(247, 247, 245)')
  await expect(list.getByRole('listitem')).toHaveCSS('max-width', '72%')
  await expect(list.getByRole('listitem')).toHaveCSS('padding', '10px 16px')
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(list.getByRole('listitem')).toHaveCSS('max-width', '88%')
  const text = list.locator('.message-text')
  await expect(text).toHaveCSS('font-size', '14px')
  await expect(text).toHaveCSS('line-height', '24px')
  await expect(text).toHaveCSS('font-weight', '400')
})

test('窄屏长草稿到上限后内部滚动，输入和发送操作始终可见', async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await mount(<ChatPageHarness />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await editor.fill(Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行长草稿`).join('\n'))
  const box = (await editor.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(190)
  expect(box.height).toBeLessThanOrEqual(201)
  expect(await editor.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect(editor).toBeInViewport({ ratio: 1 })
  await expect(send).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
  const composerBox = (await page.locator('.message-input').boundingBox())!
  expect(composerBox.x).toBeGreaterThanOrEqual(16)
  expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(374)
  const listBox = (await page.getByRole('region', { name: '消息列表' }).boundingBox())!
  expect(listBox.x - composerBox.x).toBeCloseTo(16, 0)
  expect(composerBox.x + composerBox.width - (listBox.x + listBox.width)).toBeCloseTo(16, 0)
  await expect(send).toBeDisabled()
  await editor.press('Enter')
  await expect(editor).not.toHaveText('')
  await editor.press('ControlOrMeta+a')
  await editor.press('Backspace')
  await expect(editor).toHaveText('')
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeCloseTo(24, 0)
  await expect(send).toBeInViewport({ ratio: 1 })
})

test('低高度视口的长草稿仍保留完整输入区和发送操作', async ({ mount, page }) => {
  await page.setViewportSize({ width: 844, height: 280 })
  await mount(<ChatPageHarness />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await editor.fill(Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行长草稿`).join('\n'))
  const sendBox = (await send.boundingBox())!
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(280)
  await expect(editor).toBeInViewport({ ratio: 1 })
  await expect(send).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
  await expect(send).toBeDisabled()
  await editor.press('Enter')
  await expect(editor).not.toHaveText('')
  // fill('') 直接设置 DOM 选区后立刻 Delete，可能早于 Lexical 的选区同步。
  await editor.press('ControlOrMeta+a')
  await editor.press('Backspace')
  await expect(editor).toBeInViewport({ ratio: 1 })
  await expect(send).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
})

test.describe('触屏操作', () => {
  test.use({ hasTouch: true })

  test('平板及横屏发送目标至少为44×44', async ({ mount, page }) => {
    await page.setViewportSize({ width: 844, height: 700 })
    await mount(<ChatPageHarness />)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('触屏消息')
    const send = page.getByRole('button', { name: '发送', exact: true })
    const box = (await send.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    await expect(send).toBeDisabled()
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveText('触屏消息')
  })
})

test('中英混排正文和输入框优先使用系统字体', async ({ mount, page, context }) => {
  await mount(<ChatPageHarness messages={['中文正文 English']} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill('中文正文 English')
  await expect(editor).toHaveCSS('font-family', /^system-ui,.*Noto Sans CJK SC/)
  await expect(page.locator('.message-text')).toHaveCSS('font-family', /^system-ui,.*Noto Sans CJK SC/)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  const session = await context.newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument')
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.message-text' })
  const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId })
  expect(fonts.some(font => !font.isCustomFont && font.glyphCount >= 'English'.length)).toBe(true)
  if (process.platform === 'darwin') {
    expect(fonts.some(font => font.familyName === 'PingFang SC' && font.glyphCount > 0)).toBe(true)
  }
  await session.detach()
})

test('输入区聚焦、切换和发送后保持弱边界，按钮焦点使用内部标记', async ({ mount, page }) => {
  await mount(<MessageInputHarness />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const composer = page.locator('.message-input')
  const send = page.getByRole('button', { name: '发送', exact: true })
  const before = await composer.boundingBox()
  const expectQuietBoundary = async () => {
    await expect(composer).toHaveCSS('border-width', '1px')
    await expect(composer).toHaveCSS('border-color', 'rgb(222, 222, 219)')
    await expect(composer).toHaveCSS('outline-style', 'none')
    await expect(composer).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.04) 0px 2px 12px 0px')
    expect(await composer.boundingBox()).toEqual(before)
  }

  await expectQuietBoundary()
  await editor.click()
  await editor.pressSequentially('focus check')
  await expectQuietBoundary()
  await expect(send).toBeEnabled()
  await expect(editor).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(send).toBeFocused()
  await page.evaluate(async () => {
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
  await expect(send).toBeFocused()
  await expectQuietBoundary()
  await expect(send).toHaveCSS('border-width', '0px')
  await expect(send).toHaveCSS('outline-style', 'none')
  await expect(send).toHaveCSS('box-shadow', 'none')
  await expect.poll(() => send.evaluate(el => {
    const marker = getComputedStyle(el, '::after')
    return { opacity: marker.opacity, width: marker.width, height: marker.height }
  })).toEqual({ opacity: '1', width: '4px', height: '4px' })
  await page.keyboard.press('Shift+Tab')
  await expect(editor).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(send).toBeFocused()

  await send.hover()
  await expect(send).toHaveCSS('background-color', 'rgb(51, 51, 51)')
  await page.mouse.down()
  await expect(send).toHaveCSS('background-color', 'rgb(26, 26, 26)')
  await page.mouse.up()
  await expect(editor).toHaveText('')
  await expect(editor).toBeFocused()
  await expectQuietBoundary()
  expect(await send.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('0')
})

test('消息区键盘焦点使用固定局部标记，滚动和高对比度下仍可辨认', async ({ mount, page }) => {
  await mount(<ChatPageHarness messages={Array.from({ length: 12 }, (_, i) => `消息 ${i}：${'用于验证滚动。'.repeat(24)}`)} />)
  const list = page.getByRole('region', { name: '消息列表' })
  const frame = page.locator('.chat-main-frame')
  const scroll = page.locator('.chat-main')
  await page.getByRole('heading', { name: '会话 1' }).click()
  await expect(frame).toHaveCount(1)
  expect(await frame.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('0')
  await page.keyboard.press('Tab')
  await expect(list).toBeFocused()
  await expect(list).toHaveCSS('border-width', '0px')
  await expect(list).toHaveCSS('outline-style', 'none')
  await expect(list).toHaveCSS('box-shadow', 'none')
  const markerBefore = await frame.evaluate(el => {
    const marker = getComputedStyle(el, '::after')
    return { opacity: marker.opacity, width: marker.width, height: marker.height, top: marker.top, left: marker.left }
  })
  expect(markerBefore).toMatchObject({ opacity: '1', width: '6px', height: '6px' })
  const frameBefore = await frame.boundingBox()
  const scrollBefore = await scroll.evaluate(el => el.scrollTop)
  await page.keyboard.press('PageDown')
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(scrollBefore)
  expect(await frame.boundingBox()).toEqual(frameBefore)
  expect(await frame.evaluate(el => {
    const marker = getComputedStyle(el, '::after')
    return { opacity: marker.opacity, width: marker.width, height: marker.height, top: marker.top, left: marker.left }
  })).toEqual(markerBefore)

  await page.emulateMedia({ forcedColors: 'active' })
  expect(await frame.evaluate(el => {
    const marker = getComputedStyle(el, '::after')
    return { opacity: marker.opacity, background: marker.backgroundColor, color: marker.color }
  })).toEqual({ opacity: '1', background: 'rgb(0, 0, 0)', color: 'rgb(0, 0, 0)' })
  await expect(list).toHaveCSS('outline-style', 'none')
})

test('浅色按钮以背景反馈悬停和按下，键盘焦点不叠加外圈', async ({ mount, page }) => {
  await mount(<><Button variant="secondary">浅色按钮</Button><Button variant="ghost">次要按钮</Button></>)
  const first = page.getByRole('button', { name: '浅色按钮', exact: true })
  await page.keyboard.press('Tab')
  await expect(first).toBeFocused()
  await expect(first).toHaveCSS('outline-style', 'none')
  await expect(first).toHaveCSS('box-shadow', 'none')
  expect(await first.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('1')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '次要按钮', exact: true })).toBeFocused()
  for (const name of ['浅色按钮', '次要按钮']) {
    const button = page.getByRole('button', { name, exact: true })
    await button.hover()
    await expect(button).toHaveCSS('background-color', 'rgb(240, 240, 238)')
    await page.mouse.down()
    await expect(button).toHaveCSS('background-color', 'rgb(222, 222, 219)')
    await page.mouse.up()
    await expect(button).toHaveCSS('outline-style', 'none')
    await expect(button).toHaveCSS('box-shadow', 'none')
    expect(await button.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('0')
  }
})

test('选中回复可引用追问，保留草稿并通过现有消息接口发送', async ({ mount, page }) => {
  let sentText: string | undefined
  await page.route('**/api/messages', async route => {
    const input = route.request().postDataJSON()
    sentText = input.text
    await route.fulfill({ status: 409, json: { code: 'save_rejected', error: '磁盘错误' } })
  })
  await mount(<ChatPageHarness modelConfigured />)
  await expect(page.getByRole('heading', { name: '会话 1' })).toBeVisible()
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', slow: false, error: null,
      snapshot: { seq: 1, messages: [
        { id: 'user', message: { role: 'user', content: '说明方案', timestamp: 1 } },
        { id: 'answer', message: { role: 'assistant', content: [{ type: 'text', text: '从 **服务端确认开始** 后记录耗时。' }], api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 2, stopReason: 'stop' } },
      ], running: null, compactions: [], contextUsage: null, activeContent: [] },
    } }))
  })
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill('  为什么？  ')
  const quote = page.getByRole('button', { name: '引用追问' })
  const select = async () => {
    await page.locator('.assistant-message strong').evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await quote.click()
  }
  await select()
  const remove = page.getByRole('button', { name: '移除引用' })
  await expect(remove).toBeVisible()
  await expect(editor).toBeFocused()
  expect(await editor.textContent()).toBe('  为什么？  ')
  expect(sentText).toBeUndefined()
  await remove.click()
  await expect(remove).toHaveCount(0)
  expect(await editor.textContent()).toBe('  为什么？  ')
  await select()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => sentText).toBe('> 服务端确认开始\n\n  为什么？  ')
  await expect(editor).toHaveText('为什么？')
  await expect(remove).toBeVisible()
})

test('真实异步发送保留原文、清空撤销历史和焦点，WS 先到与迟到拒绝不覆盖新草稿', async ({ mount, page }) => {
  let request: { clientMessageId: string; modelId: string; text: string } | undefined
  let release: () => Promise<void> = async () => {}
  await page.route('**/api/messages', async route => {
    request = route.request().postDataJSON()
    await new Promise<void>(resolve => {
      release = async () => { await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '正在生成' }) }); resolve() }
    })
  })
  await mount(<ChatPageHarness modelConfigured />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const original = '  第一行\n\n第二行  \n'
  await editor.fill(original)
  await expect(send).toBeEnabled()
  await send.click()
  await expect(editor).toHaveText('')
  await expect(editor).toBeFocused()
  await expect.poll(() => request?.text).toBe(original)
  await editor.press('ControlOrMeta+z')
  await expect(editor).toHaveText('')
  await editor.fill('新的草稿')
  await expect(page.getByRole('button', { name: '中止', exact: true })).toBeDisabled()
  await page.evaluate(input => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', slow: false, error: null,
      snapshot: { seq: 1, messages: [{ id: 'user', clientMessageId: input!.clientMessageId, message: { role: 'user', content: input!.text, timestamp: 1 } }], running: { kind: 'task' as const, runId: 'user', assistantMessageId: 'answer', phase: 'model', activeTools: [] }, compactions: [], contextUsage: null, activeContent: [] },
    } }))
  }, request)
  await release()
  await expect(page.getByRole('region', { name: '消息列表' }).locator('.message-text')).toHaveText(original)
  await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByText('发送失败', { exact: true })).toHaveCount(0)
  await expect(editor).toHaveText('新的草稿')
  await expect(editor).toBeFocused()
  await expect(page.getByRole('button', { name: '中止', exact: true })).toBeEnabled()
  await page.evaluate(input => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', slow: false, error: null,
      snapshot: { seq: 2, messages: [{ id: 'user', clientMessageId: input!.clientMessageId, message: { role: 'user', content: input!.text, timestamp: 1 } }, { id: 'answer', message: { role: 'assistant', content: [{ type: 'text', text: '**完成**' }], api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 2, stopReason: 'stop' } }], running: null, compactions: [], contextUsage: null, activeContent: [] },
    } }))
  }, request)
  await expect(page.locator('.assistant-message strong')).toHaveText('完成')
  await expect(editor).toHaveText('新的草稿')
  await expect(send).toBeEnabled()
})

test('HTTP 回执先到时旧空闲快照不能开放发送，正式消息与结束状态到达后才开放', async ({ mount, page }) => {
  let input: { clientMessageId: string; modelId: string; text: string } | undefined
  await page.route('**/api/messages', async route => {
    input = route.request().postDataJSON()
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ sessionId: 'session-a', kind: 'message' as const, clientMessageId: input!.clientMessageId, userMessageId: 'user', acceptedSeq: 5 }) })
  })
  await mount(<ChatPageHarness modelConfigured />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await editor.fill('回执先到')
  await send.click()
  await expect(page.getByText('已接收，正在同步', { exact: true })).toBeVisible()
  await editor.fill('下一条')
  await expect(page.getByRole('button', { name: '中止', exact: true })).toBeDisabled()
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: { connection: 'ready', slow: false, error: null, snapshot: { seq: 4, messages: [], running: null, compactions: [], contextUsage: null, activeContent: [] } } }))
  })
  await expect(page.getByRole('button', { name: '中止', exact: true })).toBeDisabled()
  await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem')).toHaveCount(1)
  await page.evaluate(input => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: { connection: 'ready', slow: false, error: null, snapshot: { seq: 6, messages: [{ id: 'user', clientMessageId: input!.clientMessageId, message: { role: 'user', content: input!.text, timestamp: 1 } }], running: null, compactions: [], contextUsage: null, activeContent: [] } } }))
  }, input)
  await expect(send).toBeEnabled()
  await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByText('已接收，正在同步', { exact: true })).toHaveCount(0)
  await expect(editor).toHaveText('下一条')
  await expect(editor).toBeFocused()
})

test('回复逐块增长和最终校准保留旧消息阅读位置，不滚动或抢输入焦点', async ({ mount, page }) => {
  const history = Array.from({ length: 26 }, (_, i) => `历史 ${i}：${'独立阅读位置。'.repeat(20)}`)
  await mount(<ChatPageHarness messages={history} modelConfigured />)
  const list = page.getByRole('region', { name: '消息列表' })
  const scroll = page.locator('.chat-main')
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await scroll.evaluate(el => { el.scrollTop = 350 })
  const oldTop = (await list.getByRole('listitem').nth(5).boundingBox())!.y
  const scrollTop = await scroll.evaluate(el => el.scrollTop)
  await editor.fill('生成时继续编辑')
  for (const seq of [1, 2, 3]) {
    await page.evaluate(({ history, seq }) => {
      window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
        connection: 'ready', slow: false, error: null,
        snapshot: { seq, messages: [...history.map((content, index) => ({ id: `history-${index}`, message: { role: 'user', content, timestamp: index } })), { id: 'answer', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 30, content: [{ type: 'thinking', thinking: '独立思考' }, { type: 'text', text: `# 标题\n\n${'回答内容\n\n'.repeat(seq * 8)}` }], stopReason: seq === 3 ? 'stop' : 'pending' } }], running: seq === 3 ? null : { kind: 'task' as const, runId: 'history-25', assistantMessageId: 'answer', phase: 'model', activeTools: [] }, compactions: [], contextUsage: null, activeContent: seq === 3 ? [] : [{ messageId: 'answer', contentIndex: 1, type: 'text' }] },
      } }))
    }, { history, seq })
    await expect(list.getByRole('listitem')).toHaveCount(27)
    expect(await scroll.evaluate(el => el.scrollTop)).toBeCloseTo(scrollTop, 0)
    expect((await list.getByRole('listitem').nth(5).boundingBox())!.y).toBeCloseTo(oldTop, 0)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveText('生成时继续编辑')
  }
})

for (const withHistory of [false, true]) {
  test(`失败 A 后成功 B 的气泡和回复保持原顺序，已有历史：${withHistory}`, async ({ mount, page }) => {
    let call = 0
    let second: { clientMessageId: string; text: string } | undefined
    await page.route('**/api/messages', async route => {
      call++
      if (call === 1) await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '输入无效' }) })
      else {
        second = route.request().postDataJSON()
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ sessionId: 'session-a', kind: 'message' as const, clientMessageId: second!.clientMessageId, userMessageId: 'user-b', acceptedSeq: 1 }) })
      }
    })
    await mount(<ChatPageHarness messages={withHistory ? ['历史 F'] : []} modelConfigured />)
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    await editor.fill('失败 A')
    await send.click()
    await expect(page.getByText('发送失败', { exact: true })).toBeVisible()
    await editor.fill('成功 B')
    await send.click()
    await expect.poll(() => second?.text).toBe('成功 B')
    await page.evaluate(({ withHistory, second }) => {
      window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
        connection: 'ready', slow: false, error: null,
        snapshot: { seq: 3, running: null, compactions: [], contextUsage: null, activeContent: [], messages: [
          ...(withHistory ? [{ id: 'history-0', message: { role: 'user', content: '历史 F', timestamp: 1 } }] : []),
          { id: 'user-b', clientMessageId: second!.clientMessageId, message: { role: 'user', content: second!.text, timestamp: 2 } },
          { id: 'answer-b', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 3, content: [{ type: 'text', text: '回答 B' }], stopReason: 'stop' } },
        ] },
      } }))
    }, { withHistory, second })
    await expect(page.getByRole('region', { name: '消息列表' }).locator('.message-text,.markdown-text')).toHaveText([...(withHistory ? ['历史 F'] : []), '失败 A', '成功 B', '回答 B'])
    await expect(editor).toHaveText('')
    await expect(editor).toBeFocused()
  })
}

const workspace = { id: 'workspace-1', path: '/tmp/青禾', name: '青禾', available: true }
const sessionA = { id: 'session-a', workspaceId: workspace.id, name: '会话 1', createdAt: '2026-11-09T08:00:00Z' }
const sessionB = { ...sessionA, id: 'session-b', name: '会话 2' }

test('侧栏不横滚，收起后保留草稿和容量，展开后可以继续切换会话', async ({ mount, page }) => {
  const longName = '很长的会话标题'.repeat(12)
  await mount(<ChatPageHarness modelConfigured sessions={[{ ...sessionA, name: longName }, sessionB]} />)
  const sidebar = page.getByRole('complementary', { name: '侧栏' })
  const toggle = page.getByRole('button', { name: '收起侧边栏' })
  const workspaces = sidebar.getByRole('navigation', { name: '工作区' })
  await expect(toggle).toBeVisible({ timeout: 1500 })
  await sidebar.getByRole('button', { name: longName }).click()
  await expect(sidebar.getByRole('button', { name: '新建会话' })).toBeInViewport({ ratio: 1 })
  expect(await workspaces.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)

  const editor = page.getByRole('textbox', { name: '消息' })
  await editor.fill('侧栏收起前的草稿')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
    connection: 'ready', slow: false, error: null,
    snapshot: { seq: 1, messages: [], activeContent: [], running: null, compactions: [],
      contextUsage: { tokens: 50, contextWindow: 100, breakdown: { systemTokens: 20, toolsTokens: 10, messageTokens: 20 } } },
  } })))
  const model = page.getByRole('combobox', { name: '模型', exact: true })
  const meter = page.getByRole('button', { name: '对话容量 50%' })
  const send = page.getByRole('button', { name: '发送', exact: true })
  expect((await model.boundingBox())!.x).toBeLessThan((await meter.boundingBox())!.x)
  expect((await meter.boundingBox())!.x).toBeLessThan((await send.boundingBox())!.x)
  await expect(page.getByText('/tmp/workspace', { exact: true })).toHaveCount(0)

  await toggle.press('Enter')
  const reopen = page.getByRole('button', { name: '展开侧边栏' })
  await expect(reopen).toBeFocused()
  await expect(sidebar).toBeHidden()
  await expect(editor).toHaveText('侧栏收起前的草稿')
  await expect(meter).toBeVisible()
  await reopen.press('Enter')
  await expect(sidebar.getByRole('button', { name: longName })).toHaveAttribute('aria-current', 'page')
  await sidebar.getByRole('button', { name: '会话 2' }).click()
  await expect(page.getByRole('heading', { name: '会话 2' })).toBeVisible()
  await expect(editor).toHaveText('')
})

test('新会话居中，键盘打开草稿，工作区入口共用一份草稿且首次发送才出现历史', async ({ mount, page }) => {
  let view = { workspaces: [] as typeof workspace[] }
  const otherWorkspace = { ...workspace, id: 'workspace-2', path: '/tmp/白榆', name: '白榆' }
  const sessions: typeof sessionA[] = []
  const starts: StartSessionRequest[] = []
  let pickerCalls = 0
  let emptySessionRequests = 0
  await page.route('**/api/workspaces', route => route.fulfill({ json: view }))
  await page.route('**/api/workspaces/pick', route => {
    if (++pickerCalls === 1) return route.fulfill({ json: { cancelled: true } })
    const chosen = pickerCalls === 2 ? workspace : otherWorkspace
    view = { workspaces: [...view.workspaces, chosen] }
    return route.fulfill({ json: { cancelled: false, workspaceId: chosen.id, created: true, view } })
  })
  await page.route('**/api/sessions', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sessions } })
    emptySessionRequests++
    return route.fulfill({ status: 405 })
  })
  await page.route('**/api/sessions/start', route => {
    const input: StartSessionRequest = route.request().postDataJSON()
    starts.push(input)
    const session = { ...sessionA, id: input.clientMessageId, workspaceId: input.workspaceId }
    sessions.push(session)
    return route.fulfill({ status: 202, json: {
      session,
      accepted: { kind: 'message', sessionId: session.id, clientMessageId: input.clientMessageId, userMessageId: 'first-user', acceptedSeq: 1 },
    } })
  })
  await mount(<ChatPageHarness modelConfigured useWorkspaceApi />)
  const heading = page.getByRole('heading', { name: 'SI', exact: true })
  const workspaceSelect = page.getByRole('combobox', { name: '工作区', exact: true })
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const add = page.getByRole('button', { name: '添加工作区', exact: true })
  const newSession = page.getByRole('button', { name: '新会话', exact: true })
  const draftRow = page.getByRole('button', { name: '未发送的新会话', exact: true })
  const groupA = page.getByRole('group', { name: '青禾', exact: true })
  const groupB = page.getByRole('group', { name: '白榆', exact: true })
  const model = page.getByRole('combobox', { name: '模型', exact: true })
  await expect(heading).toBeVisible()
  await expect(heading).toHaveCSS('font-family', /^"?EB Garamond/)
  await expect(heading).toHaveCSS('font-size', '32px')
  await expect(heading).toHaveCSS('line-height', '40px')
  await expect(heading).toHaveCSS('font-weight', '400')
  await expect(workspaceSelect).toHaveCSS('font-size', '14px')
  const headingBox = (await heading.boundingBox())!
  const editorBox = (await editor.boundingBox())!
  const workspaceBox = (await workspaceSelect.boundingBox())!
  const modelBox = (await model.boundingBox())!
  const sendBox = (await send.boundingBox())!
  expect(headingBox.x + headingBox.width / 2).toBeCloseTo(editorBox.x + editorBox.width / 2, 0)
  expect(headingBox.y + headingBox.height).toBeLessThan(workspaceBox.y)
  expect(workspaceBox.y + workspaceBox.height).toBeLessThan(editorBox.y)
  expect(workspaceBox.x).toBeLessThan(editorBox.x + editorBox.width / 2)
  expect(modelBox.x + modelBox.width).toBeLessThan(sendBox.x)
  expect(modelBox.y + modelBox.height / 2).toBeCloseTo(sendBox.y + sendBox.height / 2, 0)

  const original = '  保留原文\n第二行  '
  await editor.fill(original)
  await expect(send).toBeDisabled()
  const chooseWorkspace = async (name: string) => {
    await workspaceSelect.click()
    await page.getByRole('option', { name, exact: true }).click()
  }
  await chooseWorkspace('添加工作区…')
  await expect.poll(() => pickerCalls).toBe(1)
  await expect(workspaceSelect).toBeEnabled()
  await expect(workspaceSelect).toHaveText('选择工作区')
  await expect(groupA).toHaveCount(0)
  await chooseWorkspace('添加工作区…')
  await expect(workspaceSelect).toHaveText(workspace.name)
  await add.click()
  await expect(workspaceSelect).toHaveText(otherWorkspace.name)
  await expect(groupB.getByRole('button', { name: '未发送的新会话' })).toHaveCount(1)
  await groupA.getByRole('button', { name: '新建会话', exact: true }).press('Enter')
  await expect(workspaceSelect).toHaveText(workspace.name)
  await expect(groupA.getByRole('button', { name: '未发送的新会话' })).toHaveCount(1)
  await newSession.press('Enter')
  await newSession.press('Enter')
  await expect(draftRow).toHaveCount(1)
  await expect(draftRow).toHaveText('新会话')
  await expect.poll(() => editor.evaluate(el => Array.from(el.children, node => node.textContent).join('\n'))).toBe(original)
  const readDraft = () => page.evaluate(key => localStorage.getItem(key), draftKey(newSessionDraft))
  await expect.poll(readDraft).toBe(original)
  expect(starts).toHaveLength(0)
  expect(emptySessionRequests).toBe(0)

  await chooseWorkspace(otherWorkspace.name)
  await expect(send).toBeEnabled()
  await editor.press('Enter')
  const history = groupB.getByRole('button', { name: '会话 1', exact: true })
  await expect(history).toHaveAttribute('aria-current', 'page')
  expect(starts).toEqual([{ permissionMode: 'normal', workspaceId: otherWorkspace.id, provider: 'deepseek', modelId: 'deepseek-flash', clientMessageId: expect.any(String), text: original }])
  await expect(draftRow).toHaveCount(0)
  await expect(heading).toHaveCount(0)
  await expect.poll(readDraft).toBeNull()
  await page.evaluate(input => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      sessionId: input.clientMessageId, connection: 'ready', slow: false, error: null,
      snapshot: {
        seq: 1, running: null, compactions: [], contextUsage: null, activeContent: [],
        messages: [{ id: 'first-user', clientMessageId: input.clientMessageId, message: { role: 'user', content: input.text, timestamp: 1 } }],
      },
    } }))
  }, starts[0])
  await expect(page.getByRole('region', { name: '消息列表' }).locator('.message-text')).toHaveText(original)

  await newSession.press('Enter')
  await expect(workspaceSelect).toHaveText(otherWorkspace.name)
  await expect(editor).toHaveText('')
  await editor.fill('下一段草稿')
  await history.click()
  await expect(history).toHaveAttribute('aria-current', 'page')
  await expect(editor).toHaveText('')
  await groupB.getByRole('button', { name: '新建会话', exact: true }).press('Enter')
  await expect(editor).toHaveText('下一段草稿')
  await expect(draftRow).toHaveCount(1)
  expect(starts).toHaveLength(1)
})

test('窄屏草稿仍可选择工作区和模型，发送按钮完整可见', async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await mount(<ChatPageHarness modelConfigured sessions={[]} />)
  const workspaceSelect = page.getByRole('combobox', { name: '工作区', exact: true })
  const model = page.getByRole('combobox', { name: '模型', exact: true })
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(page.getByRole('heading', { name: 'SI', exact: true })).toBeInViewport({ ratio: 1 })
  const sidebarToggle = page.getByRole('button', { name: '展开侧边栏' })
  await sidebarToggle.press('Enter')
  const sidebar = page.getByRole('dialog', { name: '侧栏' })
  await expect(sidebar).toBeVisible()
  const settings = sidebar.getByRole('button', { name: '设置' })
  await settings.click()
  const settingsDialog = page.getByRole('dialog', { name: '设置' })
  await expect(settingsDialog).toBeVisible()
  await expect(page.getByRole('dialog', { name: '侧栏', includeHidden: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settingsDialog).toBeHidden()
  await expect(sidebarToggle).toBeFocused()
  await sidebarToggle.click()
  await settings.click()
  await settingsDialog.getByRole('button', { name: '模型', exact: true }).click()
  await settingsDialog.getByRole('button', { name: '编辑', exact: true }).click()
  const key = settingsDialog.getByLabel('API Key')
  await key.fill('unsaved-test-key')
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(key).toHaveValue('unsaved-test-key')
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(key).toHaveValue('unsaved-test-key')
  await page.keyboard.press('Escape')
  await expect(settingsDialog).toBeHidden()
  await expect(sidebarToggle).toBeFocused()
  await sidebarToggle.click()
  await sidebar.getByRole('button', { name: '新会话', exact: true }).click()
  await expect(sidebar).toBeHidden()
  await workspaceSelect.click()
  await page.getByRole('option', { name: 'workspace', exact: true }).click()
  await editor.fill('手机草稿\n第二行')
  await expect(workspaceSelect).toBeInViewport({ ratio: 1 })
  await expect(model).toBeInViewport({ ratio: 1 })
  await expect(editor).toBeInViewport({ ratio: 1 })
  await expect(send).toBeInViewport({ ratio: 1 })
  await expect(send).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true)
})

test('切换会话时从顶部阅读，并恢复草稿的空格和换行', async ({ mount, page }) => {
  const messages = Array.from({ length: 20 }, (_, i) => `历史消息 ${i}`)
  await mount(<ChatPageHarness messages={messages} modelConfigured sessions={[sessionA, sessionB]} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const scroll = page.locator('.chat-main')
  const a = page.getByRole('button', { name: '会话 1', exact: true })
  const b = page.getByRole('button', { name: '会话 2', exact: true })
  const text = '  先跑测试\n再整理结果  '
  const readDraft = () => editor.evaluate(el => Array.from(el.children, node => node.textContent).join('\n'))
  await a.click()
  await editor.fill(text)
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), draftKey(sessionA.id))).toBe(text)
  expect(await scroll.evaluate(el => (el.scrollTop = 350, el.scrollTop))).toBeGreaterThan(0)
  await b.click()
  await expect(editor).toHaveText('')
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(0)
  await editor.fill('检查 README')
  await a.click()
  await expect.poll(readDraft).toBe(text)
  await b.click()
  await expect(editor).toHaveText('检查 README')
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), recentSessionKey)).toBe(sessionB.id)
})

test('浏览器存储不可用时来回切换仍可继续编辑本页草稿', async ({ mount, page }) => {
  await page.evaluate(() => {
    const deny = () => { throw new DOMException('拒绝', 'SecurityError') }
    Storage.prototype.getItem = deny
    Storage.prototype.setItem = deny
    Storage.prototype.removeItem = deny
  })
  await mount(<ChatPageHarness modelConfigured sessions={[sessionA, sessionB]} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const a = page.getByRole('button', { name: '会话 1', exact: true })
  const b = page.getByRole('button', { name: '会话 2', exact: true })
  await a.click()
  await editor.fill('本页保留')
  await b.click()
  await expect(editor).toHaveText('')
  await a.click()
  await expect(editor).toHaveText('本页保留')
  await expect(page.getByText('浏览器存储不可用，草稿可在本页保留，重新打开后无法恢复。')).toBeVisible()
})

test('02 首发保存被拒绝时保留草稿，顶部提示三秒后消失', async ({ mount, page }) => {
  await page.clock.install()
  await page.route('**/api/workspaces', route => route.fulfill({ json: { workspaces: [workspace] } }))
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [] } }))
  await page.route('**/api/sessions/start', route => route.fulfill({
    status: 507, json: { code: 'save_rejected', error: '磁盘空间不足，未保存' },
  }))
  await mount(<ChatPageHarness useWorkspaceApi modelConfigured />)
  await page.getByRole('combobox', { name: '工作区', exact: true }).click()
  await page.getByRole('option', { name: workspace.name, exact: true }).click()
  const permission = page.locator('.composer-actions').getByRole('combobox', { name: '权限', exact: true })
  await permission.click()
  await page.getByRole('option', { name: '只读', exact: true }).click()
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill('读取 README.md')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const notice = page.locator('.save-notice')
  await expect(notice).toHaveText('会话保存失败 · 磁盘空间不足，未保存')
  expect((await notice.boundingBox())?.y).toBeLessThan(24)
  await expect(editor).toHaveText('读取 README.md')
  await expect(permission).toHaveText('只读')
  await expect(page.getByRole('button', { name: '会话 1', exact: true })).toHaveCount(0)
  await page.clock.runFor(3000)
  await expect(notice).toHaveCount(0)
  await expect(editor).toHaveText('读取 README.md')
  await expect(permission).toHaveText('只读')
})

test('28 历史读取失败时不能发送，收到完整快照后恢复', async ({ mount, page }) => {
  await mount(<ChatPageHarness modelConfigured />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(page.locator('.chat-page')).toHaveAttribute('data-session-id', 'session-a')
  await editor.fill('继续')
  await expect(send).toBeEnabled()
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', snapshot: null, slow: false, error: '无法读取完整会话历史，请重试',
    } }))
  })
  await expect(page.getByRole('alert')).toContainText('无法读取完整会话历史')
  await expect(send).toBeDisabled()
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', slow: false, error: null,
      snapshot: { seq: 1, running: null, activeContent: [], compactions: [], contextUsage: null,
        messages: [{ id: 'saved', message: { role: 'user', content: '完整原文', timestamp: 1 } }] },
    } }))
  })
  await expect(page.getByRole('region', { name: '消息列表' })).toContainText('完整原文')
  await expect(send).toBeEnabled()
})

test('超限压缩由页面状态显示，本轮详情在压缩和恢复时隐藏', async ({ mount, page }) => {
  await mount(<ChatPageHarness messages={['任务']} />)
  for (const phase of ['compaction', 'model'] as const) {
    await page.evaluate(phase => {
      window.dispatchEvent(new CustomEvent('chat-test-state', { detail: { connection: 'ready', slow: false, error: null,
        snapshot: { seq: 1, messages: [{ id: 'u', message: { role: 'user', content: '任务', timestamp: 1 } },
          { id: 'a', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
            timestamp: 2, stopReason: 'error', errorCode: 'context_overflow', content: [] } }],
        running: { kind: 'task', runId: 'u', assistantMessageId: 'a', phase, activeTools: [] }, compactions: [], contextUsage: null, activeContent: [] },
      } }))
    }, phase)
    const status = page.locator('header').getByRole('status')
    if (phase === 'compaction') await expect(status).toHaveText('正在压缩对话…')
    else await expect(status).not.toHaveText('正在压缩对话…')
    await expect(page.locator('[data-run-detail]')).toHaveCount(0)
    await expect(page.getByRole('region', { name: '消息列表' })).not.toContainText('回答生成失败')
  }
})

test('截图或文件粘贴不接管普通文字，PDF 显示支持格式', async ({ mount, page }) => {
  await mount(<ChatPageHarness modelConfigured />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.focus()

  await editor.evaluate(root => {
    const data = new DataTransfer()
    data.setData('text/plain', '保留正文\n第二行')
    root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editor).toHaveText('保留正文第二行')
  await editor.evaluate(root => {
    const data = new DataTransfer()
    data.items.add(new File(['%PDF'], 'report.pdf', { type: 'application/pdf' }))
    root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.getByRole('alert')).toContainText('支持 PNG、JPG、WebP 图片，以及 TXT、Markdown、CSV、JSON 和 UTF-8 源代码。')
  await expect(editor).toHaveText('保留正文第二行')
  await expect(page.getByText('report.pdf')).toHaveCount(0)
})

test('@ 候选优先显示同工作区，最多选择三个不同的会话', async ({ mount, page }) => {
  const session = (id: string, name: string, workspaceId = 'workspace-1') => ({ id, name, workspaceId, createdAt: '2026-11-18T08:00:00Z' })
  await page.evaluate(key => localStorage.setItem(key, 'session-a'), recentSessionKey)
  await mount(<ChatPageHarness modelConfigured sessions={[
    session('session-a', '当前会话'), session('session-e', '另一工作区', 'workspace-2'),
    session('session-b', '服务启动'), session('session-c', '测试结果'), session('session-d', '上线过程'),
  ]} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const menu = page.getByRole('listbox', { name: '引用会话' })
  const choose = async (name: string) => {
    await editor.pressSequentially('@')
    await menu.getByRole('option', { name: `Session · ${name}`, exact: true }).click()
  }
  await editor.pressSequentially('@')
  await expect(menu.getByRole('option').first()).toHaveText('Session · 服务启动')
  await expect(menu.getByRole('option', { name: 'Session · 当前会话' })).toHaveCount(0)
  await menu.getByRole('option', { name: 'Session · 服务启动', exact: true }).click()
  await choose('服务启动')
  await choose('测试结果')
  await choose('上线过程')
  await choose('另一工作区')
  await expect(page.getByRole('alert')).toContainText('一条消息最多引用 3 个会话')
  const references = page.getByRole('group', { name: '已引用会话' })
  await expect(references.getByRole('button')).toHaveCount(3)
  await expect(references).not.toContainText('另一工作区')
  await editor.pressSequentially('/')
  await expect(page.getByRole('option', { name: /compact/ })).toBeVisible()
})

test('待审计划来自服务端状态，继续讨论后聚焦输入框', async ({ mount, page }) => {
  await page.route('**/api/sessions/session-a/plan/review', async route => {
    expect(route.request().postDataJSON()).toEqual({ planId: 'assistant-plan', action: 'discuss' })
    await route.fulfill({ status: 200, json: {} })
  })
  await mount(<ChatPageHarness modelConfigured />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const update = (state: 'review' | 'planning') => page.evaluate(state => {
    const plan = state === 'review' ? { state, assistantMessageId: 'assistant-plan', steps: ['查看日志', '复查错误'] } : { state }
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', slow: false, error: null, snapshot: {
        seq: state === 'review' ? 1 : 2, messages: [], running: null, compactions: [], contextUsage: null, activeContent: [], permissionMode: 'normal', plan,
      },
    } }))
  }, state)
  await expect(page.getByRole('button', { name: '确认执行' })).toHaveCount(0)
  await update('review')
  const card = page.getByRole('region', { name: '待确认计划' })
  await expect(card.getByRole('listitem')).toHaveText(['查看日志', '复查错误'])
  await expect(card.getByRole('button')).toHaveCount(2)
  const discussed = page.waitForResponse('**/api/sessions/session-a/plan/review')
  await card.getByRole('button', { name: '去聊天里说' }).click()
  await discussed
  await update('planning')
  await expect(card).toBeHidden()
  await expect(editor).toBeFocused()
  await expect(page.getByRole('button', { name: '退出计划模式', exact: true })).toBeVisible()
})

test('移除上传中的文件后忽略晚到回执，失败附件重试成功后按有效 ID 发送', async ({ mount, page }) => {
  let releaseUpload!: () => void
  const delayedUpload = new Promise<void>(resolve => { releaseUpload = resolve })
  let attempts = 0
  await page.route('**/api/attachments?*', async route => {
    const name = route.request().headers()['x-attachment-name']
    expect(new URL(route.request().url()).searchParams.get('sessionId')).toBe('session-a')
    if (name === 'removed.png') {
      await delayedUpload
      await route.fulfill({ json: { id: 'removed', name, size: 9, mediaType: 'image/png' } }).catch(() => undefined)
      return
    }
    if (++attempts === 1) {
      await route.fulfill({ status: 500, json: { error: '上传暂时不可用' } })
      return
    }
    await route.fulfill({ json: { id: 'current', name, size: 24, mediaType: 'text/plain' } })
  })
  let sent: { clientMessageId: string; text: string; attachmentIds: string[] } | undefined
  let acceptSend!: () => void
  const delayedSend = new Promise<void>(resolve => { acceptSend = resolve })
  await page.route('**/api/messages', async route => {
    sent = route.request().postDataJSON()
    await delayedSend
    await route.fulfill({ status: 202, json: { sessionId: 'session-a', userMessageId: 'accepted', clientMessageId: sent!.clientMessageId, acceptedSeq: 1, kind: 'message' } })
  })
  await mount(<ChatPageHarness modelConfigured />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const drafts = page.getByRole('group', { name: '待发送附件' })
  await editor.fill('分析正文')
  await page.locator('input[type=file]').setInputFiles([
    { name: 'removed.png', mimeType: 'image/png', buffer: Buffer.from('mock-png') },
    { name: 'log.txt', mimeType: 'text/plain', buffer: Buffer.from('mock-log') },
  ])
  await expect(drafts.getByRole('img', { name: 'removed.png' })).toBeVisible()
  await drafts.getByRole('button', { name: '移除 removed.png' }).click()
  releaseUpload()
  await expect(drafts.getByRole('button', { name: '重试 log.txt' })).toBeVisible()
  await expect(send).toBeDisabled()
  await expect(editor).toHaveText('分析正文')
  await drafts.getByRole('button', { name: '重试 log.txt' }).click()
  await expect(send).toBeEnabled()
  await expect(drafts.getByRole('img', { name: 'removed.png' })).toHaveCount(0)
  await send.click()
  await expect.poll(() => sent?.attachmentIds).toEqual(['current'])
  await expect(editor).toHaveText('分析正文')
  await expect(drafts).toBeVisible()
  acceptSend()
  await expect(editor).toBeEmpty()
  await expect(drafts).toHaveCount(0)
})

test('引用读取失败时保留原草稿，未收到回执时用同一编号和引用重试', async ({ mount, page }) => {
  const sessions = [
    { id: 'session-a', name: '当前会话', workspaceId: 'workspace-1', createdAt: '2026-11-18T08:00:00Z' },
    { id: 'source', name: '源会话', workspaceId: 'workspace-1', createdAt: '2026-11-18T08:00:00Z' },
  ]
  const submissions: { clientMessageId: string; text: string; referenceSessionIds: string[] }[] = []
  await page.route('**/api/messages', async route => {
    const input = route.request().postDataJSON()
    submissions.push(input)
    if (submissions.length === 1) {
      await route.fulfill({ status: 400, json: { error: '无法读取引用会话，请重试或移除此引用' } })
    } else if (submissions.length === 2) {
      await route.abort('failed')
    } else {
      await route.fulfill({ status: 202, json: { kind: 'message', sessionId: 'session-a', userMessageId: 'accepted', clientMessageId: input.clientMessageId, acceptedSeq: 1 } })
    }
  })
  await page.evaluate(key => localStorage.setItem(key, 'session-a'), recentSessionKey)
  await mount(<ChatPageHarness modelConfigured sessions={sessions} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.pressSequentially('@')
  await page.getByRole('option', { name: 'Session · 源会话' }).click()
  await editor.fill('服务是如何启动的？')
  await editor.press('Enter')
  await expect(page.getByRole('alert')).toContainText('无法读取引用会话')
  await expect(editor).toHaveText('服务是如何启动的？')
  await expect(page.getByRole('group', { name: '已引用会话' })).toContainText('源会话')

  await editor.press('Enter')
  await page.getByRole('button', { name: '重试发送', exact: true }).click()
  await expect(editor).toBeEmpty()
  await expect(page.getByRole('group', { name: '已引用会话' })).toHaveCount(0)
  expect(submissions).toHaveLength(3)
  expect(submissions[1]).toEqual(submissions[2])
  expect(submissions[2]).toMatchObject({ text: '服务是如何启动的？', referenceSessionIds: ['source'] })
})

test('草稿进入计划时复用已创建的会话，失败保留命令可重试', async ({ mount, page }) => {
  let creates = 0
  let submissions = 0
  await page.route('**/api/sessions', async route => {
    creates++
    await route.fulfill({ status: 201, json: {
      id: 'created-after-plan', name: '新会话', workspaceId: 'workspace-1', createdAt: '2026-11-18T08:00:00Z',
    } })
  })
  await page.route('**/api/model-selection', route => route.fulfill({ status: 200, json: { modelId: 'deepseek-flash', provider: 'deepseek' } }))
  await page.route('**/api/messages', route => {
    const input = route.request().postDataJSON()
    expect(input).toMatchObject({ text: '/plan', sessionId: 'created-after-plan' })
    submissions++
    return submissions === 1
      ? route.fulfill({ status: 500, json: { error: '请求失败，请重试' } })
      : route.fulfill({ status: 202, json: { kind: 'handled', sessionId: input.sessionId, clientMessageId: input.clientMessageId, notices: [] } })
  })
  await mount(<ChatPageHarness modelConfigured />)
  const workspace = page.getByRole('group', { name: 'workspace', exact: true })
  await workspace.getByRole('button', { name: '新建会话', exact: true }).click()
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await editor.fill('/plan')
  await expect(send).toBeEnabled()
  await editor.press('Enter')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(editor).toHaveText('/plan')
  await expect(send).toBeEnabled()
  await editor.press('Enter')
  await expect(page.locator('.chat-page')).toHaveAttribute('data-session-id', 'created-after-plan')
  expect(creates).toBe(1)
  expect(submissions).toBe(2)
})
