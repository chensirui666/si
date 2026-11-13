import { Credentials } from '@agent-learning/credentials'
import type { AssistantMessage as PiMessage } from '@earendil-works/pi-ai'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import { toPiContext } from './context.js'
import { piModels } from './catalog.js'
import { createDeepSeekStream } from './deepseek.js'
import { AssistantEventStream } from './event-stream.js'
import type { AssistantMessage, ModelContext, ModelEventStream, ModelInfo, ModelStreamOptions, ModelUsage } from './types.js'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function reportedUsage(value: unknown, seen: Set<keyof ModelUsage>) {
  const event = record(value)
  const usage = [
    record(event.usage), record(record(event.message).usage),
    record(record(event.response).usage), record(event.usageMetadata),
  ]
  for (const field of usage) {
    if (['input_tokens', 'prompt_tokens', 'promptTokenCount'].some(key => typeof field[key] === 'number')) seen.add('input')
    if (['output_tokens', 'completion_tokens', 'candidatesTokenCount'].some(key => typeof field[key] === 'number')) seen.add('output')
    if (['total_tokens', 'totalTokenCount'].some(key => typeof field[key] === 'number')) seen.add('total')
  }
}

function assistant(message: PiMessage, seen: Set<keyof ModelUsage>): AssistantMessage {
  const { content, model, provider, api, timestamp, durationMs, responseId, responseModel, providerThinkingLevel, usage, stopReason } = message
  const reported: ModelUsage = {}
  const input = usage.input + usage.cacheRead + usage.cacheWrite
  for (const [field, count] of [['input', input], ['output', usage.output], ['total', usage.totalTokens]] as const) {
    if (Number.isFinite(count) && (count > 0 || count === 0 && seen.has(field))) reported[field] = count
  }
  return {
    content: content.map(block => block.type === 'toolCall'
      ? { ...block, arguments: block.arguments as import('./types.js').JsonObject } : block),
    role: 'assistant', model, provider, api, timestamp, durationMs, responseId, responseModel, providerThinkingLevel,
    stopReason: stopReason === 'deferred' ? 'error' : stopReason,
    ...(Object.keys(reported).length && { usage: reported }),
  }
}

type Configuration = { fetch?: typeof fetch; baseURL?: string }

export function createModelStream(credentials: Pick<Credentials, 'readApiKey'>, configuration: Configuration = {}): typeof stream {
  const deepseek = createDeepSeekStream(credentials, configuration)
  return (model, context, options) => {
    // Preserve the original Flash stream's strict tool parsing, timeout and replay behavior.
    if (model.provider === 'deepseek' && model.id === 'deepseek-flash') return deepseek(model, context, options)
    const events = new AssistantEventStream()
    const controller = new AbortController()
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const seen = new Set<keyof ModelUsage>()
    let output: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      stopReason: 'pending', timestamp: Date.now(),
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const resetTimeout = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, 300_000)
      timer.unref()
    }
    const fail = (error?: PiMessage, setupMessage?: string) => {
      const reason = options?.signal?.aborted ? 'aborted' : 'error'
      const upstream = error?.errorMessage ?? ''
      const overflow = reason === 'error' && !timedOut && error && isContextOverflow(error)
      const status = /^(?:HTTP )?(\d{3})\b|["'](?:status|code)["']\s*:\s*(\d{3})\b/.exec(upstream)
      const code = Number(status?.[1] ?? status?.[2])
      const errorMessage = reason === 'aborted' ? '本次模型调用已取消。'
        : timedOut ? '模型连续五分钟没有返回数据，调用已超时。'
        : setupMessage ?? (overflow ? '模型服务报告输入超出容量。'
          : code === 401 || code === 403 || /invalid.api.key|api.key.{0,32}(?:not valid|invalid)|unauthenticated|authentication_error/i.test(upstream) ? '模型认证失败，请检查 API Key。'
          : code === 404 ? '模型在当前服务入口不可用（HTTP 404）。'
          : code === 429 || /rate.limit|resource_exhausted/i.test(upstream) ? '模型请求受限，请稍后手动重试。'
          : /tool.call|tool.result|conversation history|message.*(?:format|invalid)|invalid.*message/i.test(upstream) ? '模型服务拒绝了消息历史或工具记录。'
          : code >= 400 && code < 600 ? `模型服务请求失败（HTTP ${code}）。` : '模型请求或响应读取失败，请检查配置与网络。')
      events.push({ type: 'error', reason, error: { ...output, stopReason: reason, errorMessage, ...(overflow && { errorCode: 'context_overflow' }) } })
    }
    void (async () => {
      try {
        signal.throwIfAborted()
        const route = piModels.getModel(model.provider, model.id)
        if (!route || route.api !== model.api) { fail(undefined, '不支持所选模型。'); return }
        const apiKey = await credentials.readApiKey(model.provider).catch(() => undefined)
        signal.throwIfAborted()
        if (!apiKey) { fail(undefined, '请为所选提供方配置 API Key。'); return }
        resetTimeout()
        const effort = options?.reasoningEffort ?? model.defaultReasoningEffort
        const target = { ...route, maxTokens: model.maxTokens, ...(configuration.baseURL && { baseUrl: configuration.baseURL }) }
        let responseModel: string | undefined
        const google = target.api === 'google-generative-ai'
        const upstream = piModels.streamSimple(target, toPiContext(context, target), {
          apiKey, fetch: configuration.fetch, signal, maxTokens: model.maxTokens, maxRetries: 0,
          ...(effort && effort !== 'off' && { reasoning: effort }),
          onProviderStreamEvent: value => {
            resetTimeout()
            reportedUsage(value, seen)
            if (google) {
              const version = record(value).modelVersion
              if (typeof version === 'string') responseModel ??= version
            }
          },
        })
        for await (const event of upstream) {
          resetTimeout()
          if (event.type === 'done') {
            output = assistant(event.message, seen)
            output.responseModel ??= responseModel
            if (signal.aborted) fail()
            else if (event.reason === 'deferred') fail(undefined, '模型未返回同步结果。')
            else events.push({ type: 'done', reason: event.reason, message: output })
            return
          }
          if (event.type === 'error') { output = assistant(event.error, seen); fail(event.error); return }
          output = assistant(event.partial, seen)
          if (event.type === 'toolcall_end') {
            const call = output.content[event.contentIndex]
            if (call?.type === 'toolCall') events.push({ ...event, toolCall: call, partial: output })
          } else events.push({ ...event, partial: output })
        }
        fail()
      } catch { fail() }
      finally { clearTimeout(timer); controller.abort() }
    })()
    return events
  }
}

const defaultStream = createModelStream(new Credentials())
export function stream(model: ModelInfo, context: ModelContext, options?: ModelStreamOptions): ModelEventStream {
  return defaultStream(model, context, options)
}
