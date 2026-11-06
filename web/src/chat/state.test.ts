import { describe, expect, it } from 'vitest'
import { applyFrame, initialState } from './state'

const empty = { seq: 0, messages: [], running: null, activeContent: [] }
const ready = () => applyFrame(initialState, { type: 'snapshot', subscriptionId: 'current', snapshot: empty }, 'current').state

describe('conversation state', () => {
  it.each([
    { seq: -1, messages: [], running: null, activeContent: [] },
    { seq: 0.5, messages: [], running: null, activeContent: [] },
    { ...empty, running: {} },
    { ...empty, activeContent: [{}] },
    { ...empty, messages: [{ id: 'one', message: { role: 'user', content: [null], timestamp: 1 } }] },
  ])('不接受不完整快照 %j', snapshot => {
    const result = applyFrame(initialState, { type: 'snapshot', subscriptionId: 'current', snapshot }, 'current')
    expect(result.state).toBe(initialState)
    expect(result.resubscribe).toBe(false)
  })

  it('旧编号、快照前更新和重复序号不改变已有状态', () => {
    const state = ready()
    expect(state.snapshot).toEqual(empty)
    expect(applyFrame(state, { type: 'snapshot', subscriptionId: 'old', snapshot: { ...empty, seq: 20 } }, 'current').state).toBe(state)
    expect(applyFrame(state, { type: 'update', subscriptionId: 'current', update: { seq: 0 } }, 'current').state).toBe(state)
    expect(applyFrame(initialState, { type: 'update', subscriptionId: 'current', update: { seq: 1 } }, 'current').state).toBe(initialState)
  })

  it('连续 accepted 保留原文且不修改已有快照，跳号与模型块请求完整快照', () => {
    const state = ready()
    const user = { id: 'one', message: { role: 'user', content: '  原文\n', timestamp: 1 } }
    const running = { userMessageId: 'one', assistantMessageId: 'two', phase: 'model' }
    const accepted = { type: 'update', subscriptionId: 'current', update: { seq: 1, change: { type: 'accepted', user, running } } }
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
    const result = applyFrame(state, { type: 'update', subscriptionId: 'current', update: { seq: ++seq, change: { type: 'model', messageId: 'answer', event } } }, 'current')
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
  const result = applyFrame(ready(), { type: 'update', subscriptionId: 'current', update: { seq: 1, change: { type: 'model', messageId: 'failed', event: { type: 'error', reason: 'error', error } } } }, 'current')
  expect(result.resubscribe).toBe(false)
  expect(result.state.snapshot?.messages).toEqual([{ id: 'failed', message: error }])
})

it.each([
  { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, content: [], stopReason: 'error', errorMessage: { unsafe: true } },
  { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, content: [{ type: 'toolCall', id: 'call', name: 'search', arguments: {}, argumentsError: { unsafe: true } }], stopReason: 'toolUse' },
])('不接受无法安全展示的错误字段 %j', message => {
  const state = initialState
  expect(applyFrame(state, { type: 'snapshot', subscriptionId: 'current', snapshot: { ...empty, messages: [{ id: 'answer', message }] } }, 'current').state).toBe(state)
})

it('模型回复结束后仍忙碌，任务更新带回结果并独立结束', () => {
  const assistant = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'note.txt' } }] }
  const running = { userMessageId: 'u', assistantMessageId: 'a', phase: 'model' }
  let state = applyFrame(initialState, { type: 'snapshot', subscriptionId: 'current', snapshot: { ...empty, running } }, 'current').state
  const update = (seq: number, change: unknown) => { state = applyFrame(state, { type: 'update', subscriptionId: 'current', update: { seq, change } }, 'current').state }
  update(1, { type: 'model', messageId: 'a', event: { type: 'done', reason: 'toolUse', message: assistant } })
  expect(state.snapshot?.running).toEqual(running)
  const toolCall = { assistantMessageId: 'a', contentIndex: 0 }
  update(2, { type: 'task', running: { ...running, phase: 'tools', activeTool: toolCall } })
  expect(state.snapshot?.running).toMatchObject({ phase: 'tools', activeTool: toolCall })
  const message = { id: 'result', toolCall, message: { role: 'toolResult', toolCallId: 'call', toolName: 'read', timestamp: 2, isError: false, content: [{ type: 'text', text: '青禾' }] } }
  update(3, { type: 'task', running: { ...running, phase: 'answer' }, message })
  expect(state.snapshot?.messages).toEqual([{ id: 'a', message: assistant }, message])
  update(4, { type: 'task', running: null })
  expect(state.snapshot?.running).toBeNull()
})
