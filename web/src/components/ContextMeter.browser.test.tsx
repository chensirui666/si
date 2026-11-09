import { expect, test } from '@playwright/experimental-ct-react'
import { ContextMeter } from './ContextMeter'
import { MessageInput } from './MessageInput'

const usage = { tokens: 27300, contextWindow: 1048576, breakdown: { systemTokens: 1600, toolsTokens: 6500, messageTokens: 13400 } }

test('悬停查看三类估算，压缩后立即下降，移出后关闭且不抢编辑焦点', async ({ mount, page }) => {
  const component = await mount(<div style={{ paddingTop: 240 }}><MessageInput sendDisabled={false} onSend={() => false} contextMeter={<ContextMeter usage={usage} />} /></div>)
  const editor = component.getByRole('textbox')
  await editor.focus()
  const meter = component.getByRole('button', { name: '对话容量 3%' })
  await meter.hover()
  const tooltip = component.getByRole('tooltip')
  await expect(tooltip).toContainText('~27,300 / 1,048,576 token')
  for (const name of ['系统提示词', '工具定义', '对话消息']) await expect(tooltip).toContainText(name)
  await expect(tooltip).toContainText('~6,500')
  await expect(editor).toBeFocused()
  await tooltip.hover()
  await expect(tooltip).toBeVisible()
  await component.update(<div style={{ paddingTop: 240 }}><MessageInput sendDisabled={false} onSend={() => false} contextMeter={<ContextMeter usage={{ ...usage, tokens: 5000 }} />} /></div>)
  await expect(tooltip).toContainText('~5,000 / 1,048,576 token')
  await page.mouse.move(5, 5)
  await expect(tooltip).toHaveCount(0)
})

test('键盘聚焦打开，Esc 关闭且保持焦点；缺少数据会关闭旧浮层', async ({ mount }) => {
  const component = await mount(<ContextMeter usage={usage} />)
  const button = component.getByRole('button')
  await button.focus()
  await expect(component.getByRole('tooltip')).toBeVisible()
  await button.press('Escape')
  await expect(component.getByRole('tooltip')).toHaveCount(0)
  await expect(button).toBeFocused()
  await component.update(<ContextMeter usage={{ breakdown: usage.breakdown }} />)
  await expect(component.getByRole('button')).toHaveCount(0)
  await expect(component).not.toContainText('0%')
  await component.update(<ContextMeter usage={usage} />)
  await expect(component.getByRole('tooltip')).toHaveCount(0)
})

test('真实零值显示 0% 且无已用色段，超量仍显示完整 token', async ({ mount }) => {
  const component = await mount(<ContextMeter usage={{ ...usage, tokens: 0 }} />)
  await expect(component.getByRole('button')).toHaveAccessibleName('对话容量 0%')
  await expect(component.locator('.context-ring-used')).toHaveCount(0)
  await component.update(<ContextMeter usage={{ ...usage, tokens: 1100000 }} />)
  await component.getByRole('button').hover()
  await expect(component.getByRole('button')).toHaveAccessibleName('对话容量 100%')
  await expect(component.getByRole('tooltip')).toContainText('~1,100,000 / 1,048,576 token')
})

test('390px 视口内完整显示分布且发送按钮不被遮挡', async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  const component = await mount(<div style={{ paddingTop: 240 }}><MessageInput sendDisabled={false} onSend={() => false} contextMeter={<ContextMeter usage={usage} />} /></div>)
  await component.getByRole('textbox').pressSequentially('下一条')
  await component.getByRole('button', { name: '对话容量 3%' }).hover()
  const panel = await component.getByRole('tooltip').boundingBox()
  const send = await component.getByRole('button', { name: '发送' }).boundingBox()
  expect(panel!.x).toBeGreaterThanOrEqual(0)
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390)
  expect(panel!.x + panel!.width <= send!.x || panel!.y + panel!.height <= send!.y).toBe(true)
  expect(panel!.y).toBeGreaterThanOrEqual(0)
  await expect(component.getByRole('button', { name: '发送' })).toBeEnabled()
})
