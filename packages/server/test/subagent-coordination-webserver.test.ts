import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { finish, fixture, toolCall, userTexts, type Exchange } from './collaboration-fixture.js'

function toolCalls(exchange: Exchange, calls: { name: string; args: object }[]) {
  exchange.delta({ role: 'assistant', tool_calls: calls.map(({ name, args }, index) => ({
    index, id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
  })) })
  exchange.finish('tool_calls')
}

function toolResults(exchange: Exchange) {
  return exchange.body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(String(message.content)))
}

function taskExchange(exchanges: Exchange[], task: string) {
  return vi.waitFor(() => {
    const found = exchanges.find(exchange => userTexts(exchange).at(-1) === 'Task: ' + task)
    if (!found) throw new Error(`未启动子任务 ${task}`)
    return found
  }, { timeout: 3500 })
}

async function ready(text: string) {
  const setup = await fixture()
  const app = await setup.start()
  await app.saveKey()
  const sessionId = await app.create(await app.pick())
  const receipt = await app.accept(sessionId, 'initial', text)
  const first = await setup.requestNumber(1)
  return { ...setup, app, sessionId, first, runId: receipt.userMessageId! }
}

it('11 并行任务重叠，按输入顺序保留失败和实际成功结果', async () => {
  const { app, sessionId, first, provider, requestNumber } = await ready('并行检查')
  toolCall(first, 'subagent', { action: 'run', background: false, tasks: [
    { name: 'first', task: 'first' }, { name: 'second', task: 'second' },
  ] })
  const [a, b] = await Promise.all([taskExchange(provider.exchanges, 'first'), taskExchange(provider.exchanges, 'second')])
  expect(provider.exchanges).toHaveLength(3)
  finish(b, 'second verified')
  await vi.waitFor(async () => expect((await app.snapshot(sessionId)).subagents).toContainEqual(expect.objectContaining({ name: 'second', status: 'completed' })))
  provider.rejectOnce({ status: 401, code: 'invalid_api_key' })
  toolCall(a, 'ls', {})
  const main = await requestNumber(4)
  expect(toolResults(main).at(-1)).toMatchObject({ items: [
    { name: 'first', status: 'failed' }, { name: 'second', status: 'completed', output: 'second verified' },
  ] })
  finish(main)
})

it.each([false, true])('13/14 串行只传递上一步，失败保留未启动项（失败=%s）', async fails => {
  const { first, requestNumber, provider } = await ready('按三个步骤检查')
  toolCall(first, 'subagent', { action: 'run', background: false, chain: [
    { name: 'first', task: '第一步' },
    { name: 'second', task: '第二步接收 {previous}', ...(fails && { cwd: '/unavailable-si-fixture' }) },
    { name: 'third', task: '第三步接收 {previous}' },
  ] })
  finish(await requestNumber(2), 'A $&')
  if (fails) {
    const parent = await requestNumber(3)
    expect(toolResults(parent).at(-1)).toMatchObject({ items: [
      { status: 'completed', output: 'A $&' }, { status: 'failed', error: expect.stringContaining('目录不可用') }, { status: 'not-started' },
    ] })
    finish(parent)
    expect(provider.exchanges).toHaveLength(3)
  } else {
    const second = await requestNumber(3)
    expect(userTexts(second).at(-1)).toBe('Task: 第二步接收 A $&')
    finish(second, 'B')
    const third = await requestNumber(4)
    expect(userTexts(third).at(-1)).toBe('Task: 第三步接收 B')
    finish(third, 'C')
    const parent = await requestNumber(5)
    expect(toolResults(parent).at(-1)).toMatchObject({ output: 'C', items: [
      { output: 'A $&' }, { output: 'B' }, { output: 'C' },
    ] })
    finish(parent)
  }
})

