import { fork, type ChildProcess } from 'node:child_process'
import { on, once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionStore, type SessionSummary } from '@agent-learning/coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { startModelServer } from '../../../web/tests/e2e/model-server.js'
import type { ConversationSnapshot, ServerFrame, SubmitMessageRequest } from '../src/webserver/protocol.js'

const fixturePath = fileURLToPath(new URL('../../../web/tests/e2e/server-fixture.mjs', import.meta.url))
const fixtureKey = 'controlled-stage3-key'
const deepseek = { modelId: 'deepseek-flash' }
const vision = { provider: 'qwen', modelId: 'qwen3.6-plus', reasoningEffort: 'high' } as const
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode]
  const exited = once(child, 'exit')
  child.kill(signal)
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { return await exited }
  finally { clearTimeout(deadline) }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-collaboration-webserver-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const provider = await startModelServer()
  cleanup.push(provider.close)
  const requestNumber = async (number: number) => {
    await vi.waitFor(() => expect(provider.exchanges).toHaveLength(number), { timeout: 4000 })
    return provider.exchanges[number - 1]!
  }
  const start = async () => {
    const child = fork(fixturePath, ['0', join(directory, 'browser-auth.json')], {
      env: { ...process.env, AGENT_LEARNING_E2E_MODEL_BASE_URL: provider.baseURL, AGENT_LEARNING_E2E_MODEL_CLOCK: '' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    cleanup.push(() => stop(child, 'SIGKILL'))
    const [startup] = await once(child, 'message', { signal: AbortSignal.timeout(6000) }) as [{ type: string; result: { url: string; authUrl: string } }]
    expect(startup.type).toBe('started')
    const { url, authUrl } = startup.result
    const auth = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    expect(auth.status).toBe(303)
    const cookie = auth.headers.getSetCookie()[0]!.split(';')[0]!
    const request = (path: string, init: RequestInit = {}) => fetch(url + path, {
      signal: AbortSignal.timeout(6000), ...init, headers: { Cookie: cookie, ...init.headers },
    })
    const call = (path: string, body?: unknown, method = 'POST') => request(path, {
      method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    })
    const pick = async () => {
      const response = await call('/api/workspaces/pick')
      expect(response.status).toBe(200)
      return (await response.json() as { workspaceId: string }).workspaceId
    }
    const create = async (workspaceId: string) => {
      const response = await call('/api/sessions', { workspaceId })
      expect(response.status).toBe(201)
      return (await response.json() as SessionSummary).id
    }
    const saveKey = async (providerId = 'deepseek') => {
      expect((await call(`/api/providers/${providerId}`, { apiKey: fixtureKey }, 'PUT')).status).toBe(200)
    }
    const snapshot = async (sessionId: string): Promise<ConversationSnapshot> => {
      const signal = AbortSignal.timeout(3000)
      const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events', { headers: { Cookie: cookie } })
      try {
        await once(socket, 'open', { signal })
        const frames = on(socket, 'message', { signal })
        socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'collaboration' }))
        for await (const [data] of frames) {
          const frame = JSON.parse(String(data)) as ServerFrame
          if (frame.type === 'snapshot') return frame.snapshot
          if (frame.type === 'subscription_error') throw new Error(frame.error)
        }
        throw new Error('会话未发送快照')
      } finally { socket.terminate() }
    }
    const send = (sessionId: string, clientMessageId: string, text = clientMessageId,
      options: Partial<SubmitMessageRequest> = {}) => call('/api/messages', { sessionId, clientMessageId, text, ...deepseek, ...options })
    const accept = async (...args: Parameters<typeof send>) => {
      const res = await send(...args)
      const receipt = await res.json() as { kind: string; clientMessageId: string; userMessageId?: string }
      expect(res.status, JSON.stringify(receipt)).toBe(202)
      return receipt
    }
    const queue = (sessionId: string, clientMessageId: string, action?: { action: 'edit'; text: string } | { action: 'steer' }) =>
      call(`/api/sessions/${sessionId}/queue/${clientMessageId}`, action, action ? 'PATCH' : 'DELETE')
    return { child, request, call, pick, create, saveKey, snapshot, accept, queue }
  }
  return { directory, provider, requestNumber, start }
}

