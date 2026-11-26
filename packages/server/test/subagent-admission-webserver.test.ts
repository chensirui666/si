import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionStore } from '@agent-learning/coding-agent'
import { expect, it, vi } from 'vitest'
import { finish, fixture, stop, toolCall, userTexts, type Exchange } from './collaboration-fixture.js'

type Harness = Awaited<ReturnType<typeof fixture>>
type App = Awaited<ReturnType<Harness['start']>>
const lastUser = (exchange: Exchange) => String(userTexts(exchange).at(-1))
const toolResults = (exchange: Exchange) => exchange.body.messages.filter(message => message.role === 'tool')
const stagedSteer = 'STAGED-STEER-STOPPED-BEFORE-MODEL'
function result(exchange: Exchange, tool: string) {
  const message = toolResults(exchange).at(-1)
  expect(message).toMatchObject({ tool_call_id: `call-${tool}` })
  return JSON.parse(String(message?.content))
}

function find(exchanges: Exchange[], after: number, match: (exchange: Exchange) => boolean) {
  return vi.waitFor(() => {
    const found = exchanges.slice(after).find(match)
    expect(found).toBeDefined()
    return found!
  }, { timeout: 4000 })
}

async function start(harness: Harness, text: string) {
  const app = await harness.start()
  await app.saveKey()
  const root = await app.create(await app.pick())
  const run = await app.accept(root, 'initial', text)
  return { app, root, run, first: await harness.requestNumber(1) }
}

async function roster(harness: Harness, text: string, names: string[]) {
  const { app, root, run, first } = await start(harness, text)
  toolCall(first, 'subagent', { action: 'run', background: true, tasks: names.map(name => ({ name, task: name + '-initial' })) })
  const exchanges = harness.provider.exchanges
  const children = new Map(await Promise.all(names.map(async name =>
    [name, await find(exchanges, 1, item => lastUser(item) === `Task: ${name}-initial`)] as const)))
  return { app, root, run, children, main: await find(exchanges, 1, item => lastUser(item) === text) }
}

async function idle(app: App, root: string) {
  return vi.waitFor(async () => {
    const state = await app.snapshot(root)
    expect(state.running).toBeNull()
    return state
  }, { timeout: 4000 })
}

function member(app: App, root: string, name: string, status: string) {
  return vi.waitFor(async () => {
    const child = (await app.snapshot(root)).subagents?.find(item => item.name === name)
    expect(child).toMatchObject({ status })
    return child!
  }, { timeout: 4000 })
}

async function saved(harness: Harness, app: App, sessionId: string) {
  expect(await stop(app.child, 'SIGTERM')).toEqual([0, null])
  const store = SessionStore.open(join(harness.directory, 'sessions.sqlite'))
  try {
    const history = store.loadSession(sessionId)
    expect(history).toBeDefined()
    return history!
  } finally { store.close() }
}

async function gate(directory: string, hook: 'admission' | 'tool' | 'context') {
  const extensionDir = join(directory, 'global-context', 'extensions')
  await mkdir(extensionDir, { recursive: true })
  const started = join(directory, 'gate-started'), released = join(directory, 'gate-released'), aborted = join(directory, 'gate-aborted')
  const hold = `
    await writeFile(${JSON.stringify(started)}, '')
    while (!await access(${JSON.stringify(released)}).then(() => true, () => false)) await setTimeout(5)
  `
  const markAbort = `signal.addEventListener('abort', () => { void writeFile(${JSON.stringify(aborted)}, '') }, { once: true })`
  const callbacks = {
    admission: `
      export default si => si.on('before_agent_start', async ({ prompt }) => {
        if (!prompt.includes('CONTINUE-CANDIDATE-')) return
        ${hold}
      })
    `,
    tool: `
      export default si => si.registerTool({
        name: 'admission_test_gate', description: '测试期间等待放行', parameters: { type: 'object', properties: {} },
        async execute(_args, { signal }) {
          ${markAbort}
          ${hold}
          signal.throwIfAborted()
          return '已放行'
        },
      })
    `,
    context: `
      export default si => si.on('context', async ({ messages }, { signal }) => {
        if (!messages.some(({ role, content }) => role === 'user'
          && typeof content === 'string' && content.includes(${JSON.stringify(stagedSteer)}))) return
        ${markAbort}
        ${hold}
      })
    `,
  }
  await writeFile(join(extensionDir, 'admission-gate.ts'), `
    import { access, writeFile } from 'node:fs/promises'
    import { setTimeout } from 'node:timers/promises'
    ${callbacks[hook]}
  `)
  return {
    started: () => vi.waitFor(() => stat(started), { timeout: 4000 }),
    aborted: () => vi.waitFor(() => stat(aborted), { timeout: 4000 }),
    release: () => writeFile(released, ''),
  }
}