it('12 和 42 同批新建与续用分别回填，迟到的停止请求只返回旧轮状态', async () => {
  const { first, requestNumber, provider, app, sessionId } = await ready('并行新建与续用')
  toolCall(first, 'subagent', { action: 'run', task: 'old', name: 'old', background: false })
  finish(await requestNumber(2), '旧历史 ID: SI-12')
  const parent = await requestNumber(3)
  const existing = (await app.snapshot(sessionId)).subagents?.[0]
  toolCalls(parent, [
    { name: 'subagent', args: { action: 'run', task: 'new', name: 'new', background: false } },
    { name: 'subagent', args: { action: 'continue', sessionId: existing?.sessionId, message: '沿用旧历史', background: false } },
  ])
  const created = await taskExchange(provider.exchanges, 'new')
  const resumed = await vi.waitFor(() => {
    const found = provider.exchanges.find(exchange => String(userTexts(exchange).at(-1)).includes('沿用旧历史'))
    if (!found) throw new Error('续用尚未启动')
    return found
  })
  expect(resumed.body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '旧历史 ID: SI-12' }))
  const oldStop = await app.call(`/api/sessions/${sessionId}/subagents/${existing?.sessionId}/stop`, { runId: existing?.runId })
  expect(await oldStop.json()).toMatchObject({ runId: existing?.runId, status: 'completed' })
  expect(resumed.closed).toBe(false)
  finish(resumed, '续用答复')
  finish(created, '新建答复')
  const main = await requestNumber(6)
  expect(toolResults(main).slice(-2)).toMatchObject([{ items: [{ output: '新建答复' }] }, { items: [{ output: '续用答复' }] }])
  finish(main)
})

it('18 两批共占八个名额，超额的新任务拒绝，其他主会话可接单', async () => {
  const { app, first, provider, requestNumber, sessionId } = await ready('占满子任务')
  const tasks = Array.from({ length: 8 }, (_, index) => ({ name: `worker-${index}`, task: `worker-${index}` }))
  toolCalls(first, [0, 4].map(offset => ({ name: 'subagent', args: { action: 'run', tasks: tasks.slice(offset, offset + 4), background: true } })))
  const children = await Promise.all(tasks.map(task => taskExchange(provider.exchanges, task.task)))
  const parent = await vi.waitFor(() => {
    const found = provider.exchanges.find(exchange => exchange !== first && !children.includes(exchange))
    if (!found) throw new Error('主会话尚未收到后台回执')
    return found
  })
  expect(children.every(child => !child.closed)).toBe(true)
  toolCall(parent, 'subagent', { action: 'run', task: '不得启动', background: false })
  const next = await requestNumber(11)
  expect(next.body.messages.filter(message => message.role === 'tool').at(-1)?.content).toContain('8 个子任务并发上限')
  const current = (await app.snapshot(sessionId)).subagents
  expect(current).toHaveLength(8)
  const worker = current?.find(child => child.name === 'worker-0')
  const release = await app.call(`/api/sessions/${sessionId}/subagents/${worker?.sessionId}/stop`, { runId: worker?.runId })
  expect(await release.json()).toMatchObject({ status: 'aborted' })
  toolCalls(next, [
    { name: 'subagent', args: { action: 'run', task: '竞争名额', background: true } },
    { name: 'subagent', args: { action: 'continue', name: 'worker-0', message: '续用竞争', background: true } },
  ])
  await requestNumber(13)
  const race = provider.exchanges.slice(11).find(exchange => userTexts(exchange)[0] === '占满子任务')!
  const receipts = race.body.messages.filter(message => message.role === 'tool').slice(-2).map(message => String(message.content))
  expect(receipts.filter(text => text.includes('"status":"accepted"'))).toHaveLength(1)
  expect(receipts.filter(text => text.includes('8 个子任务并发上限'))).toHaveLength(1)
  expect((await app.snapshot(sessionId)).subagents?.filter(child => child.status === 'running')).toHaveLength(8)
  finish(race)
  const otherId = await app.create(await app.pick())
  await app.accept(otherId, 'other', '另一个会话')
  toolCall(await requestNumber(14), 'subagent', { action: 'run', task: '独立名额', background: false })
  finish(await requestNumber(15), '独立会话已接单')
  finish(await requestNumber(16))
  const stopped = await app.call(`/api/sessions/${sessionId}/stop`)
  expect(await stopped.json()).toMatchObject({ stopped: 8, unconfirmed: 0 })
}, 15000)

