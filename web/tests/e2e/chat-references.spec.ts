import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '@agent-learning/coding-agent'
import { expect, test } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, saveKey, startBackend, stop } from './test-utils'

test('15/17 引用失败保留草稿，重发后可以 read 发送时冻结的完整历史', async ({ page }) => {
  test.setTimeout(25_000)
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-chat-references-')))
  const provider = await startModelServer()
  const workspaceId = randomUUID()
  const sourceId = randomUUID()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  const name = '启动排查历史'
  const early = '早期决定：部署目标是青禾'
  const before = '发送前补充：入口端口是 8139'
  const after = '发送后补充：端口改为 8250'
  const reply = (index: number, text: string) => {
    provider.exchanges[index]!.delta({ content: text })
    provider.exchanges[index]!.finish()
  }
  try {
    await writeFile(join(directory, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: workspaceId, path: directory }] }), { mode: 0o600 })
    const store = SessionStore.open(join(directory, 'sessions.sqlite'))
    try {
      const runId = randomUUID()
      store.save(sourceId, {
        summary: { id: sourceId, workspaceId, name, createdAt: new Date().toISOString() },
        run: { id: runId, clientMessageId: runId, sessionId: sourceId, text: early, modelId: 'deepseek-flash',
          kind: 'task', status: 'completed', startedAt: 1, finishedAt: 3, acceptedSeq: 1 },
        messages: [
          { id: runId, clientMessageId: runId, message: { role: 'user', content: early, timestamp: 1 } },
          { id: randomUUID(), message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash',
            api: 'openai-completions', timestamp: 2, stopReason: 'stop', content: [{ type: 'text', text: '运行详情。'.repeat(29_000) }] } },
        ],
      })
    } finally { store.close() }

    backend = await startBackend(join(directory, 'browser-auth.json'), 0, provider.baseURL)
    const url = backend.result.url
    await authorize(page, backend.result.authUrl)
    expect(await addWorkspace(page)).toBe(workspaceId)
    await saveKey(page, 'controlled-stage3-key')
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const pendingRefs = page.getByRole('group', { name: '已引用会话', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    await input.fill('@')
    await page.getByRole('option', { name: 'Session · ' + name, exact: true }).click()
    await expect(pendingRefs).toContainText(name)
    const task = '请查找来源会话最早的决定和最近补充。'
    await input.fill(task)
    const firstPath = '/api/sessions/start'
    await page.route('**' + firstPath, route => {
      const body = route.request().postDataJSON()
      return route.continue({ postData: { ...body, referenceSessionIds: [randomUUID()] } })
    }, { times: 1 })
    const failed = page.waitForResponse(response => new URL(response.url()).pathname === firstPath)
    await expect(send).toBeEnabled()
    await send.click()
    expect((await failed).status()).toBe(400)
    await expect(page.getByRole('alert')).toContainText('无法读取引用会话')
    await expect(pendingRefs).toContainText(name)
    await expect(input).toHaveText(task)
    expect(provider.exchanges).toHaveLength(0)

    const appendSource = async (text: string) => {
      const response = await page.request.post(url + '/api/messages', { data: {
        sessionId: sourceId, clientMessageId: randomUUID(), provider: 'deepseek', modelId: 'deepseek-flash',
        reasoningEffort: 'high', text,
      } })
      expect(response.status()).toBe(202)
    }
    await appendSource(before)
    await expect.poll(() => provider.exchanges.length).toBe(1)
    reply(0, '已记录此次入口端口。')
    await expect.poll(() => provider.exchanges[0]?.closed).toBe(true)
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === firstPath)
    await send.click()
    expect((await accepted).status()).toBe(202)
    await expect.poll(() => provider.exchanges.length).toBe(2)
    const first = provider.exchanges[1]!
    const content = first.body.messages.at(-1)?.content
    expect(typeof content).toBe('string')
    const excerpt = JSON.parse(String(content).split('\n').find(line => line.startsWith('{"sourceSessionId"'))!)
    expect(excerpt).toMatchObject({ sourceSessionId: sourceId, snapshot: { status: 'saved' } })
    expect(JSON.stringify(excerpt.excerpt)).toContain(before)
    expect(JSON.stringify(excerpt.excerpt)).not.toContain(early)
    expect(excerpt.omitted.bytes).toBeGreaterThan(0)
    const snapshot = excerpt.snapshot.path as string

    await appendSource(after)
    await expect.poll(() => provider.exchanges.length).toBe(3)
    reply(2, '已记录更新后的端口。')
    expect(await readFile(snapshot, 'utf8')).not.toContain(after)

    first.delta({ tool_calls: [3, 9].map((offset, index) => ({
      index, id: 'read-reference-' + index, type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: snapshot, offset, limit: 2 }) },
    })) })
    first.finish('tool_calls')
    await expect.poll(() => provider.exchanges.length).toBe(4)
    expect(provider.exchanges[3]!.body.messages.slice(-2)).toMatchObject([
      { role: 'tool', content: expect.stringContaining(early) },
      { role: 'tool', content: expect.stringContaining(before) },
    ])
    reply(3, '部署目标是青禾，发送时的入口端口是 8139。')
    await expect(page.getByText('部署目标是青禾，发送时的入口端口是 8139。', { exact: true })).toBeVisible()
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(directory, { recursive: true, force: true })
  }
})
