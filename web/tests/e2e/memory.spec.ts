import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import type { ProjectMemoriesView } from '@agent-learning/server/protocol'
import { expect, test, type Page } from './chinese-fixture'
import { readLiveKey } from './live-key'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, saveKey } from './test-utils'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function projectFixture(modelOptions: NonNullable<ConstructorParameters<typeof WebServer>[0]>['modelOptions']) {
  const temporary = await mkdtemp(join(tmpdir(), 'si-memory-e2e-'))
  const root = await realpath(temporary)
  const cwd = join(root, 'example-project')
  const memoryDirectory = join(root, 'memory')
  await mkdir(cwd)
  execFileSync('git', ['init', '-q', cwd])
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, modelOptions,
    sessionPath: join(root, 'sessions.sqlite'), workspacePath: join(root, 'workspaces.json'),
    skillHome: join(root, 'skills-home'), globalContextDirectory: join(root, 'global'), memoryDirectory,
    browserSecretPath: join(root, 'browser-auth.json'), modelAuthPath: join(root, 'auth.json'), webSettingsPath: join(root, 'settings.json'),
  })
  return { server, cwd, memoryDirectory, async close() { await server.close(); await rm(temporary, { force: true, recursive: true }) } }
}

async function submit(page: Page, text: string) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeEnabled()
  await send.click()
}

async function settledSession(observed: ReturnType<typeof observe>, start: number, timeout?: number) {
  const session = () => observed.updates.slice(start)
    .find(({ update }) => update.change.type === 'task' && update.change.running === null)?.sessionId
  await expect.poll(session, { timeout }).toBeTruthy()
  return session()!
}

async function projects(page: Page) {
  const result = await page.request.get(new URL('/api/memory/projects', page.url()).href)
  expect(result.status()).toBe(200)
  return (await result.json() as ProjectMemoriesView).projects
}

async function personalization(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '个性化', exact: true }).click()
  return settings
}

function diskProvenance(note: string, sessionId: string, submittedAt: number) {
  const header = note.split('\n---\n', 1)[0]!
  expect(header).toContain('type: session_write')
  expect(header).toContain('sessionId: ' + sessionId)
  expect(header).not.toContain('messageRef:')
  const savedAt = header.match(/^ +savedAt: (\S+)$/m)?.[1] ?? ''
  expect(Date.parse(savedAt)).toBeGreaterThanOrEqual(submittedAt)
  expect(Date.parse(savedAt)).toBeLessThanOrEqual(Date.now())
  return savedAt
}

test('记忆 19–21：网页保存个人摘要并进入新会话，在关闭时管理真实笔记，删除后目录消失', async ({ page }) => {
  const provider = await startModelServer()
  const fixture = await projectFixture({ baseURL: provider.baseURL })
  const personal = '## 说明顺序\n\n优先列出需要核对的内容。'
  const title = '测试环境'
  const summary = '集成测试使用专用测试库'
  const note = '运行集成测试前先核对数据库迁移。'
  const observed = observe(page)
  try {
    await authorize(page, (await fixture.server.start()).authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const settings = await personalization(page)
    await settings.getByRole('button', { name: '管理用户摘要' }).click()
    const personalDialog = page.getByRole('dialog', { name: '用户摘要', exact: true })
    await personalDialog.getByRole('textbox', { name: 'Markdown' }).fill(personal)
    await personalDialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(personalDialog.getByRole('status')).toContainText('摘要已保存')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    const submittedAt = Date.now()
    await submit(page, `今后${summary}。${note}`)
    await expect.poll(() => provider.exchanges.length).toBe(1)
    const first = provider.exchanges[0]!
    const system = String(first.body.messages[0]?.content)
    expect(system).toContain(personal)
    expect(system).not.toContain('本轮可引用的消息')
    expect(JSON.stringify(first.body.tools)).not.toContain('sourceMessageIds')
    first.delta({ tool_calls: [{ index: 0, id: 'save-memory', type: 'function', function: { name: 'memory', arguments: JSON.stringify({
      scope: 'project', operation: 'write', type: 'feedback', title, summary, content: note,
    }) } }] })
    first.finish('tool_calls')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    expect(provider.exchanges[1]?.body.messages.at(-1)).toMatchObject({
      role: 'tool', tool_call_id: 'save-memory', content: expect.stringContaining('"status":"saved"'),
    })
    provider.exchanges[1]!.delta({ content: '已保存测试约定。' })
    provider.exchanges[1]!.finish()
    await expect(page.getByRole('region', { name: '消息列表' })).toContainText('已保存测试约定。')
    const sessionId = await settledSession(observed, 0)
    const [project] = await projects(page)
    expect(project).toMatchObject({ name: 'example-project', count: 1, path: fixture.cwd })
    const path = project!.entries[0]!.path
    const disk = await readFile(path, 'utf8')
    expect(disk).toContain(note)
    diskProvenance(disk, sessionId, submittedAt)
    expect(await readFile(project!.directoryPath, 'utf8')).toContain(summary)

    await personalization(page)
    const auto = settings.getByRole('switch', { name: '启用记忆', exact: true })
    await expect(auto).toBeChecked()
    await auto.click()
    await expect(auto).not.toBeChecked()
    await settings.getByRole('button', { name: '管理项目摘要' }).click()
    const list = page.getByRole('dialog', { name: '项目摘要', exact: true })
    await list.getByRole('button', { name: /example-project\s*1 条/ }).click()
    await expect(list).toContainText(summary)
    await expect(list).toContainText(path)
    await list.getByRole('button', { name: `删除${title}`, exact: true }).click()
    await expect(list).toContainText('暂无项目记忆')
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await projects(page)).toEqual([])
    await page.keyboard.press('Escape')
    await auto.click()
    await expect(auto).toBeChecked()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '新会话', exact: true }).click()
    await submit(page, '新的集成测试任务。')
    await expect.poll(() => provider.exchanges.length).toBe(3)
    const next = String(provider.exchanges[2]!.body.messages[0]?.content)
    expect(next).toContain(personal)
    expect(next).not.toContain(summary)
    provider.exchanges[2]!.finish()
  } finally { await Promise.allSettled([fixture.close(), provider.close()]) }
})

