import { describe, expect, it } from 'vitest'
import { applyFrame, initialState as disconnected } from './state'

const sessionId = 'session-a'
const initialState = { ...disconnected, sessionId }
const empty = { seq: 0, messages: [], running: null, compactions: [], contextUsage: null, activeContent: [] }
const ready = () => applyFrame(initialState, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot: empty }, 'current').state

describe('conversation state', () => {
  it.each([
    { seq: -1, messages: [], running: null, compactions: [], contextUsage: null, activeContent: [] },
    { seq: 0.5, messages: [], running: null, compactions: [], contextUsage: null, activeContent: [] },
    { ...empty, running: {} },
    { ...empty, compactions: [], contextUsage: null, activeContent: [{}] },
    { ...empty, messages: [{ id: 'one', message: { role: 'user', content: [null], timestamp: 1 } }] },
  ])('不接受不完整快照 %j', snapshot => {
    const result = applyFrame(initialState, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot }, 'current')
    expect(result.state).toBe(initialState)
    expect(result.resubscribe).toBe(false)
  })

  it('旧编号、快照前更新和重复序号不改变已有状态', () => {
    const state = ready()
    expect(state.snapshot).toEqual(empty)
    expect(applyFrame(state, { type: 'snapshot', sessionId, subscriptionId: 'old', snapshot: { ...empty, seq: 20 } }, 'current').state).toBe(state)
    expect(applyFrame(state, { type: 'update', sessionId, subscriptionId: 'current', update: { seq: 0 } }, 'current').state).toBe(state)
    expect(applyFrame(initialState, { type: 'update', sessionId, subscriptionId: 'current', update: { seq: 1 } }, 'current').state).toBe(initialState)
  })

  it('连续 accepted 保留原文且不修改已有快照，跳号与模型块请求完整快照', () => {
    const state = ready()
    const user = { id: 'one', message: { role: 'user', content: '  原文\n', timestamp: 1 } }
    const running = { kind: 'task' as const, runId: 'one', assistantMessageId: 'two', phase: 'model', activeTools: [] }
    const accepted = { type: 'update', sessionId, subscriptionId: 'current', update: { seq: 1, change: { type: 'accepted', user, running } } }
    const result = applyFrame(state, accepted, 'current')
    expect(result.state.snapshot).toEqual({ ...empty, seq: 1, messages: [user], running })
    expect(state.snapshot).toEqual(empty)
    expect(applyFrame(state, { ...accepted, update: { ...accepted.update, seq: 2 } }, 'current').resubscribe).toBe(true)
    expect(applyFrame(state, { ...accepted, update: { seq: 1, change: { type: 'model', messageId: 'two', event: { type: 'text_delta', contentIndex: 0, delta: 'hello' } } } }, 'current').resubscribe).toBe(true)
  })
})

it('完整应用三类块、块终值和最终回复，不提前读取或重复累积内容', () => {
  let state = ready()
  let seq = 0
  const push = (event: unknown) => {
    const result = applyFrame(state, { type: 'update', sessionId, subscriptionId: 'current', update: { seq: ++seq, change: { type: 'model', messageId: 'answer', event } } }, 'current')
    expect(result.resubscribe).toBe(false)
    state = result.state
  }
  const initial = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1 }
  push({ type: 'start', initial })
  push({ type: 'thinking_start', contentIndex: 0 })
  push({ type: 'thinking_delta', contentIndex: 0, delta: '想一想' })
  push({ type: 'thinking_end', contentIndex: 0, content: '完整思考' })
  push({ type: 'text_start', contentIndex: 1 })
  const before = state
  push({ type: 'text_delta', contentIndex: 1, delta: '**答' })
  expect(before.snapshot?.messages[0].message.content).toEqual([{ type: 'thinking', thinking: '完整思考' }, { type: 'text', text: '' }])
  push({ type: 'text_end', contentIndex: 1, content: '**答案**' })
  push({ type: 'toolcall_start', contentIndex: 2 })
  push({ type: 'toolcall_delta', contentIndex: 2, delta: '{"city":' })
  expect(state.snapshot?.activeContent).toEqual([{ messageId: 'answer', contentIndex: 2, type: 'toolCall', argumentsText: '{"city":' }])
  const toolCall = { type: 'toolCall', id: 'call', name: 'weather', arguments: {}, argumentsError: '无效 JSON: {"city":' }
  push({ type: 'toolcall_end', contentIndex: 2, toolCall })
  const message = { ...initial, content: [{ type: 'text', text: '最终校准' }, toolCall], stopReason: 'toolUse' }
  push({ type: 'done', reason: 'toolUse', message })
  expect(state.snapshot?.messages).toEqual([{ id: 'answer', message }])
  expect(state.snapshot?.activeContent).toEqual([])
  expect(state.snapshot?.running).toBeNull()
})

