import { expect, test } from '@playwright/experimental-ct-react'

import { MessageInputHarness } from '../test/MessageInputHarness'

const original = '  第一行\n\n    第二行  \n'

for (const method of ['逐字输入', '粘贴'] as const) {
  for (const suffix of ['', '最后几个字']) {
    test(`${method}后立即提交原文${suffix ? '，包含最后几个字' : ''}`, async ({ mount, page, context }) => {
      const component = await mount(<MessageInputHarness />)
      const textbox = component.getByRole('textbox', { name: '消息' })
      await textbox.focus()

      if (method === '逐字输入') {
        const lines = original.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          if (index > 0) await textbox.press('Shift+Enter')
          await textbox.pressSequentially(lines[index])
        }
      } else {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.evaluate((text) => navigator.clipboard.writeText(text), original)
        await textbox.press('ControlOrMeta+v')
      }
      if (suffix) await textbox.pressSequentially(suffix)
      await textbox.press('Enter')

      await expect.poll(async () => JSON.parse((await component.getByLabel('已提交原文').textContent())!))
        .toEqual([original + suffix])
      await expect(textbox).toHaveText('')
    })
  }
}

test('发送成功后隔离撤销历史', async ({ mount }) => {
  const component = await mount(<MessageInputHarness />)
  const textbox = component.getByRole('textbox', { name: '消息' })
  await textbox.pressSequentially('待发送内容')

  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('')
  await textbox.press('ControlOrMeta+Shift+z')
  await expect(textbox).toHaveText('待发送内容')
  await textbox.press('Enter')
  await expect(textbox).toHaveText('')
  await expect(component.getByLabel('已提交原文')).toHaveText('["待发送内容"]')

  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('')
  await textbox.pressSequentially('新的草稿')
  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('')
  await expect(component.getByLabel('已提交原文')).toHaveText('["待发送内容"]')
})

test('外部门禁切换保留编辑器、原文、焦点与撤销，恢复后可提交原草稿', async ({ mount }) => {
  const component = await mount(<MessageInputHarness sendDisabled />)
  const textbox = component.getByRole('textbox', { name: '消息' })
  const originalEditor = await textbox.elementHandle()
  await textbox.pressSequentially('draft')
  await textbox.press('Shift+Enter')
  await textbox.pressSequentially('tail')
  await expect(component.getByRole('button', { name: '发送' })).toBeDisabled()
  await textbox.press('Enter')
  await expect(component.getByLabel('已提交原文')).toHaveText('[]')
  await expect(textbox).toHaveText('drafttail')
  await expect(textbox).toBeFocused()

  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('draft')
  await textbox.press('ControlOrMeta+Shift+z')
  await expect(textbox).toHaveText('drafttail')

  await component.update(<MessageInputHarness sendDisabled={false} />)
  expect(await textbox.evaluate((element, previous) => element === previous, originalEditor)).toBe(true)
  await expect(textbox).toBeFocused()
  await expect(textbox).toHaveText('drafttail')
  await expect(component.getByRole('button', { name: '发送' })).toBeEnabled()
  await textbox.press('Enter')
  await expect(component.getByLabel('已提交原文')).toHaveText('["draft\\ntail"]')
  await expect(textbox).toHaveText('')
  await expect(textbox).toBeFocused()
})

test('Enter 接收报错后仍可撤销和继续逐字编辑', async ({ mount, page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => { errors.push(error.message) })
  const component = await mount(<MessageInputHarness throwOnSend />)
  const textbox = component.getByRole('textbox', { name: '消息' })
  await textbox.pressSequentially('draft')
  await textbox.press('Shift+Enter')
  await textbox.pressSequentially('tail')

  await textbox.press('Enter')

  await expect.poll(() => errors).toEqual(['reject'])
  await expect.poll(async () => JSON.parse((await component.getByLabel('已提交原文').textContent())!))
    .toEqual(['draft\ntail'])
  expect(await textbox.textContent()).toBe('drafttail')
  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('draft')
  await textbox.pressSequentially('XY')
  await expect(textbox).toHaveText('draftXY')
  expect(errors).toEqual(['reject'])
})
