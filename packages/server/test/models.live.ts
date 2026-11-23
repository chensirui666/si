import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import { WebSocket } from 'ws'
import { expect, test, vi } from 'vitest'
import { defaultSelection, discoverModels, type AssistantMessage, type ModelInfo, type ModelSelection } from '@agent-learning/model'
import { WebServer } from '../src/webserver/index.js'
import type { ConversationUpdate, ServerFrame } from '../src/webserver/protocol.js'

const path = process.env.MODEL_LIVE_KEY_FILE
const env = path ? parseEnv(await readFile(path, 'utf8')) : {}
const variables: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'], mistral: ['MISTRAL_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'gemini(Google AI Studio)'],
  'moonshotai-cn': ['MOONSHOT_API_KEY', 'MOONSHOTAI_CN_API_KEY', 'KIMI（moonshoot）'],
  qwen: ['DASHSCOPE_API_KEY', 'Qwen（阿里云百炼）'],
  'minimax-cn': ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY', 'Minimax'],
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK'], zai: ['ZAI_API_KEY', 'GLM'],
}
const keys = new Map(Object.entries(variables).flatMap(([provider, names]) => {
  const key = names.map(name => env[name]?.trim()).find(Boolean)
  return key ? [[provider, key] as const] : []
}))
const directory = await discoverModels({ readStatus: async provider => ({ state: keys.has(provider) ? 'configured' : 'missing' }) })

if (!directory.models.length) test.skip('逐型号真实验收需要 MODEL_LIVE_KEY_FILE 中的测试凭据', () => {})

