import { afterEach, expect, it, vi } from 'vitest'
import { createModelStream, findModel } from '@agent-learning/model'
import type { ModelEvent, ModelFailureInfo } from '@agent-learning/model'
import { withModelRetry } from '../src/model-retry.js'

const model = findModel('deepseek-flash')!
const failure = (kind: ModelFailureInfo['kind'], retryAt?: number): ModelEvent => ({
  type: 'error', reason: 'error', error: { role: 'assistant', model: model.id, provider: model.provider, api: model.api,
    timestamp: 1, content: [], stopReason: 'error', failure: { kind, retryAt } },
})

function run(events: ModelEvent[], signal?: AbortSignal) {
  const change = vi.fn()
  const upstream = vi.fn(() => {
    const event = events.shift()!
    return {
      async *[Symbol.asyncIterator]() { yield event },
      async result() { return event.type === 'error' ? event.error : event.type === 'done' ? event.message : event.partial },
    }
  })
  const stream = withModelRetry(upstream, change)(model, { messages: [] }, { signal })
  const collected = (async () => {
    const output: ModelEvent[] = []
    for await (const event of stream) output.push(event)
    return output
  })()
  return { upstream, change, collected, terminal: stream.result() }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('uses 5, 10, 20, 40, 60, 60 seconds for connection refusals without spending limited attempts', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  const start = Date.now()
  const { change, upstream, terminal } = run([
    ...Array.from({ length: 6 }, () => failure('connection')), failure('stream-ended'), failure('unknown'),
  ])
  await vi.advanceTimersByTimeAsync(195_000)
  expect(change.mock.calls.filter(([state]) => state.phase === 'waiting').map(([state]) => state.retryAt - start))
    .toEqual([5_000, 15_000, 35_000, 75_000, 135_000, 195_000, 196_000])
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'limited', attempt: 1 }))
  await vi.advanceTimersByTimeAsync(1_000)
  expect((await terminal).failure).toMatchObject({ kind: 'unknown' })
  expect(upstream).toHaveBeenCalledTimes(8)
})

it('shares five limited attempts and keeps a future Retry-After on the final failure', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  const retryAt = Date.now() + 120_000
  const { change, upstream, terminal, collected } = run([
    ...Array.from({ length: 5 }, (_, index) => failure(index % 2 ? 'temporary-rate-limit' : 'stream-ended')),
    failure('rate-limit', retryAt),
  ])
  await vi.advanceTimersByTimeAsync(31_000)
  expect(change.mock.calls.filter(([state]) => state.phase === 'waiting').map(([state]) => state.attempt)).toEqual([1, 2, 3, 4, 5])
  expect((await terminal).failure).toEqual({ kind: 'rate-limit', retryAt, attempts: 5 })
  expect(await collected).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(upstream).toHaveBeenCalledTimes(6)
})

it.each(['rate-limit', 'overloaded', 'capacity', 'quota', 'unknown'] as const)('does not retry %s without an applicable deadline', async kind => {
  const { upstream, terminal, change } = run([failure(kind)])
  expect((await terminal).failure).toMatchObject({ kind })
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(change).not.toHaveBeenCalled()
})

it.each([false, true])('honors a 120 second deadline and can cancel it (cancel: %s)', async cancel => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const deadline = Date.now() + 120_000
  const { upstream, change, terminal } = run([failure('rate-limit', deadline), failure('unknown')], controller.signal)
  await vi.advanceTimersByTimeAsync(119_000)
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ retryAt: deadline, attempt: 1 }))
  expect(upstream).toHaveBeenCalledTimes(1)
  if (cancel) controller.abort()
  await vi.advanceTimersByTimeAsync(1_000)
  expect((await terminal).stopReason).toBe(cancel ? 'aborted' : 'error')
  expect(upstream).toHaveBeenCalledTimes(cancel ? 1 : 2)
})

