import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import { expect, test } from '@playwright/test'
import { readLiveKey } from './live-key'
import { addWorkspace, authorize, saveKey } from './test-utils'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('Feature9 live 20：网页首发使用项目说明里的随机标记', async ({ page, context }, testInfo) => {
  test.setTimeout(180_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const key = await readLiveKey(keyFile!)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature9-live-'))
  const cwd = join(await realpath(temporary), 'workspace')
  const path = join(cwd, 'AGENTS.md')
  const marker = 'project-' + randomUUID()
  const task = '项目标记已提供在本轮项目说明里。直接使用说明中的值，只输出标记。不要调用工具。'
  const instruction = '项目标记为 ' + marker + '。回答项目标记时，直接使用这份说明里的值。'
  const source = `<project_instructions path=${JSON.stringify(path)}>\n${instruction}\n</project_instructions>`
  const expectedContext = `<project_context>\n${source}\n</project_context>`
  let correctContext = false
  const requests: { model: string; messages: { role: string; content: string }[] }[] = []
  const server = new WebServer({
    port: 0, sessionPath: join(temporary, 'sessions.sqlite'), directoryPicker: async () => cwd, globalContextDirectory: join(temporary, 'global'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => {
      const request = JSON.parse(String(init?.body)) as typeof requests[number]
      requests.push(request)
      const system = request.messages[0]
      const sections = system?.role === 'system' ? system.content.match(/<project_context>[\s\S]*?<\/project_context>/g) : null
      correctContext = sections?.length === 1 && sections[0] === expectedContext
      if (!correctContext) return new Response('真实验收只允许发送测试项目说明', { status: 400 })
      return globalThis.fetch(url, init)
    } },
  })
  try {
    await mkdir(cwd)
    await writeFile(path, instruction)
    await authorize(page, (await server.start()).authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, key)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(task)
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/start')
    const send = page.getByRole('button', { name: '发送', exact: true })
    await send.click()
    const receipt = await accepted
    expect(receipt.status()).toBe(202)
    expect(await receipt.json()).toMatchObject({ session: { workspaceId } })
    await expect.poll(() => requests.length).toBeGreaterThan(0)
    expect(correctContext, '出站说明应只有测试文件').toBe(true)
    const messages = page.getByRole('region', { name: '消息列表' })
    const answer = messages.getByText(marker, { exact: true })
    await expect(answer).toBeVisible({ timeout: 120_000 })
    await expect(send).toBeVisible()
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.messages.slice(1)).toEqual([{ role: 'user', content: task }])
    await testInfo.attach('feature9-live-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({ model: request.model, requestCount: requests.length, source, task, answer: await answer.textContent() }),
    })
  } finally {
    await Promise.allSettled([context.clearCookies(), server.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})