it.each(['subagent', 'team'] as const)('15 两个续用竞争接单，%s 先取得接单权', async winner => {
  const harness = await fixture()
  const barrier = await gate(harness.directory, 'admission')
  const { app, root, children, main } = await roster(harness, '并行竞争测试', ['reviewer', 'scout'])
  const parentText = lastUser(main), scoutText = lastUser(children.get('scout')!)
  finish(children.get('reviewer')!, '最初的审查结果')
  const reviewer = await member(app, root, 'reviewer', 'completed')

  const send = (tool: 'subagent' | 'team') => toolCall(tool === 'subagent' ? main : children.get('scout')!, tool, {
    action: 'continue', background: true, sessionId: reviewer.sessionId, message: 'CONTINUE-CANDIDATE-' + tool,
  })
  const opponent = winner === 'subagent' ? 'team' : 'subagent'
  const senderText = (tool: typeof winner) => tool === 'subagent' ? parentText : scoutText
  const exchanges = harness.provider.exchanges
  const before = exchanges.length
  send(winner)
  try {
    await barrier.started()
    send(opponent)
    const rejected = await find(exchanges, before, item => lastUser(item) === senderText(opponent))
    expect(result(rejected, opponent)).toMatchObject({ status: 'running', message: expect.stringContaining('正在运行') })
    expect(exchanges.slice(before)).toEqual([rejected])
    expect(await member(app, root, 'reviewer', 'completed')).toEqual(reviewer)
  } finally { await barrier.release() }

  const [accepted, running] = await Promise.all([
    find(exchanges, before, item => lastUser(item) === senderText(winner)),
    find(exchanges, before, item => lastUser(item).includes('CONTINUE-CANDIDATE-' + winner)),
  ])
  const receipt = result(accepted, winner)
  expect(receipt).toMatchObject({ status: 'accepted', sessionId: reviewer.sessionId, runId: expect.any(String) })
  expect(receipt.runId).not.toBe(reviewer.runId)
  expect(await member(app, root, 'reviewer', 'running')).toMatchObject({ runId: receipt.runId, sessionId: reviewer.sessionId })
  expect(userTexts(running).filter(text => String(text).includes('CONTINUE-CANDIDATE-'))).toHaveLength(1)
  expect(exchanges.slice(before).filter(item => lastUser(item).includes('CONTINUE-CANDIDATE-'))).toEqual([running])

  const history = await saved(harness, app, reviewer.sessionId)
  expect(history.runs.map(run => run.id)).toEqual([reviewer.runId, receipt.runId])
  expect(history.runs[1].text).toContain('CONTINUE-CANDIDATE-' + winner)
  expect(history.pending ?? []).toEqual([])
}, 15000)

it('16 主会话已有待发用户消息时拒绝续用，恢复发送后仍从原队首执行', async () => {
  const harness = await fixture()
  const { app, root, run, children } = await roster(harness, '先完成这轮', ['scout'])
  expect((await app.accept(root, 'readme', '改 README')).kind).toBe('queued')
  const aborted = await app.call('/api/abort', { sessionId: root, runId: run.userMessageId })
  expect(await aborted.json()).toMatchObject({ handled: true })
  const paused = await idle(app, root)
  expect(paused.interaction?.queue).toMatchObject({ items: [{ clientMessageId: 'readme' }], paused: expect.any(String) })

  toolCall(children.get('scout')!, 'team', { action: 'continue', name: 'parent', message: '不可抢占原队首', background: false })
  const rejected = await harness.requestNumber(4)
  expect(result(rejected, 'team')).toMatchObject({ status: 'queued', message: expect.stringContaining('已有待发任务') })
  expect((await app.snapshot(root)).interaction?.queue).toEqual(paused.interaction?.queue)
  expect((await app.accept(root, 'later', '再处理下一项')).kind).toBe('queued')
  const readme = await harness.requestNumber(5)
  expect(lastUser(readme)).toBe('改 README')
  finish(readme)
  const later = await harness.requestNumber(6)
  expect(lastUser(later)).toBe('再处理下一项')
  expect(userTexts(later).join('\n')).not.toContain('不可抢占原队首')
  finish(later)
  expect((await idle(app, root)).runs?.map(item => item.clientMessageId)).toEqual(['initial', 'readme', 'later'])
}, 15000)

