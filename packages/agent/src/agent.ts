import { randomUUID } from 'node:crypto'
import { findModel, stream } from '@agent-learning/model'
import type { AssistantMessage, ModelEvent, ModelInfo } from '@agent-learning/model'
import type { AgentSubscriptionEvent, ConversationSnapshot, ConversationUpdate, ModelFrame } from './types.js'

export class AgentSubmitError extends Error {
  constructor(readonly status: 400 | 409 | 503, message: string) { super(message) }
}

export class Agent {
  private readonly state: ConversationSnapshot = { seq: 0, messages: [], running: null, activeContent: [] }
  private readonly listeners = new Set<(update: ConversationUpdate) => void>()
  private controller?: AbortController
  private task?: Promise<void>
  private closed = false

  constructor(private readonly options: { stream?: typeof stream } = {}) {}

  async submit(input: { clientMessageId: string; modelId: string; text: string }): Promise<{ clientMessageId: string; userMessageId: string; acceptedSeq: number }> {
    if (this.closed) throw new AgentSubmitError(503, '服务正在关闭')
    const model = typeof input?.modelId === 'string' ? findModel(input.modelId) : undefined
    if (!model || typeof input.text !== 'string' || !input.text.trim()
      || typeof input.clientMessageId !== 'string' || !input.clientMessageId.trim() || input.clientMessageId.length > 128) {
      throw new AgentSubmitError(400, '请提交有效原文、支持的模型和临时编号')
    }
    if (this.state.running) throw new AgentSubmitError(409, '正在生成，请等待本次回答结束')
    const user = { id: randomUUID(), clientMessageId: input.clientMessageId, message: { role: 'user' as const, content: input.text, timestamp: Date.now() } }
    const running = { userMessageId: user.id, assistantMessageId: randomUUID() }
    this.state.messages.push(user)
    this.state.running = running
    this.publish({ type: 'accepted', user, running })
    const acceptedSeq = this.state.seq
    const controller = this.controller = new AbortController()
    this.task = Promise.resolve().then(() => this.generate(model, running.assistantMessageId, controller.signal))
    return { clientMessageId: input.clientMessageId, userMessageId: user.id, acceptedSeq }
  }

  private publish(change: ConversationUpdate['change']) {
    const update = { seq: ++this.state.seq, change }
    for (const listener of this.listeners) listener(structuredClone(update))
  }

  private async generate(model: ModelInfo, messageId: string, signal: AbortSignal) {
    let terminal = false
    try {
      const messages = structuredClone(this.state.messages.flatMap(({ message }) =>
        message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted') ? [] : [message]))
      const output = (this.options.stream ?? stream)(model, { messages }, { signal })
      for await (const event of output) {
        const frame = this.frame(event)
        this.apply(messageId, frame)
        this.publish({ type: 'model', messageId, event: frame })
        if (event.type === 'done' || event.type === 'error') { terminal = true; break }
      }
      if (!terminal) throw new Error('Model stream ended without a terminal event')
    } catch {
      if (terminal) return
      const current = this.state.messages.find(message => message.id === messageId)?.message
      const error: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: current?.timestamp ?? Date.now(),
        content: current?.role === 'assistant' ? structuredClone(current.content) : [],
        stopReason: signal.aborted ? 'aborted' : 'error',
        errorMessage: signal.aborted ? '本次生成已取消' : '模型调用意外中断，请重新发送',
      }
      const frame: ModelFrame = { type: 'error', reason: signal.aborted ? 'aborted' : 'error', error }
      this.apply(messageId, frame)
      this.publish({ type: 'model', messageId, event: frame })
    } finally {
      if (this.controller?.signal === signal) this.controller = undefined
    }
  }

  private frame(event: ModelEvent): ModelFrame {
    if (event.type === 'start') {
      const { role, api, provider, model, timestamp } = event.partial
      return { type: 'start', initial: { role, api, provider, model, timestamp } }
    }
    if (event.type === 'done' || event.type === 'error') return structuredClone(event)
    const { partial: _partial, ...frame } = event
    return structuredClone(frame)
  }

  private apply(messageId: string, event: ModelFrame) {
    if (event.type === 'start') {
      this.state.messages.push({ id: messageId, message: { ...event.initial, content: [], stopReason: 'pending' } })
      return
    }
    if (event.type === 'done' || event.type === 'error') {
      const message = structuredClone(event.type === 'done' ? event.message : event.error)
      const current = this.state.messages.find(entry => entry.id === messageId)
      if (current) current.message = message
      else this.state.messages.push({ id: messageId, message })
      this.state.running = null
      this.state.activeContent = []
      return
    }
    const message = this.state.messages.find(entry => entry.id === messageId)?.message
    if (message?.role !== 'assistant') throw new Error('Missing assistant start')
    const block = message.content[event.contentIndex]
    switch (event.type) {
      case 'text_start':
        message.content[event.contentIndex] = { type: 'text', text: '' }
        this.state.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'text' })
        break
      case 'thinking_start':
        message.content[event.contentIndex] = { type: 'thinking', thinking: '' }
        this.state.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'thinking' })
        break
      case 'toolcall_start':
        message.content[event.contentIndex] = { type: 'toolCall', id: '', name: '', arguments: {} }
        this.state.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'toolCall', argumentsText: '' })
        break
      case 'text_delta':
        if (block?.type !== 'text') throw new Error('Missing text block')
        block.text += event.delta
        break
      case 'thinking_delta':
        if (block?.type !== 'thinking') throw new Error('Missing thinking block')
        block.thinking += event.delta
        break
      case 'toolcall_delta': {
        const active = this.state.activeContent.find(entry => entry.messageId === messageId && entry.contentIndex === event.contentIndex)
        if (active?.type !== 'toolCall') throw new Error('Missing tool block')
        active.argumentsText += event.delta
        break
      }
      case 'text_end': message.content[event.contentIndex] = { type: 'text', text: event.content }; break
      case 'thinking_end': message.content[event.contentIndex] = { type: 'thinking', thinking: event.content }; break
      case 'toolcall_end': message.content[event.contentIndex] = structuredClone(event.toolCall); break
    }
    if (event.type === 'text_end' || event.type === 'thinking_end' || event.type === 'toolcall_end') {
      this.state.activeContent = this.state.activeContent.filter(entry => entry.messageId !== messageId || entry.contentIndex !== event.contentIndex)
    }
  }

  subscribe(signal: AbortSignal): AsyncIterableIterator<AgentSubscriptionEvent, undefined> {
    const done: IteratorReturnResult<undefined> = { done: true, value: undefined }
    const queue: AgentSubscriptionEvent[] = []
    const waiting: ((result: IteratorResult<AgentSubscriptionEvent, undefined>) => void)[] = []
    let closed = signal.aborted
    const receive = (update: ConversationUpdate) => {
      const event: AgentSubscriptionEvent = { type: 'update', update }
      const resolve = waiting.shift()
      if (resolve) resolve({ done: false, value: event })
      else queue.push(event)
    }
    const close = () => {
      closed = true
      this.listeners.delete(receive)
      signal.removeEventListener('abort', close)
      queue.length = 0
      for (const resolve of waiting.splice(0)) resolve(done)
    }
    if (!closed) {
      this.listeners.add(receive)
      queue.push({ type: 'snapshot', snapshot: structuredClone(this.state) })
      signal.addEventListener('abort', close, { once: true })
    }
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (closed) return Promise.resolve(done)
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! })
        return new Promise(resolve => waiting.push(resolve))
      },
      return() { close(); return Promise.resolve(done) },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.controller?.abort()
    await this.task
  }
}
