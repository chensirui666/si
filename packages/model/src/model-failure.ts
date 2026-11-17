import type { ModelFailureInfo, ModelFailureKind } from './types.js'

const explicitKinds: Partial<Record<string, ModelFailureKind>> = {
  insufficient_balance: 'balance', credit_balance_exhausted: 'balance', billing_error: 'balance',
  insufficient_quota: 'quota', quota_exceeded: 'quota', exceeded_current_quota_error: 'quota', usage_limit_reached: 'quota',
  organization_spend_limit_exceeded: 'quota', project_spend_limit_exceeded: 'quota',
  organization_usage_limit_exceeded: 'quota', billing_hard_limit_reached: 'quota',
  authentication_error: 'authentication', invalid_api_key: 'authentication', api_key_invalid: 'authentication',
  unauthenticated: 'authentication',
  permission_denied: 'permission', permission_error: 'permission', model_access_denied: 'permission',
  invalid_request_error: 'invalid-request', invalid_request: 'invalid-request', invalid_argument: 'invalid-request',
  bad_request: 'invalid-request', validation_error: 'invalid-request',
  slow_down: 'temporary-rate-limit', rate_limit_error: 'temporary-rate-limit',
  rate_limit_exceeded: 'temporary-rate-limit', rate_limit_reached: 'temporary-rate-limit', rate_limit_reached_error: 'temporary-rate-limit',
  server_is_overloaded: 'overloaded', engine_overloaded_error: 'overloaded', overloaded_error: 'overloaded', overloaded: 'overloaded',
  model_capacity_unavailable: 'capacity', model_capacity_exhausted: 'capacity',
  model_temporarily_unavailable: 'capacity', capacity_exceeded: 'capacity',
}

const httpKinds: Partial<Record<number, ModelFailureKind>> = {
  401: 'authentication', 402: 'balance', 403: 'permission', 429: 'rate-limit',
  500: 'internal', 502: 'bad-gateway', 503: 'unavailable', 504: 'gateway-timeout',
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function retryDeadline(value: string | null, receivedAt: number): number | undefined {
  const header = value?.trim()
  if (!header) return
  if (/^\d+$/.test(header)) {
    const deadline = receivedAt + Number(header) * 1000
    if (Number.isSafeInteger(deadline) && deadline <= 8.64e15) return deadline
  } else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(header) && /\d{2}:\d{2}:\d{2}/.test(header)) {
    const deadline = Date.parse(header)
    if (Number.isFinite(deadline)) return Math.max(receivedAt, deadline)
  }
}

export function providerCodes(value: unknown): unknown[] {
  const body = record(value)
  const error = record(body.error)
  const details = Array.isArray(error.details) ? error.details : []
  return [body.code, body.type, body.status, error.code, error.type, error.status, ...details.map(detail => record(detail).reason)]
}

export function classifyModelFailure(input: {
  phase: 'setup' | 'request' | 'stream'
  raw?: unknown
  message?: string
  status?: number
  retryAt?: number
  codes?: unknown[]
  streamFailure?: boolean
  timedOut?: boolean
  fallback?: ModelFailureKind
}): ModelFailureInfo {
  const { phase, raw, message = '', retryAt, streamFailure, timedOut, fallback } = input
  if (timedOut) return { kind: 'timeout' }

  const codes = input.codes ?? []
  const explicit = [...codes, ...Array.from(message.matchAll(/"(?:code|type|status|reason)"\s*:\s*"([a-z_]+)"/gi), match => match[1]),
    /^[a-z_]+(?=:)/i.exec(message)?.[0]]
    .flatMap(code => typeof code === 'string' && Object.hasOwn(explicitKinds, code.toLowerCase())
      ? [explicitKinds[code.toLowerCase()]!] : [])
  const permanent = explicit.find(kind => ['balance', 'quota', 'authentication', 'permission', 'invalid-request'].includes(kind))
  if (permanent) return { kind: permanent }
  if (phase === 'request' && /\binvalid message format for this conversation history\b/i.test(message)) return { kind: 'invalid-request' }

  // Pi retains the SDK's numeric status in the normalized error on paths without response headers.
  const reportedStatus = /^(?:\d{3}\b|[^{}\n:]+ API error \((\d{3})\):)/.exec(message)
  const status = input.status ?? (phase === 'request' ? Number(reportedStatus?.[1] ?? reportedStatus?.[0]
    ?? /"(?:code|status)"\s*:\s*(\d{3})\b/.exec(message)?.[1]) : undefined)
  if (status === 401 || status === 402 || status === 403) return { kind: httpKinds[status]! }
  const specific = explicit[0]
  if (specific) return { kind: specific, ...(retryAt !== undefined && { retryAt }) }
  if (status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599) {
    const kind = httpKinds[status] ?? 'http-error'
    return { kind, ...(kind === 'http-error' && { status }), ...(retryAt !== undefined && { retryAt }) }
  }
  if (streamFailure) return { kind: 'response-error', ...(retryAt !== undefined && { retryAt }) }

  let error = raw
  const transportCodes = new Set<unknown>()
  for (let depth = 0; error && depth < 6; depth++) {
    const evidence = record(error)
    transportCodes.add(evidence.code)
    transportCodes.add(evidence.name)
    error = evidence.cause
  }
  const has = (...values: string[]) => values.some(value => transportCodes.has(value))
  if (phase === 'request' && (has('ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT')
    || /\b(?:connect ECONNREFUSED|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|UND_ERR_CONNECT_TIMEOUT)\b/.test(message))) return { kind: 'connection' }
  if (has('TimeoutError', 'APIConnectionTimeoutError', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT')
    || /\b(?:ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|timed out)\b/i.test(message)) return { kind: 'timeout' }
  const socketClosed = has('UND_ERR_SOCKET') || /\bUND_ERR_SOCKET\b/.test(message)
  const streamReset = phase === 'stream' && (has('ECONNRESET') || /\b(?:ECONNRESET|other side closed)\b/.test(message))
  if (phase !== 'setup' && (socketClosed || streamReset)) return { kind: 'connection-reset' }
  if (fallback) return { kind: fallback }
  if (phase === 'stream') {
    return { kind: /stream ended (?:before|without) (?:message_stop|a terminal response event|a (?:finish|stop) reason|finish_reason)/i.test(message)
      ? 'stream-ended' : 'stream-read' }
  }
  return { kind: phase === 'request' ? 'request-error' : 'unknown' }
}

export function observeModelFetch(fetcher: typeof fetch | undefined, observation: {
  sent?: true
  responded?: true
  status?: number
  retryAt?: number
  error?: unknown
}, observeBody = false, onResponse?: import('./types.js').ModelStreamOptions['onProviderResponse']): typeof fetch {
  return async (input, init) => {
    observation.sent = true
    try {
      const response = await (fetcher ?? globalThis.fetch)(input, init)
      observation.responded = true
      observation.status = response.status
      observation.retryAt = retryDeadline(response.headers.get('retry-after'), Date.now())
      if (onResponse) await onResponse({ status: response.status, headers: Object.fromEntries(response.headers) })
      if (!observeBody || !response.ok || !response.body) return response
      // Mistral's error formatting drops the transport cause of body read failures.
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) controller.close()
            else controller.enqueue(chunk.value)
          } catch (error) {
            observation.error = error
            controller.error(error)
          }
        },
        cancel: reason => reader.cancel(reason),
      })
      return new Response(body, response)
    } catch (error) {
      observation.error = error
      throw error
    }
  }
}