it('17 前台创建、后台续用、前台续用，三轮共享同一子会话文件发现和历史', async () => {
  const harness = await fixture()
  await writeFile(join(harness.directory, 'marker.txt'), 'login-v2')
  const { app, root, first } = await start(harness, '检查后继续使用同一子会话')
  const next = harness.requestNumber
  toolCall(first, 'subagent', { action: 'run', name: 'reviewer', task: '读取文件识别码', background: false })
  toolCall(await next(2), 'read', { path: 'marker.txt' })
  const read = await next(3)
  expect(toolResults(read).at(-1)?.content).toContain('login-v2')
  finish(read, '文件中的识别码是 login-v2')
  const main = await next(4)
  const child = await member(app, root, 'reviewer', 'completed')
  expect(result(main, 'subagent')).toMatchObject({ items: [{ sessionId: child.sessionId, runId: child.runId }] })
  toolCall(main, 'subagent', { action: 'continue', sessionId: child.sessionId, message: '后台结合已有结论', background: true })
  const exchanges = harness.provider.exchanges
  const [background, receipt] = await Promise.all([
    find(exchanges, 4, item => lastUser(item).includes('后台结合已有结论')),
    find(exchanges, 4, item => lastUser(item) === lastUser(main)),
  ])
  const accepted = result(receipt, 'subagent')
  expect(accepted).toMatchObject({ status: 'accepted', sessionId: child.sessionId, runId: expect.any(String) })
  expect(accepted.runId).not.toBe(child.runId)
  expect(background.body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '文件中的识别码是 login-v2' }))
  finish(receipt)
  await idle(app, root)
  finish(background, '后台已验证 login-v2')
  const report = await next(7)
  expect(lastUser(report)).toContain('后台已验证 login-v2')
  toolCall(report, 'subagent', { action: 'continue', sessionId: child.sessionId, message: '前台复核两次结论', background: false })
  const foreground = await next(8)
  expect(foreground.body.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', content: '文件中的识别码是 login-v2' }),
    expect.objectContaining({ role: 'assistant', content: '后台已验证 login-v2' }),
  ]))
  expect(lastUser(foreground)).toContain('前台复核两次结论')
  finish(foreground, '前台已复核 login-v2')
  const done = await next(9)
  const third = result(done, 'subagent').items[0]
  expect(third).toMatchObject({ sessionId: child.sessionId, runId: expect.any(String), output: '前台已复核 login-v2' })
  finish(done)
  await idle(app, root)
  const history = await saved(harness, app, child.sessionId)
  expect(history.runs.map(item => [item.id, item.status])).toEqual([
    [child.runId, 'completed'], [accepted.runId, 'completed'], [third.runId, 'completed'],
  ])
  expect(new Set(history.runs.map(item => item.id)).size).toBe(3)
}, 15000)

