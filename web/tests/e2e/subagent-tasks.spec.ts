import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '@agent-learning/coding-agent'
import { WebServer } from '@agent-learning/server'
import { expect, test, type Page } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, openSession, ready, saveKey, seedSession } from './test-utils'

type Provider = Awaited<ReturnType<typeof startModelServer>>
type Exchange = Provider['exchanges'][number]
type Setup = { provider: Provider; observed: ReturnType<typeof observe>; directory: string; workspaceId: string }

const editor = (page: Page) => page.getByRole('textbox', { name: '消息', exact: true })
const taskTrigger = (page: Page) => page.getByRole('button', { name: '任务', exact: true })
const taskCard = (page: Page) => page.getByRole('region', { name: '任务', exact: true })
const stopChild = (page: Page, name: string) => taskCard(page).getByRole('button', { name: '停止 ' + name, exact: true })

async function controlled(page: Page, scenario: (setup: Setup) => Promise<void | ((store: SessionStore) => void)>) {
  page.setDefaultTimeout(8000)
  const directory = await mkdtemp(join(tmpdir(), 'si-subagent-browser-'))
  const provider = await startModelServer()
  const sessionPath = join(directory, 'sessions.sqlite')
  const server = new WebServer({
    port: 0, directoryPicker: async () => directory, sessionPath,
    skillHome: join(directory, 'home'), browserSecretPath: join(directory, 'browser-auth.json'),
    globalContextDirectory: join(directory, 'global-context'), modelAuthPath: join(directory, 'auth.json'),
    workspacePath: join(directory, 'workspaces.json'), webSettingsPath: join(directory, 'web-settings.json'),
    modelOptions: { baseURL: provider.baseURL },
  })
  try {
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const verifySaved = await scenario({ provider, observed, directory, workspaceId })
    if (verifySaved) {
      await server.close()
      const store = SessionStore.open(sessionPath)
      try { verifySaved(store) } finally { store.close() }
    }
  } finally {
    await Promise.allSettled([server.close(), provider.close()])
    await rm(directory, { recursive: true, force: true })
  }
}

