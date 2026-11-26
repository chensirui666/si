import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { SessionStore } from '@agent-learning/coding-agent'
import { expect, it, vi } from 'vitest'
import { finish, fixture, stop, toolCall, userTexts, type Exchange } from './collaboration-fixture.js'

const childTask = '检查登录测试'
const childName = 'reviewer'
const finding = 'LOGIN-TEST-FINDING-12'
const reportId = (delegationId: string) => `agent:report:${delegationId}`
const single = { action: 'run', background: true, task: childTask, name: childName }

function containsUserText(exchange: Exchange, marker: string) {
  return userTexts(exchange).filter(text => typeof text === 'string' && text.includes(marker))
}

function completion(exchange: Exchange) {
  const [text] = containsUserText(exchange, '[后台完成报告')
  if (typeof text !== 'string') throw new Error('模型没有收到后台报告')
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}

function receipt(exchange: Exchange) {
  const message = [...exchange.body.messages].reverse().find(item => item.role === 'tool')
  if (typeof message?.content !== 'string') throw new Error('委派没有返回接单回执')
  const data = JSON.parse(message.content) as { delegationId: string; status: string; runId?: string; sessionId?: string }
  expect(data).toMatchObject({ delegationId: expect.any(String), status: 'accepted' })
  return data
}

async function background(setup: Awaited<ReturnType<typeof fixture>>, args: object = single) {
  const app = await setup.start()
  await app.saveKey()
  const root = await app.create(await app.pick())
  const started = await app.accept(root, 'start', '请安排后台检查')
  toolCall(await setup.requestNumber(1), 'subagent', args)
  await setup.requestNumber(3)
  const first = setup.provider.exchanges.slice(1, 3)
  const child = first.find(exchange => containsUserText(exchange, childTask).length)
  const main = first.find(exchange => exchange !== child)
  if (!child || !main) throw new Error('主会话或子会话没有接单')
  return { app, root, started, child, main, accepted: receipt(main) }
}

async function installGate(directory: string, hook: 'tool' | 'agent_settled' = 'tool') {
  const paths = { started: join(directory, 'started'), aborted: join(directory, 'aborted'), release: join(directory, 'release') }
  const extensionDir = join(directory, 'global-context', 'extensions')
  const filename = join(extensionDir, 'report-gate.ts')
  await mkdir(extensionDir, { recursive: true })
  const wait = `
    await writeFile(${JSON.stringify(paths.started)}, '')
    while (!await access(${JSON.stringify(paths.release)}).then(() => true, () => false)) await setTimeout(5)
  `
  await writeFile(filename, `
    import { access, writeFile } from 'node:fs/promises'
    import { setTimeout } from 'node:timers/promises'
    ${hook === 'tool' ? `
      export default si => si.registerTool({
        name: 'report_gate', description: '控制后台报告到达时点', parameters: { type: 'object', properties: {} },
        async execute(_args, { signal }) {
          signal.addEventListener('abort', () => { void writeFile(${JSON.stringify(paths.aborted)}, '') }, { once: true })
          ${wait}
          signal.throwIfAborted()
          return '门已打开'
        },
      })
    ` : `export default si => si.on('agent_settled', async () => { ${wait} })`}
  `)
  return {
    started: () => vi.waitFor(() => stat(paths.started), { timeout: 4000 }),
    aborted: () => vi.waitFor(() => stat(paths.aborted), { timeout: 4000 }),
    release: () => writeFile(paths.release, ''),
    remove: () => rm(filename),
  }
}

function readState(directory: string, root: string, childId?: string) {
  const store = SessionStore.open(join(directory, 'sessions.sqlite'))
  try {
    return { work: store.listDelegations(root)[0], root: store.loadSession(root), child: childId ? store.loadSession(childId) : undefined }
  } finally { store.close() }
}