type Exchange = Awaited<ReturnType<typeof startModelServer>>['exchanges'][number]
function finish(exchange: Exchange, content = '已完成。') {
  exchange.delta({ role: 'assistant', content })
  exchange.finish()
}
function toolCall(exchange: Exchange, name: string, args: object) {
  exchange.delta({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] })
  exchange.finish('tool_calls')
}
function userTexts(exchange: Exchange) {
  return exchange.body.messages.filter(message => message.role === 'user').map(message => message.content)
}
const queueIds = (snapshot: ConversationSnapshot) => snapshot.interaction?.queue.items.map(item => item.clientMessageId)

it('03 拒绝编辑图片队列项，按编号删除后只启动其余条目', async () => {
  const { requestNumber, provider, start } = await fixture()
  const app = await start()
  await app.saveKey('qwen')
  const id = await app.create(await app.pick())
  expect((await app.call('/api/model-selection', { ...vision, sessionId: id }, 'PUT')).status).toBe(200)
  expect((await app.accept(id, 'A', '首轮', vision)).kind).toBe('message')
  const a = await requestNumber(1)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC', 'base64')
  const upload = await app.request(`/api/attachments?sessionId=${id}`, {
    method: 'POST', body: new Uint8Array(png), headers: { 'Content-Type': 'application/octet-stream', 'X-Attachment-Name': 'photo.png' },
  })
  expect(upload.status).toBe(201)
  const photo = await upload.json() as { id: string }
  expect((await app.accept(id, 'B', '同一原文', vision)).kind).toBe('queued')
  const c = await app.accept(id, 'C', '同一原文', { ...vision, attachmentIds: [photo.id] })
  expect(c).toMatchObject({ kind: 'queued', clientMessageId: 'C' })
  expect((await app.accept(id, 'D', '末条', vision)).kind).toBe('queued')
  expect((await app.queue(id, 'C', { action: 'edit', text: '不能替换' })).status).toBe(400)
  const before = await app.snapshot(id)
  expect(queueIds(before)).toEqual(['B', 'C', 'D'])
  expect(before.interaction?.queue.items[1]).toMatchObject({ text: '同一原文', attachments: [photo] })
  const preview = await app.request(`/api/attachments/${photo.id}`)
  expect(preview.status).toBe(200)
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(png)
  expect(await (await app.queue(id, 'C')).json()).toEqual({ status: 'deleted' })
  expect(await app.accept(id, 'C', '同一原文', { ...vision, attachmentIds: [photo.id] })).toEqual(c)
  expect(queueIds(await app.snapshot(id))).toEqual(['B', 'D'])
  expect((await app.request(`/api/attachments/${photo.id}`)).status).toBe(404)
  finish(a)
  const b = await requestNumber(2)
  expect(userTexts(b).at(-1)).toBe('同一原文')
  expect(await (await app.queue(id, 'B')).json()).toEqual({ status: 'started' })
  finish(b)
  const d = await requestNumber(3)
  expect(userTexts(d).at(-1)).toBe('末条')
  finish(d)
  await vi.waitFor(async () => {
    const current = await app.snapshot(id)
    expect(current.running).toBeNull()
    expect(current.runs?.map(run => run.clientMessageId)).toEqual(['A', 'B', 'D'])
  })
  expect(provider.exchanges).toHaveLength(3)
}, 15000)

it('06 方案待审时保留队列，获准执行并完成方案后才启动下一条', async () => {
  const { requestNumber, provider, start } = await fixture()
  const app = await start()
  await app.saveKey()
  const id = await app.create(await app.pick())
  await app.accept(id, 'A', '/plan 制定一次迁移计划')
  const a = await requestNumber(1)
  expect((await app.accept(id, 'B', '后续改动')).kind).toBe('queued')
  finish(a, 'Plan:\n1. 核对工作区文件\n2. 保留现有接口')
  let planId: string | undefined
  await vi.waitFor(async () => {
    const state = await app.snapshot(id)
    expect(state.plan).toMatchObject({ state: 'review', steps: ['核对工作区文件', '保留现有接口'] })
    expect(queueIds(state)).toEqual(['B'])
    if (state.plan?.state === 'review') planId = state.plan.assistantMessageId
  })
  expect(provider.exchanges).toHaveLength(1)
  const approval = await app.call(`/api/sessions/${id}/plan/review`, { action: 'approve', planId })
  expect(approval.status).toBe(202)
  const execution = await requestNumber(2)
  expect(userTexts(execution).at(-1)).toContain('请执行已确认的方案')
  expect(queueIds(await app.snapshot(id))).toEqual(['B'])
  finish(execution)
  const b = await requestNumber(3)
  expect(userTexts(b).at(-1)).toBe('后续改动')
  finish(b)
  await vi.waitFor(async () => {
    const state = await app.snapshot(id)
    expect(state.running).toBeNull()
    expect(state.runs?.map(run => [run.clientMessageId, run.status])).toEqual([
      ['A', 'completed'], [`plan:${planId}`, 'completed'], ['B', 'completed'],
    ])
  })
}, 15000)

