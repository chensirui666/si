import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { SessionStore } from '@agent-learning/coding-agent'
import { Schedules } from '../src/schedules.js'
import WebSocket from 'ws'
import { WebServer } from '../src/webserver/index.js'
import type { ConversationSnapshot, ScheduledRunView, ScheduleView, ServerFrame } from '../src/webserver/protocol.js'

type Tool = Record<string, unknown>
type ResponseValue = { text: string } | { tool: Tool; id: string; name?: string } | { error: number }
type ModelRequest = {
  model: string
  reasoning_effort: string
  tools: { function: { name: string; description: string; parameters: unknown } }[]
  messages: { role: string; content: string | null; tool_call_id?: string }[]
}
const primary = { provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'high' }

function modelResponse(value: ResponseValue) {
  if ('error' in value) return Response.json({ error: { message: 'controlled model failure' } }, { status: value.error })
  const delta = 'tool' in value ? { tool_calls: [{
    index: 0, id: value.id, type: 'function',
    function: { name: value.name ?? 'cronjob_manage', arguments: JSON.stringify(value.tool) },
  }] } : { content: value.text }
  const chunk = (data: object, finish_reason: string | null) => 'data: ' + JSON.stringify({
    id: 'controlled-schedules', object: 'chat.completion.chunk', model: 'deepseek-flash',
    choices: [{ index: 0, delta: data, finish_reason }],
    usage: finish_reason && { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 },
  }) + '\n\n'
  return new Response(chunk(delta, null) + chunk({}, 'tool' in value ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
}

async function withServer(use: (app: {
  server: WebServer
  nowAt(at: number): void
  call(path: string, method?: string, body?: unknown): Promise<Response>
  newSession(name: 'a' | 'b'): Promise<{ workspaceId: string; sessionId: string }>
  frames: ServerFrame[]
  snapshot(sessionId: string): Promise<ConversationSnapshot>
  requests: ModelRequest[]
  reply(...values: (ResponseValue | Promise<ResponseValue>)[]): void
  plans(): Promise<ScheduleView[]>
  runs(id: string): Promise<ScheduledRunView[]>
  sessionPath: string
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-schedules-http-'))
  const sessionPath = join(directory, 'sessions.sqlite')
  let now = Date.parse('2026-11-21T00:00:00Z')
  let picked: 'a' | 'b' = 'a'
  let socket: WebSocket | undefined
  const requests: ModelRequest[] = []
  const replies: (ResponseValue | Promise<ResponseValue>)[] = []
  const frames: ServerFrame[] = []
  const server = new WebServer({
    port: 0, now: () => now, sessionPath,
    browserSecretPath: join(directory, 'browser-auth.json'), workspacePath: join(directory, 'workspaces.json'),
    modelAuthPath: join(directory, 'auth.json'), webSettingsPath: join(directory, 'settings.json'),
    skillHome: join(directory, 'skills'), globalContextDirectory: join(directory, 'context'),
    directoryPicker: async () => join(directory, picked),
    modelOptions: { fetch: async (_url, init) => {
      const body: ModelRequest = JSON.parse(String(init?.body))
      if (String(body.messages[0]?.content).startsWith('你是会话标题生成器。')) return modelResponse({ text: '定时任务验收' })
      requests.push(body)
      return modelResponse(await (replies.shift() ?? { error: 400 }))
    } },
  })
  try {
    await Promise.all(['a', 'b'].map(name => mkdir(join(directory, name))))
    const boot = await server.start()
    const auth = await fetch(boot.authUrl, { redirect: 'manual' })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    await auth.body?.cancel()
    async function call(path: string, method = 'GET', body?: unknown) {
      return fetch(boot.url + path, {
        method, headers: { Cookie: cookie, Origin: boot.url, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    }
    expect((await call('/api/providers/deepseek', 'PUT', { apiKey: 'controlled-key' })).status).toBe(200)
    socket = new WebSocket(boot.url.replace(/^http/, 'ws') + '/api/events', { headers: { Cookie: cookie } })
    socket.on('message', data => frames.push(JSON.parse(String(data))))
    await once(socket, 'open')
    await use({
      server, nowAt: at => { now = at }, call, frames, requests, sessionPath,
      reply: (...values) => { replies.push(...values) },
      async newSession(name) {
        picked = name
        const workspace = await call('/api/workspaces/pick', 'POST')
        expect(workspace.status).toBe(200)
        const { workspaceId } = await workspace.json()
        const session = await call('/api/sessions', 'POST', { workspaceId })
        expect(session.status).toBe(201)
        return { workspaceId, sessionId: (await session.json()).id }
      },
      async snapshot(sessionId) {
        const subscriptionId = randomUUID()
        socket!.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId }))
        return vi.waitFor(() => {
          const frame = frames.find((item): item is Extract<ServerFrame, { type: 'snapshot' }> =>
            item.type === 'snapshot' && item.subscriptionId === subscriptionId)
          expect(frame).toBeDefined()
          return frame!.snapshot
        })
      },
      async plans() {
        const response = await call('/api/schedules')
        expect(response.status).toBe(200)
        return (await response.json()).schedules
      },
      async runs(id) {
        const response = await call('/api/schedules/' + id + '/runs')
        expect(response.status).toBe(200)
        return (await response.json()).runs
      },
    })
    expect(replies).toHaveLength(0)
  } finally {
    socket?.terminate()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}
type App = Parameters<Parameters<typeof withServer>[0]>[0]

async function send(app: App, sessionId: string, text: string, selection = primary) {
  const response = await app.call('/api/messages', 'POST', { sessionId, ...selection, clientMessageId: randomUUID(), text })
  expect(response.status).toBe(202)
  return (await response.json()).userMessageId as string
}

async function terminal(app: App, runId: string, status: 'completed' | 'failed' = 'completed') {
  await vi.waitFor(() => {
    const statuses = app.frames.flatMap(frame => frame.type === 'update' && frame.update.run?.id === runId ? [frame.update.run.status] : [])
    expect(statuses).toContain(status)
  }, { timeout: 4500 })
}

function declaration(request: ModelRequest) {
  return (request.tools ?? []).find(tool => tool.function.name === 'cronjob_manage')?.function
}

it('02–03 缺失日程、一次性安排和模型未调用工具的回复均不保存计划', async () => withServer(async app => {
  const { sessionId } = await app.newSession('a')
  await app.snapshot(sessionId)
  for (const [text, response] of [
    ['定时汇总本周的 Git 提交', '你想什么时候执行，多久重复一次？'],
    ['这周五 17:00 执行一次', '当前支持每天、工作日和指定星期，不能只执行一次。'],
    ['每周五 17:00 汇总 Git 提交', '已安排。'],
  ]) {
    app.reply({ text: response! })
    await terminal(app, await send(app, sessionId, text!))
    expect(await app.plans()).toEqual([])
  }
  app.nowAt(Date.parse('2026-11-29T00:00:00Z'))
  await app.server.scanScheduledTasks()
  expect(app.requests).toHaveLength(3)
  const tool = declaration(app.requests[0]!)!
  expect(tool.description).toMatch(/一次|repeat|recurr/i)
  expect(JSON.stringify(tool.parameters)).not.toContain('timezone')

  app.reply({ tool: { action: 'create', prompt: '汇总 Git 提交', schedule: { kind: 'weekly', weekdays: [5], time: '17:00' } }, id: 'valid-create' },
    { text: '已从本周开始安排。' })
  await terminal(app, await send(app, sessionId, '明确改为每周五 17:00'))
  expect(await app.plans()).toMatchObject([{ sessionId, schedule: { kind: 'weekly', weekdays: [5], time: '17:00' } }])
}))

it('06 创建后真实工具回执已保存，模型失败仍按时提交', async () => withServer(async app => {
  const { sessionId } = await app.newSession('a')
  await app.snapshot(sessionId)
  const upshot = Promise.withResolvers<ResponseValue>()
  app.reply({ tool: { action: 'create', prompt: '定时汇总', schedule: { kind: 'daily', time: '09:00' } }, id: 'create-before-error' },
    upshot.promise)
  try {
    const runId = await send(app, sessionId, '每天 09:00 汇总')
    await vi.waitFor(() => expect(app.requests).toHaveLength(2))
    const [saved] = await app.plans()
    expect(app.requests[1]!.messages.find(message => message.tool_call_id === 'create-before-error')?.content).toContain(saved!.id)
    upshot.resolve({ error: 401 })
    await terminal(app, runId, 'failed')
    expect(await app.plans()).toEqual([saved])
    app.reply({ text: '已完成定时汇总。' })
    app.nowAt(saved!.nextRunAt!)
    await app.server.scanScheduledTasks()
    const [execution] = await app.runs(saved!.id)
    expect(execution).toMatchObject({ status: 'accepted', sessionId })
    await terminal(app, execution!.runId!)
  } finally { upshot.resolve({ error: 401 }) }
}))

it('08–09 只读无法创建，普通会话不能用工具给其他项目或会话创建', async () => withServer(async app => {
  const a = await app.newSession('a')
  const b = await app.newSession('b')
  await app.snapshot(a.sessionId)
  const create = { action: 'create', prompt: '定时汇总', schedule: { kind: 'daily', time: '09:00' } }
  expect((await app.call('/api/sessions/' + a.sessionId + '/permission', 'PUT', { permissionMode: 'read-only' })).status).toBe(200)
  app.reply({ tool: create, id: 'readonly-create' }, { text: '只读无法安排。' })
  await terminal(app, await send(app, a.sessionId, '每天 09:00 汇总'))
  expect(declaration(app.requests[0]!)).toBeUndefined()
  expect((await app.snapshot(a.sessionId)).messages.find(entry =>
    entry.message.role === 'toolResult' && entry.message.toolCallId === 'readonly-create')?.message).toMatchObject({ isError: true })
  expect(await app.plans()).toEqual([])

  expect((await app.call('/api/sessions/' + a.sessionId + '/permission', 'PUT', { permissionMode: 'normal' })).status).toBe(200)
  app.reply({ tool: { ...create, ...b }, id: 'tampered-create' }, { text: '不能指定其他会话。' })
  await terminal(app, await send(app, a.sessionId, '安排到另一个项目的会话里'))
  expect((await app.snapshot(a.sessionId)).messages.find(entry =>
    entry.message.role === 'toolResult' && entry.message.toolCallId === 'tampered-create')?.message).toMatchObject({ isError: true })
  expect(await app.plans()).toEqual([])

  app.reply({ tool: create, id: 'normal-create' }, { text: '已在当前会话安排。' })
  await terminal(app, await send(app, a.sessionId, '每天 09:00 在当前会话汇总'))
  expect(await app.plans()).toMatchObject([{ ...a, prompt: '定时汇总' }])
}))

it('12、25 定时轮次复用原会话实时设置，计划只允许由手动聊天修改', async () => withServer(async app => {
  const { workspaceId, sessionId } = await app.newSession('a')
  await app.snapshot(sessionId)
  app.reply({ tool: { action: 'create', prompt: '原计划说明', schedule: { kind: 'daily', time: '09:00' } }, id: 'create' },
    { text: '已保存。' })
  await terminal(app, await send(app, sessionId, '每天 09:00 汇总项目'))
  const [saved] = await app.plans()
  const id = saved!.id
  const spoof = await app.call('/api/messages', 'POST', {
    ...primary, clientMessageId: randomUUID(), sessionId, text: '尝试伪造定时来源', scheduledRunId: randomUUID(),
  })
  expect(spoof.status).toBe(400)

  const gate = Promise.withResolvers<ResponseValue>()
  app.reply(gate.promise, { text: '定时运行无法修改计划。' })
  try {
    app.nowAt(saved!.nextRunAt!)
    await app.server.scanScheduledTasks()
    const [first] = await app.runs(id)
    expect(first).toMatchObject({ status: 'accepted', sessionId, runStatus: 'running' })
    await vi.waitFor(() => expect(app.requests).toHaveLength(3))
    expect(declaration(app.requests[2]!)).toBeUndefined()
    gate.resolve({ tool: { action: 'update', id, prompt: '定时轮次不得修改' }, id: 'scheduled-manage' })
    await terminal(app, first!.runId!)
    expect(await app.plans()).toMatchObject([{ id, prompt: '原计划说明' }])
    const snapshot = await app.snapshot(sessionId)
    expect(snapshot.messages.find(entry =>
      entry.message.role === 'toolResult' && entry.message.toolCallId === 'scheduled-manage')?.message).toMatchObject({ isError: true })
    expect(snapshot.runs?.find(run => run.id === first!.runId)).toMatchObject({ scheduledRunId: first!.id })
  } finally { gate.resolve({ error: 400 }) }

  const changedAt = app.frames.length
  app.reply({ tool: { action: 'update', id, prompt: '手动更新过的说明' }, id: 'update-prompt' }, { text: '已更新说明。' })
  await terminal(app, await send(app, sessionId, '把任务说明改为手动更新过的说明'))
  expect(app.frames.slice(changedAt).some(frame => frame.type === 'sessions_changed')).toBe(true)
  const afterEdit = (await app.plans())[0]!
  expect(afterEdit).toMatchObject({ id, prompt: '手动更新过的说明', timezone: saved!.timezone })
  const otherSelection = { provider: 'deepseek', modelId: 'deepseek-v4-pro', reasoningEffort: 'max' }
  expect((await app.call('/api/model-selection', 'PUT', { ...otherSelection, sessionId })).status).toBe(200)
  expect((await app.call('/api/sessions/' + sessionId + '/permission', 'PUT', { permissionMode: 'read-only' })).status).toBe(200)
  app.reply({ text: '手动追问已回复。' }, { text: '第二轮执行完成。' }, { text: '第三轮执行完成。' })
  await terminal(app, await send(app, sessionId, '我仍然可以手动追问吗？', otherSelection))
  const secondRequest = app.requests.length
  for (const _ of [2, 3]) {
    app.nowAt((await app.plans())[0]!.nextRunAt!)
    await app.server.scanScheduledTasks()
    const all = await app.runs(id)
    const newest = all.find(value => value.scheduledAt === Math.max(...all.map(item => item.scheduledAt)))!
    expect(newest).toMatchObject({ status: 'accepted', sessionId })
    await terminal(app, newest.runId!)
  }
  const executions = await app.runs(id)
  expect(new Set(executions.map(value => value.id)).size).toBe(3)
  expect(new Set(executions.map(value => value.runId)).size).toBe(3)
  expect(app.requests.slice(secondRequest)).toHaveLength(2)
  for (const request of app.requests.slice(secondRequest)) {
    expect(request).toMatchObject({ model: 'deepseek-v4-pro', reasoning_effort: 'max' })
    expect(request.messages.at(-1)?.content).toContain('手动更新过的说明')
    expect((request.tools ?? []).some(tool => ['write', 'bash', 'cronjob_manage'].includes(tool.function.name))).toBe(false)
  }
  expect((await app.call('/api/sessions/' + sessionId + '/permission', 'PUT', { permissionMode: 'normal' })).status).toBe(200)
  const rule = { kind: 'weekly', weekdays: [1], time: '10:00' }
  app.reply({ tool: { action: 'update', id, schedule: rule }, id: 'update-time' }, { text: '已改为每周一 10 点。' })
  await terminal(app, await send(app, sessionId, '把这条定时任务改成每周一 10 点', otherSelection))
  const [revised] = await app.plans()
  expect(revised).toMatchObject({ id, timezone: saved!.timezone, schedule: rule })
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: revised!.timezone, weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  expect(local.format(revised!.nextRunAt!)).toMatch(/Mon.*10:00/)
  const timeReceipt = app.requests.at(-1)!.messages.filter(message => message.role === 'tool').at(-1)!
  expect(JSON.parse(String(timeReceipt.content))).toMatchObject({ id, nextRunAt: revised!.nextRunAt })

  app.reply({ tool: { action: 'update', id, sessionMode: 'new' }, id: 'update-target' }, { text: '以后每次新建会话。' },
    { tool: { action: 'update', id, schedule: { kind: 'once', time: '10:00' } }, id: 'invalid-once' }, { text: '不支持一次性。' })
  await terminal(app, await send(app, sessionId, '以后每次新建会话', otherSelection))
  await terminal(app, await send(app, sessionId, '把它改成只执行一次', otherSelection))
  const final = await app.snapshot(sessionId)
  expect(final.messages.find(entry =>
    entry.message.role === 'toolResult' && entry.message.toolCallId === 'invalid-once')?.message).toMatchObject({ isError: true })
  expect(await app.plans()).toEqual([{ ...revised, sessionMode: 'new' }])
  await app.server.close()
  const db = new DatabaseSync(app.sessionPath, { readOnly: true })
  try {
    const savedRuns = db.prepare('SELECT id, run_id, submission FROM scheduled_runs ORDER BY scheduled_at').all()
    expect(savedRuns.map(row => JSON.parse(String(row.submission)))).toMatchObject([
      { workspaceId, sessionId, modelSelection: primary, permissionMode: 'normal' },
      { workspaceId, sessionId, modelSelection: otherSelection, permissionMode: 'read-only' },
      { workspaceId, sessionId, modelSelection: otherSelection, permissionMode: 'read-only' },
    ])
    const paired = db.prepare('SELECT id FROM runs WHERE session_id = ? AND client_id = ?')
    for (const row of savedRuns) expect(paired.get(sessionId, row.id!)?.id).toBe(row.run_id)
  } finally { db.close() }
}))

it('04 保存回滚时按原工具调用编号返回失败，且不触发后续执行', async () => withServer(async app => {
  const { sessionId } = await app.newSession('a')
  await app.snapshot(sessionId)
  const prompt = '事务故障测试说明'
  const exec = DatabaseSync.prototype.exec
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT' && this.prepare('SELECT id FROM schedules WHERE prompt = ?').get(prompt)) {
      throw new Error('fixture schedule save rejection')
    }
    exec.call(this, sql)
  })
  try {
    app.reply({ tool: { action: 'create', prompt, schedule: { kind: 'daily', time: '09:00' } }, id: 'rejected-schedule' },
      { text: '保存失败。' })
    await terminal(app, await send(app, sessionId, '每天上午 9 点执行'))
  } finally { fault.mockRestore() }

  const snapshot = await app.snapshot(sessionId)
  expect(snapshot.messages.find(entry =>
    entry.message.role === 'toolResult' && entry.message.toolCallId === 'rejected-schedule')?.message).toMatchObject({ isError: true })
  expect(app.requests[1]?.messages.at(-1)).toMatchObject({ tool_call_id: 'rejected-schedule', content: expect.stringContaining('未保存') })
  expect(await app.plans()).toEqual([])
  const list = await (await app.call('/api/sessions')).json()
  expect(list.sessions[0]?.hasScheduledTask).toBeFalsy()
  app.nowAt(Date.parse('2026-11-26T00:00:00Z'))
  await app.server.scanScheduledTasks()
  expect(app.requests).toHaveLength(2)
}))

it('13 每次新建模式每轮在原项目只接收一条定时消息', async () => withServer(async app => {
  const { sessionId, workspaceId } = await app.newSession('a')
  await app.snapshot(sessionId)
  const prompt = '整理工作区变更'
  app.reply({ tool: { action: 'create', prompt, schedule: { kind: 'daily', time: '09:00' } }, id: 'create-new-session-mode' },
    { text: '已保存。' })
  await terminal(app, await send(app, sessionId, '每天 09:00 整理工作区变更'))
  const [plan] = await app.plans()
  expect((await app.call('/api/schedules/' + plan!.id, 'PATCH', { action: 'update', sessionMode: 'new' })).status).toBe(200)

  for (const requestCount of [3, 4]) {
    app.reply({ text: '整理完成。' })
    app.nowAt((await app.plans())[0]!.nextRunAt!)
    await Promise.all([app.server.scanScheduledTasks(), app.server.scanScheduledTasks()])
    const [execution] = await app.runs(plan!.id)
    expect(execution).toMatchObject({ status: 'accepted', sessionId: execution?.id })
    const snapshot = await app.snapshot(execution!.sessionId!)
    if (snapshot.runs?.[0]?.status === 'running') await terminal(app, execution!.runId!)
    expect((await app.snapshot(execution!.sessionId!)).messages.filter(entry => entry.message.role === 'user')).toHaveLength(1)
    expect(app.requests).toHaveLength(requestCount)
    await app.server.scanScheduledTasks()
    expect(app.requests).toHaveLength(requestCount)
  }

  const runs = await app.runs(plan!.id)
  expect(runs).toHaveLength(2)
  expect(new Set(runs.map(run => run.sessionId)).size).toBe(2)
  const list = await (await app.call('/api/sessions')).json()
  expect(list.sessions).toHaveLength(3)
  expect(list.sessions.every((session: { workspaceId: string }) => session.workspaceId === workspaceId)).toBe(true)
  expect((await app.plans())[0]).toMatchObject({ id: plan!.id, sessionId, workspaceId })
}))

it('16 原会话仍在回复创建请求或普通消息时跳过本轮', async () => withServer(async app => {
  const { sessionId } = await app.newSession('a')
  await app.snapshot(sessionId)
  const creation = Promise.withResolvers<ResponseValue>()
  const manual = Promise.withResolvers<ResponseValue>()
  try {
    app.reply({ tool: { action: 'create', prompt: '每日任务', schedule: { kind: 'daily', time: '09:00' } }, id: 'create-while-busy' },
      creation.promise)
    const firstRun = await send(app, sessionId, '安排每日任务')
    await vi.waitFor(() => expect(app.requests).toHaveLength(2))
    const [plan] = await app.plans()
    app.nowAt(plan!.nextRunAt!)
    await app.server.scanScheduledTasks()
    expect((await app.runs(plan!.id))[0]).toMatchObject({ status: 'skipped', reason: '会话正在处理其他消息' })
    expect(app.requests).toHaveLength(2)
    creation.resolve({ text: '已安排。' })
    await terminal(app, firstRun)

    app.reply(manual.promise)
    const secondRun = await send(app, sessionId, '普通聊天')
    await vi.waitFor(() => expect(app.requests).toHaveLength(3))
    app.nowAt((await app.plans())[0]!.nextRunAt!)
    await app.server.scanScheduledTasks()
    expect((await app.runs(plan!.id)).map(run => run.status)).toEqual(['skipped', 'skipped'])
    expect(app.requests).toHaveLength(3)
    manual.resolve({ text: '普通聊天完成。' })
    await terminal(app, secondRun)
  } finally {
    creation.resolve({ error: 401 })
    manual.resolve({ error: 401 })
  }
}))

it('05 创建事务提交后失去确认，重开原库按创建轮次重放', async () => withServer(async app => {
  const { sessionId, workspaceId } = await app.newSession('a')
  await app.snapshot(sessionId)
  const request = { action: 'create', prompt: '提交后失去回执', schedule: { kind: 'daily', time: '09:00' } }
  const exec = DatabaseSync.prototype.exec
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    const losesReceipt = sql === 'COMMIT' && this.prepare('SELECT id FROM schedules WHERE prompt = ?').get(request.prompt)
    exec.call(this, sql)
    if (losesReceipt) throw new Error('fixture lost the committed schedule receipt')
  })
  let runId: string
  try {
    app.reply({ tool: request, id: 'original-uncertain-create' })
    runId = await send(app, sessionId, '安排每日任务')
    await vi.waitFor(() => {
      const failures = app.frames.flatMap(frame => frame.type === 'update' && frame.update.saveFailure
        ? [frame.update.saveFailure] : [])
      expect(failures).toContainEqual(expect.objectContaining({ runId, reason: 'unconfirmed' }))
    })
    expect((await app.call('/api/schedules')).status).toBe(500)
    expect(app.requests).toHaveLength(1)
  } finally { fault.mockRestore() }

  await app.server.close()
  const store = SessionStore.open(app.sessionPath)
  try {
    const service = new Schedules(store, Date.now, () => undefined)
    const [saved] = service.list()
    expect(saved).toMatchObject({ sessionId, workspaceId, prompt: request.prompt })
    const owner = { sessionId, workspaceId, runId }
    expect(service.manageFromChat(owner, request)).toEqual({ ...saved, outcome: 'existing' })
    service.remove(saved!.id)
    expect(service.manageFromChat(owner, request)).toMatchObject({ id: saved!.id, outcome: 'deleted' })
    expect(service.list()).toEqual([])
  } finally { store.close() }
}))