it('50 空闲主会话用会话级停止结束后台子轮和真实 Bash', async () => {
  const setup = await fixture()
  const { app, root, child, main, accepted } = await background(setup)
  const pidFile = join(setup.directory, 'idle-bash.pid')
  toolCall(main, 'bash', { command: 'echo "$$" > idle-bash.pid; exec sleep 30', background: true, timeout: 10 })
  const afterBash = await setup.requestNumber(4)
  const pid = await vi.waitFor(async () => {
    const value = Number(await readFile(pidFile, 'utf8'))
    expect(value).toBeGreaterThan(1)
    return value
  })
  expect(() => process.kill(pid, 0)).not.toThrow()
  finish(afterBash)
  await vi.waitFor(async () => {
    const state = await app.snapshot(root)
    expect(state.running).toBeNull()
    expect(state.subagents).toMatchObject([{ runId: accepted.runId, status: 'running' }])
  })
  const stopping = await app.call(`/api/sessions/${root}/stop`)
  expect(stopping.status).toBe(200)
  expect(await stopping.json()).toMatchObject({ stopped: 2, unconfirmed: 0 })
  await vi.waitFor(() => expect(child.closed).toBe(true))
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect((await app.snapshot(root)).subagents).toMatchObject([{ runId: accepted.runId, status: 'aborted' }])
  expect(setup.provider.exchanges).toHaveLength(4)
  await app.accept(root, 'resume', '停止后继续')
  const resumed = await setup.requestNumber(5)
  expect(userTexts(resumed).at(-1)).toBe('停止后继续')
  finish(resumed)
}, 15000)

it('51 会话级停止覆盖接单中的子任务和仍在登记的 Bash', async () => {
  const setup = await fixture()
  const extensionDir = join(setup.directory, 'global-context', 'extensions')
  const filename = join(extensionDir, 'stopping-race.ts')
  const release = join(setup.directory, 'release')
  const runtimeModule = fileURLToPath(new URL('../../coding-agent/dist/index.js', import.meta.url))
  await mkdir(extensionDir, { recursive: true })
  await writeFile(filename, `
    import { access, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { createRequire } from 'node:module'
    import { setTimeout } from 'node:timers/promises'
    const { ToolRuntime } = createRequire(${JSON.stringify(filename)})(${JSON.stringify(runtimeModule)})
    const root = ${JSON.stringify(setup.directory)}
    async function hold(name, signal) {
      const onAbort = () => { void writeFile(join(root, name + '-aborted'), '') }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await writeFile(join(root, name + '-started'), '')
        while (!await access(${JSON.stringify(release)}).then(() => true, () => false)) await setTimeout(5)
      } finally { signal.removeEventListener('abort', onAbort) }
    }
    const run = ToolRuntime.prototype.run
    ToolRuntime.prototype.run = function(command, args, options) {
      if (command !== '/bin/bash' || !args[1]?.includes('race-bash.pid')) return run.call(this, command, args, options)
      return hold('bash', options.signal).then(() => run.call(this, command, args, options))
    }
    export default si => si.on('before_agent_start', (event, ctx) => {
      if (event.prompt.includes('等待接单')) return hold('child', ctx.signal)
    })
  `)
  const wait = (name: string) => vi.waitFor(() => stat(join(setup.directory, name)), { timeout: 4000 })
  const app = await setup.start()
  await app.saveKey()
  const root = await app.create(await app.pick())
  await app.accept(root, 'start', '同时安排两项检查')
  toolCall(await setup.requestNumber(1), 'subagent', { action: 'run', background: true, chain: [
    { task: '等待接单', name: 'first' }, { task: '不应启动', name: 'second' },
  ] })
  const main = await setup.requestNumber(2)
  const accepted = receipt(main)
  toolCall(main, 'bash', { command: 'echo "$$" > race-bash.pid; exec sleep 30', background: true, timeout: 10 })
  await Promise.all([wait('child-started'), wait('bash-started')])

  const stopping = app.call(`/api/sessions/${root}/stop`)
  try {
    await Promise.all([wait('child-aborted'), wait('bash-aborted')])
    const incoming = await app.call('/api/messages', { sessionId: root, clientMessageId: 'late', text: '停止中不接单', modelId: 'deepseek-flash' })
    expect(incoming.status).toBe(409)
    expect(setup.provider.exchanges).toHaveLength(2)
  } finally { await writeFile(release, '') }
  const stopped = await stopping
  expect(stopped.status).toBe(200)
  expect(await stopped.json()).toMatchObject({ unconfirmed: 0 })
  await expect(stat(join(setup.directory, 'race-bash.pid'))).rejects.toMatchObject({ code: 'ENOENT' })
  const state = await app.snapshot(root)
  expect(state.running).toBeNull()
  expect(state.subagents).toEqual([])
  expect(state.runs).toMatchObject([{ clientMessageId: 'start', status: 'aborted' }])
  expect(state.delegationOutputs).toHaveLength(1)
  expect(JSON.parse(state.delegationOutputs![0]!.output)).toMatchObject({
    delegationId: accepted.delegationId, items: [{ status: 'aborted' }, { status: 'not-started' }],
  })
  const jobs = await app.request(`/api/sessions/${root}/jobs`)
  expect(await jobs.json()).toMatchObject({ jobs: [] })
  expect(setup.provider.exchanges).toHaveLength(2)
}, 15000)

