import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebServer } from '@agent-learning/server'
import type { ToolCall } from '@agent-learning/model'
import { expect, test } from './chinese-fixture'
import { readLiveKey } from './live-key'
import { addWorkspace, authorize, observe, openSession, saveKey } from './test-utils'

const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
const example = 'pi/packages/coding-agent/examples/extensions/protected-paths.ts'
const key = (name: string) => name === '.env' ? 'DEMO' : 'README_DEMO'

test('Feature 4 06/19：原版 Pi 扩展在网页真模任务拦截、允许和停用文件编辑', async ({ page }, testInfo) => {
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  test.setTimeout(300_000)
  const root = await mkdtemp(join(tmpdir(), 'si-hooks-live-'))
  const cwd = join(root, 'workspace')
  const directory = join(root, 'extensions')
  const installed = join(directory, 'protected-paths.ts')
  const checkout = fileURLToPath(new URL('../../../', import.meta.url))
  const upstream = process.env.PI_PROTECTED_PATHS_FILE ?? join(dirname(execFileSync('git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: checkout, encoding: 'utf8' }).trim()), example)
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, skillHome: join(root, 'home'),
    extensionsDirectory: directory, globalContextDirectory: root,
    browserSecretPath: join(root, 'browser.json'), modelAuthPath: join(root, 'auth.json'),
    sessionPath: join(root, 'sessions.sqlite'), workspacePath: join(root, 'workspaces.json'),
    webSettingsPath: join(root, 'settings.json'),
  })
  try {
    await mkdir(cwd)
    await mkdir(directory)
    await copyFile(upstream, installed)
    await writeFile(join(cwd, '.env'), 'DEMO=before\n')
    await writeFile(join(cwd, 'README.md'), 'README_DEMO=before\n')
    const observed = observe(page)
    const send = async (files: string[]) => {
      const position = observed.updates.length
      const message = page.getByRole('textbox', { name: '消息', exact: true })
      await message.fill(`这是一次本地文件编辑测试。只用 edit 工具，分别修改 ${files.map(name => `${name} 中的 ${key(name)}=before → ${key(name)}=after`).join('，以及 ')}。请实际对每个目标发出 edit 调用。若被拒绝，报告原因，继续其余目标，禁止用 bash 或 write 绕开。`)
      const button = page.getByRole('button', { name: '发送', exact: true })
      await expect(button).toBeEnabled()
      await button.click()
      await expect.poll(() => observed.updates.slice(position).some(({ update: { change } }) =>
        change.type === 'task' && change.running === null), { timeout: 120_000 }).toBe(true)
      const changes = observed.updates.slice(position).map(item => item.update.change)
      const calls = changes.flatMap(change => change.type === 'model' && change.event.type === 'done'
        ? change.event.message.content.filter((block): block is ToolCall => block.type === 'toolCall' && block.name === 'edit') : [])
      const results = changes.flatMap(change => change.type === 'task' && change.message?.message.role === 'toolResult'
        ? [{ ...change.message, message: change.message.message }] : [])
      return (name: string) => {
        const call = calls.find(item => typeof item.arguments.path === 'string' &&
          (item.arguments.path === name || item.arguments.path.endsWith('/' + name)))
        expect(call, '模型实际发出了 edit ' + name).toBeDefined()
        const result = results.find(item => item.message.toolCallId === call!.id)
        expect(result, '同编号的工具结果').toBeDefined()
        return result!
      }
    }
    await authorize(page, (await server.start()).authUrl)
    await addWorkspace(page)
    await saveKey(page, await readLiveKey(keyFile!))
    const enabled = await send(['.env', 'README.md'])
    const blocked = enabled('.env')
    expect(blocked.toolErrorCode).toBe('hook_blocked')
    expect(blocked.message).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('is protected') }] })
    expect(blocked.fileOperation).toBeUndefined()
    const allowed = enabled('README.md')
    expect(allowed.message.isError).toBe(false)
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('DEMO=before\n')
    expect(await readFile(join(cwd, 'README.md'), 'utf8')).toBe('README_DEMO=after\n')

    const sessionId = (await page.locator('.chat-page').getAttribute('data-session-id'))!
    await server.close()
    await rename(installed, join(root, 'protected-paths.ts.disabled'))
    await authorize(page, (await server.start()).authUrl)
    await openSession(page, observed, sessionId)
    const disabled = (await send(['.env']))('.env')
    expect(disabled.message.isError).toBe(false)
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('DEMO=after\n')
    await testInfo.attach('feature4-file-effects', { contentType: 'application/json', body: JSON.stringify({
      blocked: { id: blocked.message.toolCallId, reason: blocked.message.content, after: 'DEMO=before' },
      allowed: { id: allowed.message.toolCallId, after: 'README_DEMO=after' },
      disabled: { id: disabled.message.toolCallId, after: 'DEMO=after' },
    }) })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
