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
  const firstDraft = 'first draft'
  await textbox.pressSequentially(firstDraft)

  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('')
  await textbox.press('ControlOrMeta+Shift+z')
  await expect(textbox).toHaveText(firstDraft)
  await textbox.press('Enter')
  await expect(textbox).toHaveText('')
  await expect(component.getByLabel('已提交原文')).toHaveText(JSON.stringify([firstDraft]))

  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('')
  await textbox.pressSequentially('second draft')
  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('')
  await expect(component.getByLabel('已提交原文')).toHaveText(JSON.stringify([firstDraft]))
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
  test(`命令前缀通过 ${method} 直接执行压缩`, async ({ mount }) => {
    const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness /></div>)
    const textbox = component.getByRole('textbox', { name: '消息' })
    await textbox.pressSequentially('/co')
    const option = component.getByRole('option', { name: /compact/ })
    await expect(option).toBeVisible()
    await expect(option).toHaveAttribute('aria-selected', 'true')
    if (method === 'click') await option.click()
    else await textbox.press(method)
    await expect(component.getByLabel('已提交原文')).toHaveText('["/compact"]')
    await expect(textbox).toHaveText('')
    await expect(textbox).toBeFocused()
    await expect(component.getByRole('listbox')).toHaveCount(0)
    await textbox.press('Enter')
    await expect(component.getByLabel('已提交原文')).toHaveText('["/compact"]')
  })
}

