import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AssistantMessage, ModelContext, ModelEventStream, ToolCall } from '@agent-learning/model'
import { Type } from 'typebox'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { AgentSession } from '../src/agent-session.js'
import { MemoryStore } from '../src/memory-store.js'
import { SessionStore } from '../src/session-store.js'
import { createTools } from '../src/tools.js'
import { ToolRuntime } from '../src/tool-runtime.js'

const privateNote = '必须先核对 relay-1977，然后才连接测试库。'
const userNote = '## 协作偏好\n\n请先说明影响再动手。'
const newUserNote = '## 协作偏好\n\n先给最短的操作顺序。'
const readOnlyTools = ['read', 'grep', 'find', 'ls']

let directory: string, cwd: string, store: MemoryStore, runtime: ToolRuntime
let settings: { enabled: boolean; generation: number }
const open: AgentSession[] = []
const databases: SessionStore[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'si-memory-session-'))
  cwd = join(directory, 'repo')
  await mkdir(cwd)
  execFileSync('git', ['init', '-q', cwd])
  store = new MemoryStore(join(directory, 'memory'))
  runtime = new ToolRuntime()
  settings = { enabled: true, generation: 0 }
})

afterEach(async () => {
  for (const session of open.splice(0)) await session.close()
  for (const database of databases.splice(0)) database.close()
  await runtime.close()
  await rm(directory, { force: true, recursive: true })
})

function reply(text: string | ToolCall): ModelEventStream {
  const stopReason = typeof text === 'string' ? 'stop' : 'toolUse'
  const message: AssistantMessage = { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', api: 'openai-completions',
    timestamp: Date.now(), content: [typeof text === 'string' ? { type: 'text', text } : text], stopReason }
  return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: 'done', reason: stopReason, message } } }
}

function session(handle: (context: ModelContext, index: number) => string | ToolCall, options: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const contexts: ModelContext[] = []
  const agent = new AgentSession({ resolveDirectory: async () => cwd, skillHome: directory, globalContextDirectory: directory,
    tools: dir => createTools(runtime, { web_search: async () => '', web_fetch: async () => '' }, dir),
    memory: { store, settings: async () => settings },
    titleStream: () => reply('测试会话'),
    stream: (_model, context) => { contexts.push(structuredClone(context)); return reply(handle(context, contexts.length - 1)) },
    ...options,
  })
  open.push(agent)
  return { agent, contexts }
}

function call(name: string, args: ToolCall['arguments']): ToolCall {
  return { type: 'toolCall', id: `${name}-call`, name, arguments: args }
}

async function snapshot(agent: AgentSession) {
  const controller = new AbortController()
  try {
    const event = (await agent.subscribe(controller.signal).next()).value
    if (event?.type !== 'snapshot') throw new Error('missing session snapshot')
    return event.snapshot
  } finally { controller.abort() }
}

async function turn(agent: AgentSession, id: string, text = '请检查测试环境。') {
  const receipt = await agent.submit({ clientMessageId: id, text, modelId: 'deepseek-flash' })
  const state = await vi.waitFor(async () => {
    const view = await snapshot(agent)
    expect(view.running).toBeNull()
    return view
  }, { interval: 5 })
  return { receipt, state }
}

function latestTools(context: ModelContext) { return context.tools?.map(tool => tool.name) ?? [] }

async function seedProject() {
  const project = await store.resolveProject(cwd)
  await store.apply('project', project, [{ operation: 'write', title: '测试库约定', summary: '集成测试使用测试库',
    content: privateNote, type: 'feedback' }], { sessionId: 'setup' })
  return (await store.prepareProject(project)).entries[0]!
}

it('01/31 用同一条流程记录来自前文的约定，服务端记录成功写入的会话与时间', async () => {
  const proposal = '以后集成测试都连接真实测试数据库，可以吗？'
  const { agent, contexts } = session((_context, index) => {
    if (index === 0) return proposal
    if (index === 1) return call('memory', { scope: 'project', operation: 'write', type: 'feedback', title: '测试约定',
      summary: '集成测试的约定', content: privateNote })
    return '本轮完成。'
  }, { sessionId: 'test-session' })
  const first = await turn(agent, 'first', '请先和我确认测试环境。')
  expect(latestTools(contexts[0]!)).toContain('memory')
  expect(await store.listProjects()).toEqual([])
  const next = await turn(agent, 'next', '可以')
  expect(contexts[1]?.messages.map(message => message.content)).toContainEqual([{ type: 'text', text: proposal }])
  expect(contexts[1]?.messages.at(-1)?.content).toBe('可以')
  expect(contexts[1]?.systemPrompt).not.toContain(first.state.messages[0]!.id)
  const stored = (await store.listProjects())[0]!
  expect(stored.entries).toHaveLength(1)
  const note = await readFile(stored.entries[0]!.path, 'utf8')
  const metadata = parse(note.split('---')[1]!)
  expect(metadata.sources).toEqual([{ type: 'session_write', sessionId: 'test-session', savedAt: metadata.updatedAt }])
  expect(Date.parse(metadata.sources[0].savedAt)).toBeGreaterThanOrEqual(next.state.messages[2]!.message.timestamp)
  expect(next.state.messages.at(-2)?.message).toMatchObject({ role: 'toolResult', toolCallId: 'memory-call', isError: false })
  expect(next.state.messages.at(-1)?.message).toMatchObject({ role: 'assistant', stopReason: 'stop' })
})

