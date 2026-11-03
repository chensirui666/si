import { test, expect } from '@playwright/experimental-ct-react'
import { ChatPageHarness } from '../test/ChatPageHarness'

test('设置弹窗约束键盘焦点，Escape 关闭后返回入口并清空 Key', async ({ mount, page }) => {
  await mount(<ChatPageHarness />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill('设置期间保留的草稿')
  const trigger = page.getByRole('button', { name: '设置', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: '添加提供方', exact: true }).click()
  await page.getByRole('button', { name: 'DeepSeek', exact: true }).click()
  const key = page.getByLabel('API Key', { exact: true })
  await key.fill('fake-browser-private-key')
  await expect(key).toHaveAttribute('type', 'password')
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(editor).toHaveText('设置期间保留的草稿')
  await trigger.click()
  await page.getByRole('button', { name: '添加提供方', exact: true }).click()
  await page.getByRole('button', { name: 'DeepSeek', exact: true }).click()
  await expect(key).toHaveValue('')
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
})
