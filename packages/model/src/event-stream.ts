import type { AssistantMessage, ModelEvent, ModelEventStream } from './types.js'

export class AssistantEventStream implements ModelEventStream {
  private readonly queue: ModelEvent[] = []
  private readonly waiting: ((result: IteratorResult<ModelEvent>) => void)[] = []
  private done = false
  private resolveResult!: (message: AssistantMessage) => void
  private readonly finalResult = new Promise<AssistantMessage>((resolve) => { this.resolveResult = resolve })

  push(event: ModelEvent): void {
    if (this.done) return
    if (event.type === 'done' || event.type === 'error') {
      this.done = true
      this.resolveResult(event.type === 'done' ? event.message : event.error)
    }
    const resolve = this.waiting.shift()
    if (resolve) resolve({ done: false, value: event })
    else this.queue.push(event)
    if (this.done) {
      for (const waiter of this.waiting.splice(0)) waiter({ done: true, value: undefined })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
    while (true) {
      if (this.queue.length) yield this.queue.shift()!
      else if (this.done) return
      else {
        const item = await new Promise<IteratorResult<ModelEvent>>((resolve) => this.waiting.push(resolve))
        if (item.done) return
        yield item.value
      }
    }
  }

  result(): Promise<AssistantMessage> { return this.finalResult }
}