it('a scheduled run with a definite end-write failure records a failed result and can run again', async () => withServer(async app => {
  const { sessionId } = await app.newSession('a')
  await app.snapshot(sessionId)
  app.reply({ tool: { action: 'create', prompt: '每日检查', schedule: { kind: 'daily', time: '09:00' } }, id: 'scheduled-failure-setup' },
    { text: '已保存。' })
  await terminal(app, await send(app, sessionId, '安排每日检查'))
  const [plan] = await app.plans()
  const exec = DatabaseSync.prototype.exec
  let rejected = false
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (!rejected && sql === 'COMMIT' && this.prepare(
      "SELECT id FROM runs WHERE json_extract(data, '$.scheduledRunId') IS NOT NULL AND json_extract(data, '$.status') = 'failed'",
    ).get()) {
      rejected = true
      throw new Error('fixture scheduler failed to save the end state')
    }
    exec.call(this, sql)
  })
  try {
    app.reply({ error: 401 })
    app.nowAt(plan!.nextRunAt!)
    await app.server.scanScheduledTasks()
    const [first] = await app.runs(plan!.id)
    await terminal(app, first!.runId!, 'failed')
    expect(rejected).toBe(true)
    expect((await app.runs(plan!.id))[0]?.runStatus).toBe('failed')
  } finally { fault.mockRestore() }

  app.reply({ text: '本轮检查完成。' })
  app.nowAt((await app.plans())[0]!.nextRunAt!)
  await app.server.scanScheduledTasks()
  const [second] = await app.runs(plan!.id)
  expect(second?.status).toBe('accepted')
  await terminal(app, second!.runId!)
}))