it('07 SIGTERM 冻结领取，只清空已加载会话的普通队列和插话', async () => {
  const { directory, provider, requestNumber, start } = await fixture()
  const prepare = await start()
  await prepare.saveKey()
  const workspaceId = await prepare.pick()
  const loaded = await prepare.create(workspaceId)
  const active = await prepare.create(workspaceId)
  const cold = await prepare.create(workspaceId)
  expect(await stop(prepare.child, 'SIGTERM')).toEqual([0, null])
  const store = SessionStore.open(join(directory, 'sessions.sqlite'))
  try {
    store.save(cold, { pending: [{ input: { ...deepseek, clientMessageId: 'cold', text: '保留冷会话待发项' },
      text: '保留冷会话待发项', status: 'queued', acceptedSeq: 1 }] })
  } finally { store.close() }
  const extensionDir = join(directory, 'global-context', 'extensions')
  const settled = join(directory, 'settled')
  const release = join(directory, 'release')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'gate.ts'), `
    import { access, writeFile } from 'node:fs/promises'
    import { setTimeout } from 'node:timers/promises'
    export default si => si.on('agent_settled', async () => {
      await writeFile(${JSON.stringify(settled)}, '')
      while (!await access(${JSON.stringify(release)}).then(() => true, () => false)) await setTimeout(5)
    })
  `)
  const app = await start()
  await app.accept(loaded, 'A')
  const a = await requestNumber(1)
  await app.accept(loaded, 'B')
  finish(a)
  await vi.waitFor(() => stat(settled))
  expect(queueIds(await app.snapshot(loaded))).toEqual(['B'])
  await app.accept(active, 'working')
  const held = await requestNumber(2)
  expect((await app.accept(active, 'S', '保留待发插话', { mode: 'steer' })).kind).toBe('steering')
  expect((await app.snapshot(active)).interaction?.steering).toMatchObject([{ clientMessageId: 'S' }])
  const stopping = stop(app.child, 'SIGTERM')
  try {
    await vi.waitFor(async () => expect((await app.request('/api/sessions')).status).toBe(503))
  } finally { await writeFile(release, '') }
  expect(await stopping).toEqual([0, null])
  expect(provider.exchanges).toHaveLength(2)
  await vi.waitFor(() => expect(held.closed).toBe(true))
  const reopened = await start()
  const cleared = await reopened.snapshot(loaded)
  expect(queueIds(cleared)).toEqual([])
  expect(cleared.interaction?.steering).toEqual([])
  expect(cleared.runs).toMatchObject([{ clientMessageId: 'A', status: 'completed' }])
  const closedActive = await reopened.snapshot(active)
  expect(closedActive.interaction?.steering).toEqual([])
  expect(closedActive.runs).toMatchObject([{ clientMessageId: 'working', status: 'aborted' }])
  const untouched = await reopened.snapshot(cold)
  expect(queueIds(untouched)).toEqual(['cold'])
  expect(untouched.interaction?.queue.paused).toEqual(expect.any(String))
  expect(provider.exchanges).toHaveLength(2)
}, 15000)