function textOf(message: AssistantMessage | undefined) {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

async function fixture(work: (api: Awaited<ReturnType<typeof setup>>) => Promise<void>, capture = true) {
  const temporary = await mkdtemp(join(tmpdir(), 'si-model-live-'))
  let api: Awaited<ReturnType<typeof setup>> | undefined
  try {
    api = await setup(temporary, capture)
    await work(api)
  } finally {
    try { await api?.close() }
    finally { await rm(temporary, { recursive: true, force: true }) }
  }
}

async function setup(temporary: string, capture: boolean) {
  const cwd = join(temporary, 'workspace')
  await mkdir(cwd)
  const marker = 'm2f1-' + randomUUID().slice(0, 10)
  await writeFile(join(cwd, 'index.txt'), '目标文件路径为 secret-note.txt。')
  await writeFile(join(cwd, 'secret-note.txt'), `验收编号 ${marker}`)
  const requests: { hostname: string; body: string }[] = []
  let lastMoonshotRequest = 0
  const server = new WebServer({
    port: 0, sessionPath: join(temporary, 'sessions.sqlite'), directoryPicker: async () => cwd,
    skillHome: join(temporary, 'skill-home'), globalContextDirectory: join(temporary, 'global'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    compaction: { triggerTokens: 100_000, keepRecentTokens: 60 },
    modelOptions: capture ? { fetch: async (url, init) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
      const { hostname } = new URL(href)
      const body = String(init?.body ?? '')
      if (hostname === 'api.moonshot.cn') {
        // Leave room for the test account's rolling rate limit with the real output budget.
        await delay(Math.max(0, lastMoonshotRequest + 32_000 - Date.now()), undefined, { signal: init?.signal ?? undefined })
        lastMoonshotRequest = Date.now()
      }
      requests.push({ hostname, body })
      const response = await globalThis.fetch(url, init)
      if (hostname === 'api.moonshot.cn' && response.status === 429) {
        const payload = await response.clone().json().catch(() => null)
        const type = ['rate_limit_reached_error', 'engine_overloaded_error', 'exceeded_current_quota_error']
          .find(item => item === payload?.error?.type) ?? 'unknown'
        const limit = /\b(TPM|RPM|TPD)\s+rate limit,\s*current:\s*(\d+),\s*limit:\s*(\d+)/i.exec(String(payload?.error?.message ?? ''))
        const retry = response.headers.get('retry-after')
        console.info('Moonshot HTTP 429', type, limit?.slice(1), retry && /^\d+$/.test(retry) ? Number(retry) : undefined)
      }
      return response
    } } : undefined,
  })
  let socket: WebSocket | undefined
  const close = async () => { socket?.terminate(); await server.close() }
  try {
    const { url, authUrl } = await server.start()
    const auth = await fetch(authUrl, { redirect: 'manual' })
    const cookie = auth.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('本机验收授权失败')
    const headers = { cookie, 'content-type': 'application/json' }
    const request = (method: string, endpoint: string, body?: unknown) =>
      fetch(url + endpoint, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) })
    const workspace = await request('POST', '/api/workspaces/pick')
    expect(workspace.status).toBe(200)
    const { workspaceId } = await workspace.json()
    const created = await request('POST', '/api/sessions', { workspaceId })
    expect(created.status).toBe(201)
    const { id: sessionId } = await created.json()
    const updates: { at: number; update: ConversationUpdate }[] = []
    let ready = false
    socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events', { headers })
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as ServerFrame
      if (!('sessionId' in frame) || frame.sessionId !== sessionId) return
      if (frame.type === 'snapshot') ready = true
      if (frame.type === 'update') updates.push({ at: performance.now(), update: frame.update })
    })
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'models-live' }))
    await vi.waitFor(() => expect(ready).toBe(true), { timeout: 5000 })

    async function key(provider: string, apiKey: string) {
      expect((await request('PUT', '/api/providers/' + provider, { apiKey })).status).toBe(200)
    }
    async function select(model: ModelInfo) {
      const selection = defaultSelection(model)
      expect((await request('PUT', '/api/model-selection', { ...selection, sessionId })).status).toBe(200)
      return selection
    }
    async function submit(selection: ModelSelection, text: string) {
      const before = updates.length
      const startedAt = performance.now()
      const clientMessageId = randomUUID()
      const result = await request('POST', '/api/messages', { ...selection, sessionId, clientMessageId, text })
      expect(result.status).toBe(202)
      const receipt = await result.json()
      const frames = () => updates.slice(before).map(({ update }) => update)
      function timeline() {
        const window = updates.slice(before)
        const first = (match: (update: ConversationUpdate) => boolean) => {
          const at = window.find(({ update }) => match(update))?.at
          return at === undefined ? undefined : Math.round(at - startedAt)
        }
        return {
          acceptedMs: first(update => update.run?.clientMessageId === clientMessageId && update.run.status === 'running'),
          modelStartMs: first(({ change }) => change.type === 'model' && change.event.type === 'start'),
          firstOutputMs: first(({ change }) => change.type === 'model' && (
            ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(change.event.type)
            || change.event.type === 'replace' && change.event.message.content.length > 0
          )),
          modelEndMs: first(({ change }) => change.type === 'model' && (
            change.event.type === 'done' || change.event.type === 'error'
            || change.event.type === 'replace' && change.event.message.stopReason !== 'pending'
          )),
          runEndMs: first(update => update.run?.clientMessageId === clientMessageId && update.run.status !== 'running'),
        }
      }
      return {
        frames, timeline, id: receipt.userMessageId ?? receipt.compactionId,
        async finish() {
          const terminal = await vi.waitFor(() => {
            const run = frames().find(update => update.run?.clientMessageId === clientMessageId && update.run.status !== 'running')?.run
            expect(run).toBeDefined()
            return run!
          }, { timeout: 115_000, interval: 75 })
          const assistants = frames().flatMap(({ change }) => change.type === 'model'
            ? change.event.type === 'done' ? [change.event.message] : change.event.type === 'error' ? [change.event.error] : change.event.type === 'replace' && change.event.message.stopReason !== 'pending' ? [change.event.message] : [] : [])
          return { terminal, assistants, frames: frames() }
        },
      }
    }
    async function abort(runId: string) {
      const response = await request('POST', '/api/abort', { sessionId, runId })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ handled: true })
    }
    return { close, marker, requests, key, select, submit, abort }
  } catch (error) { await close(); throw error }
}