it('21–23 空闲和停止时拒绝两种插话，已接收但未交付的插话只留在原轮', async () => {
  const harness = await fixture()
  const barrier = await gate(harness.directory, 'tool')
  const { app, root, children, main } = await roster(harness, '检查插话边界', ['reviewer', 'scout'])
  const scout = children.get('scout')!
  const exchanges = harness.provider.exchanges
  finish(children.get('reviewer')!)
  const original = await member(app, root, 'reviewer', 'completed')
  const steer = (sender: Exchange, tool: 'subagent' | 'team', message: string) =>
    toolCall(sender, tool, { action: 'steer', sessionId: original.sessionId, message })
  const responses = async (after: number, mainExchange: Exchange, scoutExchange: Exchange) =>
    Promise.all([find(exchanges, after, item => lastUser(item) === lastUser(mainExchange)),
      find(exchanges, after, item => lastUser(item) === lastUser(scoutExchange))])
  let before = exchanges.length
  steer(main, 'subagent', 'IDLE-ROOT-STEER')
  steer(scout, 'team', 'IDLE-TEAM-STEER')
  const [idleMain, idleScout] = await responses(before, main, scout)
  expect(result(idleMain, 'subagent')).toMatchObject({ status: 'idle', message: expect.stringContaining('空闲') })
  expect(result(idleScout, 'team')).toMatchObject({ status: 'idle', message: expect.stringContaining('空闲') })
  expect(exchanges.length).toBe(before + 2)
  expect(await member(app, root, 'reviewer', 'completed')).toEqual(original)

  before = exchanges.length
  toolCall(idleMain, 'subagent', { action: 'continue', sessionId: original.sessionId, message: '启动要停止的旧轮', background: true })
  const [receipt, old] = await Promise.all([find(exchanges, before, item => lastUser(item) === lastUser(main)),
    find(exchanges, before, item => lastUser(item).includes('启动要停止的旧轮'))])
  const oldRun = result(receipt, 'subagent').runId
  toolCall(old, 'admission_test_gate', {})
  await barrier.started()
  before = exchanges.length
  steer(receipt, 'subagent', 'ACCEPTED-BEFORE-STOP')
  const accepted = await find(exchanges, before, item => lastUser(item) === lastUser(main))
  expect(result(accepted, 'subagent')).toMatchObject({ status: 'accepted', runId: oldRun })
  const stopping = app.call(`/api/sessions/${root}/subagents/${original.sessionId}/stop`, { runId: oldRun })
  let stoppingMain: Exchange
  let stoppedBefore: number
  try {
    await barrier.aborted()
    stoppedBefore = exchanges.length
    steer(accepted, 'subagent', 'STOPPING-ROOT-STEER')
    steer(idleScout, 'team', 'STOPPING-TEAM-STEER')
    const [rejectedMain, rejectedScout] = await responses(stoppedBefore, main, scout)
    expect(result(rejectedMain, 'subagent')).toMatchObject({ status: 'stopping', message: expect.stringContaining('正在停止') })
    expect(result(rejectedScout, 'team')).toMatchObject({ status: 'stopping', message: expect.stringContaining('正在停止') })
    stoppingMain = rejectedMain
  } finally { await barrier.release() }
  expect(await (await stopping).json()).toMatchObject({ runId: oldRun, status: 'aborted' })
  before = exchanges.length
  toolCall(stoppingMain, 'subagent', { action: 'continue', sessionId: original.sessionId, message: '开始新轮', background: false })
  const resumed = await find(exchanges, before, item => lastUser(item).includes('开始新轮'))
  const resumedRun = await member(app, root, 'reviewer', 'running')
  expect(resumedRun.runId).not.toBe(oldRun)
  expect(userTexts(resumed).join('\n')).not.toMatch(/ACCEPTED-BEFORE-STOP|IDLE-.*-STEER|STOPPING-.*-STEER/)
  expect(exchanges.slice(0, before).filter(item => lastUser(item).includes('启动要停止的旧轮'))).toEqual([old])
  finish(resumed)
  expect(await member(app, root, 'reviewer', 'completed')).toMatchObject({ runId: resumedRun.runId })
  const history = await saved(harness, app, original.sessionId)
  expect(history.runs.map(item => [item.id, item.status])).toEqual([
    [original.runId, 'completed'], [oldRun, 'aborted'], [resumedRun.runId, 'completed'],
  ])
  expect(history.pending?.map(item => ({ status: item.status, targetRunId: item.targetRunId, text: item.text }))).toEqual([
    { status: 'undelivered', targetRunId: oldRun, text: expect.stringContaining('ACCEPTED-BEFORE-STOP') },
  ])
}, 15000)

