import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import { expect, test } from './chinese-fixture'
import { addWorkspace, authorize, observe, saveKey } from './test-utils'

test('Feature 4 草稿和正式会话处理 ping，正式工具卡使用实际编辑路径和最终结果', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'si-web-hooks-'))
  const cwd = join(root, 'workspace'), extensions = join(root, 'extensions')
  const requests: string[] = []
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, skillHome: join(root, 'home'), globalContextDirectory: root,
    modelAuthPath: join(root, 'auth.json'), browserSecretPath: join(root, 'browser.json'),
    sessionPath: join(root, 'sessions.sqlite'), workspacePath: join(root, 'workspaces.json'), webSettingsPath: join(root, 'settings.json'),
    modelOptions: { fetch: async (_url, options) => {
      requests.push(String(options?.body))
      const first = requests.length === 1
      const delta = first ? { tool_calls: [{ index: 0, id: 'edit-1', function: { name: 'edit',
        arguments: JSON.stringify({ path: 'original.txt', edits: [{ oldText: 'before', newText: 'after' }] }) } }] } : { content: '完成' }
      const chunk = { id: 'test', model: 'deepseek-flash', created: 1, choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] }
      return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } },
  })
  try {
    await mkdir(cwd)
    await mkdir(extensions)
    await writeFile(join(cwd, 'actual.txt'), 'before\n')
    await writeFile(join(extensions, 'session.ts'), `
      export default si => {
        let pings = 0
        si.on('input', ({ text }, ctx) => {
          if (text === 'ping') { ctx.ui.notify('pong ' + ++pings); return { action: 'handled' } }
          return { action: 'transform', text: '正式文本' }
        })
        si.on('before_agent_start', () => ({
          message: { customType: 'test', content: '隐藏附加指令', display: false }
        }))
        si.on('tool_call', event => { event.input.path = 'actual.txt' })
        si.on('tool_result', () => ({ isError: true, content: [{ type: 'text', text: '扩展改写结果' }] }))
      }
    `)
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await addWorkspace(page)
    await saveKey(page, 'placeholder-local-fixture')
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const button = page.getByRole('button', { name: '发送', exact: true })
    const send = async (text: string) => { await input.fill(text); await expect(button).toBeEnabled(); await button.click() }

    await send('ping')
    await expect(page.getByText('pong 1', { exact: true })).toBeVisible()
    await expect(input).toHaveText('')
    await expect(page.getByRole('button', { name: '会话 1', exact: true })).toHaveCount(0)
    expect(requests).toHaveLength(0)

    await send('原始文本')
    await expect.poll(() => observed.updates.some(({ update: { change } }) =>
      change.type === 'task' && change.running === null) || observed.snapshots.some(({ snapshot }) =>
      snapshot.running === null && snapshot.messages.some(entry => entry.message.role === 'assistant' && entry.message.stopReason === 'stop'))).toBe(true)
    await expect(page.getByText('正式文本', { exact: true })).toBeVisible()
    await expect(page.getByText('隐藏附加指令', { exact: true })).toHaveCount(0)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain('隐藏附加指令')
    expect(requests[1]).toContain('扩展改写结果')
    expect(requests[1]).toContain('最终状态：失败')
    expect(await readFile(join(cwd, 'actual.txt'), 'utf8')).toBe('after\n')
    const card = page.locator('.tool-block').filter({ hasText: 'actual.txt' })
    await expect(card).toHaveCount(1)
    await expect(card.locator('[data-state="error"]')).toHaveCount(1)
    await expect(card).not.toContainText('original.txt')

    await send('ping')
    await expect(page.getByText('pong 2', { exact: true })).toBeVisible()
    await expect(page.getByText('ping', { exact: true })).toHaveCount(0)
    await expect(input).toHaveText('')
    expect(requests).toHaveLength(2)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
