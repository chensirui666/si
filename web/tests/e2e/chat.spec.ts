import { test, expect } from '@playwright/test'

test('页面启动、发送与刷新清空', async ({ page }) => {
  await page.goto('/')
  const messages = page.getByRole('region', { name: '消息列表' })
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await expect(messages.getByRole('listitem')).toHaveCount(0)
  await editor.fill('你好')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(messages.getByRole('listitem')).toHaveCount(1)
  await expect(messages.getByRole('listitem')).toHaveText('你好')
  await expect(editor).toHaveText('')
  await expect(editor).toBeFocused()
  await editor.fill('还没发出的草稿')
  await page.reload()
  await expect(messages.getByRole('listitem')).toHaveCount(0)
  await expect(editor).toHaveText('')
})
