import { test, expect } from '@playwright/experimental-ct-react'
import { ChatPage } from './ChatPage'
import { Button } from '../components/ui/button'

test('发送及恢复焦点时保持阅读位置', async ({ mount, page }) => {
  await mount(<ChatPage />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const list = page.getByRole('region', { name: '消息列表' })
  const items = list.getByRole('listitem')
  for (let i = 0; i < 26; i++) {
    await editor.fill(`旧消息 ${i}：${'用于验证独立滚动的内容。'.repeat(12)}`)
    await editor.press('Enter')
  }
  await expect(items).toHaveCount(26)
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)

  await list.evaluate(el => { el.scrollTop = 350 })
  const oldItem = items.nth(5)
  const oldTop = (await oldItem.boundingBox())!.y
  const readingPosition = await list.evaluate(el => el.scrollTop)
  await editor.fill('新消息')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(items).toHaveCount(27)
  await expect(editor).toBeFocused()
  expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(readingPosition, 0)
  expect((await oldItem.boundingBox())!.y).toBeCloseTo(oldTop, 0)

  await list.evaluate(el => { el.scrollTop = el.scrollHeight })
  const bottom = await list.evaluate(el => el.scrollTop)
  await editor.fill('停在底部发送的消息')
  await editor.press('Enter')
  await expect(items).toHaveCount(28)
  expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(bottom, 0)
  expect(await list.evaluate(el => el.scrollTop + el.clientHeight < el.scrollHeight)).toBe(true)

  await list.evaluate(el => { el.scrollTop = 350 })
  const beforeMultiline = await list.evaluate(el => el.scrollTop)
  const composerBefore = await editor.boundingBox()
  const oldTopBeforeMultiline = (await oldItem.boundingBox())!.y
  const multiline = '多行草稿\n第二行\n\n第四行\n第五行\n最后一行'
  await editor.fill(multiline)
  expect((await editor.boundingBox())!.height).toBeGreaterThan(composerBefore!.height + 90)
  expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(beforeMultiline, 0)
  expect((await oldItem.boundingBox())!.y).toBeCloseTo(oldTopBeforeMultiline, 0)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(items).toHaveCount(29)
  await expect(editor).toHaveText('')
  await expect(editor).toBeFocused()
  expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(beforeMultiline, 0)
  expect((await oldItem.boundingBox())!.y).toBeCloseTo(oldTopBeforeMultiline, 0)
  expect((await editor.boundingBox())!.height).toBeCloseTo(composerBefore!.height, 0)
  expect((await editor.boundingBox())!.y).toBeCloseTo(composerBefore!.y, 0)
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)

  await list.focus()
  const keyboardBefore = await list.evaluate(el => el.scrollTop)
  await list.press('PageDown')
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(keyboardBefore)
  await list.press('ControlOrMeta+End')
  await list.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(items.last()).toBeInViewport()
  await expect(items.last()).toHaveText(multiline)
})

test('发送按钮随空白和有效草稿切换颜色，发送后恢复空白状态', async ({ mount, page }) => {
  await mount(<ChatPage />)
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
  await expect(page.getByRole('listitem')).toHaveText('有效消息')
  await expect(editor).toHaveText('')
  await expectEmptyButton()
})

test('白色页面与消息输入区同轴，正文和标题遵守已确认尺寸', async ({ mount, page }) => {
  await mount(<ChatPage />)
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
  expect(composerBox.x + composerBox.width / 2).toBeCloseTo(640, 0)
  expect(listBox.x).toBeCloseTo(composerBox.x, 0)
  expect(listBox.width).toBeCloseTo(composerBox.width, 0)
  await editor.fill('正文消息')
  await editor.press('Enter')
  await expect(list.getByRole('listitem')).toHaveCSS('background-color', 'rgb(247, 247, 245)')
  const text = list.locator('.message-text')
  await expect(text).toHaveCSS('font-size', '14px')
  await expect(text).toHaveCSS('line-height', '24px')
  await expect(text).toHaveCSS('font-weight', '400')
})

test('窄屏长草稿到上限后内部滚动，输入和发送操作始终可见', async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await mount(<ChatPage />)
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
  await send.click()
  await expect(editor).toHaveText('')
  expect((await editor.boundingBox())!.height).toBeCloseTo(24, 0)
  await expect(send).toBeInViewport({ ratio: 1 })
})

test('低高度视口的长草稿仍保留完整输入区和发送操作', async ({ mount, page }) => {
  await page.setViewportSize({ width: 844, height: 280 })
  await mount(<ChatPage />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await editor.fill(Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行长草稿`).join('\n'))
  const sendBox = (await send.boundingBox())!
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(280)
  await expect(editor).toBeInViewport({ ratio: 1 })
  await expect(send).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
  await send.click()
  await expect(editor).toHaveText('')
  await expect(editor).toBeInViewport({ ratio: 1 })
  await expect(send).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
})

test.describe('触屏操作', () => {
  test.use({ hasTouch: true })

  test('平板及横屏发送目标至少为44×44', async ({ mount, page }) => {
    await page.setViewportSize({ width: 844, height: 700 })
    await mount(<ChatPage />)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('触屏消息')
    const send = page.getByRole('button', { name: '发送', exact: true })
    const box = (await send.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    await send.tap()
    await expect(page.getByRole('listitem')).toHaveText('触屏消息')
  })
})

test('正文使用随应用加载的 Noto Sans CJK SC 字体', async ({ mount, page, context }) => {
  await mount(<ChatPage />)
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
  await mount(<ChatPage />)
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
  await expectQuietBoundary()
  await expect(send).toHaveCSS('border-width', '0px')
  await expect(send).toHaveCSS('outline-style', 'none')
  await expect(send).toHaveCSS('box-shadow', 'none')
  await expect.poll(() => send.evaluate(el => {
    const marker = getComputedStyle(el, '::after')
    return { opacity: marker.opacity, width: marker.width, height: marker.height }
  })).toEqual({ opacity: '1', width: '4px', height: '4px' })

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
  await mount(<ChatPage />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const list = page.getByRole('region', { name: '消息列表' })
  const frame = page.locator('.message-list-frame')
  for (let i = 0; i < 12; i++) {
    await editor.fill(`消息 ${i}：${'用于验证滚动。'.repeat(24)}`)
    await editor.press('Enter')
  }
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