it('08 SIGKILL 后重开保留已确认的队列和插话，并关闭中断任务的问答', async () => {
  const { requestNumber, provider, start } = await fixture()
  const app = await start()
  await app.saveKey()
  const id = await app.create(await app.pick())
  const accepted = await app.accept(id, 'A')
  const a = await requestNumber(1)
  expect((await app.accept(id, 'B')).kind).toBe('queued')
  expect((await app.accept(id, 'C')).kind).toBe('queued')
  expect((await app.accept(id, 'S', '插话 S', { mode: 'steer' })).kind).toBe('steering')
  toolCall(a, 'ask_user_question', { questions: [{ id: 'q1', question: '保留原接口吗？' }], timeout: -1 })
  let questionId: string | undefined
  await vi.waitFor(async () => {
    const waiting = (await app.snapshot(id)).interaction?.questions[0]
    expect(waiting).toMatchObject({ status: 'waiting', toolCallId: 'call-ask_user_question' })
    questionId = waiting?.id
  })
  expect(await stop(app.child, 'SIGKILL')).toEqual([null, 'SIGKILL'])
  const reopened = await start()
  const restored = await reopened.snapshot(id)
  expect(restored.running).toBeNull()
  expect(restored.runs).toMatchObject([{ id: accepted.userMessageId, clientMessageId: 'A', status: 'interrupted', restored: true }])
  expect(queueIds(restored)).toEqual(['B', 'C'])
  expect(restored.interaction?.queue.paused).toEqual(expect.any(String))
  expect(restored.interaction?.steering).toMatchObject([{ clientMessageId: 'S', text: '插话 S' }])
  expect(restored.interaction?.questions).toMatchObject([{ id: questionId, status: 'aborted' }])
  expect((await reopened.call(`/api/sessions/${id}/questions/${questionId}/reply`, {
    replyId: 'too-late', answers: [{ id: 'q1', selected: [], custom: '保留' }],
  })).status).toBe(409)
  expect(provider.exchanges).toHaveLength(1)
  expect((await reopened.accept(id, 'D')).kind).toBe('queued')
  const b = await requestNumber(2)
  expect(userTexts(b).slice(-2)).toEqual(['插话 S', 'B'])
  finish(b)
  const c = await requestNumber(3)
  expect(userTexts(c).at(-1)).toBe('C')
  finish(c)
  const d = await requestNumber(4)
  expect(userTexts(d).at(-1)).toBe('D')
  finish(d)
  await vi.waitFor(async () => {
    const state = await reopened.snapshot(id)
    expect(state.running).toBeNull()
    expect(state.runs?.map(run => run.clientMessageId)).toEqual(['A', 'B', 'C', 'D'])
    expect(state.messages.filter(message => message.clientMessageId === 'S')).toMatchObject([{ runId: state.runs?.[1]?.id, steering: true }])
  })
  expect(provider.exchanges).toHaveLength(4)
}, 15000)

it.each([false, true])('12/13/17 在工具收到中止后暂缓返回，直接插话在收尾期间到达为 %s', async duringAbort => {
  const { directory, provider, requestNumber, start } = await fixture()
  const extensionDir = join(directory, 'global-context', 'extensions')
  const started = join(directory, 'started')
  const aborted = join(directory, 'aborted')
  const release = join(directory, 'release')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'gate.ts'), `
    import { access, writeFile } from 'node:fs/promises'
    import { setTimeout } from 'node:timers/promises'
    export default si => si.registerTool({
      name: 'hold_for_abort', description: 'test tool', parameters: { type: 'object', properties: {} },
      async execute(_args, { signal }) {
        signal.addEventListener('abort', () => { void writeFile(${JSON.stringify(aborted)}, '') }, { once: true })
        await writeFile(${JSON.stringify(started)}, '')
        while (!await access(${JSON.stringify(release)}).then(() => true, () => false)) await setTimeout(5)
        signal.throwIfAborted()
        return 'done'
      },
    })
  `)
  const app = await start()
  await app.saveKey()
  const id = await app.create(await app.pick())
  const accepted = await app.accept(id, 'A')
  toolCall(await requestNumber(1), 'hold_for_abort', {})
  await vi.waitFor(() => stat(started))
  expect((await app.accept(id, 'B')).kind).toBe('queued')
  expect((await app.accept(id, 'C')).kind).toBe('queued')
  const aborting = app.call('/api/abort', { sessionId: id, runId: accepted.userMessageId })
  try {
    await vi.waitFor(() => stat(aborted))
    expect(await (await app.queue(id, 'B', { action: 'steer' })).json()).toEqual({ status: 'queued' })
    const unchanged = await app.snapshot(id)
    expect(unchanged.running).toMatchObject({ runId: accepted.userMessageId })
    expect(queueIds(unchanged)).toEqual(['B', 'C'])
    if (duringAbort) {
      expect((await app.accept(id, 'D', 'D', { mode: 'steer' })).kind).toBe('queued')
      const recovering = await app.snapshot(id)
      expect(queueIds(recovering)).toEqual(['B', 'C', 'D'])
      expect(recovering.interaction?.steering).toEqual([])
    }
    expect(provider.exchanges).toHaveLength(1)
  } finally {
    await writeFile(release, '')
    expect(await (await aborting).json()).toMatchObject({ handled: true })
  }
  if (!duringAbort) {
    const idle = await app.snapshot(id)
    expect(idle.running).toBeNull()
    expect(queueIds(idle)).toEqual(['B', 'C'])
    expect(await (await app.queue(id, 'B', { action: 'steer' })).json()).toEqual({ status: 'queued' })
    expect(queueIds(await app.snapshot(id))).toEqual(['B', 'C'])
    expect(provider.exchanges).toHaveLength(1)
    expect((await app.accept(id, 'D')).kind).toBe('queued')
  }
  for (const [index, marker] of ['B', 'C', 'D'].entries()) {
    const exchange = await requestNumber(index + 2)
    expect(userTexts(exchange).at(-1)).toBe(marker)
    if (!duringAbort && marker === 'B') {
      expect(await (await app.queue(id, 'B', { action: 'steer' })).json()).toEqual({ status: 'started' })
    }
    finish(exchange)
  }
  await vi.waitFor(async () => {
    const state = await app.snapshot(id)
    expect(state.running).toBeNull()
    expect(state.runs?.map(run => [run.clientMessageId, run.status])).toEqual([
      ['A', 'aborted'], ['B', 'completed'], ['C', 'completed'], ['D', 'completed'],
    ])
    expect(state.messages.filter(message => message.clientMessageId === 'B')).toHaveLength(1)
  })
}, 15000)