it('start 前的失败仍形成正式回复并结束运行', () => {
  const error = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, content: [], stopReason: 'error', errorMessage: '调用失败' }
  const result = applyFrame(ready(), { type: 'update', sessionId, subscriptionId: 'current', update: { seq: 1, change: { type: 'model', messageId: 'failed', event: { type: 'error', reason: 'error', error } } } }, 'current')
  expect(result.resubscribe).toBe(false)
  expect(result.state.snapshot?.messages).toEqual([{ id: 'failed', message: error }])
})

it.each([
  { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, content: [], stopReason: 'error', errorMessage: { unsafe: true } },
  { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, content: [{ type: 'toolCall', id: 'call', name: 'search', arguments: {}, argumentsError: { unsafe: true } }], stopReason: 'toolUse' },
])('不接受无法安全展示的错误字段 %j', message => {
  const state = initialState
  expect(applyFrame(state, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot: { ...empty, messages: [{ id: 'answer', message }] } }, 'current').state).toBe(state)
})

it('模型回复结束后仍忙碌，任务更新带回结果并独立结束', () => {
  const assistant = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'note.txt' } }] }
  const running = { kind: 'task' as const, runId: 'u', assistantMessageId: 'a', phase: 'model', activeTools: [] }
  const user = { id: 'u', message: { role: 'user', content: '读取', timestamp: 0 } }
  let state = applyFrame(initialState, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot: { ...empty, messages: [user], running } }, 'current').state
  const update = (seq: number, change: unknown) => { state = applyFrame(state, { type: 'update', sessionId, subscriptionId: 'current', update: { seq, change } }, 'current').state }
  update(1, { type: 'model', messageId: 'a', event: { type: 'done', reason: 'toolUse', message: assistant } })
  expect(state.snapshot?.running).toEqual(running)
  const toolCall = { assistantMessageId: 'a', contentIndex: 0 }
  update(2, { type: 'task', running: { ...running, phase: 'tools', activeTools: [toolCall] } })
  expect(state.snapshot?.running).toMatchObject({ phase: 'tools', activeTools: [toolCall] })
  const message = { id: 'result', toolCall, fileOperation: { kind: 'read', path: '/work/note.txt' }, message: { role: 'toolResult', toolCallId: 'call', toolName: 'read', timestamp: 2, isError: false, content: [{ type: 'text', text: '青禾' }] } }
  update(3, { type: 'task', running: { ...running, phase: 'model', activeTools: [] }, message, messageIndex: 2 })
  expect(state.snapshot?.messages).toEqual([user, { id: 'a', message: assistant }, message])
  update(4, { type: 'task', running: null })
  expect(state.snapshot?.running).toBeNull()
})


