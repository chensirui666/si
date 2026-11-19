import { test, expect } from '@playwright/experimental-ct-react'
import type { AssistantMessage as Message } from '@agent-learning/model'
import { AssistantMessage } from './AssistantMessage'
import { MarkdownText } from './markdown/MarkdownText'

const base: Message = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, content: [], stopReason: 'pending' }

test('工具开始即显示，展开后可读流式参数和最终参数错误', async ({ mount }) => {
  const running = { kind: 'task' as const, runId: 'u', assistantMessageId: 'a', phase: 'model' as const, activeTools: [] }
  const message: Message = { ...base, content: [{ type: 'toolCall', id: '', name: '', arguments: {} }] }
  const component = await mount(<AssistantMessage messages={[{ id: 'a', message }]} running={running} activeContent={[{ messageId: 'a', contentIndex: 0, type: 'toolCall', argumentsText: '{"city":' }]} />)
  await component.getByText('工具调用', { exact: true }).click()
  await expect(component.locator('pre')).toBeVisible()
  await expect(component.locator('pre')).toHaveText('{"city":')
  await expect(component.locator('pre')).toHaveCSS('font-family', /^ui-monospace,.*Noto Sans Mono CJK SC/)
  await expect(component.locator('pre')).toHaveCSS('font-size', '14px')
  await expect(component.locator('pre')).toHaveCSS('line-height', '22px')
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
  for (const [stopReason, status] of [['stop', ''], ['length', '达到长度限制，回答可能不完整'], ['toolUse', ''], ['error', '实际错误'], ['aborted', '已停止 · 本轮已取消']] as const) {
    await component.update(<AssistantMessage messages={[{ id: 'a', message: { ...base, content: [{ type: 'text', text: '保留正文' }], stopReason, errorMessage: stopReason === 'error' ? '实际错误' : undefined } }]} />)
    await expect(component.getByText('保留正文')).toBeVisible()
    if (status) await expect(component.getByText(status)).toBeVisible()
    else await expect(component.locator('.message-ending')).toHaveCount(0)
  }
})

test('代码块显示语言并原样复制长代码', async ({ mount, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const code = `  const value = '${'x'.repeat(100)}'\n  console.log(value)`
  const component = await mount(<div style={{ width: 280 }}><MarkdownText text={'```ts\n' + code + '\n```'} /></div>)
  await expect(component.getByText('ts', { exact: true })).toBeVisible()
  await component.getByRole('button', { name: '复制', exact: true }).click()
  await expect(component.getByRole('button', { name: '已复制' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
  expect(await component.locator('pre').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
})

test('整条回复同时复制 Markdown 和富文本，剪贴板只包含回复正文', async ({ mount, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const first = '## 核对结果\n\n- **可读**\n\n```ts\n  const n = 1\n```'
  const last = '| 名称 | 数量 |\n| --- | ---: |\n| 项目 | 3 |'
  const component = await mount(<AssistantMessage messages={[
    { id: 'a', message: { ...base, stopReason: 'toolUse', content: [{ type: 'thinking', thinking: '内部执行过程' }, { type: 'text', text: first }] } },
    { id: 'b', message: { ...base, stopReason: 'stop', content: [{ type: 'text', text: last }] } },
  ]} />)
  await component.getByRole('button', { name: '复制整条回复', exact: true }).click()
  await expect(component.getByRole('button', { name: '已复制' })).toBeVisible()
  const result = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read()
    return { text: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() }
  })
  expect(result.text).toBe(first + '\n\n' + last)
  for (const tag of ['h2', 'ul', 'strong', 'pre', 'table']) expect(result.html).toContain('<' + tag)
  expect(result.html).not.toMatch(/内部执行过程|复制|<button/)
})

test('窄屏宽表保持独立滚动，支持原样复制和展开预览', async ({ mount, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 390, height: 700 })
  const table = '| 项目 | 类型 | 总 Star | 我的判断 |\n| --- | --- | ---: | --- |\n| `storytold/photocraft` | 图片编辑 | 79k | 一段会在窄屏正常折行的说明 |'
  const component = await mount(<div style={{ width: 290 }}><MarkdownText text={'## 榜单\n\n' + table} /></div>)
  const cell = component.getByRole('cell', { name: '79k' })
  await expect(cell).toHaveCSS('text-align', 'right')
  await expect(cell).toHaveCSS('vertical-align', 'top')
  await expect(cell).toHaveCSS('border-left-width', '0px')
  await expect(component.getByRole('columnheader', { name: '项目' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(component.locator('code wbr')).toHaveCount(1)
  await expect.poll(() => component.locator('.markdown-table-scroll').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await component.getByRole('table').hover()
  await component.getByRole('button', { name: '复制表格' }).click()
  await expect(component.getByRole('button', { name: '已复制' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(table)
  const expand = component.getByRole('button', { name: '展开表格' })
  await expand.click()
  const preview = page.getByRole('dialog', { name: '表格预览' })
  await expect(preview.getByRole('table')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
  await expect(expand).toBeFocused()

  await component.update(<div style={{ width: 290 }}><MarkdownText text={'## 短目录\n\n| 名称 | 类型 |\n| --- | --- |\n| .localized | 文件 |'} /></div>)
  await expect(component.getByRole('button', { name: '展开表格' })).toHaveCount(0)
})

test('增量渲染冻结前文后，表格仍复制对应的原始 Markdown', async ({ mount, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const prefix = '第一段\n\n第二段\n\n第三段\n\n'
  const table = '| 项目 | 判断 |\n| --- | --- |\n| `a/b` | **确认** |'
  const component = await mount(<MarkdownText text={prefix + '| 项目 | 判断 |'} streaming />)
  await component.update(<MarkdownText text={prefix + table + '\n\n尾段'} streaming />)
  await component.getByRole('table').hover()
  await component.getByRole('button', { name: '复制表格' }).click()
  await expect(component.getByRole('button', { name: '已复制' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(table)
})