it('从当前记忆回查同仓库会话，只返回写入时已存在的原话，跨项目和关闭记忆时隔离', async () => {
  const database = SessionStore.open(join(directory, 'sessions.sqlite'))
  databases.push(database)
  const subdirectory = join(cwd, 'subdirectory')
  const outside = join(directory, 'outside')
  await Promise.all([mkdir(subdirectory), mkdir(outside)])
  const workspaces = new Map([['source', cwd], ['same-project', subdirectory], ['other-project', outside]])
  const persistence = (id: string, workspaceId: string) => {
    const summary = { id, workspaceId, name: id, createdAt: new Date().toISOString() }
    return { store: database, summary, first: () => ({ ...summary }) }
  }
  const uniqueEvidence = 'origin-evidence-7834'
  const source = session((_context, index) => index === 0 ? call('memory', { scope: 'user', operation: 'write', title: '协作习惯',
    summary: '先提供核对清单', content: '以后交付前先给核对清单。' }) : '完成。', { persistence: persistence('origin-session', 'source') })
  await turn(source.agent, 'first', `以后交付前先给核对清单。这条来自 ${uniqueEvidence}。`)
  const [entry] = (await store.readUser()).entries
  expect(entry).toBeDefined()
  await turn(source.agent, 'later', 'later-evidence-should-be-absent')

  const resolveWorkspaceDirectory = async (id: string) => workspaces.get(id)!
  const lookup = (_context: ModelContext, index: number) => index === 0
    ? call('memory_source', { scope: 'user', entryId: entry!.entryId }) : '完成来源核对。'
  const related = session(lookup, { persistence: persistence('lookup-session', 'same-project'), permissionMode: 'read-only',
    resolveDirectory: async () => subdirectory, resolveWorkspaceDirectory })
  const traced = await turn(related.agent, 'lookup', '这条约定来自哪里？')
  expect(latestTools(related.contexts[0]!)).toContain('memory_source')
  expect(latestTools(related.contexts[0]!)).not.toContain('memory')
  expect(related.contexts[0]?.systemPrompt).toContain(entry!.entryId)
  expect(traced.state.messages.at(-2)?.message).toMatchObject({ toolCallId: 'memory_source-call', isError: false })
  expect(JSON.stringify(related.contexts[1]?.messages)).toContain(uniqueEvidence)
  expect(JSON.stringify(related.contexts[1]?.messages)).not.toContain('later-evidence-should-be-absent')

  const unrelated = session(lookup, { persistence: persistence('outside-session', 'other-project'),
    resolveDirectory: async () => outside, resolveWorkspaceDirectory })
  const refused = await turn(unrelated.agent, 'lookup')
  expect(refused.state.messages.at(-2)?.message).toMatchObject({ toolCallId: 'memory_source-call', isError: true })
  expect(JSON.stringify(unrelated.contexts)).not.toContain(uniqueEvidence)

  settings = { enabled: false, generation: 1 }
  const off = await turn(related.agent, 'off')
  const next = related.contexts.at(-1)!
  expect(latestTools(next)).not.toContain('memory_source')
  expect(next.messages).toContainEqual(expect.objectContaining({ role: 'toolResult', toolCallId: 'memory_source-call' }))
  expect(JSON.stringify(next.messages)).not.toContain(uniqueEvidence)
  expect(JSON.stringify(off.state.messages)).toContain(uniqueEvidence)
})

