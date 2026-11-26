import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import type { SessionSummary } from '@agent-learning/server/protocol'
import { expect, test, type Page } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, saveKey } from './test-utils'

const permission = (page: Page) => page.locator('.composer-actions').getByRole('combobox', { name: '权限', exact: true })
async function select(page: Page, name: string, settings = false) {
  const picker = settings ? page.getByRole('dialog').getByRole('combobox', { name: '权限', exact: true }) : permission(page)
  await picker.click()
  await page.getByRole('option', { name, exact: true }).click()
  await expect(picker).toHaveText(name)
}

test('权限 17/23/24/29：草稿独立保存，同会话同步，服务重启恢复', async ({ page, context }) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-permission-browser-'))
  const cwd = join(temporary, 'workspace')
  const provider = await startModelServer()
  const options = {
    port: 0, sessionPath: join(temporary, 'sessions.sqlite'), directoryPicker: async () => cwd,
    skillHome: join(temporary, 'skill-home'), globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { baseURL: provider.baseURL },
  }
  const server = new WebServer(options)
  let restarted: WebServer | undefined
  try {
    await mkdir(cwd)
    const { url, authUrl } = await server.start()
    await authorize(page, authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    await expect(permission(page)).toHaveCount(1)
    await expect(permission(page)).toHaveText('普通')

    const create = await page.request.post(url + '/api/sessions', { data: { workspaceId }, headers: { Origin: url } })
    expect(create.status()).toBe(201)
    const original: SessionSummary = await create.json()
    await select(page, '只读')
    await page.reload()
    await expect(permission(page)).toHaveText('只读')
    const second = await context.newPage()
    await authorize(second, authUrl)
    await second.locator(`.workspace-conversation[data-session-id="${original.id}"]`).click()
    await expect(permission(second)).toHaveText('普通')

    await second.getByRole('button', { name: '设置', exact: true }).click()
    await expect(second.getByRole('dialog').getByRole('combobox', { name: '权限' })).toHaveText('普通')
    await select(second, '只读', true)
    await select(second, '普通', true)
    await second.keyboard.press('Escape')
    await expect(permission(page)).toHaveText('只读')
    await expect(permission(second)).toHaveText('普通')

    await page.getByRole('textbox', { name: '消息', exact: true }).fill('查看权限')
    const send = page.getByRole('button', { name: '发送', exact: true })
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    const first = provider.exchanges[0]!
    expect((first.body.tools as { function: { name: string } }[]).map(tool => tool.function.name).sort()).toEqual(['ask_user_question', 'find', 'grep', 'ls', 'read', 'subagent'])
    first.delta({ content: '只读已确认' })
    first.finish()
    await expect(page.locator('.message-list')).toContainText('只读已确认')
    const id = await page.locator('.chat-page').getAttribute('data-session-id')
    expect(id).toBeTruthy()
    await second.locator(`.workspace-conversation[data-session-id="${id}"]`).click()
    await expect(permission(second)).toHaveText('只读')
    await select(second, '普通')
    await expect(permission(page)).toHaveText('普通')
    await page.reload()
    await expect(permission(page)).toHaveText('普通')

    await second.getByRole('button', { name: '设置', exact: true }).click()
    await select(second, '只读', true)
    await second.keyboard.press('Escape')
    await server.close()
    restarted = new WebServer(options)
    const resumed = await restarted.start()
    await authorize(page, resumed.authUrl)
    await page.locator(`.workspace-conversation[data-session-id="${original.id}"]`).click()
    await expect(permission(page)).toHaveText('普通')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('combobox', { name: '权限' })).toHaveText('只读')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '新建会话', exact: true }).click()
    await expect(permission(page)).toHaveText('只读')
    await authorize(second, resumed.authUrl)
    await second.getByRole('button', { name: '设置', exact: true }).click()
    await select(second, '普通', true)
    await second.keyboard.press('Escape')
    await expect(permission(page)).toHaveText('只读')
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('打开时默认只读')
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(2)
    const latest = provider.exchanges[1]!
    expect((latest.body.tools as { function: { name: string } }[]).map(tool => tool.function.name).sort()).toEqual(['ask_user_question', 'find', 'grep', 'ls', 'read', 'subagent'])
    latest.delta({ content: '原草稿使用只读' })
    latest.finish()
    await expect(page.locator('.message-list')).toContainText('原草稿使用只读')
    await page.locator('.sidebar-new-session').click()
    await expect(permission(page)).toHaveText('普通')
  } finally {
    await Promise.allSettled([server.close(), provider.close(), restarted?.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})
