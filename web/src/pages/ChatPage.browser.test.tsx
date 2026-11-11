import { test, expect } from '@playwright/experimental-ct-react'
import type { StartSessionRequest } from '@agent-learning/server/protocol'
import { ChatPageHarness } from '../test/ChatPageHarness'
import { MessageInputHarness } from '../test/MessageInputHarness'
import { draftKey, newSessionDraft, recentSessionKey } from '../chat/drafts'
import { Button } from '../components/ui/button'

test.beforeEach(async ({ page }) => {
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
  const items = list.getByRole('listitem')
  await expect(items).toHaveCount(26)
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  await list.evaluate(el => { el.scrollTop = 350 })
  const oldItem = items.nth(5)
  const oldTop = (await oldItem.boundingBox())!.y
  const readingPosition = await list.evaluate(el => el.scrollTop)
  const multiline = '多行草稿\n第二行\n\n第四行\n第五行\n最后一行'
  const before = await editor.boundingBox()
  await editor.fill(multiline)
  expect((await editor.boundingBox())!.height).toBeGreaterThan(before!.height + 90)
  expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(readingPosition, 0)
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
    expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(readingPosition, 0)
    expect((await oldItem.boundingBox())!.y).toBeCloseTo(oldTop, 0)
  }
  // fill('') 直接设置 DOM 选区后立刻 Delete，可能早于 Lexical 的选区同步。
  await editor.press('ControlOrMeta+a')
  await editor.press('Backspace')
  await expect(editor).toHaveText('')
  await expect.poll(async () => (await editor.boundingBox())!.height).toBeCloseTo(before!.height, 0)
  expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(readingPosition, 0)
  await list.focus()
  const keyboardBefore = await list.evaluate(el => el.scrollTop)
  await list.press('PageDown')
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(keyboardBefore)
  await list.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(items.last()).toBeInViewport()
  const bottom = await list.evaluate(el => el.scrollTop)
  await page.evaluate(history => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', slow: false, error: null,
      snapshot: { seq: 2, messages: [...history, '新同步消息'].map((content, index) => ({ id: `history-${index}`, message: { role: 'user', content, timestamp: index } })), running: null, compactions: [], contextUsage: null, activeContent: [] },
    } }))
  }, history)
  await expect(items).toHaveCount(27)
  expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(bottom, 0)
  expect(await list.evaluate(el => el.scrollTop + el.clientHeight < el.scrollHeight)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
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

test('白色页面与消息输入区同轴，正文和标题遵守已确认尺寸', async ({ mount, page }) => {
  await mount(<ChatPageHarness messages={['正文消息']} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const list = page.getByRole('region', { name: '消息列表' })
  const composer = page.locator('.message-input')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.getByRole('heading', { name: '聊天' })).toHaveCSS('font-size', '20px')
  await expect(page.getByRole('heading', { name: '聊天' })).toHaveCSS('line-height', '28px')
  await expect(page.getByRole('heading', { name: '聊天' })).toHaveCSS('font-weight', '600')
  await expect(editor).toHaveCSS('font-size', '14px')
  await expect(editor).toHaveCSS('line-height', '24px')
  await expect(editor).toHaveCSS('font-weight', '400')
  expect((await editor.boundingBox())!.height).toBeCloseTo(24, 0)
  const listBox = (await list.boundingBox())!
  const composerBox = (await composer.boundingBox())!
  expect(composerBox.width).toBeLessThanOrEqual(760)
  const workspaceBox = (await page.locator('.chat-workspace').boundingBox())!
  expect(composerBox.x + composerBox.width / 2).toBeCloseTo(workspaceBox.x + workspaceBox.width / 2, 0)
  expect(listBox.x).toBeCloseTo(composerBox.x, 0)
  expect(listBox.width).toBeCloseTo(composerBox.width, 0)
  await expect(list.getByRole('listitem')).toHaveCSS('background-color', 'rgb(247, 247, 245)')
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

test('正文使用随应用加载的 Noto Sans CJK SC 字体', async ({ mount, page, context }) => {
  await mount(<ChatPageHarness messages={['中文正文 English']} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill('中文正文 English')
  await editor.press('Enter')
  const faces = await page.evaluate(async () => {
    const loaded = await document.fonts.load('400 14px "Noto Sans CJK SC"', '中文正文 English')
    return loaded.map(face => ({ family: face.family, status: face.status }))
  })
  expect(faces).toContainEqual({ family: 'Noto Sans CJK SC', status: 'loaded' })
  await expect(page.locator('.message-text')).toHaveCSS('font-family', /Noto Sans CJK SC/)

  const session = await context.newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument')
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.message-text' })
  const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId })
  expect(fonts.some(font => font.familyName === 'Noto Sans CJK SC' && font.isCustomFont && font.glyphCount > 0)).toBe(true)
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
  const frame = page.locator('.message-list-frame')
  await page.getByRole('heading', { name: '聊天' }).click()
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
  const scrollBefore = await list.evaluate(el => el.scrollTop)
  await page.keyboard.press('PageDown')
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(scrollBefore)
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
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await list.evaluate(el => { el.scrollTop = 350 })
  const oldTop = (await list.getByRole('listitem').nth(5).boundingBox())!.y
  const scrollTop = await list.evaluate(el => el.scrollTop)
  await editor.fill('生成时继续编辑')
  for (const seq of [1, 2, 3]) {
    await page.evaluate(({ history, seq }) => {
      window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
        connection: 'ready', slow: false, error: null,
        snapshot: { seq, messages: [...history.map((content, index) => ({ id: `history-${index}`, message: { role: 'user', content, timestamp: index } })), { id: 'answer', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 30, content: [{ type: 'thinking', thinking: '独立思考' }, { type: 'text', text: `# 标题\n\n${'回答内容\n\n'.repeat(seq * 8)}` }], stopReason: seq === 3 ? 'stop' : 'pending' } }], running: seq === 3 ? null : { kind: 'task' as const, runId: 'history-25', assistantMessageId: 'answer', phase: 'model', activeTools: [] }, compactions: [], contextUsage: null, activeContent: seq === 3 ? [] : [{ messageId: 'answer', contentIndex: 1, type: 'text' }] },
      } }))
    }, { history, seq })
    await expect(list.getByRole('listitem')).toHaveCount(27)
    expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(scrollTop, 0)
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
  const addOption = { label: '添加工作区…' }
  await workspaceSelect.selectOption(addOption)
  await expect.poll(() => pickerCalls).toBe(1)
  await expect(workspaceSelect).toBeEnabled()
  await expect(workspaceSelect).not.toHaveValue('add-workspace')
  await expect(groupA).toHaveCount(0)
  await workspaceSelect.selectOption(addOption)
  await expect(workspaceSelect).toHaveValue(workspace.id)
  await add.click()
  await expect(workspaceSelect).toHaveValue(otherWorkspace.id)
  await expect(groupB.getByRole('button', { name: '未发送的新会话' })).toHaveCount(1)
  await groupA.getByRole('button', { name: '新建会话', exact: true }).press('Enter')
  await expect(workspaceSelect).toHaveValue(workspace.id)
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

  await workspaceSelect.selectOption(otherWorkspace.id)
  await expect(send).toBeEnabled()
  await editor.press('Enter')
  const history = groupB.getByRole('button', { name: '会话 1', exact: true })
  await expect(history).toHaveAttribute('aria-current', 'page')
  expect(starts).toEqual([{ workspaceId: otherWorkspace.id, modelId: 'deepseek-flash', clientMessageId: expect.any(String), text: original }])
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
  await expect(workspaceSelect).toHaveValue(otherWorkspace.id)
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
  await workspaceSelect.selectOption(workspace.id)
  await editor.fill('手机草稿\n第二行')
  await expect(workspaceSelect).toBeInViewport({ ratio: 1 })
  await expect(model).toBeInViewport({ ratio: 1 })
  await expect(editor).toBeInViewport({ ratio: 1 })
  await expect(send).toBeInViewport({ ratio: 1 })
  await expect(send).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true)
})

test('切换两段会话后恢复草稿的空格和换行', async ({ mount, page }) => {
  await mount(<ChatPageHarness modelConfigured sessions={[sessionA, sessionB]} />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const a = page.getByRole('button', { name: '会话 1', exact: true })
  const b = page.getByRole('button', { name: '会话 2', exact: true })
  const text = '  先跑测试\n再整理结果  '
  const readDraft = () => editor.evaluate(el => Array.from(el.children, node => node.textContent).join('\n'))
  await a.click()
  await editor.fill(text)
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), draftKey(sessionA.id))).toBe(text)
  await b.click()
  await expect(editor).toHaveText('')
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
  await page.getByRole('combobox', { name: '工作区', exact: true }).selectOption(workspace.id)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill('读取 README.md')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const notice = page.locator('.save-notice')
  await expect(notice).toHaveText('磁盘空间不足，未保存')
  expect((await notice.boundingBox())?.y).toBeLessThan(24)
  await expect(editor).toHaveText('读取 README.md')
  await expect(page.getByRole('button', { name: '会话 1', exact: true })).toHaveCount(0)
  await page.clock.runFor(3000)
  await expect(notice).toHaveCount(0)
  await expect(editor).toHaveText('读取 README.md')
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