const readBoth = '只使用 read 工具。先单独读取 index.txt 获取下一份文件路径，再根据工具返回的路径单独读取目标文件。最后原样给出目标文件中的验收编号。'

function verifyRead(run: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['submit']>['finish']>, selection: ModelSelection, marker: string) {
  const last = run.assistants.at(-1)
  expect(run.terminal.status, last?.errorMessage).toBe('completed')
  expect(run.terminal).toMatchObject(selection)
  expect(last).toMatchObject({ provider: selection.provider, model: selection.modelId })
  expect(run.frames.some(({ change }) => change.type === 'model' && change.event.type === 'text_delta')).toBe(true)
  const tools = run.assistants.flatMap(reply => reply.content.filter(block => block.type === 'toolCall'))
  const results = run.frames.flatMap(({ change }) => change.type === 'task' && change.message?.message.role === 'toolResult' ? [change.message.message] : [])
  expect(tools.map(call => call.name)).toEqual(['read', 'read'])
  expect(run.assistants.filter(reply => reply.stopReason === 'toolUse')).toHaveLength(2)
  expect(results.map(item => item.toolCallId)).toEqual(tools.map(call => call.id))
  expect(results.every(item => !item.isError)).toBe(true)
  expect(textOf(last)).toContain(marker)
}

for (const model of directory.models) test.concurrent(`真实验收 ${model.provider}/${model.id}`, async () => {
  await fixture(async api => {
    const name = `${model.provider}/${model.id}`
    const apiKey = keys.get(model.provider)!
    await api.key(model.provider, apiKey)
    const selection = await api.select(model)
    const selected = selection.reasoningEffort ?? '无可调档位'
    const read = await (await api.submit(selection, readBoth)).finish()
    verifyRead(read, selection, api.marker)
    if (model.provider === 'moonshotai-cn' && model.id === 'kimi-k3.1-pro') {
      const taskRequests = api.requests.filter(({ body }) => !JSON.parse(body).messages.some(
        (message: { role: string; content: unknown }) => message.role === 'system'
          && typeof message.content === 'string' && message.content.startsWith('你是会话标题生成器。')))
      expect(taskRequests).toHaveLength(3)
      for (const request of taskRequests) {
        expect(request.hostname).toBe('api.moonshot.cn')
        expect(JSON.parse(request.body)).toMatchObject({ model: model.id, reasoning_effort: selected, stream: true })
      }
    }
    console.info(`${name} 17 通过 · ${selected} · ${api.requests.at(-1)?.hostname ?? '服务商 SDK'}`)

    for (let step = 0; step < 2; step++) {
      const seed = await (await api.submit(selection, '以下是无需记忆的测试填充。只回复 OK。' + '测试填充。'.repeat(150))).finish()
      expect(seed.terminal.status, seed.assistants.at(-1)?.errorMessage).toBe('completed')
    }
    const compaction = await (await api.submit(selection, '/compact')).finish()
    const compactionReason = compaction.frames.flatMap(({ change }) =>
      change.type === 'compaction' && change.record.status !== 'running' && change.record.status !== 'success' ? [change.record.reason] : []).at(-1)
    expect(compaction.terminal.status, compactionReason).toBe('completed')
    const summary = compaction.frames.flatMap(({ change }) =>
      change.type === 'compaction' && change.record.status === 'success' ? [change.record] : []).at(-1)
    expect(summary?.summary).toContain(api.marker)
    const recalled = await (await api.submit(selection, '不用工具。只回答之前从目标文件中读出的验收编号。')).finish()
    expect(recalled.terminal.status, recalled.assistants.at(-1)?.errorMessage).toBe('completed')
    expect(textOf(recalled.assistants.at(-1))).toContain(api.marker)
    if (model.api !== 'google-generative-ai') expect(api.requests.at(-1)?.body).toContain('<summary>')
    console.info(`${name} 19 通过`)

    const pending = await api.submit(selection, '不用工具。现在开始列出数字 1 到 8000，每个数字单独一行，请直接开始。')
    await vi.waitFor(() => expect(pending.frames().some(({ change }) => change.type === 'model' && change.event.type === 'text_delta')).toBe(true),
      { timeout: 60_000, interval: 50 })
    await api.abort(pending.id)
    const stopped = await pending.finish()
    expect(stopped.terminal.status).toBe('aborted')
    expect(textOf(stopped.assistants.at(-1))).toBeTruthy()
    console.info(`${name} 18 通过`)

    await api.key(model.provider, 'si-milestone2-intentionally-invalid-key')
    const rejected = await (await api.submit(selection, '只回答 OK。')).finish()
    expect(rejected.terminal.status).toBe('failed')
    expect(rejected.assistants.at(-1)?.errorMessage).toMatch(/认证失败|API Key/)
    expect(rejected.frames.some(({ change }) => change.type === 'task' && change.message?.message.role === 'toolResult')).toBe(false)
    console.info(`${name} 07 通过`)
  }, model.api !== 'google-generative-ai')
}, 360_000)