it.each([{ caseId: '15', hasQueue: false }, { caseId: '16', hasQueue: true }])('$caseId 空闲时直接插话，是否已有普通队列为 $hasQueue', async ({ hasQueue }) => {
  const { requestNumber, provider, start } = await fixture()
  const app = await start()
  await app.saveKey()
  const id = await app.create(await app.pick())
  const a = await app.accept(id, 'A')
  await requestNumber(1)
  expect((await app.accept(id, 'S', '插话 S', { mode: 'steer' })).kind).toBe('steering')
  if (hasQueue) {
    expect((await app.accept(id, 'B')).kind).toBe('queued')
    expect((await app.accept(id, 'C')).kind).toBe('queued')
  }
  const abort = await app.call('/api/abort', { sessionId: id, runId: a.userMessageId })
  expect(await abort.json()).toMatchObject({ handled: true })
  const idle = await app.snapshot(id)
  expect(idle.running).toBeNull()
  expect(queueIds(idle)).toEqual(hasQueue ? ['B', 'C'] : [])
  expect(idle.interaction?.steering).toMatchObject([{ clientMessageId: 'S' }])
  expect(provider.exchanges).toHaveLength(1)

  const sending = () => app.accept(id, 'D', '插话 D', { mode: 'steer' })
  const accepted = await sending()
  const next = await requestNumber(2)
  if (hasQueue) {
    expect(accepted).toMatchObject({ kind: 'steering', clientMessageId: 'D' })
    expect(userTexts(next).slice(-3)).toEqual(['插话 S', '插话 D', 'B'])
    expect(queueIds(await app.snapshot(id))).toEqual(['C'])
    finish(next)
    const c = await requestNumber(3)
    expect(userTexts(c).at(-1)).toBe('C')
    finish(c)
  } else {
    expect(accepted).toMatchObject({ kind: 'message', clientMessageId: 'D', userMessageId: expect.any(String) })
    expect(userTexts(next).slice(-2)).toEqual(['插话 S', '插话 D'])
    expect(await sending()).toEqual(accepted)
    finish(next)
  }
  await vi.waitFor(async () => {
    const state = await app.snapshot(id)
    expect(state.running).toBeNull()
    expect(state.runs?.map(run => run.clientMessageId)).toEqual(hasQueue ? ['A', 'B', 'C'] : ['A', 'D'])
    expect(state.messages.filter(message => message.clientMessageId === 'D')).toHaveLength(1)
  })
  expect(provider.exchanges).toHaveLength(hasQueue ? 3 : 2)
}, 15000)