describe('Feature6 乱序结果和进度校验', () => {
  const base = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, stopReason: 'toolUse' }
  const calls = ['note.txt', 'status.txt'].map((path, i) => ({ type: 'toolCall', id: `call-${i}`, name: 'read', arguments: { path } }))
  const messages = [{ id: 'u', message: { role: 'user', content: '找项目', timestamp: 0 } }, { id: 'a', message: { ...base, content: calls } }]
  const locations = [0, 1].map(contentIndex => ({ assistantMessageId: 'a', contentIndex }))
  const running = { kind: 'task' as const, runId: 'u', assistantMessageId: 'a', phase: 'tools', activeTools: locations }
  const result = (i: number) => ({ id: `r${i}`, toolCall: locations[i], message: { role: 'toolResult', toolCallId: `call-${i}`, toolName: 'read', timestamp: 2, isError: false, content: [{ type: 'text', text: i ? '状态：测试中' : '项目名称：青禾' }] } })
  const start = () => applyFrame(initialState, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot: { ...empty, messages, running } }, 'current').state
  const task = (state: ReturnType<typeof start>, change: unknown, seq = 1) => applyFrame(state, { type: 'update', sessionId, subscriptionId: 'current', update: { seq, change } }, 'current')

  it('W2 B 先到、A 后插入，增量与两次刷新快照相同', () => {
    const state = start()
    const first = task(state, { type: 'task', running: { ...running, activeTools: [locations[0]] }, message: result(1), messageIndex: 2 })
    expect(first.resubscribe).toBe(false)
    expect(first.state.snapshot?.messages).toEqual([...messages, result(1)])
    const firstRefresh = applyFrame(initialState, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot: first.state.snapshot }, 'current').state
    expect(firstRefresh.snapshot).toEqual(first.state.snapshot)
    const second = task(first.state, { type: 'task', running: { ...running, activeTools: [] }, message: result(0), messageIndex: 2 }, 2)
    expect(second.resubscribe).toBe(false)
    expect(second.state.snapshot?.messages).toEqual([...messages, result(0), result(1)])
    expect(applyFrame(initialState, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot: second.state.snapshot }, 'current').state.snapshot).toEqual(second.state.snapshot)
    expect(state.snapshot?.messages).toEqual(messages)
  })

  it('W2.1 新一轮助手尚未 start 也接受 model 进度', () => {
    const state = start()
    const result = task(state, { type: 'task', running: { kind: 'task' as const, runId: 'u', assistantMessageId: 'next', phase: 'model', activeTools: [] } })
    expect(result.resubscribe).toBe(false)
    expect(result.state.snapshot?.running).toMatchObject({ kind: 'task', assistantMessageId: 'next' })
    expect(applyFrame(initialState, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot: result.state.snapshot }, 'current').state.connection).toBe('ready')
  })

  it.each([
    { message: result(0) },
    { messageIndex: 2 },
    { message: result(0), messageIndex: 100 },
    { message: result(0), messageIndex: -1 },
    { message: result(0), messageIndex: 0 },
    { message: { ...result(0), toolErrorCode: 'interrupted' }, messageIndex: 2 },
    { message: { ...result(0), fileOperation: { kind: 'modified', path: '/work/note.txt' } }, messageIndex: 2 },
    { message: { ...result(0), fileOperation: { kind: 'read', path: 42 } }, messageIndex: 2 },
    { message: { ...result(0), toolCall: { assistantMessageId: 'unknown', contentIndex: 0 } }, messageIndex: 2 },
    { message: { ...result(0), message: { ...result(0).message, toolCallId: 'wrong' } }, messageIndex: 2 },
  ])('W3.1—3.3 无效结果通知要求重新获取记录 %j', fields => {
    const state = start()
    const applied = task(state, { type: 'task', running: { ...running, activeTools: [] }, ...fields })
    expect(applied.resubscribe).toBe(true)
    expect(applied.state).toBe(state)
  })

  it.each([
    { kind: 'task' as const, runId: 'missing', assistantMessageId: 'a', phase: 'model', activeTools: [] },
    { kind: 'task' as const, runId: 'u', assistantMessageId: 'missing', phase: 'tools', activeTools: [] },
    { kind: 'task' as const, runId: 'u', assistantMessageId: 'u', phase: 'model', activeTools: [] },
  ])('任务进度必须对应实际用户和合法助手位置 %j', invalid => {
    const state = start()
    const applied = task(state, { type: 'task', running: invalid })
    expect(applied.resubscribe).toBe(true)
    expect(applied.state).toBe(state)
    const snapshot = applyFrame(initialState, { type: 'snapshot', sessionId, subscriptionId: 'current', snapshot: { ...empty, messages, running: invalid } }, 'current')
    expect(snapshot.state).toBe(initialState)
  })

  it.each([
    [{ assistantMessageId: 'a', contentIndex: 6 }],
    [{ assistantMessageId: 'unknown', contentIndex: 0 }],
    [locations[0], locations[0]],
  ].map(activeTools => ({ activeTools })))('W3.4 不存在或重复的活动工具不能应用 %j', ({ activeTools }) => {
    const state = start()
    const applied = task(state, { type: 'task', running: { ...running, activeTools } })
    expect(applied.resubscribe).toBe(true)
    expect(applied.state).toBe(state)
  })
})