it('29–31、33、37 同伴插话续用在实际当前轮状态下分流', async () => {
  const { app, first, provider, requestNumber, sessionId } = await ready('前台协作')
  toolCall(first, 'subagent', { action: 'run', background: false, tasks: [
    { name: 'scout', task: '侦查' }, { name: 'reviewer', task: '审查' },
  ] })
  const [scout, reviewer] = await Promise.all([taskExchange(provider.exchanges, '侦查'), taskExchange(provider.exchanges, '审查')])
  reviewer.delta({ role: 'assistant', content: '原答复' })
  toolCall(scout, 'team', { action: 'list' })
  const located = await requestNumber(4)
  const [other] = toolResults(located).at(-1).agents
  expect(other).toMatchObject({ name: 'reviewer', status: 'running' })
  toolCall(located, 'team', { action: 'answer', name: 'reviewer' })
  const noAnswer = await requestNumber(5)
  expect(toolResults(noAnswer).at(-1)).toMatchObject({ sessionId: other.sessionId, output: null })
  toolCalls(noAnswer, [
    { name: 'team', args: { action: 'steer', sessionId: other.sessionId, message: 'SCOUT-2942' } },
    { name: 'team', args: { action: 'steer', name: 'parent', message: 'PARENT-3022' } },
    ...[false, true].map(background => ({ name: 'team', args: { action: 'continue', name: 'parent', message: '不能启动新轮', background } })),
  ])
  const confirmation = await requestNumber(6)
  expect(toolResults(confirmation).slice(-4)).toMatchObject([
    { status: 'accepted', runId: other.runId }, { status: 'accepted' }, { status: 'running' }, { status: 'running' },
  ])
  finish(confirmation, '侦查已完成')
  reviewer.finish()
  const reevaluate = await requestNumber(7)
  expect(reevaluate.body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '原答复' }))
  expect(userTexts(reevaluate).filter(text => String(text).includes('SCOUT-2942'))).toEqual([expect.stringContaining('scout')])
  expect((await app.snapshot(sessionId)).subagents).toContainEqual(expect.objectContaining({ runId: other.runId, status: 'running' }))
  finish(reevaluate, '按侦查结果修订')
  const main = await requestNumber(8)
  expect(userTexts(main).filter(text => String(text).includes('PARENT-3022'))).toHaveLength(1)
  expect(toolResults(main).at(-1)).toMatchObject({ items: [{ output: '侦查已完成' }, { output: '按侦查结果修订' }] })
  finish(main)
})

it('28 跨聊天工具和 HTTP 都不能访问已知子会话 ID', async () => {
  const { app, sessionId, first, requestNumber } = await ready('建立会话隔离')
  toolCall(first, 'subagent', { action: 'run', task: '私有任务', name: 'isolated', background: false })
  finish(await requestNumber(2), '仅原会话能看到')
  const main = await requestNumber(3)
  const child = (await app.snapshot(sessionId)).subagents?.[0]
  expect(child).toBeDefined()
  finish(main)
  const other = await app.create(await app.pick())
  const wrong = await app.call(`/api/sessions/${other}/subagents/${child?.sessionId}/stop`, { runId: child?.runId })
  expect(wrong.status).toBe(404)
  expect((await app.call('/api/messages', { sessionId: child?.sessionId, clientMessageId: 'wrong', modelId: 'deepseek-flash', text: '非法续用' })).status).toBe(404)
  await app.accept(other, 'other', '查询别人的子任务')
  toolCall(await requestNumber(4), 'subagent', { action: 'status', sessionId: child?.sessionId })
  const refused = await requestNumber(5)
  const result = refused.body.messages.filter(message => message.role === 'tool').at(-1)?.content
  expect(result).toContain('找不到')
  expect(result).not.toContain('仅原会话能看到')
  finish(refused)
})

