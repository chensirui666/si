import { stream } from '@agent-learning/model'
import type { AssistantMessage, ModelContext, ModelInfo, ToolResultMessage } from '@agent-learning/model'
import type { AgentEvent, AgentResult, AgentRunInput } from './types.js'

export class Agent {
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private running = false

  constructor(private readonly options: { stream?: typeof stream } = {}) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: AgentEvent) {
    for (const listener of this.listeners) listener(event)
  }

  async run(input: AgentRunInput): Promise<AgentResult> {
    if (this.running) throw new Error('正在生成，请等待本次回答结束')
    this.running = true
    try { return await this.loop(input) }
    finally { this.running = false }
  }

  continue(input: AgentRunInput): Promise<AgentResult> {
    return this.run(input)
  }

  private async loop({ model, context, tools = [], signal, prepareContext, saveToolCheckpoint }: AgentRunInput): Promise<AgentResult> {
    if (tools.length) context = {
      ...context,
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    }
    const failure = (message: string, reason: 'error' | 'aborted' = 'error', afterReply = false): AgentResult =>
      ({ type: 'failure', message, reason, afterReply })
    let afterReply = false
    try {
      for (;;) {
        afterReply = false
        signal.throwIfAborted()
        if (prepareContext) {
          const prepared = prepareContext(context)
          const next = prepared instanceof Promise ? await prepared : prepared
          signal.throwIfAborted()
          if ('error' in next) return failure(next.error)
          context = next
        }
        const response = await this.generate(model, context, signal)
        const complete: AgentResult = { type: 'response', message: response }
        if (response.stopReason === 'error' || response.stopReason === 'aborted') return complete
        const calls = response.content.flatMap((call, contentIndex) => call.type === 'toolCall' ? [{ call, contentIndex }] : [])
        if (!calls.length) return response.stopReason === 'toolUse'
          ? failure('模型未返回可处理的工具调用。')
          : complete
        afterReply = true
        if (saveToolCheckpoint) await saveToolCheckpoint({ type: 'assistant', message: response })
        signal.throwIfAborted()
        if (!context.tools?.length || !tools.length) return failure('本次请求未提供工具，工具调用未执行。')
        const ids = calls.map(({ call }) => call.id)
        if (ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) {
          return failure('工具调用编号缺失或重复，本批工具未执行。')
        }

        const publishResult = async (outcome: Extract<AgentEvent, { type: 'tool_result' }> & { executed: boolean }) => {
          if (saveToolCheckpoint) await saveToolCheckpoint(outcome)
          const { executed: _executed, ...event } = outcome
          this.emit(event)
          return event.result
        }
        const execute = async ({ call, contentIndex }: typeof calls[number]) => {
          signal.throwIfAborted()
          const truncated = response.stopReason === 'length'
          if (!truncated) this.emit({ type: 'tool_start', contentIndex })
          let text: string
          let isError = false
          let errorCode: string | undefined
          const details: unknown[] = []
          let executed = false
          try {
            if (truncated) throw new Error('本批工具未执行：本轮回复截断，请重新提供完整的工具调用。')
            if (call.argumentsError) throw new Error(call.argumentsError)
            const tool = tools.find(({ name }) => name === call.name)
            if (!tool) throw new Error(`未知工具：${call.name}`)
            executed = true
            text = await tool.execute(call.arguments, { signal, recordDetails: detail => { details.push(detail) } })
          } catch (error) {
            isError = true
            text = error instanceof Error ? error.message : '工具执行失败。'
            if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') errorCode = error.code
          }
          const result: ToolResultMessage = {
            role: 'toolResult', toolCallId: call.id, toolName: call.name,
            content: [{ type: 'text', text }], isError, timestamp: Date.now(),
          }
          return { type: 'tool_result' as const, contentIndex, result, details, executed, ...(errorCode && { errorCode }) }
        }
        const results: ToolResultMessage[] = []
        if (calls.some(({ call }) => tools.find(tool => tool.name === call.name)?.executionMode === 'sequential')) {
          for (const call of calls) results.push(await publishResult(await execute(call)))
        } else if (saveToolCheckpoint) {
          const settled = await Promise.allSettled(calls.map(execute))
          for (const outcome of settled) {
            if (outcome.status === 'fulfilled') results.push(await publishResult(outcome.value))
          }
          const rejected = settled.find(outcome => outcome.status === 'rejected')
          if (rejected) throw rejected.reason
        } else {
          for (const outcome of await Promise.allSettled(calls.map(call => execute(call).then(publishResult)))) {
            if (outcome.status === 'rejected') throw outcome.reason
            results.push(outcome.value)
          }
        }
        signal.throwIfAborted()
        context = { ...context, messages: [...context.messages, response, ...results] }
      }
    } catch {
      return signal.aborted
        ? failure('本次生成已取消', 'aborted', afterReply)
        : failure('模型调用意外中断，请重新发送', 'error', afterReply)
    }
  }

  private async generate(model: ModelInfo, context: ModelContext, signal: AbortSignal) {
    let terminal: AssistantMessage | undefined
    try {
      for await (const event of (this.options.stream ?? stream)(model, context, { signal })) {
        this.emit({ type: 'model', event, context })
        if (event.type === 'done' || event.type === 'error') {
          terminal = event.type === 'done' ? event.message : event.error
          break
        }
      }
    } catch (error) {
      if (!terminal) throw error
    }
    if (!terminal) throw new Error('Model stream ended without a terminal event')
    return terminal
  }
}