type WireCall = { id: string; function: { name: string; arguments: string } }
type WireMessage = { role: string; content?: string | null; tool_call_id?: string; tool_calls?: WireCall[] }
type LiveRequest = { model: string; messages: WireMessage[] }

function pairedTool(requests: LiveRequest[], toolCallId: string, name: string) {
  for (const { messages } of requests) {
    const call = messages.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : [])
      .find(tool => tool.id === toolCallId && tool.function.name === name)
    const result = messages.find(message => message.role === 'tool' && message.tool_call_id === toolCallId)
    if (call && typeof result?.content === 'string') return { call, result: { ...result, content: result.content } }
  }
  throw new Error(`真实模型请求中没有找到 ${name}（${toolCallId}）的成对调用与结果`)
}

test('记忆 23：真实 DeepSeek 区分同一句确认，跨会话使用约定并按需核对出处', async ({ page }, testInfo) => {
  test.setTimeout(360_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const key = await readLiveKey(keyFile!)
  const requests: LiveRequest[] = []
  const fixture = await projectFixture({ fetch: async (url, init) => {
    const request = JSON.parse(String(init?.body)) as LiveRequest
    if (request.messages[0]?.content?.includes('## 长期记忆')) requests.push(request)
    return globalThis.fetch(url, init)
  } })
  const db = 'si_test_' + randomUUID().slice(0, 8)
  const oneTimeCode = 'once-' + randomUUID().slice(0, 8)
  const oneTimeProposal = `我只想验证这次对话的页面显示。先回复「我准备好了」，等我同意后输出一次「临时验证编号是 ${oneTimeCode}」。`
  const originalWording = '迁移没有过，就不要开始跑'
  const durableProposal = `我在考虑为本项目定一条长期约定：集成测试统一连真实测试数据库 ${db}，并且「${originalWording}」。先简要复述这个待定方案，等我确认才正式采用。`
  const confirmation = '可以'
  const observed = observe(page)
  const run = async (text: string) => {
    const start = observed.updates.length
    const sent = requests.length
    await submit(page, text)
    const sessionId = await settledSession(observed, start, 120_000)
    const events = observed.updates.slice(start).filter(event => event.sessionId === sessionId)
    const tools = events.flatMap(({ update: { change } }) => change.type === 'task' && change.message?.message.role === 'toolResult'
      ? [{ message: change.message.message, fileOperation: change.message.fileOperation }] : [])
    const answer = events.flatMap(({ update: { change } }) => change.type === 'model' && change.event.type === 'done' && change.event.reason === 'stop'
      ? change.event.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('')
    expect(answer).toBeTruthy()
    return { tools, answer, requests: requests.slice(sent), sessionId }
  }
  try {
    await authorize(page, (await fixture.server.start()).authUrl)
    await addWorkspace(page)
    await saveKey(page, key)
    const oneTimePending = await run(oneTimeProposal)
    const oneTime = await run(confirmation)
    expect(oneTime.sessionId).toBe(oneTimePending.sessionId)
    expect(oneTime.answer).toContain(oneTimeCode)
    expect(oneTime.requests[0]?.messages.filter(({ role }) => role === 'user').map(({ content }) => content))
      .toEqual([oneTimeProposal, confirmation])
    const oneTimeToolNames = [...oneTimePending.tools, ...oneTime.tools].map(({ message }) => message.toolName)
    expect(oneTimeToolNames).not.toContain('memory')
    const oneTimeProjects = await projects(page)
    expect(oneTimeProjects).toEqual([])
    await expect(readFile(join(fixture.memoryDirectory, 'USER.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await page.getByRole('button', { name: '新会话', exact: true }).click()
    const pending = await run(durableProposal)
    expect(pending.sessionId).not.toBe(oneTime.sessionId)
    expect(await projects(page)).toEqual([])
    const submittedAt = Date.now()
    const saved = await run(confirmation)
    expect(saved.sessionId).toBe(pending.sessionId)
    expect(saved.requests[0]?.messages.filter(({ role }) => role === 'user').map(({ content }) => content))
      .toEqual([durableProposal, confirmation])
    const writeResult = saved.tools.find(({ message }) => message.toolName === 'memory' && !message.isError)?.message
    expect(writeResult).toBeDefined()
    const savedPair = pairedTool(saved.requests, writeResult!.toolCallId, 'memory')
    const saveArguments = JSON.parse(savedPair.call.function.arguments)
    expect(saveArguments).toMatchObject({ scope: 'project', operation: 'write' })
    expect(saveArguments).not.toHaveProperty('sourceMessageIds')
    expect(JSON.parse(savedPair.result.content)).toMatchObject({ status: 'saved' })
    const found = await projects(page)
    expect(found).toHaveLength(1)
    const project = found[0]!
    expect(project.entries).toHaveLength(1)
    const entry = project.entries[0]!
    const disk = await readFile(entry.path, 'utf8')
    expect(disk).toContain(db)
    expect(disk).toMatch(/迁移/)
    const savedAt = diskProvenance(disk, saved.sessionId, submittedAt)
    expect(await readFile(project.directoryPath, 'utf8')).toContain(entry.line)

    await page.getByRole('button', { name: '新会话', exact: true }).click()
    const recallQuestion = '我准备给这个项目补集成测试。按现有项目约定，我应该连接哪个数据库？开跑前要检查什么？'
    const recalled = await run(recallQuestion)
    expect(recalled.sessionId).not.toBe(saved.sessionId)
    const system = recalled.requests[0]?.messages[0]?.content
    expect(system).toContain(entry.line)
    expect(system).not.toContain(disk)
    expect(recalled.requests[0]?.messages.some(({ content }) => content?.includes(durableProposal))).toBe(false)
    expect(recalled.tools.some(({ message }) => message.toolName === 'memory_source')).toBe(false)
    const readResult = recalled.tools.find(({ fileOperation, message }) => fileOperation?.path === entry.path
      && message.toolName === 'read' && !message.isError)?.message
    expect(readResult).toBeDefined()
    const readPair = pairedTool(recalled.requests, readResult!.toolCallId, 'read')
    expect(readPair.result.content).toContain(db)
    expect(recalled.answer).toContain(db)
    expect(recalled.answer).toMatch(/迁移/)
    await expect(page.getByRole('region', { name: '消息列表' })).toContainText(db)

    const originQuestion = '这个项目的集成测试约定是在原会话里怎么确认的？请查出处，逐字引用我当时提到迁移的原话和确认时发的那条短消息。'
    const origin = await run(originQuestion)
    expect(origin.sessionId).toBe(recalled.sessionId)
    expect(origin.requests[0]?.messages.some(({ content }) => content?.includes(durableProposal))).toBe(false)
    const sourceResult = origin.tools.find(({ message }) => message.toolName === 'memory_source' && !message.isError)?.message
    expect(sourceResult).toBeDefined()
    const sourcePair = pairedTool(origin.requests, sourceResult!.toolCallId, 'memory_source')
    expect(JSON.parse(sourcePair.call.function.arguments)).toMatchObject({ scope: 'project', entryId: entry.entryId })
    const excerpt = JSON.parse(sourcePair.result.content)
    expect(excerpt).toMatchObject({
      status: 'found', sessionId: saved.sessionId, savedAt,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: durableProposal }),
        expect.objectContaining({ role: 'user', text: confirmation }),
      ]),
    })
    expect(origin.answer).toContain(originalWording)
    expect(origin.answer).toContain(confirmation)
    await expect(page.getByRole('region', { name: '消息列表' }).locator('.assistant-message').last()).toContainText(originalWording)

    const evidence = testInfo.outputPath('memory-live-evidence.json')
    await writeFile(evidence, JSON.stringify({
      model: saved.requests[0]?.model,
      confirmation,
      oneTime: {
        proposal: oneTimeProposal, sessionId: oneTime.sessionId, answer: oneTime.answer,
        toolNames: oneTimeToolNames, projectNotes: oneTimeProjects.length, userNoteExists: false,
      },
      durable: {
        proposal: durableProposal, sessionId: saved.sessionId, savedAt, notePath: entry.path,
        note: disk, directoryEntry: entry.line, tool: savedPair, answer: saved.answer,
      },
      recall: { question: recallQuestion, sessionId: recalled.sessionId, tool: readPair, answer: recalled.answer },
      origin: { question: originQuestion, sessionId: origin.sessionId, tool: sourcePair, excerpt, answer: origin.answer },
    }, null, 2))
    await testInfo.attach('memory-live-evidence', { contentType: 'application/json', path: evidence })
  } finally { await fixture.close() }
})
