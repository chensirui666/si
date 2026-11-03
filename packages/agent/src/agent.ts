import type { AgentSubscriptionEvent, ConversationSnapshot } from './types.js'

export class Agent {
  private readonly state: ConversationSnapshot = {
    seq: 0,
    messages: [],
    running: null,
    activeContent: [],
  }

  subscribe(signal: AbortSignal): AsyncIterableIterator<AgentSubscriptionEvent, undefined> {
    const snapshot = structuredClone(this.state)
    const done: IteratorReturnResult<undefined> = { done: true, value: undefined }
    const waiting = new Set<(result: IteratorResult<AgentSubscriptionEvent, undefined>) => void>()
    let closed = signal.aborted
    let snapshotPending = true

    const close = () => {
      closed = true
      signal.removeEventListener('abort', close)
      for (const resolve of waiting) resolve(done)
      waiting.clear()
    }

    if (!closed) signal.addEventListener('abort', close, { once: true })

    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (closed) return Promise.resolve(done)
        if (snapshotPending) {
          snapshotPending = false
          return Promise.resolve({ done: false, value: { type: 'snapshot', snapshot } })
        }
        // shortcut: 阶段一没有状态变化，阶段三接入模型时补充按序更新通知。
        return new Promise((resolve) => waiting.add(resolve))
      },
      return() {
        close()
        return Promise.resolve(done)
      },
    }
  }
}
