import { afterEach, describe, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import * as modelApi from '../src/index.js'
import type { ModelInfo } from '../src/index.js'

const selected: ModelInfo = {
  id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions', contextWindow: 1_048_576, maxTokens: 65_536,
}
const context = { messages: [{ role: 'user' as const, content: '  你好\n第二行  ', timestamp: 1 }] }
const credentials = { readApiKey: async () => 'test-private-key' }
const encoder = new TextEncoder()

function chunk(delta: Record<string, unknown> = {}, finish_reason: string | null = null) {
  return {
    id: 'response-1', object: 'chat.completion.chunk', created: 1, model: 'reported-model',
    choices: [{ index: 0, delta, finish_reason }],
  }
}

function response(chunks: unknown[], done = true) {
  return new Response(chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function liveResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let signal!: AbortSignal
  const fetcher = (async (_url, init) => {
    signal = init!.signal!
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return {
    fetcher,
    send(value: unknown) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)) },
    heartbeat() { controller.enqueue(encoder.encode(': keep-alive\n\n')) },
    end() { controller.close() },
    fail() { controller.error(new Error('private upstream failure test-private-key')) },
    failWithAbort() { controller.error(new DOMException('private transport failure test-private-key', 'AbortError')) },
    aborted() { return signal.aborted },
  }
}

async function consume(stream: ReturnType<typeof modelApi.stream>) {
  const events = []
  for await (const event of stream) events.push(event)
  return { events, result: await stream.result() }
}

afterEach(() => vi.useRealTimers())

describe('Model single SDK stream', () => {
  it.each([false, true])('fills only missing results per batch without mutating history (next user: %s)', async nextUser => {
    const call = (id: string): modelApi.ToolCall => ({ type: 'toolCall', id, name: 'read', arguments: { path: id } })
    const turn: modelApi.AssistantMessage = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: 1,
      stopReason: 'toolUse', content: [{ type: 'thinking', thinking: '保留思考' }, call('read'), call('bash'), call('write')] }
    const result = (id: string, text: string, isError = false): modelApi.ToolResultMessage => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], isError, timestamp: 1 })
    const history: modelApi.ModelContext['messages'] = [turn, { role: 'system', content: '穿插系统消息', timestamp: 1 }, result('read', '真实文件'), result('bash', '真实取消', true),
      { ...turn, content: [call('read'), call('write')] }, result('read', '新一批真实文件'), ...(nextUser ? context.messages : [])]
    const original = structuredClone(history)
    const requests: any[] = []
    const run = modelApi.createModelStream(credentials, { fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init!.body)).messages)
      return response([chunk({ content: 'ok' }, 'stop')])
    } })
    for (let i = 0; i < 2; i++) await consume(run(selected, { messages: history, tools: [{ name: 'read', description: 'Read text', parameters: Type.Object({}) }] }))
    const expected = [
      { role: 'assistant', reasoning_content: '保留思考' },
      { role: 'tool', tool_call_id: 'read', content: '真实文件' },
      { role: 'tool', tool_call_id: 'bash', content: '真实取消' },
      { role: 'tool', tool_call_id: 'write', content: 'No result provided' },
      { role: 'system', content: '穿插系统消息' },
      { role: 'assistant' },
      { role: 'tool', tool_call_id: 'read', content: '新一批真实文件' },
      { role: 'tool', tool_call_id: 'write', content: 'No result provided' },
      ...(nextUser ? [{ role: 'user', content: '  你好\n第二行  ' }] : []),
    ]
    expect(requests[0]).toMatchObject(expected)
    expect(requests[0]).toHaveLength(expected.length)
    expect(requests[1]).toEqual(requests[0])
    expect(history).toEqual(original)
  })
  it('sends caller-provided generic tool declarations through the SDK', async () => {
    let payload: Record<string, unknown> | undefined
    const tools: modelApi.Tool[] = [{
      name: 'lookup', description: 'Find a record by key',
      parameters: Type.Object({ key: Type.String(), count: Type.Optional(Type.Number()) }),
    }]
    const run = modelApi.createModelStream(credentials, { fetch: async (_url, init) => {
      payload = JSON.parse(String(init!.body))
      return response([chunk({ content: 'ok' }, 'stop')])
    } })
    const { result } = await consume(run(selected, { ...context, tools }))
    expect(result.stopReason).toBe('stop')
    expect(payload!.tools).toEqual([{
      type: 'function', function: {
        name: 'lookup', description: 'Find a record by key',
        parameters: { type: 'object', properties: { key: { type: 'string' }, count: { type: 'number' } }, required: ['key'] },
      },
    }])
  })

  it('omits the SDK tools field for an empty declaration list', async () => {
    let payload: Record<string, unknown> | undefined
    const run = modelApi.createModelStream(credentials, { fetch: async (_url, init) => {
      payload = JSON.parse(String(init!.body))
      return response([chunk({ content: 'ok' }, 'stop')])
    } })
    await consume(run(selected, { ...context, tools: [] }))
    expect(payload).not.toHaveProperty('tools')
  })

  it('exports the stream contract and a copied static model lookup', () => {
    expect(modelApi.createModelStream).toBeTypeOf('function')
    expect(modelApi.stream).toBeTypeOf('function')
    expect(modelApi.findModel('other')).toBeUndefined()
    const found = modelApi.findModel(selected.id)!
    expect(found).toEqual(selected)
    found.name = 'changed'
    expect(modelApi.findModel(selected.id)!.name).toBe('DeepSeek Flash')
  })

  it('sends fixed settings and exact history once, emits all blocks, and shares its final result', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const run = modelApi.createModelStream(credentials, { fetch: (async (url, init) => {
      requests.push({ url: String(url), init: init! })
      return response([
        chunk({ reasoning_content: '先想' }),
        chunk({ content: '你好' }),
        chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"a":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
        chunk({}, 'tool_calls'),
        { id: 'response-1', model: 'reported-model', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } },
      ])
    }) as typeof fetch })
    const input = {
      systemPrompt: 'system instruction',
      messages: [
        context.messages[0],
        { role: 'assistant' as const, content: [{ type: 'thinking' as const, thinking: 'old hidden thought' }, { type: 'text' as const, text: 'old reply' }], api: selected.api, provider: selected.provider, model: selected.id, stopReason: 'stop' as const, timestamp: 2 },
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'next question' }], timestamp: 3 },
      ],
    }
    const stream = run(selected, input)
    const resultPromise = stream.result()
    expect(stream.result()).toBe(resultPromise)
    const { events, result } = await consume(stream)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://api.deepseek.com/chat/completions')
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe('Bearer test-private-key')
    const payload = JSON.parse(requests[0].init.body as string)
    expect(payload).toMatchObject({ model: 'deepseek-flash', stream: true, thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 65_536, stream_options: { include_usage: true } })
    expect(payload.messages).toEqual([
      { role: 'system', content: 'system instruction' },
      { role: 'user', content: '  你好\n第二行  ' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'next question' },
    ])
    expect(JSON.stringify(payload)).not.toContain('test-private-key')
    expect(payload).not.toHaveProperty('tools')
    expect(events.map((event) => event.type)).toEqual([
      'start', 'thinking_start', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta',
      'text_end', 'toolcall_start', 'toolcall_delta', 'toolcall_delta', 'toolcall_end', 'done',
    ])
    expect(result.content).toEqual([
      { type: 'thinking', thinking: '先想', thinkingSignature: 'reasoning_content' },
      { type: 'text', text: '你好' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { a: 1 } },
    ])
    expect(result).toMatchObject({ stopReason: 'toolUse', responseId: 'response-1', responseModel: 'reported-model', usage: { input: 12, output: 7, total: 19 } })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(await resultPromise).toBe(result)
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'toolUse', message: result })
    const starts = events.filter((event) => 'partial' in event)
    expect(starts.every((event) => 'partial' in event && event.partial === result)).toBe(true)
  })

  it.each([['stop', 'stop'], ['length', 'length'], ['tool_calls', 'toolUse']])('maps %s to %s without fabricated usage', async (finish, reason) => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([chunk({ content: 'a' }), chunk({}, finish)]) })
    const { events, result } = await consume(run(selected, context))
    expect(result.stopReason).toBe(reason)
    expect(result).not.toHaveProperty('usage')
    expect(events.filter((event) => event.type === 'done' || event.type === 'error')).toHaveLength(1)
  })

  it('keeps only reported usage fields', async () => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([chunk({}, 'stop'), { choices: [], usage: { prompt_tokens: 4 } }]) })
    expect((await consume(run(selected, context))).result.usage).toEqual({ input: 4 })
  })

  it('treats optional null stream fields as absent instead of an invalid tool request', async () => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([
      chunk({ role: 'assistant', content: null, reasoning_content: null, tool_calls: null }),
      chunk({ content: 'answer', tool_calls: null }), chunk({}, 'stop'),
    ]) })
    expect((await consume(run(selected, context))).result).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'answer' }] })
  })

  it.each(['data: {invalid private text\n\n', 'data: {"error":{"message":"test-private-key private text"}}\n\n'])('sanitizes malformed SSE and streamed provider errors', async (body) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const run = modelApi.createModelStream(credentials, { fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
      const { result } = await consume(run(selected, context))
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).not.toMatch(/test-private-key|private text/)
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it.each(['', '  ', '{}', '{"a":true,"b":[null,1]}', '[]', 'null', '"x"', '1', 'false', '{"a":"\\q"}', '{"a":"raw\nline"}', '{"a":1'])('strictly finalizes tool arguments %j', async (argumentsText) => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([
      chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'unknown', arguments: argumentsText } }] }), chunk({}, 'tool_calls'),
    ]) })
    const { events, result } = await consume(run(selected, context))
    const tool = result.content[0]
    expect(tool.type).toBe('toolCall')
    if (tool.type !== 'toolCall') throw new Error('missing tool')
    expect(tool.id).toBe('a')
    expect(tool.name).toBe('unknown')
    const valid = ['', '  ', '{}', '{"a":true,"b":[null,1]}'].includes(argumentsText)
    expect(tool.arguments).toEqual(argumentsText === '{"a":true,"b":[null,1]}' ? { a: true, b: [null, 1] } : {})
    if (valid) expect(tool).not.toHaveProperty('argumentsError')
    else {
      expect(tool.argumentsError).toContain(argumentsText)
      expect(tool.argumentsError).toMatch(/JSON|object|对象/)
    }
    expect(events.some((event) => event.type === 'toolcall_end')).toBe(true)
    expect(result.stopReason).toBe('toolUse')
  })

  it('groups interleaved calls by index then ID, retaining and later filling empty identifiers', async () => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([
      chunk({ tool_calls: [{ index: 0, type: 'function', function: { arguments: '{"a":' } }, { index: 1, id: 'second', type: 'function', function: { name: 'two', arguments: '{"b":' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'first', function: { name: 'one', arguments: '1}' } }, { id: 'second', function: { arguments: '2}' } }] }),
      chunk({ tool_calls: [{ index: 2, type: 'function', function: { name: 'empty', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ]) })
    const { result } = await consume(run(selected, context))
    expect(result.content).toEqual([
      { type: 'toolCall', id: 'first', name: 'one', arguments: { a: 1 } },
      { type: 'toolCall', id: 'second', name: 'two', arguments: { b: 2 } },
      { type: 'toolCall', id: '', name: 'empty', arguments: {} },
    ])
  })

  it('reads the current Key for each request and does not change an in-flight authentication header', async () => {
    let key = 'old-key'
    const providers: string[] = []
    const headers: string[] = []
    const run = modelApi.createModelStream({ readApiKey: async provider => { providers.push(provider); return key } }, { fetch: (async (_url, init) => {
      headers.push(new Headers(init!.headers).get('authorization')!)
      key = 'new-key'
      return response([chunk({}, 'stop')])
    }) as typeof fetch })
    await consume(run(selected, context))
    await consume(run(selected, context))
    expect(headers).toEqual(['Bearer old-key', 'Bearer new-key'])
    expect(providers).toEqual(['deepseek', 'deepseek'])
  })

  it('turns setup failure into a final error before start without exposing credential errors', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const run = modelApi.createModelStream({ readApiKey: async () => { throw new Error('private-key original file contents') } }, { fetch: fetcher })
    const stream = run(selected, context)
    const { events, result } = await consume(stream)
    expect(events.map((event) => event.type)).toEqual(['error'])
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBeTruthy()
    expect(JSON.stringify(result)).not.toMatch(/private-key|original file/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([400, 401, 403, 422, 429, 500])('does not retry HTTP %s and sanitizes provider text', async (status) => {
    let calls = 0
    const run = modelApi.createModelStream(credentials, { fetch: async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: 'test-private-key raw provider message' } }), { status, headers: { 'content-type': 'application/json' } })
    } })
    const { events, result } = await consume(run(selected, context))
    expect(calls).toBe(1)
    expect(events.map((event) => event.type)).toEqual(['error'])
    expect(result.stopReason).toBe('error')
    expect(result).not.toHaveProperty('errorCode')
    expect(result.errorMessage).not.toMatch(/test-private-key|raw provider message/)
    expect(result.errorMessage).toContain(String(status))
  })

  it.each([
    [400, 'context_length_exceeded', 'private test-private-key', true],
    [422, undefined, "This model's maximum context length is 1048576 tokens. You requested 1100000 tokens. test-private-key", true],
    [400, undefined, 'Input length (1100000) exceeds model maximum context length (1048576). test-private-key', true],
    [400, undefined, 'invalid max_tokens parameter; maximum context length is 1048576', false],
    [401, 'context_length_exceeded', 'test-private-key', false],
    [429, 'context_length_exceeded', 'test-private-key', false],
    [500, 'context_length_exceeded', 'test-private-key', false],
    [400, undefined, 'rate limit: too many tokens', false],
  ])('classifies only explicit context overflow (%s, %s, classified %s)', async (status, code, message, overflow) => {
    let requests = 0
    const run = modelApi.createModelStream(credentials, { fetch: async () => {
      requests++
      return new Response(JSON.stringify({ error: { message, code } }), { status, headers: { 'content-type': 'application/json' } })
    } })
    const { result } = await consume(run(selected, context))
    expect(requests).toBe(1)
    expect(result.stopReason).toBe('error')
    expect(result.errorCode).toBe(overflow ? 'context_overflow' : undefined)
    expect(JSON.stringify(result)).not.toMatch(/test-private-key|1100000|1048576/)
  })

  it.each([null, 'content_filter', 'network_error', 'unknown'])('fails missing or unsupported finish reason %s while preserving text', async (finish) => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([chunk({ content: 'partial' }, finish)]) })
    const { events, result } = await consume(run(selected, context))
    expect(result).toMatchObject({ stopReason: 'error', content: [{ type: 'text', text: 'partial' }] })
    expect(events.at(-1)?.type).toBe('error')
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })

  it('does not report success before the usage tail has finished and preserves partial tools on tail failure', async () => {
    const upstream = liveResponse()
    const stream = modelApi.createModelStream(credentials, { fetch: upstream.fetcher })(selected, context)
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value.type).toBe('start')
    let settled = false
    void stream.result().then(() => { settled = true })
    upstream.send(chunk({ content: 'partial', tool_calls: [{ index: 0, id: 'tool', function: { name: 'read', arguments: '{"a":' } }] }, 'stop'))
    for (let index = 0; index < 4; index++) await iterator.next()
    expect(settled).toBe(false)
    upstream.fail()
    const rest = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) rest.push(event)
    const result = await stream.result()
    expect(result.stopReason).toBe('error')
    expect(result.content[0]).toEqual({ type: 'text', text: 'partial' })
    expect(result.content[1]).toMatchObject({ type: 'toolCall', arguments: {}, argumentsError: expect.stringContaining('{"a":') })
    expect(rest.at(-1)?.type).toBe('error')
    expect(JSON.stringify(result)).not.toContain('private upstream failure')
  })

  it('reports a transport AbortError after finish as error even when SDK iteration ends normally', async () => {
    const upstream = liveResponse()
    const stream = modelApi.createModelStream(credentials, { fetch: upstream.fetcher })(selected, context)
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value.type).toBe('start')
    upstream.send(chunk({ content: 'kept' }, 'stop'))
    expect((await iterator.next()).value.type).toBe('text_start')
    expect((await iterator.next()).value.type).toBe('text_delta')
    upstream.failWithAbort()
    const rest = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) rest.push(event)
    const result = await stream.result()
    expect(result).toMatchObject({ stopReason: 'error', content: [{ type: 'text', text: 'kept' }] })
    expect(result.errorMessage).not.toMatch(/private transport failure|test-private-key/)
    expect(rest.filter((event) => event.type === 'error' || event.type === 'done').map((event) => event.type)).toEqual(['error'])
  })

  it('keeps distinct text and thinking intervals in their output order around tool calls', async () => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([
      chunk({ content: 'A' }),
      chunk({ tool_calls: [{ index: 0, id: 'call', function: { name: 'read', arguments: '{"a":' } }] }),
      chunk({ content: 'B' }),
      chunk({ reasoning_content: 'think' }),
      chunk({ content: 'C' }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
      chunk({ content: 'D' }),
      chunk({}, 'tool_calls'),
    ]) })
    const { events, result } = await consume(run(selected, context))
    expect(result.content).toEqual([
      { type: 'text', text: 'A' },
      { type: 'toolCall', id: 'call', name: 'read', arguments: { a: 1 } },
      { type: 'text', text: 'B' },
      { type: 'thinking', thinking: 'think', thinkingSignature: 'reasoning_content' },
      { type: 'text', text: 'C' },
      { type: 'text', text: 'D' },
    ])
    expect(events.filter((event) => event.type === 'text_end').map((event) => [event.contentIndex, event.content])).toEqual([[0, 'A'], [2, 'B'], [4, 'C'], [5, 'D']])
    expect(events.filter((event) => event.type === 'thinking_end').map((event) => [event.contentIndex, event.content])).toEqual([[3, 'think']])
    expect(events.filter((event) => event.type === 'toolcall_start')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'toolcall_end')).toHaveLength(1)
  })

  it('ends a thinking interval before publishing the first answer text while the stream remains open', async () => {
    const upstream = liveResponse()
    const stream = modelApi.createModelStream(credentials, { fetch: upstream.fetcher })(selected, context)
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value.type).toBe('start')
    upstream.send(chunk({ reasoning_content: 'thought' }))
    expect((await iterator.next()).value.type).toBe('thinking_start')
    expect((await iterator.next()).value.type).toBe('thinking_delta')
    upstream.send(chunk({ content: 'answer' }))
    const transition = (await iterator.next()).value
    upstream.send(chunk({}, 'stop'))
    upstream.end()
    const rest = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) rest.push(event)
    expect(transition).toMatchObject({ type: 'thinking_end', contentIndex: 0, content: 'thought' })
    expect(rest.filter((event) => event.type === 'thinking_end')).toHaveLength(0)
    expect(rest.find((event) => event.type === 'text_start')).toMatchObject({ contentIndex: 1 })
    expect((await stream.result()).stopReason).toBe('stop')
  })

  it('preserves deltas when producer progress leads the event consumer', async () => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([chunk({ content: 'A' }), chunk({ content: 'B' }), chunk({}, 'stop')]) })
    const stream = run(selected, context)
    await stream.result()
    const { events } = await consume(stream)
    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.delta)).toEqual(['A', 'B'])
    expect(events.find((event) => event.type === 'start')!.partial.content).toEqual([{ type: 'text', text: 'AB' }])
  })

  it('aborts before request preparation and during generation with a single aborted result', async () => {
    const before = new AbortController()
    before.abort()
    let calls = 0
    const run = modelApi.createModelStream(credentials, { fetch: async () => { calls++; return response([]) } })
    const first = await consume(run(selected, context, { signal: before.signal }))
    expect(first.result.stopReason).toBe('aborted')
    expect(calls).toBe(0)

    const upstream = liveResponse()
    const controller = new AbortController()
    const stream = modelApi.createModelStream(credentials, { fetch: upstream.fetcher })(selected, context, { signal: controller.signal })
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value.type).toBe('start')
    upstream.send(chunk({ content: 'kept' }))
    expect((await iterator.next()).value.type).toBe('text_start')
    expect((await iterator.next()).value.type).toBe('text_delta')
    controller.abort()
    const remaining = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) remaining.push(event)
    expect(upstream.aborted()).toBe(true)
    expect(await stream.result()).toMatchObject({ stopReason: 'aborted', content: [{ type: 'text', text: 'kept' }] })
    expect(remaining.filter((event) => event.type === 'error')).toHaveLength(1)
  })

  it('cancels its SDK response reader when a protocol error ends an open body', async () => {
    let cancelled = false
    const run = modelApi.createModelStream(credentials, { fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: 42 }))}\n\n`)) },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    const { events, result } = await consume(run(selected, context))
    expect(result.stopReason).toBe('error')
    expect(events.map((event) => event.type)).toEqual(['start', 'error'])
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  it('allows sustained generation beyond the SDK default ten-minute timeout and waits for usage', async () => {
    vi.useFakeTimers()
    const upstream = liveResponse()
    const stream = modelApi.createModelStream(credentials, { fetch: upstream.fetcher })(selected, context)
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value.type).toBe('start')
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(240_000)
      upstream.send(chunk({ content: 'a' }))
      if (index === 0) expect((await iterator.next()).value.type).toBe('text_start')
      expect((await iterator.next()).value.type).toBe('text_delta')
    }
    upstream.send(chunk({}, 'stop'))
    upstream.send({ choices: [], usage: { completion_tokens: 4 } })
    upstream.end()
    for await (const _event of { [Symbol.asyncIterator]: () => iterator }) { /* drain */ }
    expect(await stream.result()).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'aaaa' }], usage: { output: 4 } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails if the usage tail stalls after a valid finish reason', async () => {
    vi.useFakeTimers()
    const upstream = liveResponse()
    const stream = modelApi.createModelStream(credentials, { fetch: upstream.fetcher })(selected, context)
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value.type).toBe('start')
    upstream.send(chunk({ content: 'finished body' }, 'stop'))
    await iterator.next()
    await iterator.next()
    await vi.advanceTimersByTimeAsync(300_000)
    const rest = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) rest.push(event)
    expect((await stream.result()).stopReason).toBe('error')
    expect(rest.at(-1)?.type).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not invent empty content blocks, and rejects an unsupported model before network access', async () => {
    let calls = 0
    const run = modelApi.createModelStream(credentials, { fetch: async () => { calls++; return response([chunk({ content: '', reasoning_content: '' }), chunk({}, 'stop')]) } })
    const empty = await consume(run(selected, context))
    expect(empty.result.content).toEqual([])
    expect(empty.events.map((event) => event.type)).toEqual(['start', 'done'])
    const unsupported = await consume(run({ ...selected, id: 'other' }, context))
    expect(unsupported.result.stopReason).toBe('error')
    expect(unsupported.events.map((event) => event.type)).toEqual(['error'])
    expect(calls).toBe(1)
  })

  it('keeps duplicate IDs under different indices visible for whole-batch validation', async () => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([
      chunk({ tool_calls: [{ index: 0, id: 'same', function: { name: 'read', arguments: '{}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'same', function: { name: 'write', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ]) })
    const { result } = await consume(run(selected, context))
    expect(result.stopReason).toBe('toolUse')
    expect(result.content).toEqual([
      { type: 'toolCall', id: 'same', name: 'read', arguments: {} },
      { type: 'toolCall', id: 'same', name: 'write', arguments: {} },
    ])
  })

  it('fails the model response when an indexed call changes its ID mid-stream', async () => {
    const run = modelApi.createModelStream(credentials, { fetch: async () => response([
      chunk({ tool_calls: [{ index: 0, id: 'first', function: { name: 'read', arguments: '{' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'changed', function: { arguments: '}' } }] }, 'tool_calls'),
    ]) })
    const { result } = await consume(run(selected, context))
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('编号')
  })

  it('preserves tool and final-answer reasoning in the next user turn', async () => {
    const requests: Record<string, unknown>[] = []
    const replies = [
      [chunk({ reasoning_content: 'decide to read' }), chunk({
        tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read', arguments: '{"path":"notes.txt"}' } }],
      }, 'tool_calls')],
      [chunk({ reasoning_content: 'read result understood' }), chunk({ content: 'Read it.' }, 'stop')],
      [chunk({ content: 'Follow-up answered.' }, 'stop')],
    ]
    const run = modelApi.createModelStream(credentials, { fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init!.body)))
      return response(replies.shift()!)
    } })
    const tools = [{ name: 'read', description: 'Read text', parameters: Type.Object({ path: Type.String() }) }]
    const first = (await consume(run(selected, { ...context, tools }))).result
    const toolResult: modelApi.ToolResultMessage = {
      role: 'toolResult', toolCallId: 'read-1', toolName: 'read',
      content: [{ type: 'text', text: 'file content' }], isError: false, timestamp: 3,
    }
    const answered = [...context.messages, first, toolResult]
    const final = (await consume(run(selected, { messages: answered }))).result
    await consume(run(selected, { messages: [...answered, final, { role: 'user', content: 'Next question', timestamp: 5 }], tools }))

    expect(requests[1]).not.toHaveProperty('tools')
    expect(requests[1].messages).toMatchObject([
      { role: 'user' },
      { role: 'assistant', tool_calls: [{ id: 'read-1' }] },
      { role: 'tool', tool_call_id: 'read-1', content: 'file content' },
    ])
    expect(requests[1].messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ reasoning_content: expect.anything() })]))
    expect(requests[2]).toHaveProperty('tools')
    expect(requests[2].messages).toMatchObject([
      { role: 'user' },
      { role: 'assistant', reasoning_content: 'decide to read', tool_calls: [{ id: 'read-1' }] },
      { role: 'tool', tool_call_id: 'read-1', content: 'file content' },
      { role: 'assistant', content: 'Read it.', reasoning_content: 'read result understood' },
      { role: 'user', content: 'Next question' },
    ])
  })

  it('times out the first response wait at five minutes and aborts the transport without retry', async () => {
    vi.useFakeTimers()
    let signal!: AbortSignal
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let calls = 0
    const run = modelApi.createModelStream(credentials, { fetch: (async (_url, init) => {
      calls++
      signal = init!.signal!
      started()
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }) as typeof fetch })
    const stream = run(selected, context)
    const reading = consume(stream)
    await ready
    let settled = false
    void stream.result().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(299_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const { result } = await reading
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toMatch(/超时|timeout/i)
    expect(signal.aborted).toBe(true)
    expect(calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses rolling model-data inactivity, ignores SSE heartbeat, and allows total duration above five minutes', async () => {
    vi.useFakeTimers()
    const upstream = liveResponse()
    const stream = modelApi.createModelStream(credentials, { fetch: upstream.fetcher })(selected, context)
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value.type).toBe('start')
    await vi.advanceTimersByTimeAsync(240_000)
    upstream.send(chunk({ content: 'A' }))
    expect((await iterator.next()).value.type).toBe('text_start')
    expect((await iterator.next()).value.type).toBe('text_delta')
    await vi.advanceTimersByTimeAsync(240_000)
    upstream.send(chunk({ content: 'B' }))
    expect((await iterator.next()).value.type).toBe('text_delta')
    await vi.advanceTimersByTimeAsync(240_000)
    upstream.heartbeat()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(upstream.aborted()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const events = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event)
    const result = await stream.result()
    expect(result).toMatchObject({ stopReason: 'error', content: [{ type: 'text', text: 'AB' }] })
    expect(upstream.aborted()).toBe(true)
    expect(events.at(-1)?.type).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
  })
})