it('05/06 权限只读和计划模式可以查阅，但工具调用无法写入记忆', async () => {
  await store.saveUser(userNote, 0)
  for (const mode of ['read-only', 'plan'] as const) {
    const { agent, contexts } = session((_context, index) => index === 0
      ? call('memory', { scope: 'user', operation: 'write', title: '偏好', content: '意外覆盖。' }) : '继续工作。',
    { permissionMode: mode === 'read-only' ? mode : 'normal' })
    if (mode === 'plan') await turn(agent, 'plan', '/plan')
    const { state } = await turn(agent, `${mode}-task`)
    expect(latestTools(contexts[0]!)).toEqual(expect.arrayContaining(readOnlyTools))
    expect(latestTools(contexts[0]!)).not.toContain('memory')
    expect(contexts[0]?.systemPrompt).toContain(userNote)
    expect(state.messages.at(-2)).toMatchObject({ toolErrorCode: 'permission_denied' })
    expect((await store.readUser()).markdown).toBe(userNote)
  }
})

it('09/12/14/30 目录随新消息刷新，个人记忆保持会话版本，关闭后保留配对，重开后读取新版', async () => {
  const initial = await store.saveUser(userNote, 0)
  const { agent, contexts } = session((_context, index) => {
    if (index === 1) return call('read', { path: join(cwd, 'note-alias.md') })
    if (index === 2) return call('memory', { scope: 'user', operation: 'write', title: '内容', summary: '测试',
      content: `memory-args-private ${'界'.repeat(1375)}` })
    return '本轮完成。'
  })
  await turn(agent, 'first')
  const note = await seedProject()
  await symlink(note.path, join(cwd, 'note-alias.md'))
  await store.saveUser(newUserNote, initial.revision)
  const visible = await turn(agent, 'read')
  expect(contexts[0]?.systemPrompt).toContain(userNote)
  expect(contexts[0]?.systemPrompt).not.toContain('测试库约定')
  expect(contexts[1]?.systemPrompt).toContain(userNote)
  expect(contexts[1]?.systemPrompt).toContain('测试库约定')
  expect(contexts[1]?.systemPrompt).toContain(`${initial.characters} / 1375 字符`)
  expect(contexts[1]?.systemPrompt).toMatch(/1 \/ 200 条，\d+ \/ 24000 字节/)
  expect(JSON.stringify(contexts[1])).not.toContain(privateNote)
  expect(JSON.stringify(contexts[2]?.messages)).toContain(privateNote)
  expect(JSON.stringify(contexts[3]?.messages)).toContain('capacity_exceeded')
  expect(JSON.stringify(contexts[3]?.messages)).toContain(newUserNote.split('\n\n')[1])
  expect(visible.state.messages.find(entry => entry.fileOperation?.kind === 'read')?.fileOperation?.path).toBe(await realpath(note.path))

  settings = { enabled: false, generation: 1 }
  const disabled = await turn(agent, 'off')
  const disabledContext = contexts.at(-1)!
  expect(disabledContext.systemPrompt).not.toContain('长期记忆')
  expect(latestTools(disabledContext)).not.toContain('memory')
  expect(JSON.stringify(disabledContext.messages)).not.toMatch(/relay-1977|memory-args-private|先给最短的操作顺序/)
  expect(disabledContext.messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId)).toEqual(['read-call', 'memory-call'])
  expect(JSON.stringify(disabled.state.messages)).toContain(privateNote)

  settings = { enabled: true, generation: 2 }
  await turn(agent, 'on')
  expect(contexts.at(-1)?.systemPrompt).toContain(newUserNote)
  const latest = await store.readUser()
  const [project] = await store.listProjects()
  await store.saveUser(userNote, latest.revision)
  await store.deleteProjectEntry(project!.projectId, note.entryId, note.revision)
  settings = { enabled: true, generation: 4 }
  await turn(agent, 'on-again')
  expect(contexts.at(-1)?.systemPrompt).toContain(userNote)
  expect(contexts.at(-1)?.systemPrompt).not.toContain(note.title)
  expect(latestTools(contexts.at(-1)!)).toContain('memory')
})

it('12 本轮项目目录和开关固定，到下一条消息才重新准备', async () => {
  const testTool = { name: 'external_save', description: '模拟外部会话提交', parameters: Type.Object({}), async execute() {
    await seedProject()
    settings = { enabled: false, generation: 1 }
    return '另一会话已提交。'
  } }
  const { agent, contexts } = session((_context, index) => index === 0 ? call('external_save', {}) : '完成。', { tools: () => [testTool] })
  await turn(agent, 'first')
  expect(contexts[1]?.systemPrompt).not.toContain('测试库约定')
  expect(latestTools(contexts[1]!)).toContain('memory')
  await turn(agent, 'second')
  expect(latestTools(contexts[2]!)).not.toContain('memory')
  settings = { enabled: true, generation: 2 }
  await turn(agent, 'third')
  expect(contexts[3]?.systemPrompt).toMatch(/测试库约定/)
})

