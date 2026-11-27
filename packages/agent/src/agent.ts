import { createNestedToolRunner } from './nested-tools.js'
import { isDeepStrictEqual } from 'node:util'
import { stream } from '@agent-learning/model'
import type { AssistantMessage, ModelContext, ModelInfo, ToolCall, ToolResultMessage } from '@agent-learning/model'
import type { AgentEvent, AgentObservations, AgentResult, AgentRunInput, ExecutableTool, NestedToolCheckpoint, NestedToolOutcome } from './types.js'

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
    const messages: AgentObservations['agent_end']['messages'] = []
    try {
      if (input.observe) await input.observe('agent_start', {})
      return await this.loop(input, messages)
    } finally {
      try { if (input.observe) await input.observe('agent_end', { messages }) }
      finally { this.running = false }
    }
  }

  continue(input: AgentRunInput): Promise<AgentResult> {
    return this.run(input)
  }

  private async loop({ model, reasoningEffort, context, tools = [], signal, prepareContext, finalizeContext, afterStep, beforeToolCall, saveToolCheckpoint, observe, userMessage, resolveTools, prepareToolCall,
    rewriteToolResult, streamOptions, resolveNestedTools, saveNestedToolCheckpoint }: AgentRunInput, messages: AgentObservations['agent_end']['messages']): Promise<AgentResult> {
    if (tools.length) context = {
      ...context,
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    }
    const failure = (message: string, reason: 'error' | 'aborted' = 'error', afterReply = false): AgentResult =>
      ({ type: 'failure', message, reason, afterReply })
    let afterReply = false
    let turnIndex = 0
    try {
      for (;;) {
        afterReply = false
        signal.throwIfAborted()
        if (observe) {
          await observe('turn_start', { turnIndex, timestamp: Date.now() })
          if (turnIndex === 0 && userMessage) {
            messages.push(userMessage)
            await observe('message_start', { message: userMessage })
          }
        }
        signal.throwIfAborted()
        turnIndex++
        if (prepareContext) {
          const prepared = prepareContext(context)
          const next = prepared instanceof Promise ? await prepared : prepared
          signal.throwIfAborted()
          if ('error' in next) return failure(next.error)
          context = next
        }
        if (finalizeContext) {
          const pending = finalizeContext(context)
          const final = pending instanceof Promise ? await pending : pending
          signal.throwIfAborted()
          if ('error' in final) return failure(final.error)
          context = final
        }
        const roundTools = resolveTools?.() ?? tools
        const response = await this.generate(model, context, signal, reasoningEffort, streamOptions?.(), observe)
        messages.push(response)
        const complete: AgentResult = { type: 'response', message: response }
        if (response.stopReason === 'error' || response.stopReason === 'aborted') return complete
        const calls = response.content.flatMap((call, contentIndex) => call.type === 'toolCall' ? [{ call, contentIndex }] : [])
        if (!calls.length) {
          if (response.stopReason === 'toolUse') return failure('模型未返回可处理的工具调用。')
          if (!afterStep || !await afterStep(response, false)) return complete
          afterReply = true
          context = { ...context, messages: [...context.messages, response] }
          continue
        }
        afterReply = true
        if (saveToolCheckpoint) await saveToolCheckpoint({ type: 'assistant', message: response })
        signal.throwIfAborted()
        if (!context.tools?.length || !roundTools.length) return failure('本次请求未提供工具，工具调用未执行。')
        const ids = calls.map(({ call }) => call.id)
        if (ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) {
          return failure('工具调用编号缺失或重复，本批工具未执行。')
        }

        const publishResult = async (outcome: Extract<AgentEvent, { type: 'tool_result' }> & { executed: boolean }) => {
          if (saveToolCheckpoint) await saveToolCheckpoint(outcome)
          const { executed: _executed, ...event } = outcome
          messages.push(event.result)
          if (observe) await observe('message_start', { message: event.result })
          this.emit(event)
          return event.result
        }
        const runTool = async (call: ToolCall, contentIndex: number, tool: ExecutableTool | undefined,
          toolSignal: AbortSignal, nested = false): Promise<NestedToolOutcome> => {
          const truncated = response.stopReason === 'length'
          let output: string | ToolResultMessage['content']
          let isError = false
          let errorCode: string | undefined
          const details: unknown[] = []
          let executed = false
          let actualArguments: ToolCall['arguments'] | undefined
          let prepared = call
          const identity = { toolCallId: call.id, toolName: call.name }
          const nestedRunner = tool?.nestedExecution && !nested && resolveNestedTools
            ? createNestedToolRunner(call.id, resolveNestedTools,
              (child, binding, childSignal) => runTool(child, contentIndex, binding, childSignal, true))
            : undefined
          const saveNested = (checkpoint: Pick<NestedToolCheckpoint, 'arguments'> &
            ({ status: 'running' } | { status: Exclude<NestedToolCheckpoint['status'], 'running'>; outcome: NestedToolOutcome })) =>
            saveNestedToolCheckpoint?.({ contentIndex, id: call.id, name: call.name, ...checkpoint })
          let savingStart = false
          if (observe) await observe('tool_execution_start', { ...identity, args: call.arguments })
          try {
            if (toolSignal.aborted) throw Object.assign(new Error('任务已取消，工具未执行。'), { code: 'interrupted' })
            if (truncated) throw new Error('本批工具未执行：本轮回复截断，请重新提供完整的工具调用。')
            if (call.argumentsError) throw new Error(call.argumentsError)
            if (!tool) {
              const denied = beforeToolCall?.(call, tool, nested)
              if (denied) throw Object.assign(new Error(denied.message), { code: denied.code })
              throw new Error(`未知工具：${call.name}`)
            }
            if (prepareToolCall) {
              const decision = await prepareToolCall(call, tool, nested, toolSignal)
              if (toolSignal.aborted) throw Object.assign(new Error('任务已取消，工具未执行。'), { code: 'interrupted' })
              if (nested || decision.denial === undefined) prepared = { ...call, arguments: decision.arguments }
              if (decision.denial !== undefined) throw Object.assign(new Error(decision.denial), { code: 'hook_blocked' })
              if (JSON.stringify(call.arguments) !== JSON.stringify(prepared.arguments)) actualArguments = prepared.arguments
            }
            const denial = beforeToolCall?.(prepared, tool, nested)
            if (denial) throw Object.assign(new Error(denial.message), { code: denial.code })
            if (nested) {
              savingStart = true
              await saveNested({ status: 'running', arguments: prepared.arguments })
              savingStart = false
              toolSignal.throwIfAborted()
              const latestDenial = beforeToolCall?.(prepared, tool, true)
              if (latestDenial) throw Object.assign(new Error(latestDenial.message), { code: latestDenial.code })
            } else this.emit({ type: 'tool_start', contentIndex, ...(actualArguments && { actualArguments }) })
            executed = true
            const toolOutput = await tool.execute(prepareToolCall ? structuredClone(prepared.arguments) : prepared.arguments,
              { signal: nestedRunner ? AbortSignal.any([toolSignal, nestedRunner.signal]) : toolSignal, toolCallId: call.id, contentIndex, recordDetails: detail => { details.push(detail) },
                ...(nested && { nestedToolCallId: call.id }), ...nestedRunner?.context })
            if (typeof toolOutput === 'string' || Array.isArray(toolOutput)) output = toolOutput
            else ({ content: output, isError, errorCode } = toolOutput)
          } catch (error) {
            if (savingStart) throw error
            isError = true
            output = error instanceof Error ? error.message : '工具执行失败。'
            if (toolSignal.aborted && error === toolSignal.reason) errorCode = 'interrupted'
            if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') errorCode = error.code
          }
          await nestedRunner?.finish()
          let result: ToolResultMessage = {
            role: 'toolResult', toolCallId: call.id, toolName: call.name,
            content: typeof output === 'string' ? [{ type: 'text', text: output }] : output, isError, timestamp: Date.now(),
          }
          const rawResult = result
          if (executed && rewriteToolResult) result = await rewriteToolResult(prepared, result, tool, toolSignal)
          const rewritten = nested && result !== rawResult && !isDeepStrictEqual(result, rawResult)
          if (executed && (actualArguments || result.isError !== isError)) {
            result = { ...result, content: [...result.content, { type: 'text', text:
              (actualArguments ? `实际工具参数：${JSON.stringify(actualArguments)}。` : '') + `最终状态：${result.isError ? '失败' : '成功'}。` }] }
          }
          if (observe) await observe('tool_execution_end', { ...identity, result, isError: result.isError })
          const outcome = { result, details, executed, rewritten, ...(errorCode && { errorCode }),
            ...(executed && actualArguments && { actualArguments }) }
          if (nested) {
            const status = !executed || errorCode === 'permission_denied' || errorCode === 'hook_blocked' || errorCode === 'mcp_unavailable' ? 'not-executed'
              : !result.isError ? 'succeeded' : errorCode === 'interrupted' ? 'stopped' : 'failed'
            await saveNested({ status, arguments: prepared.arguments, outcome })
          }
          return outcome
        }
        const execute = async ({ call, contentIndex }: typeof calls[number]) => {
          signal.throwIfAborted()
          const { rewritten: _rewritten, ...outcome } = await runTool(call, contentIndex, roundTools.find(tool => tool.name === call.name), signal)
          return { type: 'tool_result' as const, contentIndex, ...outcome }
        }
        const results: ToolResultMessage[] = []
        if (calls.some(({ call }) => roundTools.find(tool => tool.name === call.name)?.executionMode === 'sequential')) {
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
        if (afterStep) await afterStep(response, true)
        context = { ...context, messages: [...context.messages, response, ...results] }
      }
    } catch {
      return signal.aborted
        ? failure('本次生成已取消', 'aborted', afterReply)
        : failure('模型调用意外中断，请重新发送', 'error', afterReply)
    }
  }

  private async generate(model: ModelInfo, context: ModelContext, signal: AbortSignal, reasoningEffort?: AgentRunInput['reasoningEffort'],
    streamOptions?: ReturnType<NonNullable<AgentRunInput['streamOptions']>>, observe?: AgentRunInput['observe']) {
    let terminal: AssistantMessage | undefined
    let started = false
    try {
      for await (const event of (this.options.stream ?? stream)(model, context, { signal, reasoningEffort, ...streamOptions })) {
        if (observe) {
          const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial
          if (!started) {
            started = true
            await observe('message_start', { message })
          }
          if (event.type !== 'start' && event.type !== 'done' && event.type !== 'error') {
            await observe('message_update', { message, assistantMessageEvent: event })
          }
        }
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