it('52 会话级停止只在原调用显示迟到的报告，用户队首暂停保留', async () => {
  const setup = await fixture()
  const gate = await installGate(setup.directory, 'agent_settled')
  const { app, root, child, main, accepted } = await background(setup)
  expect((await app.accept(root, 'readme', '改 README')).kind).toBe('queued')
  finish(child, finding)
  await gate.started()
  const stopping = app.call(`/api/sessions/${root}/stop`)
  try { await vi.waitFor(() => expect(main.closed).toBe(true), { timeout: 4000 }) }
  finally { await gate.release() }

  const stopped = await stopping
  expect(stopped.status).toBe(200)
  expect(await stopped.json()).toMatchObject({ unconfirmed: 0 })
  const paused = await app.snapshot(root)
  expect(paused.running).toBeNull()
  expect(paused.interaction?.queue).toMatchObject({ items: [{ clientMessageId: 'readme' }], paused: expect.any(String) })
  expect(paused.interaction?.steering).toEqual([])
  expect(paused.delegationOutputs).toHaveLength(1)
  expect(JSON.parse(paused.delegationOutputs![0]!.output)).toMatchObject({
    delegationId: accepted.delegationId, items: [{ output: finding, status: 'completed' }],
  })
  expect(setup.provider.exchanges).toHaveLength(3)
  expect((await app.accept(root, 'resume', '继续')).kind).toBe('queued')
  const readme = await setup.requestNumber(4)
  expect(userTexts(readme).at(-1)).toBe('改 README')
  expect(containsUserText(readme, finding)).toHaveLength(0)
  finish(readme)
  const resumed = await setup.requestNumber(5)
  expect(userTexts(resumed).at(-1)).toBe('继续')
  expect(containsUserText(resumed, finding)).toHaveLength(0)
  finish(resumed)
  await vi.waitFor(async () => {
    const state = await app.snapshot(root)
    expect(state.running).toBeNull()
    expect(state.runs?.map(run => run.clientMessageId)).toEqual(['start', 'readme', 'resume'])
  })
  expect(setup.provider.exchanges).toHaveLength(5)
}, 15000)

it('53 后台报告在当前工具完成后进入同一轮的下一次请求', async () => {
  const setup = await fixture()
  const gate = await installGate(setup.directory)
  const { app, root, started, child, main, accepted } = await background(setup)
  toolCall(main, 'report_gate', {})
  await gate.started()
  finish(child, finding)
  await vi.waitFor(async () => {
    const state = await app.snapshot(root)
    expect(state.running).toMatchObject({ runId: started.userMessageId, phase: 'tools' })
    expect(state.interaction?.steering).toMatchObject([{ clientMessageId: reportId(accepted.delegationId), text: expect.stringContaining(finding) }])
  })
  expect(setup.provider.exchanges).toHaveLength(3)
  await gate.release()
  const next = await setup.requestNumber(4)
  expect(next.body.messages.some(message => message.role === 'tool' && String(message.content).includes('门已打开'))).toBe(true)
  expect(containsUserText(next, finding)).toHaveLength(1)
  const state = await app.snapshot(root)
  expect(state.running).toMatchObject({ runId: started.userMessageId })
  expect(state.runs).toHaveLength(1)
  expect(state.messages.filter(entry => entry.clientMessageId === reportId(accepted.delegationId))).toMatchObject([{
    steering: true, runId: started.userMessageId, agentSource: { kind: 'report', sessionId: accepted.sessionId, name: childName },
  }])
  finish(next)
}, 15000)

