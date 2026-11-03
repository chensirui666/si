import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'

describe('Agent 初始订阅', () => {
  it('首先提供真实空快照', async () => {
    const controller = new AbortController()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: 'snapshot',
        snapshot: { seq: 0, messages: [], running: null, activeContent: [] },
      },
    })

    controller.abort()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it('修改快照不会改变 Agent 或其他订阅的状态', async () => {
    const agent = new Agent()
    const controller = new AbortController()
    const first = agent.subscribe(controller.signal)[Symbol.asyncIterator]()
    const firstEvent = (await first.next()).value
    expect(firstEvent?.type).toBe('snapshot')
    if (firstEvent?.type !== 'snapshot') throw new Error('缺少初始快照')

    firstEvent.snapshot.seq = 9
    firstEvent.snapshot.messages.push({
      id: 'only-in-returned-copy',
      message: { role: 'user', content: '改副本', timestamp: 0 },
    })
    firstEvent.snapshot.activeContent.push({
      messageId: 'only-in-returned-copy', contentIndex: 0, type: 'text',
    })

    const second = agent.subscribe(controller.signal)[Symbol.asyncIterator]()
    expect((await second.next()).value).toEqual({
      type: 'snapshot',
      snapshot: { seq: 0, messages: [], running: null, activeContent: [] },
    })
    controller.abort()
  })

  it('取消一个订阅不会结束另一个订阅', async () => {
    const agent = new Agent()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = agent.subscribe(firstController.signal)[Symbol.asyncIterator]()
    const second = agent.subscribe(secondController.signal)[Symbol.asyncIterator]()
    await first.next()
    await second.next()

    const firstPending = first.next()
    let secondEnded = false
    const secondPending = second.next().then((result) => {
      secondEnded = true
      return result
    })
    firstController.abort()

    expect(await firstPending).toEqual({ done: true, value: undefined })
    expect(secondEnded).toBe(false)
    secondController.abort()
    expect(await secondPending).toEqual({ done: true, value: undefined })
  })

  it('预取消信号不产生快照或遗留监听', async () => {
    const controller = new AbortController()
    controller.abort()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('等待更新时取消会结束所有等待并移除监听', async () => {
    const controller = new AbortController()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const firstPending = iterator.next()
    const secondPending = iterator.next()

    controller.abort()

    expect(await firstPending).toEqual({ done: true, value: undefined })
    expect(await secondPending).toEqual({ done: true, value: undefined })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each(['读取前', '收到快照后', '等待更新中'])('%s return 会立刻释放订阅', async (stage) => {
    const controller = new AbortController()
    const iterator = new Agent().subscribe(controller.signal)[Symbol.asyncIterator]()
    if (stage !== '读取前') await iterator.next()
    const pending = stage === '等待更新中' ? iterator.next() : undefined

    expect(await iterator.return?.()).toEqual({ done: true, value: undefined })
    if (pending) expect(await pending).toEqual({ done: true, value: undefined })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})