it('43/44 停止主轮只取消直接等待的前台子任务，后台仍回报', async () => {
  const { app, sessionId, runId, first, provider, requestNumber } = await ready('停止主轮')
  toolCalls(first, [
    { name: 'subagent', args: { action: 'run', name: 'fore', task: '前台', background: false } },
    { name: 'subagent', args: { action: 'run', name: 'back', task: '后台', background: true } },
  ])
  const [front, back] = await Promise.all([taskExchange(provider.exchanges, '前台'), taskExchange(provider.exchanges, '后台')])
  const abort = await app.call('/api/abort', { sessionId, runId })
  expect(await abort.json()).toMatchObject({ handled: true })
  await vi.waitFor(() => expect(front.closed).toBe(true))
  expect(back.closed).toBe(false)
  expect((await app.snapshot(sessionId)).subagents).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'fore', status: 'aborted' }), expect.objectContaining({ name: 'back', status: 'running' }),
  ]))
  finish(back, '仍交付 BACK-44')
  const next = await requestNumber(4)
  expect(userTexts(next).at(-1)).toContain('仍交付 BACK-44')
  finish(next)
})

it.each([false, true])('25/26、35/36 同伴续用带旧历史，输出只回到发起者（后台=%s）', async background => {
  const { app, sessionId, first, requestNumber, provider } = await ready('两个协作成员')
  toolCall(first, 'subagent', { action: 'run', name: 'reviewer', task: '先留结论', background: false })
  finish(await requestNumber(2), '旧审查结论 SI-3526')
  const main = await requestNumber(3)
  toolCall(main, 'subagent', { action: 'status' })
  const status = await requestNumber(4)
  const [fromMain] = toolResults(status).at(-1).agents
  expect(fromMain).toMatchObject({ status: 'completed', name: 'reviewer' })
  toolCall(status, 'subagent', { action: 'run', name: 'scout', task: '找同伴并续办', background: false })
  toolCall(await requestNumber(5), 'team', { action: 'list' })
  const scout = await requestNumber(6)
  expect(toolResults(scout).at(-1).agents).toEqual([fromMain])
  toolCall(scout, 'team', { action: 'answer', name: 'reviewer' })
  const answer = await requestNumber(7)
  expect(toolResults(answer).at(-1)).toEqual({ sessionId: fromMain.sessionId, output: '旧审查结论 SI-3526' })
  toolCall(answer, 'team', { action: 'continue', name: 'reviewer', message: '解释旧审查结论', background })
  const reviewer = await vi.waitFor(() => {
    const found = provider.exchanges.find(exchange => String(userTexts(exchange).at(-1)).includes('解释旧审查结论'))
    if (!found) throw new Error('审查会话未续用')
    return found
  })
  expect(reviewer.body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '旧审查结论 SI-3526' }))
  expect(String(userTexts(reviewer).at(-1))).toContain('scout')
  const current = (await app.snapshot(sessionId)).subagents?.find(child => child.sessionId === fromMain.sessionId)
  expect(current).toMatchObject({ status: 'running' })
  expect(current?.runId).not.toBe(fromMain.runId)
  if (!background) {
    expect(provider.exchanges).toHaveLength(8)
    finish(reviewer, '前台同伴答复')
    const resumedScout = await requestNumber(9)
    expect(toolResults(resumedScout).at(-1)).toMatchObject({ items: [{ runId: current?.runId, output: '前台同伴答复' }] })
    finish(resumedScout, '侦查完成')
    finish(await requestNumber(10))
  } else {
    const received = await vi.waitFor(() => {
      const found = provider.exchanges.slice(7).find(exchange => exchange !== reviewer)
      if (!found) throw new Error('等待后台接单回执')
      return found
    })
    const receipt = toolResults(received).at(-1)
    expect(receipt).toMatchObject({ status: 'accepted', runId: current?.runId })
    finish(received, '侦查先完成')
    const parent = await requestNumber(10)
    finish(parent)
    finish(reviewer, '仅回给 scout 的后台结果 SI-3636')
    const report = await requestNumber(11)
    expect(userTexts(report).at(-1)).toContain('仅回给 scout 的后台结果 SI-3636')
    expect(toolResults(report).at(-1)).toEqual(receipt)
    expect(userTexts(parent).join(' ')).not.toContain('SI-3636')
    finish(report, '侦查读到了结果')
  }
}, 15000)