it('54 空闲主会话由后台报告开启新轮，原工具调用显示同一结果', async () => {
  const setup = await fixture()
  const { app, root, started, child, main, accepted } = await background(setup)
  finish(main)
  await vi.waitFor(async () => expect((await app.snapshot(root)).running).toBeNull())
  finish(child, finding)
  const next = await setup.requestNumber(4)
  const result = completion(next)
  expect(result).toMatchObject({ delegationId: accepted.delegationId, items: [{ status: 'completed', output: finding }] })
  expect(containsUserText(next, finding)).toHaveLength(1)
  const state = await app.snapshot(root)
  expect(state.runs).toMatchObject([
    { id: started.userMessageId, status: 'completed' }, { clientMessageId: reportId(accepted.delegationId), status: 'running' },
  ])
  const call = state.messages.find(entry => entry.message.role === 'toolResult' && entry.message.toolName === 'subagent')
  expect(call?.toolCall).toMatchObject({ assistantMessageId: expect.any(String), contentIndex: 0 })
  expect(state.delegationOutputs).toMatchObject([{ ...call!.toolCall, output: expect.any(String) }])
  expect(JSON.parse(state.delegationOutputs![0]!.output)).toEqual(result)
  finish(next)
}, 15000)

it('55 普通停止收尾时新到的报告排在用户的 README 请求之后并恢复执行', async () => {
  const setup = await fixture()
  const gate = await installGate(setup.directory)
  const { app, root, started, child, main, accepted } = await background(setup)
  toolCall(main, 'report_gate', {})
  await gate.started()
  expect((await app.accept(root, 'readme', '改 README')).kind).toBe('queued')
  const aborting = app.call('/api/abort', { sessionId: root, runId: started.userMessageId })
  try {
    await gate.aborted()
    finish(child, finding)
    await vi.waitFor(async () => {
      const state = await app.snapshot(root)
      expect(state.interaction?.queue.items.map(item => item.clientMessageId)).toEqual(['readme', reportId(accepted.delegationId)])
      expect(state.interaction?.steering).toEqual([])
    })
    expect(setup.provider.exchanges).toHaveLength(3)
  } finally { await gate.release() }
  expect(await (await aborting).json()).toMatchObject({ handled: true })
  const readme = await setup.requestNumber(4)
  expect(userTexts(readme).at(-1)).toBe('改 README')
  expect(containsUserText(readme, finding)).toHaveLength(0)
  finish(readme)
  const report = await setup.requestNumber(5)
  expect(completion(report)).toMatchObject({ delegationId: accepted.delegationId, items: [{ output: finding }] })
  expect(containsUserText(report, finding)).toHaveLength(1)
  finish(report)
  await vi.waitFor(async () => {
    const state = await app.snapshot(root)
    expect(state.running).toBeNull()
    expect(state.runs?.map(run => [run.clientMessageId, run.status])).toEqual([
      ['start', 'aborted'], ['readme', 'completed'], [reportId(accepted.delegationId), 'completed'],
    ])
  })
}, 15000)

it('普通停止保留已接收但没交给模型的后台报告，收到新消息后只交付一次', async () => {
  const setup = await fixture()
  const gate = await installGate(setup.directory)
  const { app, root, started, child, main, accepted } = await background(setup)
  toolCall(main, 'report_gate', {})
  await gate.started()
  finish(child, finding)
  const id = reportId(accepted.delegationId)
  await vi.waitFor(async () => {
    expect((await app.snapshot(root)).interaction?.steering).toMatchObject([{ clientMessageId: id }])
  })
  const aborting = app.call('/api/abort', { sessionId: root, runId: started.userMessageId })
  try { await gate.aborted() }
  finally { await gate.release() }
  expect(await (await aborting).json()).toMatchObject({ handled: true })
  const paused = await app.snapshot(root)
  expect(paused.running).toBeNull()
  expect(paused.runs).toMatchObject([{ id: started.userMessageId, status: 'aborted' }])
  expect(paused.interaction?.queue.paused).toEqual(expect.any(String))
  expect(paused.interaction?.steering).toMatchObject([{ clientMessageId: id }])
  expect(paused.messages.some(entry => entry.clientMessageId === id)).toBe(false)
  expect(setup.provider.exchanges).toHaveLength(3)

  const nextRun = await app.accept(root, 'resume', '继续检查')
  const next = await setup.requestNumber(4)
  expect(userTexts(next).at(-1)).toBe('继续检查')
  expect(containsUserText(next, finding)).toHaveLength(1)
  expect((await app.snapshot(root)).messages.filter(entry => entry.clientMessageId === id)).toMatchObject([{
    steering: true, runId: nextRun.userMessageId, agentSource: { kind: 'report', sessionId: accepted.sessionId, name: childName },
  }])
  finish(next)
}, 15000)