it('Feature 10 case 26 scheduled runs reject forced questions without waiting', async () => withServer(async app => {
  const { sessionId } = await app.newSession('a')
  await app.snapshot(sessionId)
  app.reply({ tool: { action: 'create', prompt: '定时测试', schedule: { kind: 'daily', time: '09:00' } }, id: 'create' },
    { text: '计划已保存' })
  await terminal(app, await send(app, sessionId, '每天 09:00 测试'))
  const [saved] = await app.plans()
  app.reply({ name: 'ask_user_question', id: 'forced-ask', tool: { questions: [{ id: 'q', question: '需要回答？' }] } },
    { text: '定时任务仍可完成' })
  app.nowAt(saved!.nextRunAt!)
  await app.server.scanScheduledTasks()
  const [run] = await app.runs(saved!.id)
  await terminal(app, run!.runId!)
  expect(app.requests[2]!.tools.some(tool => tool.function.name === 'ask_user_question')).toBe(false)
  expect(app.requests[3]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'forced-ask' })
  const history = await app.snapshot(sessionId)
  expect(history.interaction?.questions ?? []).toEqual([])
  expect(history.messages.find(entry => entry.message.role === 'toolResult' && entry.message.toolCallId === 'forced-ask')?.message)
    .toMatchObject({ isError: true })
}))