it.each([0, 0.5, 0.999999])('uses the specified jitter interval for each local retry (%s)', async random => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(random)
  const start = Date.now()
  const { change, upstream, terminal } = run(Array.from({ length: 6 }, () => failure('temporary-rate-limit')))
  await vi.advanceTimersByTimeAsync(34_100)
  const waits = change.mock.calls.filter(([state]) => state.phase === 'waiting').map(([state]) => state.retryAt)
  expect(waits).toHaveLength(5)
  for (const [index, deadline] of waits.entries()) {
    const delay = deadline - (waits[index - 1] ?? start)
    expect(delay).toBeGreaterThanOrEqual(900 * 2 ** index)
    expect(delay).toBeLessThan(1100 * 2 ** index)
    if (random === 0.5) expect(delay).toBe(1000 * 2 ** index)
  }
  expect(upstream).toHaveBeenCalledTimes(6)
  expect((await terminal).failure?.attempts).toBe(5)
})

it.each(['rate-limit', 'overloaded'] as const)('keeps the absolute deadline for %s, including elapsed time', async kind => {
  vi.useFakeTimers()
  const receivedAt = Date.now() - 1000
  const retryAt = receivedAt + 60_000
  const { change, upstream, terminal } = run([failure(kind, retryAt), failure('unknown')])
  await vi.advanceTimersByTimeAsync(58_999)
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', retryAt }))
  await vi.advanceTimersByTimeAsync(1)
  expect(upstream).toHaveBeenCalledTimes(2)
  expect((await terminal).failure?.kind).toBe('unknown')
})

it('skips waiting if an applicable service deadline has elapsed', async () => {
  const { change, terminal, upstream } = run([failure('rate-limit', Date.now() - 1), failure('unknown')])
  expect((await terminal).failure?.kind).toBe('unknown')
  expect(change.mock.calls.map(([state]) => state.phase)).toEqual(['retrying'])
  expect(upstream).toHaveBeenCalledTimes(2)
})

it('splits waits beyond the runtime timer limit without moving the deadline', async () => {
  vi.useFakeTimers()
  const deadline = Date.now() + 2_147_483_648
  const { upstream, change, terminal } = run([failure('rate-limit', deadline), failure('unknown')])
  await vi.advanceTimersByTimeAsync(2_147_483_647)
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ retryAt: deadline }))
  await vi.advanceTimersByTimeAsync(1)
  expect((await terminal).failure?.kind).toBe('unknown')
  expect(upstream).toHaveBeenCalledTimes(2)
})

it('recovers a real adapter request error in the same step', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('unknown request error'))
    .mockImplementation(async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }))
  const report = vi.fn()
  const adapter = createModelStream({ readApiKey: async () => 'controlled' }, { fetch: fetcher })
  const context = { messages: [{ role: 'user' as const, content: 'same input', timestamp: 1 }] }
  const response = withModelRetry(adapter, report)(model, context)
  const collect = (async () => { for await (const _ of response) { /* consume stream */ } })()
  await vi.advanceTimersByTimeAsync(999)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'request-error', attempt: 1, phase: 'waiting' }))
  await vi.advanceTimersByTimeAsync(1)
  await collect
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[0][1]?.body).toEqual(fetcher.mock.calls[1][1]?.body)
  expect(await response.result()).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] })
})

it('uses exactly five retries for code-less Responses failure events', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  const fetcher = vi.fn(async () => new Response('event: response.failed\ndata: {"type":"response.failed"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } }))
  const adapter = createModelStream({ readApiKey: async () => 'controlled' }, { fetch: fetcher })
  const report = vi.fn()
  const response = withModelRetry(adapter, report)(findModel('chat-latest', 'openai')!, { messages: [] })
  const collect = (async () => { for await (const _ of response) { /* consume stream */ } })()
  await vi.advanceTimersByTimeAsync(31_000)
  await collect
  expect(fetcher).toHaveBeenCalledTimes(6)
  expect(report.mock.calls.filter(([state]) => state.phase === 'retrying').map(([state]) => state.reason))
    .toEqual(Array(5).fill('response-error'))
  expect(await response.result()).toMatchObject({ stopReason: 'error', failure: { kind: 'response-error', attempts: 5 } })
})