const flash = directory.models.find(model => model.provider === 'deepseek' && model.id === 'deepseek-flash')
for (const modelId of ['gemini-4-hydrogen', 'gemini-3.7-flash']) {
  const gemini = directory.models.find(model => model.provider === 'google' && model.id === modelId)
  test.concurrent.skipIf(!flash || !gemini)(`20 真实跨协议续做 DeepSeek → ${modelId} → DeepSeek`, async () => {
    await fixture(async api => {
      await api.key('deepseek', keys.get('deepseek')!)
      await api.key('google', keys.get('google')!)
      const first = await api.select(flash!)
      verifyRead(await (await api.submit(first, readBoth)).finish(), first, api.marker)
      for (const model of [gemini!, flash!]) {
        const selected = await api.select(model)
        const turn = await (await api.submit(selected, '接续上面的验收。再用 read 工具读取刚才的目标文件，原样给出验收编号。')).finish()
        expect(turn.terminal.status, `${model.provider}/${model.id} ${turn.assistants.at(-1)?.errorMessage ?? ''}`).toBe('completed')
        const call = turn.assistants.flatMap(message => message.content.filter(block => block.type === 'toolCall')).at(-1)
        expect(call?.name).toBe('read')
        expect(turn.frames.some(({ change }) => change.type === 'task' && change.message?.message.role === 'toolResult'
          && change.message.message.toolCallId === call?.id && !change.message.message.isError)).toBe(true)
        expect(textOf(turn.assistants.at(-1))).toContain(api.marker)
      }
      console.info(`20 通过 DeepSeek → ${modelId} → DeepSeek`)
    }, false)
  }, 360_000)
}

for (const provider of Object.keys(variables)) {
  const model = directory.models.find(item => item.provider === provider)
  test.concurrent.skipIf(!model)(`模型请求恢复正常调用 ${provider}/${model?.id ?? '缺少测试凭据'}`, async () => {
    await fixture(async api => {
      await api.key(provider, keys.get(provider)!)
      const selection = await api.select(model!)
      const request = await api.submit(selection, '请直接回复“恢复验收通过”，无需调用工具。')
      const retryStates = () => request.frames().flatMap(({ change }) => change.type === 'task' && change.running?.kind === 'task' && change.running.retry
        ? [{ mode: change.running.retry.mode, reason: change.running.retry.reason, phase: change.running.retry.phase }] : [])
      const result = await request.finish().catch(error => {
        console.info('模型请求恢复验收未收到终态', {
          provider, model: model!.id, api: model!.api, ...request.timeline(), retry: retryStates(),
        })
        throw error
      })
      const last = result.assistants.at(-1)
      console.info('模型请求恢复验收', { provider, model: model!.id, api: model!.api, status: result.terminal.status,
        requests: provider === 'google' ? undefined : api.requests.length, ...request.timeline(), retry: retryStates(), reason: last?.failure?.kind })
      expect(result.terminal.status, last?.errorMessage).toBe('completed')
      expect(last?.stopReason).toBe('stop')
      expect(textOf(last).trim()).toContain('恢复验收通过')
    }, provider !== 'google')
  }, 135_000)
}