it('普通停止期间新报告能自动开始，停止前的报告等到用户主动提交', async () => {
  const setup = await fixture()
  const gate = await installGate(setup.directory)
  const { app, root, started, child, main, accepted } = await background(setup)
  const secondTask = '核对付款测试'
  const secondFinding = 'PAYMENT-TEST-FINDING-12'
  toolCall(main, 'subagent', { action: 'run', task: secondTask, name: 'payment', background: true })
  await setup.requestNumber(5)
  const nextExchanges = setup.provider.exchanges.slice(3, 5)
  const secondChild = nextExchanges.find(exchange => containsUserText(exchange, secondTask).length)
  const mainAfterReceipt = nextExchanges.find(exchange => exchange !== secondChild)
  if (!secondChild || !mainAfterReceipt) throw new Error('第二次委派未接单')
  const secondReceipt = receipt(mainAfterReceipt)
  expect(secondReceipt.delegationId).not.toBe(accepted.delegationId)

  toolCall(mainAfterReceipt, 'report_gate', {})
  await gate.started()
  finish(child, finding)
  const firstId = reportId(accepted.delegationId)
  const secondId = reportId(secondReceipt.delegationId)
  await vi.waitFor(async () => {
    expect((await app.snapshot(root)).interaction?.steering).toMatchObject([{ clientMessageId: firstId }])
  })

  const aborting = app.call('/api/abort', { sessionId: root, runId: started.userMessageId })
  try {
    await gate.aborted()
    finish(secondChild, secondFinding)
    await vi.waitFor(async () => {
      const state = await app.snapshot(root)
      expect(state.interaction?.queue.items).toMatchObject([{ clientMessageId: secondId }])
    })
    expect(setup.provider.exchanges).toHaveLength(5)
  } finally { await gate.release() }
  expect(await (await aborting).json()).toMatchObject({ handled: true })

  const automatic = await setup.requestNumber(6)
  expect(completion(automatic)).toMatchObject({ delegationId: secondReceipt.delegationId })
  expect(containsUserText(automatic, secondFinding)).toHaveLength(1)
  expect(containsUserText(automatic, finding)).toHaveLength(0)
  finish(automatic)
  await vi.waitFor(async () => {
    const state = await app.snapshot(root)
    expect(state.running).toBeNull()
    expect(state.runs).toMatchObject([
      { clientMessageId: 'start', status: 'aborted' }, { clientMessageId: secondId, status: 'completed' },
    ])
    expect(state.messages.filter(entry => entry.clientMessageId === firstId)).toHaveLength(0)
  })
  expect(setup.provider.exchanges).toHaveLength(6)

  const user = await app.accept(root, 'resume', '继续处理报告')
  const resumed = await setup.requestNumber(7)
  expect(userTexts(resumed).at(-1)).toBe('继续处理报告')
  expect(containsUserText(resumed, finding)).toHaveLength(1)
  expect((await app.snapshot(root)).messages.filter(entry => entry.clientMessageId === firstId)).toMatchObject([{
    runId: user.userMessageId, steering: true, agentSource: { kind: 'report', sessionId: accepted.sessionId, name: childName },
  }])
  finish(resumed)
}, 15000)

it('56 服务进程退出后重建批次报告，保留已完成、已中断与未启动项', async () => {
  const setup = await fixture()
  const { app, root, child, accepted } = await background(setup, { action: 'run', background: true, chain: [
    { task: childTask, name: 'first' }, { task: '核对第一项结论 {previous}', name: 'second' }, { task: '第三项检查', name: 'third' },
  ] })
  finish(child, finding)
  const second = await setup.requestNumber(4)
  expect(containsUserText(second, `核对第一项结论 ${finding}`)).toHaveLength(1)
  expect(await stop(app.child, 'SIGKILL')).toEqual([null, 'SIGKILL'])
  const before = readState(setup.directory, root)
  expect(before.work?.finished).toBeUndefined()
  expect(before.work?.report).toBeUndefined()
  expect(before.work?.items.map(item => item.status)).toEqual(['completed', 'running', 'not-started'])

  const reopened = await setup.start()
  const resumed = await setup.requestNumber(5)
  expect(completion(resumed)).toMatchObject({
    delegationId: accepted.delegationId,
    items: [{ status: 'completed', output: finding }, { status: 'interrupted' }, { status: 'not-started' }],
  })
  const state = await reopened.snapshot(root)
  expect(state.subagents?.map(task => [task.name, task.status])).toEqual([['first', 'completed'], ['second', 'interrupted']])
  expect(state.runs?.map(run => run.clientMessageId)).toEqual(['start', reportId(accepted.delegationId)])
  finish(resumed)
}, 15000)

