import { test, expect } from '@playwright/experimental-ct-react'
import type { AssistantMessage as Message } from '@agent-learning/model'
import { AssistantMessage } from './AssistantMessage'
import { MarkdownText } from './markdown/MarkdownText'

const base: Message = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, content: [], stopReason: 'pending' }

test('工具开始即显示，展开后可读流式参数和最终参数错误', async ({ mount }) => {
  const running = { userMessageId: 'u', assistantMessageId: 'a', phase: 'model' } as const
  const message: Message = { ...base, content: [{ type: 'toolCall', id: '', name: '', arguments: {} }] }
  const component = await mount(<AssistantMessage messages={[{ id: 'a', message }]} running={running} activeContent={[{ messageId: 'a', contentIndex: 0, type: 'toolCall', argumentsText: '{"city":' }]} />)
  await component.getByText('工具调用', { exact: true }).click()
  await expect(component.locator('pre')).toBeVisible()
  await expect(component.locator('pre')).toHaveText('{"city":')
  await component.update(<AssistantMessage messages={[{ id: 'a', message: { ...message, content: [{ type: 'toolCall', id: 'call', name: 'weather', arguments: {}, argumentsError: '参数 JSON 无效，原文：{"city":' }], stopReason: 'toolUse' } }]} running={running} />)
  await expect(component.getByText('weather')).toBeVisible()
  await expect(component.getByText('参数 JSON 无效，原文：{"city":')).toBeVisible()
})

test('Markdown GFM 流式尾部更新、最终引用校准与恶意内容隔离', async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  const initial = '# 标题\n\n[引用][ref]\n\n第三段\n\n**尚未完成'
  const component = await mount(<div style={{ width: 280 }}><MarkdownText text={initial} streaming /></div>)
  const heading = await component.getByRole('heading', { name: '标题' }).elementHandle()
  const final = initial + '**\n\n| 字段 | 值 |\n| --- | --- |\n| a | b |\n\n- [x] 完成\n\n~~删除~~\n\n```js\n<script>window.injected = true</script>\n```\n\n[安全](https://example.com) [恶意](javascript:alert%281%29) ![危险图片](data:image/svg+xml,x)\n\n<img src=x onerror="window.injected = true">\n\n[ref]: https://example.com/ref'
  await component.update(<div style={{ width: 280 }}><MarkdownText text={final} streaming /></div>)
  expect(await component.getByRole('heading', { name: '标题' }).evaluate((element, old) => element === old, heading)).toBe(true)
  await expect(component.locator('strong')).toHaveText('尚未完成')
  await expect(component.getByRole('table')).toBeVisible()
  await expect(component.getByRole('checkbox')).toBeChecked()
  await expect(component.locator('del')).toHaveText('删除')
  await expect(component.getByRole('link', { name: '恶意' })).toHaveCount(0)
  await expect(component.locator('script,img,[onerror]')).toHaveCount(0)
  await expect(component.getByRole('link', { name: '安全' })).toHaveAttribute('rel', 'noopener noreferrer')
  expect(await page.evaluate(() => 'injected' in window)).toBe(false)
  await component.update(<div style={{ width: 280 }}><MarkdownText text={final} /></div>)
  await expect(component.getByRole('link', { name: '引用' })).toHaveAttribute('href', 'https://example.com/ref')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('终止状态保留正文，正常的工具阶段没有报错提示', async ({ mount }) => {
  const component = await mount(<AssistantMessage messages={[{ id: 'a', message: base }]} />)
  await expect(component).toHaveText('')
  for (const [stopReason, status] of [['stop', ''], ['length', '达到长度限制，回答可能不完整'], ['toolUse', ''], ['error', '实际错误'], ['aborted', '回答已中止']] as const) {
    await component.update(<AssistantMessage messages={[{ id: 'a', message: { ...base, content: [{ type: 'text', text: '保留正文' }], stopReason, errorMessage: stopReason === 'error' ? '实际错误' : undefined } }]} />)
    await expect(component.getByText('保留正文')).toBeVisible()
    if (status) await expect(component.getByText(status)).toBeVisible()
    else await expect(component.locator('.message-ending')).toHaveCount(0)
  }
})