it('accepted 的任务编号不属于所收用户时重取快照', () => {
  const state = ready()
  const result = applyFrame(state, { type: 'update', sessionId, subscriptionId: 'current', update: { seq: 1, change: {
    type: 'accepted', user: { id: 'u', message: { role: 'user', content: 'hello', timestamp: 1 } },
    running: { kind: 'task' as const, runId: 'missing', assistantMessageId: 'a', phase: 'model', activeTools: [] },
  } } }, 'current')
  expect(result.resubscribe).toBe(true)
  expect(result.state).toBe(state)
})

it('独立压缩记录与容量按序更新，成功收尾仍忙碌，重复帧不产生第二条记录', () => {
  let state = ready()
  const running = { kind: 'compaction', runId: 'c1', phase: 'compaction' }
  const record = { id: 'c1', clientMessageId: 'draft', trigger: 'manual', status: 'running', startedAt: 1 }
  const push = (seq: number, change: unknown, contextUsage?: unknown) => applyFrame(state, { type: 'update', sessionId, subscriptionId: 'current', update: { seq, change, ...(contextUsage === undefined ? {} : { contextUsage }) } }, 'current')
  let result = push(1, { type: 'compaction', record, running })
  expect(result.resubscribe).toBe(false)
  state = result.state
  const success = { ...record, status: 'success', finishedAt: 2, summary: '摘要', firstKeptMessageId: 'u1', contextLastMessageId: 'a1', estimatedBefore: 1000, estimatedAfter: 400 }
  const capacity = { tokens: 450, contextWindow: 10000, breakdown: { systemTokens: 50, toolsTokens: 100, messageTokens: 250 } }
  const invalid = { ...success, fileOperations: { readFiles: [42], modifiedFiles: [] } }
  expect(push(2, { type: 'compaction', record: invalid, running }).resubscribe).toBe(true)
  const withFiles = { ...success, fileOperations: { readFiles: ['/work/note.txt'], modifiedFiles: [] } }
  result = push(2, { type: 'compaction', record: withFiles, running }, capacity)
  expect(result.resubscribe).toBe(false)
  state = result.state
  expect(state.snapshot?.compactions).toEqual([withFiles])
  expect(state.snapshot?.contextUsage).toEqual(capacity)
  expect(state.snapshot?.messages).toEqual([])
  expect(push(2, { type: 'compaction', record: success, running }).state).toBe(state)
  result = push(3, { type: 'task', running: null })
  expect(result.state.snapshot?.running).toBeNull()
})

it.each([
  { tokens: -1, breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } },
  { tokens: 0, contextWindow: 0, breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } },
  { tokens: 10, breakdown: { systemTokens: 0, toolsTokens: '10', messageTokens: 0 } },
])('无效容量更新请求重新同步，不污染已确认快照 %j', contextUsage => {
  const state = ready()
  const result = applyFrame(state, { type: 'update', sessionId, subscriptionId: 'current', update: { seq: 1, change: { type: 'task', running: null }, contextUsage } }, 'current')
  expect(result.resubscribe).toBe(true)
  expect(result.state).toBe(state)
})
