import { test, expect } from '@playwright/experimental-ct-react'
import { ChatPage } from './ChatPage'

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
  await editor.fill('多行草稿\n第二行\n\n第四行\n最后一行')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(items).toHaveCount(29)
  await expect(editor).toHaveText('')
  await expect(editor).toBeFocused()
  expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(beforeMultiline, 0)
  expect((await editor.boundingBox())!.y).toBeCloseTo(composerBefore!.y, 0)
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)

  await list.focus()
  const keyboardBefore = await list.evaluate(el => el.scrollTop)
  await list.press('PageDown')
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(keyboardBefore)
  await list.press('ControlOrMeta+End')
  await list.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(items.last()).toBeInViewport()
  await expect(items.last()).toHaveText('多行草稿\n第二行\n\n第四行\n最后一行')
})