it('23b 纯文字收尾后，停止正在准备模型输入的子会话，插话仍标为未交付', async () => {
  const harness = await fixture()
  const barrier = await gate(harness.directory, 'context')
  const { app, root, children, main } = await roster(harness, '检查模型请求前的停止', ['reviewer', 'scout'])
  const reviewer = await member(app, root, 'reviewer', 'running')
  const target = children.get('reviewer')!, sender = children.get('scout')!
  target.delta({ role: 'assistant', content: '已经输出的初步回复' })
  toolCall(sender, 'team', { action: 'steer', sessionId: reviewer.sessionId, message: stagedSteer })
  const acknowledgment = await harness.requestNumber(5)
  expect(result(acknowledgment, 'team')).toMatchObject({ status: 'accepted', runId: reviewer.runId })

  target.finish()
  await barrier.started()
  const stopping = app.call(`/api/sessions/${root}/subagents/${reviewer.sessionId}/stop`, { runId: reviewer.runId })
  try {
    await barrier.aborted()
    expect(harness.provider.exchanges).toHaveLength(5)
  } finally { await barrier.release() }
  expect(await (await stopping).json()).toMatchObject({ runId: reviewer.runId, status: 'aborted' })
  expect(harness.provider.exchanges).toHaveLength(5)

  toolCall(main, 'subagent', { action: 'continue', sessionId: reviewer.sessionId, message: '另起一轮检查', background: false })
  const continued = await harness.requestNumber(6)
  expect(lastUser(continued)).toContain('另起一轮检查')
  expect(JSON.stringify(continued.body.messages)).not.toContain(stagedSteer)
  const newRun = await member(app, root, 'reviewer', 'running')
  expect(newRun.runId).not.toBe(reviewer.runId)
  finish(continued)
  const completed = await harness.requestNumber(7)
  expect(result(completed, 'subagent')).toMatchObject({ items: [{ runId: newRun.runId, status: 'completed' }] })
  finish(completed)
  await idle(app, root)

  const history = await saved(harness, app, reviewer.sessionId)
  expect(history.runs.map(item => [item.id, item.status])).toEqual([
    [reviewer.runId, 'aborted'], [newRun.runId, 'completed'],
  ])
  expect(JSON.stringify(history.messages)).not.toContain(stagedSteer)
  expect(history.pending).toMatchObject([
    { status: 'undelivered', targetRunId: reviewer.runId, text: expect.stringContaining(stagedSteer) },
  ])
}, 15000)

it('24 后台子 Agent 从原历史续用空闲直属主会话，并在原工具调用收到回复', async () => {
  const harness = await fixture()
  const { app, root, children, main } = await roster(harness, '原主会话用户问题', ['scout'])
  const memberInfo = await member(app, root, 'scout', 'running')
  finish(main, '原主会话历史标记 PARENT-HISTORY')
  await idle(app, root)
  const scout = children.get('scout')!
  toolCall(scout, 'team', { action: 'continue', name: 'parent', message: '请根据已有历史给出决定', background: false })
  const continued = await harness.requestNumber(4)
  expect(userTexts(continued)).toEqual(['原主会话用户问题', expect.stringContaining('子 Agent「scout」')])
  expect(lastUser(continued)).toContain('请根据已有历史给出决定')
  expect(continued.body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '原主会话历史标记 PARENT-HISTORY' }))
  const state = await app.snapshot(root)
  expect(state.runs).toHaveLength(2)
  expect(state.messages.find(entry => entry.id === state.running?.runId)?.agentSource).toEqual({
    name: 'scout', kind: 'continue', sessionId: memberInfo.sessionId,
  })
  expect(harness.provider.exchanges).toHaveLength(4)
  finish(continued, '主会话决定采用 PARENT-HISTORY')
  const scoutResult = await harness.requestNumber(5)
  expect(result(scoutResult, 'team')).toMatchObject({ items: [{ sessionId: root, runId: state.running?.runId,
    output: '主会话决定采用 PARENT-HISTORY' }] })
  finish(scoutResult, '子会话收到决定')
  finish(await harness.requestNumber(6))
  await idle(app, root)
}, 15000)

it('38 计划待审核时拒绝子 Agent 续用直属主会话，计划和消息队列保持原状态', async () => {
  const harness = await fixture()
  const { app, root, children, main } = await roster(harness, '准备后进入计划审核', ['scout'])
  finish(main)
  await idle(app, root)
  await app.accept(root, 'plan', '/plan 制定迁移计划')
  finish(await harness.requestNumber(4), 'Plan:\n1. 核对当前入口\n2. 保留已有接口')
  const review = await idle(app, root)
  expect(review.plan).toMatchObject({ state: 'review' })
  toolCall(children.get('scout')!, 'team', { action: 'continue', name: 'parent', message: '不应越过审核', background: false })
  const refused = await harness.requestNumber(5)
  expect(result(refused, 'team')).toMatchObject({ status: 'review', message: expect.stringContaining('待审核') })
  const after = await app.snapshot(root)
  expect(after.plan).toEqual(review.plan)
  expect(after.runs).toEqual(review.runs)
  expect(after.interaction).toEqual(review.interaction)
  expect(harness.provider.exchanges).toHaveLength(5)
}, 15000)
