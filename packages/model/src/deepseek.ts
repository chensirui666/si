import { Credentials } from '@agent-learning/credentials'
import OpenAI from 'openai'
import { AssistantEventStream } from './event-stream.js'
import { parseToolArguments } from './tool-arguments.js'
import type {
  AssistantMessage, ModelContext, ModelDiscovery, ModelEventStream, ModelInfo,
  ModelStopReason, TextContent, ThinkingContent, ToolCall,
} from './types.js'

const deepseek: ModelInfo = {
  id: 'deepseek-flash',
  name: 'DeepSeek Flash',
  provider: 'deepseek',
  api: 'openai-completions',
}

export function findModel(modelId: string): ModelInfo | undefined {
  return modelId === deepseek.id ? { ...deepseek } : undefined
}

export async function discoverModels(
  credentials: Pick<Credentials, 'readStatus'> = new Credentials(),
): Promise<ModelDiscovery> {
  const status = await credentials.readStatus('deepseek')
  return { models: status.state === 'configured' ? [{ ...deepseek }] : [], deepseek: status }
}

function convertMessages(context: ModelContext): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  if (context.systemPrompt !== undefined) messages.push({ role: 'system', content: context.systemPrompt })
  let pending: ToolCall[] = []
  const received = new Set<string>()
  const heldSystems: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  const closeTools = () => {
    for (const call of pending) {
      if (!received.has(call.id)) messages.push({ role: 'tool', tool_call_id: call.id, content: 'No result provided' })
    }
    pending = []
    received.clear()
    messages.push(...heldSystems)
    heldSystems.length = 0
  }
  for (const message of context.messages) {
    if (message.role === 'assistant' || message.role === 'user') closeTools()
    if (message.role === 'system' || message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : message.content.map((block) => block.text).join('')
      if (message.role === 'system' && pending.length) heldSystems.push({ role: 'system', content })
      else messages.push({ role: message.role, content })
    } else if (message.role === 'toolResult') {
      received.add(message.toolCallId)
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content.map((block) => block.text).join('') })
    } else {
      const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      const tools = message.content.filter((block) => block.type === 'toolCall')
      pending = tools
      if (!text && !tools.length) continue
      const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
        role: 'assistant', content: text || null,
        reasoning_content: message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join(''),
      }
      if (tools.length) {
        assistant.tool_calls = tools.map((tool) => ({
          id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
        }))
      }
      messages.push(assistant)
    }
  }
  closeTools()
  return messages
}

class ModelFailure extends Error {}

function safeError(error: unknown): string {
  if (error instanceof ModelFailure) return error.message
  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    if (error.status === 401 || error.status === 403) return `模型认证失败（HTTP ${error.status}），请检查 API Key。`
    if (error.status === 429) return '模型请求受限（HTTP 429），请稍后手动重试。'
    return `模型服务请求失败（HTTP ${error.status}）。`
  }
  return '模型请求或响应读取失败，请检查配置与网络。'
}

type ToolState = { block: ToolCall; contentIndex: number; argumentsText: string; index?: number }