it('a manual message waits for a scheduled run and then starts without an extra send', async () => withServer(async app => {
  const { sessionId } = await app.newSession('a')
  await app.snapshot(sessionId)
  app.reply({ tool: { action: 'create', prompt: '定时测试', schedule: { kind: 'daily', time: '09:00' } }, id: 'create' },
    { text: '计划已保存' })
  await terminal(app, await send(app, sessionId, '每天 09:00 测试'))
  const [saved] = await app.plans()
  const held = Promise.withResolvers<ResponseValue>()
  app.reply(held.promise, { text: '已完成手动消息' })
  try {
    app.nowAt(saved!.nextRunAt!)
    await app.server.scanScheduledTasks()
    const [run] = await app.runs(saved!.id)
    await vi.waitFor(() => expect(app.requests).toHaveLength(3))
    const clientMessageId = randomUUID()
    const receipt = await app.call('/api/messages', 'POST', { ...primary, sessionId, clientMessageId, text: '手动继续', mode: 'steer' })
    expect(receipt.status).toBe(202)
    expect(await receipt.json()).toMatchObject({ kind: 'queued', clientMessageId })
    held.resolve({ text: '定时结束' })
    await terminal(app, run!.runId!)
    await vi.waitFor(() => expect(app.requests).toHaveLength(4))
    expect(app.requests[3]!.messages.at(-1)?.content).toBe('手动继续')
    await vi.waitFor(() => expect(app.frames.some(frame => frame.type === 'update' &&
      frame.update.run?.clientMessageId === clientMessageId && frame.update.run.status === 'completed')).toBe(true))
  } finally { held.resolve({ text: '定时结束' }) }
}))
