import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { WebSocket } from 'ws'
import { expect, it } from 'vitest'
import type { AssistantMessage, ToolResultMessage } from '@agent-learning/model'
import { WebServer } from '../src/webserver/index.js'
import type { ConversationMessage, ServerFrame, SessionSummary } from '../src/webserver/protocol.js'

// Use a public IP so the host's synthetic DNS answers do not prevent this live extraction.
const publicPage = 'https://1.1.1.1/'
const cases = [
  { name: 'bash', prompt: '使用 bash，command 为 ls，timeout 为 10。最后列出工具实际看到的两个文件名。', result: /draft\.txt[\s\S]*note\.txt/, answer: /draft\.txt[\s\S]*note\.txt|note\.txt[\s\S]*draft\.txt/ },
  { name: 'edit', prompt: '我已读过 note.txt，确认旧文本“状态：开发中”完整且唯一。本次只允许一次工具调用，请直接调用 edit，参数为 {"path":"note.txt","edits":[{"oldText":"状态：开发中","newText":"状态：测试中"}]}。无须再次读取。收到工具结果后报告实际状态和文件名。', result: /note\.txt/, answer: /测试中/ },
  { name: 'write', prompt: '参数为 {"path":"notes/note.txt","content":"项目名称：青禾"}。write 会创建父目录。收到工具结果后报告实际写入路径。', result: /notes\/note\.txt/, answer: /notes\/note\.txt/ },
  { name: 'find', prompt: '使用 find 在 samples 子目录按通配符 *.txt 查找，limit 为 10。最后给出实际找到的文件名。', result: /matched\.txt/, answer: /matched\.txt/ },
  { name: 'grep', prompt: '参数为 {"path":"note.txt","pattern":"开发中","literal":true,"context":1,"limit":5}。收到工具结果后报告命中行号和完整命中文本。', result: /note\.txt:2:.*状态：开发中/, answer: /状态：开发中/ },
  { name: 'web_search', prompt: '用 web_search 搜索 “IANA example domains reserved for documentation”，limit 为 3。最后原样给出第一条结果的 URL。', result: /1\. .+\nhttps?:\/\/[^\n]+\n\S/, answer: /https?:\/\// },
  { name: 'web_fetch', prompt: `用 web_fetch 获取 ${publicPage} 的正文，urls 仅有这个网址。最后报告正文中出现的服务提供方名称和该网页原网址。`, result: /1\.1\.1\.1[\s\S]*Cloudflare/i, answer: /Cloudflare/i },
] as const

for (const scenario of cases) it(`T2–T8 live: ${scenario.name} 执行、回填和回答`, async test => {
  const path = process.env.DEEPSEEK_LIVE_KEY_FILE
  if (!path) return test.skip('未提供 DEEPSEEK_LIVE_KEY_FILE')
  const needsTavily = scenario.name.startsWith('web_')
  if (needsTavily && !process.env.TAVILY_LIVE_KEY_FILE) return test.skip('未提供 TAVILY_LIVE_KEY_FILE')
  const modelEnv = parseEnv(await readFile(path, 'utf8'))
  const tavilyEnv = needsTavily ? parseEnv(await readFile(process.env.TAVILY_LIVE_KEY_FILE!, 'utf8')) : {}
  const deepseek = modelEnv.DEEPSEEK_API_KEY || modelEnv.DEEPSEEK
  const tavily = tavilyEnv.TAVILY_API_KEY || tavilyEnv.TAVILY || tavilyEnv.tavily
  if (!deepseek || (needsTavily && !tavily)) throw new Error('验收文件缺少测试凭据，内容已省略。')
  const temporary = await mkdtemp(join(tmpdir(), 'agent-learning-feature4-live-'))
  const cwd = join(temporary, 'workspace')
  const requests: { messages: { role: string; content: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]; tools?: unknown[] }[] = []
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd,
    globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return globalThis.fetch(url, init)
    } },
  })
  let socket: WebSocket | undefined
  try {
    await mkdir(join(cwd, 'samples'), { recursive: true })
    await Promise.all([
      writeFile(join(cwd, 'note.txt'), '项目名称：青禾\n状态：开发中\n负责人：小林\n'),
      writeFile(join(cwd, 'draft.txt'), 'draft'),
      writeFile(join(cwd, 'samples/matched.txt'), 'yes'),
      writeFile(join(cwd, 'samples/ignored.md'), 'no'),
    ])
    const { url, authUrl } = await server.start()
    const exchange = await fetch(authUrl, { redirect: 'manual' })
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('本机验收授权失败。')
    const headers = { cookie, 'content-type': 'application/json' }
    const setKey = async (endpoint: string, apiKey: string) => {
      const response = await fetch(url + endpoint, { method: 'PUT', headers, body: JSON.stringify({ apiKey }) })
      expect(response.status, '本地保存测试凭据失败').toBe(200)
    }
    await setKey('/api/providers/deepseek', deepseek)
    if (needsTavily) await setKey('/api/web/providers/tavily', tavily!)
    const picked = await fetch(url + '/api/workspaces/pick', { method: 'POST', headers })
    expect(picked.status).toBe(200)
    const { workspaceId } = await picked.json()
    const created = await fetch(url + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ workspaceId }) })
    expect(created.status).toBe(201)
    const { id: sessionId } = await created.json() as SessionSummary
    const messages = new Map<string, ConversationMessage>()
    const subscribe = new WebSocket(url.replace('http:', 'ws:') + '/api/events', { headers })
    socket = subscribe
    let ready!: () => void, finish!: () => void
    const listening = new Promise<void>(resolve => { ready = resolve })
    const finished = new Promise<void>(resolve => { finish = resolve })
    subscribe.on('error', () => {})
    subscribe.once('open', () => subscribe.send(JSON.stringify({ type: 'subscribe', subscriptionId: 'live-tools', sessionId })))
    subscribe.on('message', raw => {
      const frame = JSON.parse(String(raw)) as ServerFrame
      if (!('sessionId' in frame) || frame.sessionId !== sessionId) return
      if (frame.type === 'snapshot') ready()
      if (frame.type !== 'update') return
      const { change } = frame.update
      if (change.type === 'model' && (change.event.type === 'done' || change.event.type === 'error')) {
        messages.set(change.messageId, { id: change.messageId, message: change.event.type === 'done' ? change.event.message : change.event.error })
      } else if (change.type === 'task') {
        if (change.message) messages.set(change.message.id, change.message)
        if (!change.running) finish()
      }
    })
    await Promise.race([listening, waitForTimeout(10_000)])
    const text = `本次验收 ${scenario.name} 工具。请直接调用 ${scenario.name} 一次，只调用这个工具，收到结果后直接回答。${scenario.prompt}`
    const accepted = await fetch(url + '/api/messages', {
      method: 'POST', headers, body: JSON.stringify({ sessionId, clientMessageId: 'live-tool', modelId: 'deepseek-flash', text }),
    })
    expect(accepted.status).toBe(202)
    await Promise.race([finished, waitForTimeout(180_000)])
    const assistants = [...messages.values()].filter(item => item.message.role === 'assistant').map(item => item.message as AssistantMessage)
    const results = [...messages.values()].filter(item => item.message.role === 'toolResult').map(item => item.message as ToolResultMessage)
    const calls = assistants[0]?.content.filter(item => item.type === 'toolCall') ?? []
    expect(calls.map(call => call.name), assistants[0]?.errorMessage).toEqual([scenario.name])
    const result = results[0]
    expect(results.map(item => item.toolName)).toEqual([scenario.name])
    expect(result?.isError, result?.content.map(item => item.text).join('\n')).toBe(false)
    const toolText = result!.content.map(item => item.text).join('\n')
    expect(toolText).toMatch(scenario.result)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.tools).toHaveLength(8)
    expect(requests[1]?.tools).toHaveLength(8)
    expect(requests[1]?.messages.at(-2)?.tool_calls?.[0]?.id).toBe(calls[0]!.id)
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: calls[0]!.id, content: toolText })
    const answer = assistants[1]?.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('') ?? ''
    expect(assistants[1]?.stopReason, assistants[1]?.errorMessage).toBe('stop')
    expect(answer).toMatch(scenario.answer)
    if (scenario.name === 'edit') expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('项目名称：青禾\n状态：测试中\n负责人：小林\n')
    if (scenario.name === 'write') expect(await readFile(join(cwd, 'notes/note.txt'), 'utf8')).toBe('项目名称：青禾')
    if (scenario.name === 'find') expect(toolText).not.toContain('ignored.md')
    if (scenario.name === 'grep') expect(toolText).toMatch(/note\.txt[-:]1[-:].*项目名称：青禾[\s\S]*note\.txt[-:]3[-:].*负责人：小林/)
    if (scenario.name === 'web_search') expect(answer).toContain(toolText.split('\n')[1]!)
    if (scenario.name === 'web_fetch') expect(answer).toContain(publicPage)
  } finally {
    socket?.terminate()
    await server.close()
    await rm(temporary, { recursive: true, force: true })
  }
}, 200_000)

function waitForTimeout(milliseconds: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('等待本机验收结果超时。')), milliseconds).unref()
  })
}