export function createModelStream(
  credentials: Pick<Credentials, 'readApiKey'>,
  configuration: { fetch?: typeof fetch; baseURL?: string } = {},
): typeof stream {
  return (model, context, options) => {
    const events = new AssistantEventStream()
    const started = performance.now()
    const output: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      stopReason: 'pending', timestamp: Date.now(),
    }

    void (async () => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let interruption: 'error' | 'aborted' | undefined
      let interruptionMessage: string | undefined
      let rejectInterruption!: (error: ModelFailure) => void
      const interrupted = new Promise<never>((_resolve, reject) => { rejectInterruption = reject })
      void interrupted.catch(() => undefined)
      const interrupt = (reason: 'error' | 'aborted', message: string) => {
        if (interruption) return
        interruption = reason
        interruptionMessage = message
        controller.abort()
        rejectInterruption(new ModelFailure(message))
      }
      const cancel = () => interrupt('aborted', '本次模型调用已取消。')
      const resetTimeout = () => {
        clearTimeout(timer)
        timer = setTimeout(() => interrupt('error', '模型连续五分钟没有返回数据，调用已超时。'), 300_000)
      }
      const toolStates: ToolState[] = []
      const toolsByIndex = new Map<number, ToolState>()
      const toolsById = new Map<string, ToolState>()
      let text: { block: TextContent; contentIndex: number } | undefined
      let thinking: { block: ThinkingContent; contentIndex: number } | undefined
      let finalReason: Exclude<ModelStopReason, 'error' | 'aborted'> | undefined
      const endCurrentContent = () => {
        if (text) {
          events.push({ type: 'text_end', contentIndex: text.contentIndex, content: text.block.text, partial: output })
          text = undefined
        }
        if (thinking) {
          events.push({ type: 'thinking_end', contentIndex: thinking.contentIndex, content: thinking.block.thinking, partial: output })
          thinking = undefined
        }
      }

      try {
        options?.signal?.addEventListener('abort', cancel, { once: true })
        if (options?.signal?.aborted) cancel()
        if (interruption) throw new ModelFailure('本次模型调用已取消。')
        const supported = findModel(model.id)
        if (!supported || supported.provider !== model.provider || supported.api !== model.api) {
          throw new ModelFailure('不支持所选模型。')
        }
        resetTimeout()
        const apiKey = await Promise.race([credentials.readApiKey('deepseek'), interrupted])
        if (interruption) throw new ModelFailure('本次模型调用已取消。')
        const client = new OpenAI({
          apiKey, baseURL: configuration.baseURL ?? 'https://api.deepseek.com', fetch: configuration.fetch,
          maxRetries: 0, logLevel: 'off',
          // The rolling timer owns inactivity; 0 means immediate timeout in the SDK.
          timeout: 2_147_483_647,
        })
        const upstream = await Promise.race([
          client.chat.completions.create({
            model: model.id, messages: convertMessages(context), stream: true,
            stream_options: { include_usage: true }, reasoning_effort: 'high',
            ...(context.tools?.length ? { tools: context.tools.map((tool) => ({
              type: 'function' as const,
              function: { name: tool.name, description: tool.description, parameters: { ...tool.parameters } },
            })) } : {}),
            ...{ thinking: { type: 'enabled' } },
          }, { signal: controller.signal, maxRetries: 0 }),
          interrupted,
        ])
        events.push({ type: 'start', partial: output })
        const iterator = upstream[Symbol.asyncIterator]()
        while (true) {
          const item = await Promise.race([iterator.next(), interrupted])
          if (item.done) break
          const data = item.value
          if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) {
            throw new ModelFailure('模型响应格式无效。')
          }
          resetTimeout()
          if (typeof data.id === 'string' && data.id) output.responseId ??= data.id
          if (typeof data.model === 'string' && data.model) output.responseModel ??= data.model
          if (data.usage) {
            for (const [reported, key] of [['prompt_tokens', 'input'], ['completion_tokens', 'output'], ['total_tokens', 'total']] as const) {
              const value = data.usage[reported]
              if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                output.usage ??= {}
                output.usage[key] = value
              }
            }
          }
          const choice = data.choices[0]
          if (!choice) continue
          const delta = choice.delta as typeof choice.delta & { reasoning_content?: string }
          if (!delta || typeof delta !== 'object') throw new ModelFailure('模型响应格式无效。')
          if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
            if (typeof delta.reasoning_content !== 'string') throw new ModelFailure('模型思考内容格式无效。')
            if (delta.reasoning_content) {
              if (!thinking) {
                endCurrentContent()
                const block: ThinkingContent = { type: 'thinking', thinking: '', thinkingSignature: 'reasoning_content' }
                thinking = { block, contentIndex: output.content.push(block) - 1 }
                events.push({ type: 'thinking_start', contentIndex: thinking.contentIndex, partial: output })
              }
              thinking.block.thinking += delta.reasoning_content
              events.push({ type: 'thinking_delta', contentIndex: thinking.contentIndex, delta: delta.reasoning_content, partial: output })
            }
          }
          if (delta.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== 'string') throw new ModelFailure('模型正文内容格式无效。')
            if (delta.content) {
              if (!text) {
                endCurrentContent()
                const block: TextContent = { type: 'text', text: '' }
                text = { block, contentIndex: output.content.push(block) - 1 }
                events.push({ type: 'text_start', contentIndex: text.contentIndex, partial: output })
              }
              text.block.text += delta.content
              events.push({ type: 'text_delta', contentIndex: text.contentIndex, delta: delta.content, partial: output })
            }
          }
          if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
            if (!Array.isArray(delta.tool_calls)) throw new ModelFailure('模型工具调用格式无效。')
            for (const call of delta.tool_calls) {
              if (!call || typeof call !== 'object') throw new ModelFailure('模型工具调用格式无效。')
              if ((call.id !== undefined && typeof call.id !== 'string') ||
                (call.function?.name !== undefined && typeof call.function.name !== 'string') ||
                (call.function?.arguments !== undefined && typeof call.function.arguments !== 'string')) {
                throw new ModelFailure('模型工具调用格式无效。')
              }
              endCurrentContent()
              const index = typeof call.index === 'number' ? call.index : undefined
              let state = index === undefined ? undefined : toolsByIndex.get(index)
              if (!state && call.id) {
                const byId = toolsById.get(call.id)
                if (index === undefined || byId?.index === undefined) state = byId
              }
              if (!state) {
                const block: ToolCall = { type: 'toolCall', id: call.id ?? '', name: call.function?.name ?? '', arguments: {} }
                state = { block, contentIndex: output.content.push(block) - 1, argumentsText: '' }
                toolStates.push(state)
                events.push({ type: 'toolcall_start', contentIndex: state.contentIndex, partial: output })
              }
              if (index !== undefined) {
                state.index = index
                toolsByIndex.set(index, state)
              }
              if (call.id) {
                if (state.block.id && state.block.id !== call.id) throw new ModelFailure('模型更改了同一工具调用的编号。')
                toolsById.set(call.id, state)
                if (!state.block.id) state.block.id = call.id
              }
              if (!state.block.name && call.function?.name) state.block.name = call.function.name
              const argumentsDelta = call.function?.arguments ?? ''
              state.argumentsText += argumentsDelta
              events.push({ type: 'toolcall_delta', contentIndex: state.contentIndex, delta: argumentsDelta, partial: output })
            }
          }
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') finalReason = choice.finish_reason
            else if (choice.finish_reason === 'tool_calls') finalReason = 'toolUse'
            else throw new ModelFailure('模型返回了无效的结束原因。')
          }
        }
        if (interruption) throw new ModelFailure('本次模型调用已停止。')
        // SDK can swallow a transport AbortError and end iteration without throwing.
        if (upstream.controller.signal.aborted) throw new ModelFailure('模型响应读取中断。')
        if (!finalReason) throw new ModelFailure('模型响应中断，未收到有效结束原因。')
        output.stopReason = finalReason
      } catch (error) {
        controller.abort()
        output.stopReason = interruption ?? 'error'
        output.errorMessage = interruptionMessage ?? safeError(error)
      } finally {
        clearTimeout(timer)
        options?.signal?.removeEventListener('abort', cancel)
        endCurrentContent()
        for (const { block, contentIndex, argumentsText } of toolStates) {
          Object.assign(block, parseToolArguments(argumentsText))
          events.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: output })
        }
        output.durationMs = Math.max(0, Math.round(performance.now() - started))
        if (output.stopReason === 'error' || output.stopReason === 'aborted') {
          events.push({ type: 'error', reason: output.stopReason, error: output })
        } else {
          events.push({ type: 'done', reason: output.stopReason as 'stop' | 'length' | 'toolUse', message: output })
        }
      }
    })()
    return events
  }
}

export function stream(model: ModelInfo, context: ModelContext, options?: { signal?: AbortSignal }): ModelEventStream {
  return defaultStream(model, context, options)
}

const defaultStream = createModelStream(new Credentials())