function tool(index: number, id: string, name: 'subagent' | 'team' | 'bash' | 'read' | 'ask_user_question', args: object) {
  return { index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function call(exchange: Exchange, ...tools: ReturnType<typeof tool>[]) {
  exchange.delta({ tool_calls: tools })
  exchange.finish('tool_calls')
}

function answer(exchange: Exchange, text: string) {
  exchange.delta({ content: text })
  exchange.finish()
}

async function findExchange(provider: Provider, from: number, find: (exchange: Exchange) => boolean) {
  const match = () => provider.exchanges.slice(from).find(find)
  await expect.poll(() => Boolean(match()), { timeout: 10000 }).toBe(true)
  return match()!
}

const hasUserText = (exchange: Exchange, text: string) => exchange.body.messages
  .some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(text))

async function send(page: Page, provider: Provider, prompt: string) {
  const from = provider.exchanges.length
  await editor(page).fill(prompt)
  await editor(page).press('Enter')
  return findExchange(provider, from, exchange => hasUserText(exchange, prompt))
}

async function idle(page: Page) {
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
}

async function openTool(page: Page, text: string) {
  const group = page.locator('.process-group').filter({ has: page.locator('.tool-block').filter({ hasText: text }) })
  if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click()
  const row = group.locator('.tool-block').filter({ hasText: text })
  if (await row.getAttribute('open') === null) await row.locator('summary').click()
  return row
}

test('39/40 后台完成输出更新原工具行，刷新和切换保留各自的子任务', async ({ page }) => {
  await controlled(page, async ({ provider, observed, workspaceId }) => {
    const x = await seedSession(page, observed, workspaceId)
    const first = await send(page, provider, '启动聊天 X')
    call(first, tool(0, 'delegate-x', 'subagent', { action: 'run', name: 'scout', task: 'X 的侦查工作', background: true }))
    const scout = await findExchange(provider, 0, exchange => hasUserText(exchange, 'X 的侦查工作'))
    const closingX = await findExchange(provider, 0, exchange => hasUserText(exchange, '启动聊天 X') && exchange !== first)
    answer(closingX, '侦查工作已交接')
    await idle(page)

    const y = await seedSession(page, observed, workspaceId)
    const second = await send(page, provider, '启动聊天 Y')
    call(second, tool(0, 'delegate-y', 'subagent', { action: 'run', name: 'reviewer', task: 'Y 的独立审查', background: true }))
    const reviewer = await findExchange(provider, 0, exchange => hasUserText(exchange, 'Y 的独立审查'))
    const closingY = await findExchange(provider, 0, exchange => hasUserText(exchange, '启动聊天 Y') && exchange !== second)
    const receipt = closingY.body.messages.find(message => message.role === 'tool')?.content
    expect(typeof receipt).toBe('string')
    await expect(page.locator('.tool-block').filter({ hasText: 'Y 的独立审查' })).toHaveCount(1)
    const row = await openTool(page, 'Y 的独立审查')
    await expect(row.locator('.tool-result')).toHaveText(String(receipt))
    answer(reviewer, 'Y 审查结果：标记 reviewer-6a0f')
    await expect(row.locator('.tool-result')).toContainText('reviewer-6a0f')
    expect(await row.getAttribute('open')).not.toBeNull()
    answer(closingY, '审查已交接')
    const report = await findExchange(provider, 0, exchange => hasUserText(exchange, 'reviewer-6a0f'))
    expect(report.body.messages.find(message => message.role === 'tool')?.content).toBe(receipt)
    answer(report, '已收到审查结果')
    await idle(page)

    await openSession(page, observed, x)
    const snapshots = observed.snapshots.length
    await page.reload()
    await ready(page, observed, snapshots, false)
    await taskTrigger(page).click()
    await expect(stopChild(page, 'scout')).toBeVisible()
    await expect(taskCard(page)).not.toContainText('reviewer')
    expect(scout.closed).toBe(false)

    await openSession(page, observed, y)
    await expect(taskCard(page)).not.toContainText('scout')
    await expect(taskCard(page).getByRole('listitem').filter({ hasText: 'reviewer' })).toContainText('已完成')
    await expect((await openTool(page, 'Y 的独立审查')).locator('.tool-result')).toContainText('reviewer-6a0f')
  })
})

test('41 停止等待中的 A 后，B 继续并单独保存答复', async ({ page }) => {
  await controlled(page, async ({ provider, observed, workspaceId }) => {
    const parent = await seedSession(page, observed, workspaceId)
    const setup = await send(page, provider, '准备可续用的 B')
    call(setup, tool(0, 'setup-b', 'subagent', { action: 'run', name: 'B', task: '创建 B 的首轮记录', background: false }))
    answer(await findExchange(provider, 0, exchange => hasUserText(exchange, '创建 B 的首轮记录')), 'B 的首轮已结束')
    answer(await findExchange(provider, 0, exchange => exchange !== setup && hasUserText(exchange, '准备可续用的 B')), 'B 已准备好')
    await idle(page)

    const launch = await send(page, provider, '创建并行的 A')
    call(launch, tool(0, 'setup-a', 'subagent', { action: 'run', name: 'A', task: 'A 启动后续用 B', background: true }))
    const a = await findExchange(provider, 0, exchange => hasUserText(exchange, 'A 启动后续用 B'))
    call(a, tool(0, 'wait-b', 'team', { action: 'continue', name: 'B', message: '保持 B 第二轮运行', background: false }))
    const b = await findExchange(provider, 0, exchange => hasUserText(exchange, '保持 B 第二轮运行'))
    const rootAgain = await findExchange(provider, 0, exchange => exchange !== launch && hasUserText(exchange, '创建并行的 A'))
    answer(rootAgain, 'A 已交接')

    await taskTrigger(page).click()
    await expect(stopChild(page, 'A')).toBeEnabled()
    await expect(stopChild(page, 'B')).toBeEnabled()
    const stopResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname.startsWith(`/api/sessions/${parent}/subagents/`))
    await stopChild(page, 'A').click()
    expect(await (await stopResponse).json()).toMatchObject({ status: 'aborted' })
    await expect(taskCard(page).getByRole('listitem').filter({ hasText: 'A' })).toContainText('已停止')
    await expect(stopChild(page, 'B')).toBeEnabled()
    expect(b.closed).toBe(false)

    answer(b, 'B 独立完成：b-finished-55c9')
    await expect(taskCard(page).getByRole('listitem').filter({ hasText: 'B' })).toContainText('已完成')
    const unexpectedA = provider.exchanges.filter(exchange => exchange !== a && hasUserText(exchange, 'A 启动后续用 B'))
      .filter(exchange => !hasUserText(exchange, '创建并行的 A'))
    expect(unexpectedA).toEqual([])
    return store => {
      const children = store.listSubagents(parent)
      const savedA = store.loadSession(children.find(child => child.name === 'A')!.id)!
      const savedB = store.loadSession(children.find(child => child.name === 'B')!.id)!
      expect(savedA.runs.map(run => run.status)).toEqual(['aborted'])
      expect(JSON.stringify(savedA.messages)).not.toContain('b-finished-55c9')
      expect(savedB.runs.at(-1)?.status).toBe('completed')
      expect(savedB.messages.at(-1)?.message).toMatchObject({ role: 'assistant', content: expect.arrayContaining([{ type: 'text', text: 'B 独立完成：b-finished-55c9' }]) })
    }
  })
})

