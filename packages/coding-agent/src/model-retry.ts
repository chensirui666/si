import type { AssistantMessage, ModelEvent, stream } from '@agent-learning/model'
import type { ModelRetryState } from './types.js'

const maxAttempts = 5
const maxTimerDelay = 2_147_483_647
const localRetryReasons = new Set([
  'connection-reset', 'stream-read', 'stream-ended', 'timeout', 'temporary-rate-limit',
  'internal', 'bad-gateway', 'unavailable', 'gateway-timeout', 'request-error', 'response-error', 'http-error',
])
const serverRetryReasons = new Set(['rate-limit', 'overloaded', 'capacity'])

async function waitUntil(deadline: number, signal?: AbortSignal) {
  while (!signal?.aborted && Date.now() < deadline) {
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, Math.min(maxTimerDelay, Math.max(0, deadline - Date.now())))
      signal?.addEventListener('abort', finish, { once: true })
    })
  }
}

export function withModelRetry(upstream: typeof stream, report: (state: ModelRetryState) => void): typeof stream {
  return (model, context, options) => {
    let resolve!: (message: AssistantMessage) => void
    const result = new Promise<AssistantMessage>(settle => { resolve = settle })
    const signal = options?.signal

    async function* attempts(): AsyncGenerator<ModelEvent> {
      let limited = 0
      let connectionDelay = 5_000
      let next: ModelRetryState | undefined
      let partial: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: 'pending',
      }
      try {
        while (!signal?.aborted) {
          if (next) {
            if (next.mode === 'limited') limited++
            report({ ...next, phase: 'retrying', retryAt: undefined })
          }
          const attempt = upstream(model, context, options)
          let failure: Extract<ModelEvent, { type: 'error' }> | undefined
          for await (const event of attempt) {
            if (event.type === 'error') { failure = event; partial = event.error; break }
            if (event.type === 'done') {
              resolve(event.message)
              yield event
              return
            }
            partial = event.partial
            yield event
          }
          if (signal?.aborted) break
          if (!failure) throw new Error('Model stream ended without a terminal event')
          const evidence = failure.reason === 'error' && !failure.error.errorCode ? failure.error.failure : undefined
          const now = Date.now()
          const retryAt = evidence?.retryAt
          if (evidence?.kind === 'connection') {
            next = { mode: 'connection', reason: 'connection', phase: 'waiting', retryAt: now + connectionDelay }
            connectionDelay = Math.min(60_000, connectionDelay * 2)
          } else if (evidence && (localRetryReasons.has(evidence.kind) || retryAt !== undefined && serverRetryReasons.has(evidence.kind))) {
            if (limited === maxAttempts) {
              const error: AssistantMessage = { ...failure.error, failure: {
                kind: evidence.kind, status: evidence.status, attempts: maxAttempts,
                ...(retryAt !== undefined && retryAt > now && { retryAt }),
              } }
              resolve(error)
              yield { ...failure, error }
              return
            }
            next = {
              mode: 'limited', phase: 'waiting', reason: evidence.kind, status: evidence.status,
              attempt: limited + 1, maxAttempts,
              retryAt: retryAt ?? now + Math.floor(1000 * 2 ** limited * (0.9 + Math.random() * 0.2)),
            }
          } else {
            resolve(failure.error)
            yield failure
            return
          }
          if (next.retryAt !== undefined && next.retryAt > now) {
            report(next)
            await waitUntil(next.retryAt, signal)
          }
        }
      } catch {
        // An exception without an adapter terminal carries no evidence that the request failed.
      }
      const reason = signal?.aborted ? 'aborted' : 'error'
      const error: AssistantMessage = {
        ...partial, stopReason: reason, errorCode: undefined,
        errorMessage: signal?.aborted ? '本次生成已取消' : '模型调用意外中断，请重新发送',
        failure: signal?.aborted ? undefined : { kind: 'unknown' },
      }
      resolve(error)
      yield { type: 'error', reason, error }
    }

    return { [Symbol.asyncIterator]: attempts, result: () => result }
  }
}
