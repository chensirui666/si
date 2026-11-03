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
    const running = { userMessageId: 'one', assistantMessageId: 'two' }
    const accepted = { type: 'update', subscriptionId: 'current', update: { seq: 1, change: { type: 'accepted', user, running } } }
    const result = applyFrame(state, accepted, 'current')
    expect(result.state.snapshot).toEqual({ ...empty, seq: 1, messages: [user], running })
    expect(state.snapshot).toEqual(empty)
    expect(applyFrame(state, { ...accepted, update: { ...accepted.update, seq: 2 } }, 'current').resubscribe).toBe(true)
    expect(applyFrame(state, { ...accepted, update: { seq: 1, change: { type: 'model', messageId: 'two', event: { type: 'text_delta', contentIndex: 0, delta: 'hello' } } } }, 'current').resubscribe).toBe(true)
  })
})