test('45 /stop 停止本聊天的主轮、两类子轮和两组 Bash，其他聊天继续', async ({ page }) => {
  await controlled(page, async ({ provider, observed, workspaceId, directory }) => {
    const root = await seedSession(page, observed, workspaceId)
    const other = await seedSession(page, observed, workspaceId)
    const command = (name: string) => `echo "$$" > ${name}.pid; exec sleep 60 # ${name}`
    const pid = async (name: string) => {
      await expect.poll(() => readFile(join(directory, name + '.pid'), 'utf8').catch(() => '')).toMatch(/^\d+/)
      return Number(await readFile(join(directory, name + '.pid'), 'utf8'))
    }
    const otherMain = await send(page, provider, '准备其他聊天的任务')
    call(otherMain, tool(0, 'other-work', 'subagent', { action: 'run', name: 'other-agent', task: '其他会话的运行', background: true }),
      tool(1, 'other-shell', 'bash', { command: command('other-bash'), background: true }))
    const otherChild = await findExchange(provider, 0, exchange => hasUserText(exchange, '其他会话的运行'))
    const otherPid = await pid('other-bash')
    await openSession(page, observed, root)

    const main = await send(page, provider, '准备本聊天的三类任务')
    call(main, tool(0, 'root-shell', 'bash', { command: command('root-bash'), background: true }),
      tool(1, 'root-bg', 'subagent', { action: 'run', name: 'worker-bg', task: '本聊天后台运行', background: true }),
      tool(2, 'root-fg', 'subagent', { action: 'run', name: 'worker-fg', task: '本聊天前台运行', background: false }))
    const background = await findExchange(provider, 0, exchange => hasUserText(exchange, '本聊天后台运行'))
    const foreground = await findExchange(provider, 0, exchange => hasUserText(exchange, '本聊天前台运行'))
    call(background, tool(0, 'child-shell', 'bash', { command: command('child-bash'), background: true }))
    const backgroundAgain = await findExchange(provider, 0, exchange => exchange !== background && hasUserText(exchange, '本聊天后台运行'))
    const rootPid = await pid('root-bash'), childPid = await pid('child-bash')
    await taskTrigger(page).click()
    await expect(stopChild(page, 'worker-bg')).toBeVisible()
    await expect(stopChild(page, 'worker-fg')).toBeVisible()
    await expect(taskCard(page)).toContainText('root-bash')
    const sentBefore = observed.submissions.length
    await editor(page).fill('/stop 这段文字不会发送')
    await editor(page).press('Enter')
    await expect(page.getByRole('status').filter({ hasText: '已停止 5 项' })).toBeVisible()
    expect(observed.submissions).toHaveLength(sentBefore)
    await expect(taskCard(page).getByText('已停止', { exact: true })).toHaveCount(2)
    await expect(taskCard(page)).not.toContainText('root-bash')
    await expect.poll(() => foreground.closed && backgroundAgain.closed).toBe(true)
    await expect(page.getByRole('button', { name: '中止', exact: true })).toHaveCount(0)
    expect(() => process.kill(rootPid, 0)).toThrow(/ESRCH/)
    expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/)
    expect(() => process.kill(otherPid, 0)).not.toThrow()
    expect(otherChild.closed).toBe(false)
    await openSession(page, observed, other)
    await expect(stopChild(page, 'other-agent')).toBeVisible()
    await expect(taskCard(page)).toContainText('other-bash')
    return store => {
      const history = store.loadSession(root)!
      expect(history.runs.map(run => run.status)).toEqual(['aborted'])
      expect(JSON.stringify(history.messages)).not.toContain('/stop')
    }
  })
})

