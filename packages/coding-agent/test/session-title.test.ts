import { expect, it, vi } from 'vitest'
import { findModel, type AssistantMessage, type ModelEventStream, type stream } from '@agent-learning/model'
import { generateSessionTitle, temporarySessionTitle } from '../src/session-title.js'

const model = findModel('deepseek-flash', 'deepseek')!
const assistant = (text: string): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], timestamp: 1,
  api: model.api, model: model.id, provider: model.provider, stopReason: 'stop',
})
const result = (text: string) => ({
  result: async () => assistant(text),
  async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message: assistant(text) } as const },
} satisfies ModelEventStream)

it('21 只用首条正文和首轮模型的最低推理档生成标题', async () => {
  const call = vi.fn<typeof stream>().mockReturnValue(result('排查服务启动失败'))
  const text = '帮我排查服务为什么启动失败'
  const signal = new AbortController().signal
  expect(temporarySessionTitle(text)).toBe(text)
  await expect(generateSessionTitle(call, model, text, signal)).resolves.toBe('排查服务启动失败')
  expect(call).toHaveBeenCalledOnce()
  const [route, context, options] = call.mock.calls[0]!
  expect(route).toMatchObject({ id: model.id, provider: model.provider })
  expect(context.messages).toEqual([{ role: 'user', timestamp: 0, content: text }])
  expect(context.tools).toBeUndefined()
  expect(options?.reasoningEffort).toBe(model.reasoningEfforts?.[0])
})

it('22 无效的标题保留临时名称', async () => {
  const call = vi.fn<typeof stream>().mockReturnValue(result('标题\n还有解释'))
  await expect(generateSessionTitle(call, model, '用户正文', new AbortController().signal)).resolves.toBeUndefined()
  expect(temporarySessionTitle('  第一行\n继续描述 ')).toBe('第一行 继续描述')
})

it('23 对旧库的一次迁移只从已保存的首条消息改写编号标题', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SessionStore } = await import('../src/session-store.js')
  const directory = await mkdtemp(join(tmpdir(), 'chat-title-'))
  const path = join(directory, 'sessions.sqlite')
  const old = SessionStore.open(path)
  const createdAt = new Date().toISOString()
  try {
    for (const [id, name] of [['numbered', '会话 3'], ['named', '已经命名'], ['empty', '会话 4']]) {
      const summary = { id, name, createdAt, workspaceId: 'work' }
      const run = { id: 'user-' + id, sessionId: id, clientMessageId: id, modelId: model.id, text: '服务启动失败',
        kind: 'task', status: 'running', startedAt: 1, acceptedSeq: 1 } as const
      const user = { id: run.id, clientMessageId: id, message: { role: 'user', content: run.text, timestamp: 1 } } as const
      old.save(id, { summary, ...(id !== 'empty' && { run, messages: [user] }) })
    }
    old.close()
    const previous = new DatabaseSync(path)
    previous.exec('PRAGMA user_version=0')
    previous.close()
    const upgraded = SessionStore.open(path)
    try {
      expect(upgraded.listSessions().map(session => session.name)).toEqual(['服务启动失败', '已经命名', '新会话'])
      expect(upgraded.readReferenceSource('numbered')?.messages).toEqual([{ role: 'user', text: '服务启动失败' }])
    } finally { upgraded.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