it('57 单项结果已持久化但报告尚未生成时重启，补送原结果且子任务不重跑', async () => {
  const setup = await fixture()
  const gate = await installGate(setup.directory, 'agent_settled')
  const { app, root, child, accepted } = await background(setup)
  finish(child, finding)
  await gate.started()
  expect(await stop(app.child, 'SIGKILL')).toEqual([null, 'SIGKILL'])
  await gate.remove()
  const before = readState(setup.directory, root, accepted.sessionId)
  expect(before.work?.finished).toBeUndefined()
  expect(before.work?.report).toBeUndefined()
  expect(before.work?.items).toMatchObject([{ sessionId: accepted.sessionId, runId: accepted.runId, status: 'completed', output: finding }])
  expect(before.child?.runs).toMatchObject([{ id: accepted.runId, status: 'completed' }])

  const reopened = await setup.start()
  const resumed = await setup.requestNumber(4)
  expect(completion(resumed)).toMatchObject({
    delegationId: accepted.delegationId,
    items: [{ sessionId: accepted.sessionId, runId: accepted.runId, status: 'completed', output: finding }],
  })
  await expect(reopened.snapshot(root)).resolves.toMatchObject({ subagents: [
    { sessionId: accepted.sessionId, runId: accepted.runId, status: 'completed' },
  ] })
  finish(resumed)
  await vi.waitFor(async () => expect((await reopened.snapshot(root)).running).toBeNull())
  expect(await stop(reopened.child, 'SIGTERM')).toEqual([0, null])
  const after = readState(setup.directory, root, accepted.sessionId)
  expect(after.work?.report).toBe('delivered')
  expect(after.child?.runs).toHaveLength(1)
  expect(setup.provider.exchanges).toHaveLength(4)
}, 15000)

it('58 接收方已存报告后重启重投，原编号只进入会话和模型一次', async () => {
  const setup = await fixture()
  const gate = await installGate(setup.directory)
  const { app, root, child, main, accepted } = await background(setup)
  toolCall(main, 'report_gate', {})
  await gate.started()
  finish(child, finding)
  const id = reportId(accepted.delegationId)
  await vi.waitFor(async () => {
    expect((await app.snapshot(root)).interaction?.steering).toMatchObject([{ clientMessageId: id }])
  })
  expect(await stop(app.child, 'SIGKILL')).toEqual([null, 'SIGKILL'])
  await gate.remove()
  const before = readState(setup.directory, root)
  expect(before.root?.pending?.filter(item => item.input.clientMessageId === id)).toMatchObject([{ status: 'steering' }])
  expect(before.root?.messages.some(entry => entry.clientMessageId === id)).toBe(false)

  // Recreate a crash before the sender's acknowledgement commits, preserving the receiver's actual saved input.
  const db = new DatabaseSync(join(setup.directory, 'sessions.sqlite'))
  try {
    expect(db.prepare("UPDATE delegations SET report = 'pending' WHERE id = ? AND report = 'delivered'").run(accepted.delegationId).changes).toBe(1)
  } finally { db.close() }

  const reopened = await setup.start()
  const paused = await reopened.snapshot(root)
  expect(paused.interaction?.steering.map(item => item.clientMessageId)).toEqual([id])
  expect(setup.provider.exchanges).toHaveLength(3)
  const next = await reopened.accept(root, 'resume', '继续检查')
  const resumed = await setup.requestNumber(4)
  expect(containsUserText(resumed, finding)).toHaveLength(1)
  expect(completion(resumed)).toMatchObject({ delegationId: accepted.delegationId })
  finish(resumed)
  await vi.waitFor(async () => expect((await reopened.snapshot(root)).running).toBeNull())
  expect(await stop(reopened.child, 'SIGTERM')).toEqual([0, null])
  const after = readState(setup.directory, root)
  expect(after.work?.report).toBe('delivered')
  expect(after.root?.pending?.filter(item => item.input.clientMessageId === id)).toMatchObject([{ status: 'delivered' }])
  expect(after.root?.messages.filter(entry => entry.clientMessageId === id)).toMatchObject([{ runId: next.userMessageId, steering: true }])
  expect(setup.provider.exchanges).toHaveLength(4)
}, 15000)