test('27 用户回答前台子 Agent 的问题后，主 Agent 沿原子会话继续', async ({ page }) => {
  await controlled(page, async ({ provider, observed, workspaceId, directory }) => {
    const parent = await seedSession(page, observed, workspaceId)
    await writeFile(join(directory, 'entry.txt'), '当前旧入口 entry-old-7e8b')
    const main = await send(page, provider, '检查是否要替换入口')
    call(main, tool(0, 'review-entry', 'subagent', { action: 'run', name: 'reviewer', task: '读取旧入口并交回待决定事项', background: false }))
    const child = await findExchange(provider, 0, exchange => hasUserText(exchange, '读取旧入口并交回待决定事项'))
    const afterRead = provider.exchanges.length
    call(child, tool(0, 'read-entry', 'read', { path: 'entry.txt' }))
    const answerChild = await findExchange(provider, afterRead, exchange => hasUserText(exchange, '读取旧入口并交回待决定事项'))
    expect(answerChild.body.messages.find(message => message.role === 'tool')?.content).toContain('entry-old-7e8b')
    answer(answerChild, '已核对 entry-old-7e8b，需用户决定是否覆盖旧入口。')

    const mainAfterReview = await findExchange(provider, 0, exchange => exchange !== main && hasUserText(exchange, '检查是否要替换入口'))
    const receipt = mainAfterReview.body.messages.find(message => message.role === 'tool')
    expect(receipt?.content).toContain('需用户决定是否覆盖旧入口')
    const firstChildId = JSON.parse(String(receipt!.content)).items[0].sessionId as string
    expect(firstChildId).toBeTruthy()
    const afterQuestion = provider.exchanges.length
    call(mainAfterReview, tool(0, 'overwrite-choice', 'ask_user_question', { questions: [
      { id: 'overwrite', question: '是否覆盖旧入口？', options: [{ label: '要覆盖' }, { label: '保留旧入口' }] },
    ] }))
    const question = page.getByRole('region', { name: '回答问题' })
    await expect(question.getByText('是否覆盖旧入口？', { exact: true })).toBeVisible()
    await question.getByText('要覆盖', { exact: true }).click()
    await expect(question.getByRole('radio', { name: '要覆盖', exact: true })).toBeChecked()
    await question.getByRole('button', { name: '提交', exact: true }).click()
    const mainAfterAnswer = await findExchange(provider, afterQuestion, exchange => hasUserText(exchange, '检查是否要替换入口'))
    expect(mainAfterAnswer.body.messages.filter(message => message.role === 'tool').at(-1)?.content).toContain('要覆盖')
    const afterContinue = provider.exchanges.length
    call(mainAfterAnswer, tool(0, 'continue-entry', 'subagent', { action: 'continue', sessionId: firstChildId, background: false, message: '用户选择要覆盖，请继续原任务' }))
    const resumed = await findExchange(provider, afterContinue, exchange => hasUserText(exchange, '用户选择要覆盖，请继续原任务'))
    expect(hasUserText(resumed, '读取旧入口并交回待决定事项')).toBe(true)
    expect(resumed.body.messages.find(message => message.role === 'tool')?.content).toContain('entry-old-7e8b')
    answer(resumed, '已按用户选择规划覆盖 entry-old-7e8b')
    const final = await findExchange(provider, afterContinue, exchange => exchange !== resumed && hasUserText(exchange, '检查是否要替换入口'))
    expect(final.body.messages.filter(message => message.role === 'tool').at(-1)?.content).toContain('规划覆盖 entry-old-7e8b')
    answer(final, '确认覆盖 entry-old-7e8b')
    await expect(page.getByRole('region', { name: '消息列表' }).getByText('确认覆盖 entry-old-7e8b', { exact: true })).toBeVisible()

    return store => {
      expect(store.listSubagents(parent).map(child => child.id)).toEqual([firstChildId])
      expect(store.loadSession(firstChildId)?.runs.map(run => run.status)).toEqual(['completed', 'completed'])
    }
  })
})