it('20/32 两种插话等整批工具，目标停止期间拒绝两种续用', async () => {
  const { directory, provider, requestNumber, start } = await fixture()
  const extensionDir = join(directory, 'global-context', 'extensions')
  const entered = join(directory, 'tool-entered')
  const release = join(directory, 'tool-release')
  const aborted = join(directory, 'tool-aborted')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'gate.ts'), `
    import { access, writeFile } from 'node:fs/promises'
    import { setTimeout } from 'node:timers/promises'
    export default si => si.registerTool({
      name: 'batch_gate', description: 'test tool', parameters: { type: 'object', properties: {} },
      async execute(_args, { signal }) {
        signal.addEventListener('abort', () => { void writeFile(${JSON.stringify(aborted)}, '') }, { once: true })
        await writeFile(${JSON.stringify(entered)}, '')
        while (!await access(${JSON.stringify(release)}).then(() => true, () => false)) await setTimeout(5)
        signal.throwIfAborted()
        return '整个工具批次完成'
      },
    })
  `)
  const app = await start()
  await app.saveKey()
  const id = await app.create(await app.pick())
  await app.accept(id, 'task', '并行准备')
  const first = await requestNumber(1)
  toolCall(first, 'subagent', { action: 'run', background: true, tasks: [
    { name: 'helper', task: '发送同伴插话' }, { name: 'receiver', task: '阻塞工具并接收插话' },
  ] })
  const [helper, receiver] = await Promise.all([
    taskExchange(provider.exchanges, '发送同伴插话'), taskExchange(provider.exchanges, '阻塞工具并接收插话'),
  ])
  const parent = provider.exchanges.find(exchange => ![first, helper, receiver].includes(exchange))!
  toolCalls(receiver, [{ name: 'ls', args: {} }, { name: 'batch_gate', args: {} }])
  await vi.waitFor(() => stat(entered))
  const target = (await app.snapshot(id)).subagents?.find(child => child.name === 'receiver')
  expect(target).toBeDefined()
  toolCall(parent, 'subagent', { action: 'steer', name: 'receiver', message: 'PARENT-20' })
  const ack1 = await requestNumber(5)
  expect(toolResults(ack1).at(-1)).toMatchObject({ status: 'accepted', runId: target?.runId })
  toolCall(helper, 'team', { action: 'steer', sessionId: target?.sessionId, message: 'PEER-20' })
  const ack2 = await requestNumber(6)
  expect(toolResults(ack2).at(-1)).toMatchObject({ status: 'accepted', runId: target?.runId })
  expect(provider.exchanges).toHaveLength(6)
  await writeFile(release, '')
  const resumed = await requestNumber(7)
  const messages = resumed.body.messages
  const tools = messages.flatMap((message, index) => message.role === 'tool' ? [index] : [])
  const parentNote = messages.findIndex(message => message.role === 'user' && String(message.content).includes('PARENT-20'))
  const peerNote = messages.findIndex(message => message.role === 'user' && String(message.content).includes('PEER-20'))
  expect(tools).toHaveLength(2)
  expect(parentNote).toBeGreaterThan(tools.at(-1)!)
  // OpenAI-compatible history may merge adjacent user messages into one content block.
  expect(peerNote).toBeGreaterThanOrEqual(parentNote)
  const inputs = JSON.stringify(messages.slice(parentNote))
  expect(inputs.indexOf('PARENT-20')).toBeLessThan(inputs.indexOf('PEER-20'))
  expect(inputs.match(/PARENT-20/g)).toHaveLength(1)
  expect(inputs.match(/PEER-20/g)).toHaveLength(1)
  await Promise.all([rm(release), rm(entered)])
  toolCall(resumed, 'batch_gate', {})
  await vi.waitFor(() => stat(entered))
  const stopping = app.call(`/api/sessions/${id}/subagents/${target?.sessionId}/stop`, { runId: target?.runId })
  await vi.waitFor(() => stat(aborted))
  toolCall(ack1, 'subagent', { action: 'continue', name: 'receiver', background: true, message: '主会话提前续用' })
  const rejected1 = await requestNumber(8)
  expect(toolResults(rejected1).at(-1)).toMatchObject({ status: 'stopping' })
  toolCall(ack2, 'team', { action: 'continue', name: 'receiver', background: false, message: '同伴提前续用' })
  const rejected2 = await requestNumber(9)
  expect(toolResults(rejected2).at(-1)).toMatchObject({ status: 'stopping' })
  await writeFile(release, '')
  expect(await (await stopping).json()).toMatchObject({ runId: target?.runId, status: 'aborted' })
  toolCall(rejected1, 'subagent', { action: 'continue', name: 'receiver', background: false, message: '这次可以续用' })
  const allowed = await requestNumber(10)
  expect(String(userTexts(allowed).at(-1))).toContain('这次可以续用')
  expect(userTexts(allowed).join(' ')).not.toContain('提前续用')
  finish(allowed, '成功续用')
  finish(await requestNumber(11))
  finish(rejected2)
}, 15000)