it('19 拒绝无效或跨会话回答，整组跳过只结算原工具一次', async () => {
  const { directory, provider, requestNumber, start } = await fixture()
  await writeFile(join(directory, 'old-interface.txt'), '旧接口保持原样')
  await writeFile(join(directory, 'independent.txt'), '独立读取内容')
  const app = await start()
  await app.saveKey()
  const workspaceId = await app.pick()
  const id = await app.create(workspaceId)
  const other = await app.create(workspaceId)
  await app.accept(id, 'A')
  toolCall(await requestNumber(1), 'ask_user_question', { timeout: -1, questions: [
    { id: 'old', question: '是否更新旧接口？', options: [{ label: '更新' }, { label: '保留' }] },
    { id: 'next', question: '接下来查什么？' },
  ] })
  let questionId: string | undefined
  await vi.waitFor(async () => {
    const question = (await app.snapshot(id)).interaction?.questions[0]
    expect(question).toMatchObject({ status: 'waiting' })
    questionId = question?.id
  })
  const skip = [{ id: 'old', selected: [] }, { id: 'next', selected: [] }]
  const reply = (answers: unknown, target = id) => app.call(`/api/sessions/${target}/questions/${questionId}/reply`, { replyId: 'skip', answers })
  for (const invalid of [
    [skip[0]], [skip[0], skip[0]], [skip[0], { id: 'unknown', selected: [] }],
    [{ id: 'old', selected: ['不存在'] }, skip[1]], [{ id: 'old', selected: ['更新', '保留'] }, skip[1]],
  ]) expect((await reply(invalid)).status).toBe(400)
  expect((await reply(skip, other)).status).toBe(400)
  expect((await app.snapshot(id)).interaction?.questions).toMatchObject([{ id: questionId, status: 'waiting' }])
  expect(provider.exchanges).toHaveLength(1)

  const submitted = await reply(skip)
  expect(submitted.status).toBe(200)
  expect(await submitted.json()).toEqual({ kind: 'answered', replyId: 'skip' })
  expect(await (await reply(skip)).json()).toEqual({ kind: 'answered', replyId: 'skip' })
  const afterSkip = await requestNumber(2)
  expect(afterSkip.body.messages.filter(message => message.role === 'tool')).toMatchObject([
    { tool_call_id: 'call-ask_user_question', content: expect.stringContaining(JSON.stringify(skip)) },
  ])
  toolCall(afterSkip, 'read', { path: 'independent.txt' })
  const reading = await requestNumber(3)
  expect(reading.body.messages.filter(message => message.role === 'tool').at(-1))
    .toMatchObject({ tool_call_id: 'call-read', content: expect.stringContaining('独立读取内容') })
  finish(reading)
  await vi.waitFor(async () => {
    const state = await app.snapshot(id)
    expect(state.running).toBeNull()
    expect(state.interaction?.questions).toMatchObject([{ id: questionId, status: 'answered', answers: skip }])
    expect(state.messages.filter(message => message.message.role === 'toolResult' && message.message.toolCallId === 'call-ask_user_question')).toHaveLength(1)
    expect(state.messages.filter(message => message.message.role === 'user')).toHaveLength(1)
  })
  expect(await readFile(join(directory, 'old-interface.txt'), 'utf8')).toBe('旧接口保持原样')
}, 15000)

it('图片队列不转入仍用纯文本模型的当前任务', async () => {
  const { requestNumber, start } = await fixture()
  const app = await start()
  await app.saveKey()
  await app.saveKey('qwen')
  const id = await app.create(await app.pick())
  const textOnly = { provider: 'deepseek', modelId: 'deepseek-v4-pro', reasoningEffort: 'high' } as const
  expect((await app.call('/api/model-selection', { ...textOnly, sessionId: id }, 'PUT')).status).toBe(200)
  await app.accept(id, 'A', '首轮纯文本', textOnly)
  const current = await requestNumber(1)
  expect((await app.call('/api/model-selection', { ...vision, sessionId: id }, 'PUT')).status).toBe(200)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC', 'base64')
  const upload = await app.request(`/api/attachments?sessionId=${id}`, {
    method: 'POST', body: new Uint8Array(png), headers: { 'Content-Type': 'application/octet-stream', 'X-Attachment-Name': 'photo.png' },
  })
  expect(upload.status).toBe(201)
  const photo = await upload.json() as { id: string }
  await app.accept(id, 'B', '带图下一轮', { ...vision, attachmentIds: [photo.id] })
  expect((await app.queue(id, 'B', { action: 'steer' })).status).toBe(400)
  const state = await app.snapshot(id)
  expect(queueIds(state)).toEqual(['B'])
  expect(state.interaction?.steering).toEqual([])
  finish(current)
  const next = await requestNumber(2)
  expect(next.body.model).toBe(vision.modelId)
  expect(JSON.stringify(userTexts(next).at(-1))).toContain('带图下一轮')
  finish(next)
  await vi.waitFor(async () => expect((await app.snapshot(id)).running).toBeNull())
}, 15000)
