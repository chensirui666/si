import { Check } from 'typebox/value'
import type { AgentRunInput } from '@agent-learning/agent'
import type { JsonObject, ModelMessage, ToolResultMessage } from '@agent-learning/model'
import { extensionMessage, isJson, object, type ExtensionContext, type ExtensionMessage, type ExtensionRuntime } from './runtime.js'

export function textContent(block: unknown) {
  return object(block) && block.type === 'text' && typeof block.text === 'string'
    && (block.textSignature === undefined || typeof block.textSignature === 'string')
}

function toolContent(value: unknown): value is ToolResultMessage['content'] {
  return Array.isArray(value) && value.every(block => textContent(block) || object(block) && block.type === 'image'
    && typeof block.mimeType === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)
    && typeof block.data === 'string' && block.data.length > 0)
}

export function requestMessages(value: unknown): value is ModelMessage[] {
  if (!Array.isArray(value)) return false
  const pending = new Map<string, string>()
  for (const message of value) {
    if (!object(message) || !Number.isFinite(message.timestamp)) return false
    if (message.role === 'toolResult') {
      if (typeof message.toolCallId !== 'string' || !pending.has(message.toolCallId) || message.toolName !== pending.get(message.toolCallId)
        || typeof message.isError !== 'boolean' || !toolContent(message.content)) return false
      pending.delete(message.toolCallId)
      continue
    }
    if (pending.size) return false
    if (message.role === 'user') {
      if (!(typeof message.content === 'string' || Array.isArray(message.content) && message.content.every(textContent))) return false
    } else if (message.role === 'assistant') {
      if (!Array.isArray(message.content) || typeof message.api !== 'string' || typeof message.provider !== 'string'
        || typeof message.model !== 'string' || !['stop', 'length', 'toolUse'].includes(String(message.stopReason))) return false
      for (const block of message.content) {
        if (textContent(block)) continue
        if (!object(block)) return false
        if (block.type === 'thinking' && typeof block.thinking === 'string') continue
        if (block.type !== 'toolCall' || typeof block.id !== 'string' || !block.id.trim() || pending.has(block.id)
          || typeof block.name !== 'string' || !block.name.trim() || !object(block.arguments) || !isJson(block.arguments)) return false
        pending.set(block.id, block.name)
      }
    } else return false
  }
  return pending.size === 0
}

export function beforeStart(runtime: ExtensionRuntime, ctx: ExtensionContext, systemPrompt: string, prompt: string, runId: string) {
  return runtime.chain('before_agent_start', ctx, { systemPrompt, extra: [] as ExtensionMessage[], overridden: false },
    state => ({ messageType: 'user', prompt, systemPrompt: state.systemPrompt }), (state, _event, result) => {
      if (!result) return state
      if (result.systemPrompt !== undefined && typeof result.systemPrompt !== 'string'
        || result.message !== undefined && !extensionMessage(result.message)) throw new Error('无效的启动改写')
      return {
        systemPrompt: result.systemPrompt ?? state.systemPrompt,
        extra: result.message ? [...state.extra, structuredClone(result.message)] : state.extra,
        overridden: state.overridden || result.systemPrompt !== undefined,
      }
    }, { runId })
}

const blocked = '扩展已拦截工具调用。'

export function toolHooks(runtime: ExtensionRuntime, context: () => ExtensionContext, runId: string):
Pick<AgentRunInput, 'prepareToolCall' | 'rewriteToolResult'> {
  return {
    async prepareToolCall(call, tool) {
      if (!Check(tool.parameters, call.arguments)) return { arguments: call.arguments, denial: '原始工具参数不符合声明。' }
      const initial: { arguments: JsonObject; denial?: string } = { arguments: call.arguments }
      const decision = await runtime.chain('tool_call', context(), initial,
        state => ({ toolCallId: call.id, toolName: call.name, input: state.arguments }), (_state, event, result) => {
          if (result && (result.block !== undefined && typeof result.block !== 'boolean'
            || result.reason !== undefined && typeof result.reason !== 'string')) throw new Error('无效的工具调用决定')
          if (result && result.block) return { arguments: event.input, denial: result.reason?.trim() || blocked }
          if (!object(event.input) || !isJson(event.input) || !Check(tool.parameters, event.input)) {
            throw new Error('改写后的工具参数不符合声明。')
          }
          return { arguments: structuredClone(event.input) }
        }, { runId, stop: state => state.denial !== undefined, onError: state => ({ ...state, denial: blocked }) })
      if (decision.denial === undefined && !Check(tool.parameters, decision.arguments)) return { ...decision, denial: '改写后的工具参数不符合声明。' }
      return decision
    },
    rewriteToolResult(call, result) {
      return runtime.chain('tool_result', context(), result,
        current => ({ toolCallId: call.id, toolName: call.name, input: call.arguments, content: current.content, isError: current.isError }),
        (current, _event, update) => {
          if (!update) return current
          if (update.isError !== undefined && typeof update.isError !== 'boolean'
            || update.content !== undefined && (!toolContent(update.content) || !isJson(update.content))) throw new Error('无效的工具结果改写')
          return { ...current, content: update.content === undefined ? current.content : structuredClone(update.content), isError: update.isError ?? current.isError }
        }, { runId })
    },
  }
}
