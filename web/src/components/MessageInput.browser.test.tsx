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

test('发送、中止和正在中止切换保留同一编辑器、草稿、焦点和撤销记录', async ({ mount }) => {
  const component = await mount(<MessageInputHarness />)
  const textbox = component.getByRole('textbox', { name: '消息' })
  const original = await textbox.elementHandle()
  await textbox.pressSequentially('draft')
  await textbox.press('Shift+Enter')
  await textbox.pressSequentially('tail')
  for (const action of ['abort', 'aborting'] as const) {
    await component.update(<MessageInputHarness action={action} sendDisabled />)
    expect(await textbox.evaluate((element, previous) => element === previous, original)).toBe(true)
    await expect(textbox).toBeFocused()
    await expect(textbox).toHaveText('drafttail')
    await textbox.press('Enter')
    await expect(component.getByLabel('已提交原文')).toHaveText('[]')
    const button = component.getByRole('button', { name: action === 'abort' ? '中止' : '正在中止', exact: true })
    if (action === 'abort') {
      await expect(button).toBeEnabled()
      await button.click()
      await expect(component.getByLabel('中止次数')).toHaveText('1')
      await textbox.focus()
    } else await expect(button).toBeDisabled()
  }
  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('draft')
  await textbox.press('ControlOrMeta+Shift+z')
  await expect(textbox).toHaveText('drafttail')
  await component.update(<MessageInputHarness />)
  await textbox.press('Enter')
  await expect(component.getByLabel('已提交原文')).toHaveText('["draft\\ntail"]')
})

for (const method of ['click', 'Tab', 'Enter'] as const) {
  test(`命令前缀通过 ${method} 仅补全，下一次 Enter 才发送`, async ({ mount }) => {
    const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness /></div>)
    const textbox = component.getByRole('textbox', { name: '消息' })
    await textbox.pressSequentially('/co')
    const option = component.getByRole('option', { name: /compact/ })
    await expect(option).toBeVisible()
    await expect(option).toHaveAttribute('aria-selected', 'true')
    if (method === 'click') await option.click()
    else await textbox.press(method)
    await expect(textbox).toHaveText('/compact')
    await expect(textbox).toBeFocused()
    await expect(component.getByRole('listbox')).toHaveCount(0)
    await expect(component.getByLabel('已提交原文')).toHaveText('[]')
    await textbox.press('Enter')
    await expect(component.getByLabel('已提交原文')).toHaveText('["/compact"]')
    await expect(textbox).toHaveText('')
  })
}

test('补全保留撤销与重做，Esc 关闭保留前缀且普通重渲染不重开', async ({ mount }) => {
  const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness /></div>)
  const textbox = component.getByRole('textbox', { name: '消息' })
  await textbox.pressSequentially('/co')
  await textbox.press('Tab')
  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('/co')
  await textbox.press('ControlOrMeta+Shift+z')
  await expect(textbox).toHaveText('/compact')
  await textbox.press('ControlOrMeta+a')
  await textbox.pressSequentially('/co')
  await textbox.press('Escape')
  await expect(component.getByRole('listbox')).toHaveCount(0)
  await expect(textbox).toHaveText('/co')
  await component.update(<div style={{ paddingTop: 180 }}><MessageInputHarness accept={false} /></div>)
  await expect(component.getByRole('listbox')).toHaveCount(0)
  await expect(component.getByLabel('已提交原文')).toHaveText('[]')
})

for (const text of ['请读取 src/index.txt', '/unknown']) {
  test(`普通内容 ${text} 没有命令候选且 Tab 正常移焦`, async ({ mount }) => {
    const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness /></div>)
    const textbox = component.getByRole('textbox', { name: '消息' })
    await textbox.pressSequentially(text)
    await expect(component.getByRole('listbox')).toHaveCount(0)
    await textbox.press('Tab')
    await expect(component.getByRole('button', { name: '发送' })).toBeFocused()
    await expect(textbox).toHaveText(text)
    await expect(component.getByLabel('已提交原文')).toHaveText('[]')
  })
}

test('任务忙碌时仍能补全，失焦关闭菜单且不发送', async ({ mount, page }) => {
  const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness sendDisabled action="abort" /></div>)
  const textbox = component.getByRole('textbox', { name: '消息' })
  await textbox.pressSequentially('/')
  await expect(component.getByRole('listbox')).toBeVisible()
  await page.getByLabel('已提交原文').click()
  await expect(component.getByRole('listbox')).toHaveCount(0)
  await expect(textbox).toHaveText('/')
  await textbox.click()
  await textbox.press('End')
  await textbox.pressSequentially('co')
  await textbox.press('Tab')
  await expect(textbox).toHaveText('/compact')
  await textbox.press('Enter')
  await expect(component.getByLabel('已提交原文')).toHaveText('[]')
})

test('Esc 关闭后清空并重新输入相同命令前缀会再次提供候选', async ({ mount }) => {
  const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness /></div>)
  const textbox = component.getByRole('textbox', { name: '消息' })
  await textbox.pressSequentially('/')
  await expect(component.getByRole('listbox')).toBeVisible()
  await textbox.press('Escape')
  await expect(component.getByRole('listbox')).toHaveCount(0)
  await textbox.press('Backspace')
  await textbox.pressSequentially('/')
  await expect(component.getByRole('option', { name: /compact/ })).toBeVisible()
  await expect(component.getByLabel('已提交原文')).toHaveText('[]')
})