it('27 第 201 条被拒绝，原调用收到容量原因后仍能继续执行工具并结束', async () => {
  const project = await store.resolveProject(cwd)
  const target = dirname((await store.prepareProject(project)).directoryPath)
  await mkdir(target, { recursive: true })
  await writeFile(join(cwd, 'check.txt'), '当前任务仍在继续。')
  await Promise.all(Array.from({ length: 199 }, (_, index) => {
    const entryId = `entry-${index}`
    const metadata = { entryId, title: 'Test', summary: '测试', type: 'feedback', revision: 1, updatedAt: new Date(1).toISOString(), sources: [] }
    return writeFile(join(target, `${entryId}.md`), `---\n${JSON.stringify(metadata)}\n---\n\n原有项目记忆。\n`)
  }))
  const { agent, contexts } = session((_context, index) => {
    if (index === 3) return call('read', { path: 'check.txt' })
    if (index !== 0 && index !== 2) return '完成。'
    return call('memory', { scope: 'project', operation: 'write', type: 'feedback', title: `第 ${index} 个约定`, summary: '集成测试约定',
      content: `测试方案：${index}` })
  })
  await turn(agent, 'limit')
  const full = await store.prepareProject(project)
  expect(full.count).toBe(200)
  const overflow = await turn(agent, 'overflow')
  const denied = contexts[3]?.messages.at(-1)
  expect(denied).toMatchObject({ role: 'toolResult', toolCallId: 'memory-call', isError: true })
  const result = denied?.role === 'toolResult' ? denied.content[0] : undefined
  expect(JSON.parse(result?.type === 'text' ? result.text : '{}')).toMatchObject({ status: 'capacity_exceeded', overByCount: 1 })
  expect(contexts[4]?.messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'read-call', isError: false })
  expect(overflow.state.messages.at(-1)?.message).toMatchObject({ role: 'assistant', stopReason: 'stop' })
  expect(await store.prepareProject(project)).toEqual(full)
})

it('13/14 压缩成功使个人缓存刷新，关闭记忆的摘要请求省去旧笔记正文', async () => {
  const personal = await store.saveUser(userNote, 0)
  const note = await seedProject()
  const { agent, contexts } = session((context, index) => !context.tools ? '概要。' : index === 0 ? call('read', { path: note.path }) : '终点'.repeat(600),
    { compaction: { triggerTokens: 100_000, keepRecentTokens: 80 } })
  await turn(agent, 'one', '第一段编程请求。'.repeat(100))
  await turn(agent, 'two', '第二段编程请求。'.repeat(100))
  await store.saveUser(newUserNote, personal.revision)
  const compacted = await turn(agent, 'compact', '/compact')
  expect(compacted.state.compactions.at(-1)?.status).toBe('success')
  await turn(agent, 'resume')
  expect(contexts.at(-1)?.systemPrompt).toContain(newUserNote)

  const other = session((context, index) => !context.tools ? '概要。' : index === 0 ? call('read', { path: note.path }) : '终点'.repeat(600),
    { compaction: { triggerTokens: 100_000, keepRecentTokens: 80 } })
  await turn(other.agent, 'one', '第一段编程请求。'.repeat(100))
  await turn(other.agent, 'two', '第二段编程请求。'.repeat(100))
  settings = { enabled: false, generation: 1 }
  await turn(other.agent, 'compact', '/compact')
  expect(JSON.stringify(other.contexts.at(-1))).toContain('read-call')
  expect(JSON.stringify(other.contexts.at(-1))).not.toContain('relay-1977')
})

it('关闭时与其他项目会话无法直接读取同一笔记，包括通过文件别名读取', async () => {
  const note = await seedProject()
  await symlink(note.path, join(directory, 'alias.md'))
  const other = join(directory, 'other')
  await mkdir(other)
  const handle = (_context: ModelContext, index: number) => index === 0 ? call('read', { path: join(directory, 'alias.md') }) : '继续。'
  const isolated = session(handle, { resolveDirectory: async () => other })
  expect((await turn(isolated.agent, 'isolated')).state.messages.at(-2)?.message).toMatchObject({ role: 'toolResult', isError: true })
  settings = { enabled: false, generation: 1 }
  const disabled = session(handle)
  expect((await turn(disabled.agent, 'disabled')).state.messages.at(-2)?.message).toMatchObject({ role: 'toolResult', isError: true })
  for (const { contexts } of [isolated, disabled]) expect(JSON.stringify(contexts)).not.toContain('relay-1977')
})