it('主会话改为只读后，运行中及续用的既有子 Agent 都不能写文件', async () => {
  const { directory, first, app, sessionId, requestNumber } = await ready('检查旧子会话权限')
  toolCall(first, 'subagent', { action: 'run', name: 'writer', task: '以普通模式开始', background: false })
  const before = await requestNumber(2)
  expect(JSON.stringify(before.body.tools)).toContain('"name":"write"')
  const permission = await app.call(`/api/sessions/${sessionId}/permission`, { permissionMode: 'read-only' }, 'PUT')
  expect(permission.status).toBe(200)
  toolCall(before, 'write', { path: 'must-remain-missing.txt', content: '意外写入' })
  const denied = await requestNumber(3)
  expect(denied.body.messages.filter(message => message.role === 'tool').at(-1)?.content).toContain('只读模式')
  expect(JSON.stringify(denied.body.tools)).not.toContain('"name":"write"')
  await expect(stat(join(directory, 'must-remain-missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  finish(denied, '遵守只读')
  const main = await requestNumber(4)
  toolCall(main, 'subagent', { action: 'continue', name: 'writer', message: '继续原历史', background: false })
  const resumed = await requestNumber(5)
  expect(JSON.stringify(resumed.body.tools)).not.toContain('"name":"write"')
  expect(resumed.body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '遵守只读' }))
  finish(resumed)
  finish(await requestNumber(6))
})

it('19 主会话和子会话各自仅能调用自己的协作工具', async () => {
  const { app, sessionId, first, requestNumber } = await ready('核对模型真实工具入口')
  expect(JSON.stringify(first.body.tools)).toContain('"name":"subagent"')
  expect(JSON.stringify(first.body.tools)).not.toContain('"name":"team"')
  toolCall(first, 'team', { action: 'list' })
  const main = await requestNumber(2)
  expect(main.body.messages.filter(message => message.role === 'tool').at(-1)?.content).toContain('未知工具：team')
  expect((await app.snapshot(sessionId)).subagents).toHaveLength(0)
  toolCall(main, 'subagent', { action: 'run', task: '核对子会话', background: false })
  const child = await requestNumber(3)
  expect(JSON.stringify(child.body.tools)).toContain('"name":"team"')
  expect(JSON.stringify(child.body.tools)).not.toContain('"name":"subagent"')
  toolCall(child, 'subagent', { action: 'run', task: '禁止创建后代', background: true })
  const refused = await requestNumber(4)
  expect(refused.body.messages.filter(message => message.role === 'tool').at(-1)?.content).toContain('未知工具：subagent')
  expect((await app.snapshot(sessionId)).subagents).toHaveLength(1)
  finish(refused)
  finish(await requestNumber(5))
})