test('Esc 关闭保留前缀且普通重渲染不重开', async ({ mount }) => {
  const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness /></div>)
  const textbox = component.getByRole('textbox', { name: '消息' })
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

test('任务忙碌时保留压缩草稿，确认动作无法提交', async ({ mount }) => {
  const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness sendDisabled action="abort" /></div>)
  const textbox = component.getByRole('textbox', { name: '消息' })
  await textbox.pressSequentially('/co')
  await expect(component.getByRole('option', { name: /compact/ })).toHaveCount(0)
  await textbox.press('Enter')
  await expect(textbox).toHaveText('/co')
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

test('技能 08–14：目录按工作区加载，分组、来源、Tab、鼠标、输入法和失败反馈', async ({ mount, page }) => {
  let releaseA!: () => void
  const slow = new Promise<void>(resolve => { releaseA = resolve })
  await page.route('**/api/workspaces/*/skills', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    if (id === 'a') await slow
    if (id === 'broken') { await route.fulfill({ status: 500, json: { error: '目录暂不可用' } }); return }
    await route.fulfill({ json: { complete: true, skills: [
      { name: `review-${id}`, description: '检查修改', source: 'project-si', disableModelInvocation: false },
      { name: 'manual', description: '人工使用', source: 'bundled', disableModelInvocation: true },
      { name: 'custom', description: '个人说明', source: 'user-si', disableModelInvocation: false },
    ] } }).catch(() => {})
  })
  const component = await mount(<div style={{ paddingTop: 240 }}><MessageInputHarness skillWorkspaceId="a" /></div>)
  const textbox = component.getByRole('textbox', { name: '消息' })
  const requested = page.waitForRequest('**/api/workspaces/a/skills')
  await textbox.pressSequentially('/')
  await requested
  await component.update(<div style={{ paddingTop: 240 }}><MessageInputHarness skillWorkspaceId="b" /></div>)
  const review = component.getByRole('option', { name: /review-b/ })
  await expect(review).toContainText('项目')
  await expect(component.getByRole('option', { name: /manual/ })).toContainText('预置')
  await expect(component.getByRole('option', { name: /custom/ })).toContainText('个人')
  await expect(component.getByRole('group', { name: '命令', exact: true })).toContainText('/compact')
  await expect(component.getByRole('group', { name: '技能', exact: true })).toContainText('review-b')
  releaseA()
  await expect(component.getByRole('option', { name: /review-a/ })).toHaveCount(0)
  await expect(textbox).toHaveText('/')
  await textbox.press('ArrowDown')
  await textbox.press('Tab')
  expect(await textbox.textContent()).toBe('/skill:review-b ')
  await expect(textbox).toBeFocused()
  await expect(component.getByLabel('已提交原文')).toHaveText('[]')

  await textbox.fill('/rev')
  await review.click()
  expect(await textbox.textContent()).toBe('/skill:review-b ')
  await expect(textbox.locator('[style*="--skill-prefix-color"]')).toHaveText('/skill:review-b')
  await expect(textbox.locator('[style*="--skill-prefix-color"]')).toHaveCSS('color', 'rgb(37, 84, 199)')
  await expect(component.getByLabel('已提交原文')).toHaveText('[]')
  await textbox.press('ControlOrMeta+z')
  await expect(textbox).toHaveText('/rev')
  await textbox.press('ControlOrMeta+Shift+z')
  await expect(textbox.locator('[style*="--skill-prefix-color"]')).toHaveText('/skill:review-b')
  await textbox.pressSequentially('inspect')
  await expect(textbox).toHaveText('/skill:review-b inspect')
  await expect(textbox.locator('[style*="--skill-prefix-color"]')).toHaveText('/skill:review-b')
  await textbox.press('Enter')
  await expect(component.getByLabel('已提交原文')).toHaveText('["/skill:review-b inspect"]')

  await component.update(<div style={{ paddingTop: 240 }}><MessageInputHarness skillWorkspaceId="broken" /></div>)
  await textbox.fill('/')
  await expect(component.getByText(/目录暂不可用/)).toBeVisible()
  await component.getByRole('option', { name: /compact/ }).click()
  await expect(textbox).toHaveText('')
  await expect(component.getByLabel('已提交原文')).toHaveText('["/skill:review-b inspect","/compact"]')

  await component.update(<div style={{ paddingTop: 240 }}><MessageInputHarness skillWorkspaceId="b" /></div>)
  await textbox.fill('/')
  await expect(review).toBeVisible()
  await textbox.dispatchEvent('compositionstart')
  await textbox.press('Enter')
  await expect(textbox).toHaveText('/')
  await expect(component.getByLabel('已提交原文')).toHaveText('["/skill:review-b inspect","/compact"]')
  await textbox.dispatchEvent('compositionend')
})

test('添加菜单只含文件与计划，选择计划保留正文并在发送时生效', async ({ mount, page }) => {
  const component = await mount(<div style={{ paddingTop: 180 }}><MessageInputHarness plan="available" /></div>)
  const editor = component.getByRole('textbox', { name: '消息' })
  const add = component.getByRole('button', { name: '添加', exact: true })
  const menu = component.getByRole('menu', { name: '添加' })
  const submitted = component.getByLabel('已提交原文')
  await editor.fill('读一下 README')
  await add.click()
  await expect(menu.getByRole('menuitem')).toHaveText(['添加文件', '计划模式'])
  const files = menu.getByRole('menuitem', { name: '添加文件' })
  await expect(files).toBeFocused()
  await files.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: '计划模式' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(add).toBeFocused()

  await add.click()
  const choosing = page.waitForEvent('filechooser')
  await files.click()
  await (await choosing).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('note') })
  await expect(submitted).toHaveText('["notes.txt"]')
  await add.click()
  await menu.getByRole('menuitem', { name: '计划模式' }).click()
  await expect(menu).toBeHidden()
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('/plan 读一下 README')
  await expect(component.getByRole('button', { name: '退出计划模式' })).toHaveCount(0)
  await expect(submitted).toHaveText('["notes.txt"]')
  await editor.press('Enter')
  await expect(submitted).toHaveText('["notes.txt","/plan 读一下 README"]')
})

test('运行中可点 Plan × 或手输退出，均与中止及发送正文独立', async ({ mount }) => {
  const component = await mount(<MessageInputHarness plan="active" sendDisabled action="abort" />)
  const editor = component.getByRole('textbox', { name: '消息' })
  await expect(editor).toHaveAttribute('aria-placeholder', '描述你的任务以生成计划…')
  await editor.fill('下一条消息')
  await component.getByRole('button', { name: '退出计划模式' }).click()
  await expect(editor).toHaveText('下一条消息')
  await expect(component.getByLabel('已提交原文')).toHaveText('["exit"]')
  await editor.fill('/plan   off')
  await editor.press('Enter')
  await expect(component.getByLabel('已提交原文')).toHaveText('["exit","/plan   off"]')
  await expect(component.getByLabel('中止次数')).toHaveText('0')
})
