import { test, expect } from '@playwright/experimental-ct-react'
import { draftKey, recentSessionKey } from '../chat/drafts'
import { ChatPageHarness } from '../test/ChatPageHarness'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/web/settings', route => route.fulfill({
    json: {
      searchProvider: 'tavily', fetchProvider: 'tavily',
      providers: [{ id: 'tavily', name: 'Tavily', capabilities: ['search', 'fetch'], status: { state: 'missing' } }],
    },
  }))
})

test('设置弹窗约束键盘焦点，Escape 关闭后返回入口并清空 Key', async ({ mount, page }) => {
  await mount(<ChatPageHarness />)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill('设置期间保留的草稿')
  const trigger = page.getByRole('button', { name: '设置', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(dialog).toBeVisible()
  const heading = dialog.getByRole('heading', { name: '设置', exact: true })
  await expect(heading).toHaveCSS('font-family', /^system-ui,.*Noto Sans CJK SC/)
  await expect(heading).toHaveCSS('font-size', '20px')
  await expect(heading).toHaveCSS('line-height', '28px')
  await dialog.getByRole('button', { name: '模型', exact: true }).click()
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
  await dialog.getByRole('button', { name: '模型', exact: true }).click()
  await page.getByRole('button', { name: '添加提供方', exact: true }).click()
  await page.getByRole('button', { name: 'DeepSeek', exact: true }).click()
  await expect(key).toHaveValue('')
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual({
    [recentSessionKey]: 'session-a', [draftKey('session-a')]: '设置期间保留的草稿',
  })
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
})

test('网页工具分别选择能力服务商，保存共用 Key 后再编辑没有旧 Key', async ({ mount, page }) => {
  const tavily = { id: 'tavily', name: 'Tavily', capabilities: ['search', 'fetch'], status: { state: 'missing' } }
  let view = { searchProvider: 'tavily', fetchProvider: 'tavily', providers: [tavily, { id: 'search-only', name: '测试搜索', capabilities: ['search'], status: { state: 'missing' } }] }
  await page.route('**/api/web/settings', route => {
    if (route.request().method() === 'PUT') view = { ...view, ...route.request().postDataJSON() }
    return route.fulfill({ json: view })
  })
  await page.route('**/api/web/providers/tavily', route => {
    expect(route.request().method()).toBe('PUT')
    expect(route.request().postDataJSON()).toEqual({ apiKey: 'example-tavily-key' })
    view = { ...view, providers: [{ ...tavily, status: { state: 'configured' } }, view.providers[1]] }
    return route.fulfill({ json: view })
  })
  await mount(<ChatPageHarness />)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const tools = page.getByRole('button', { name: '网页工具', exact: true })
  await tools.click()
  const search = page.getByRole('combobox', { name: '网页搜索' })
  const fetch = page.getByRole('combobox', { name: '网页获取' })
  await fetch.click()
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await search.click()
  await page.getByRole('option', { name: '测试搜索' }).click()
  await expect.poll(() => view.searchProvider).toBe('search-only')
  const edit = page.getByRole('button', { name: '编辑 Tavily' })
  await edit.click()
  const key = page.getByLabel('API Key', { exact: true })
  await key.fill('example-tavily-key')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('已保存在本机，尚未验证远端有效性')).toBeVisible()
  await expect(page.getByText('已配置', { exact: true })).toBeVisible()
  await expect(key).toHaveValue('')
  await page.getByRole('button', { name: '模型', exact: true }).click()
  await tools.click()
  await edit.click()
  await expect(key).toHaveValue('')
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual({ [recentSessionKey]: 'session-a' })
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
})

test('切换英文后，已有错误摘要更新并保留诊断原文', async ({ mount, page }) => {
  await page.route('**/api/settings/language', route => route.fulfill({
    json: { language: route.request().method() === 'GET' ? 'zh-CN' : 'en' },
  }))
  await mount(<ChatPageHarness />, { hooksConfig: { loadSavedLanguage: true } })
  await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', 'session-a')
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('chat-test-state', { detail: {
      connection: 'ready', slow: false, error: 'Provider quota exceeded', snapshot: null,
    } }))
  })
  await expect(page.getByRole('alert')).toHaveText('无法读取会话 · Provider quota exceeded')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('combobox', { name: '语言' }).click()
  await page.getByRole('option', { name: 'English' }).click()
  await expect(page.getByRole('combobox', { name: 'Language' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alert')).toHaveText('Could not load the chat · Provider quota exceeded')
})

test('默认权限保存失败后，显示重读确认的原值', async ({ mount, page }) => {
  await page.route('**/api/settings/permission', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { error: '写入失败' } })
    : route.fulfill({ json: { defaultPermissionMode: 'normal' } }))
  await mount(<ChatPageHarness />)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const mode = dialog.getByRole('combobox', { name: '权限', exact: true })
  await expect(mode).toHaveText('普通', { timeout: 2000 })
  await mode.click()
  await page.getByRole('option', { name: '只读', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('写入失败')
  await expect(mode).toHaveText('普通')
})

test('默认权限保存回执断开后，按重读结果显示已保存的值', async ({ mount, page }) => {
  let mode = 'normal'
  await page.route('**/api/settings/permission', route => {
    if (route.request().method() === 'PUT') {
      mode = route.request().postDataJSON().defaultPermissionMode
      return route.abort()
    }
    return route.fulfill({ json: { defaultPermissionMode: mode } })
  })
  await mount(<ChatPageHarness />)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const permission = dialog.getByRole('combobox', { name: '权限', exact: true })
  await expect(permission).toHaveText('普通')
  await permission.click()
  await page.getByRole('option', { name: '只读', exact: true }).click()
  await expect(permission).toHaveText('只读')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
})
