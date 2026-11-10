import { describe, expect, it } from 'vitest'
import { createModelStream, findModel, type AssistantMessage, type ModelContext, type ModelEventStream } from '@agent-learning/model'
import { defaultTools } from '../src/tools.js'

const model = findModel('deepseek-flash')!
const credentials = { readApiKey: async () => 'offline-tools-test-key' }
const input: ModelContext = {
  messages: [{ role: 'user', content: '使用 read 读取 note.txt，从第 1 行开始，最多 5 行。', timestamp: 1 }],
  tools: defaultTools,
}

function chunk(delta: Record<string, unknown> = {}, finish_reason: string | null = null) {
  return {
    id: 'tools-response', object: 'chat.completion.chunk', created: 1, model: model.id,
    choices: [{ index: 0, delta, finish_reason }],
  }
}

function toolChunk(argumentsText = '{"path":"note.txt","offset":1,"limit":5}', name = 'read') {
  return chunk({ tool_calls: [{ index: 0, id: 'original-call-id', type: 'function', function: { name, arguments: argumentsText } }] })
}

function response(chunks: unknown[]) {
  return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function deliveredCalls(message: AssistantMessage) {
  return message.stopReason === 'stop' || message.stopReason === 'toolUse'
    ? message.content.filter(block => block.type === 'toolCall')
    : []
}

async function receive(stream: ModelEventStream) {
  for await (const _event of stream) {}
  const message = await stream.result()
  return { message, calls: deliveredCalls(message) }
}

describe('eight tool declarations through the real Model and SDK', () => {
  it('sends every real declaration with its name, description and complete parameter rules', async () => {
    let requestBody: Record<string, unknown> | undefined
    const run = createModelStream(credentials, { fetch: (async (_url, init) => {
      requestBody = JSON.parse(String(init!.body))
      return response([chunk({ content: '收到。' }), chunk({}, 'stop')])
    }) as typeof fetch })

    const { message } = await receive(run(model, input))

    expect(message.stopReason).toBe('stop')
    expect(defaultTools.map(tool => tool.name)).toEqual(['read', 'bash', 'edit', 'write', 'find', 'grep', 'web_search', 'web_fetch'])
    expect(requestBody!.tools).toEqual(defaultTools.map(tool => ({
      type: 'function', function: {
        name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)),
      },
    })))
  })

  it.each([
    { name: 'unknown_tool', argumentsText: '{"anything":true}', expected: { anything: true } },
    { name: 'read', argumentsText: '{"limit":5}', expected: { limit: 5 } },
  ])('keeps unvalidated $name arguments after sending the actual declarations', async ({ name, argumentsText, expected }) => {
    const run = createModelStream(credentials, { fetch: async () => response([toolChunk(argumentsText, name), chunk({}, 'tool_calls')]) })

    const { calls } = await receive(run(model, input))

    expect(calls).toEqual([{ type: 'toolCall', id: 'original-call-id', name, arguments: expected }])
  })

  it('keeps the original call and argumentsError for later validation', async () => {
    const run = createModelStream(credentials, { fetch: async () => response([toolChunk('{"path":'), chunk({}, 'tool_calls')]) })

    const { calls } = await receive(run(model, input))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ type: 'toolCall', id: 'original-call-id', name: 'read', arguments: {} })
    expect(calls[0]!.argumentsError).toEqual(expect.any(String))
  })
})

describe('independent caller waits for the final delivery decision', () => {
  it.each([['stop', 'stop'], ['tool_calls', 'toolUse']])('delivers the original call only after %s completes', async (finish, reason) => {
    const run = createModelStream(credentials, { fetch: async () => response([toolChunk(), chunk({}, finish)]) })

    const { message, calls } = await receive(run(model, input))

    expect(message.stopReason).toBe(reason)
    expect(calls).toEqual([{ type: 'toolCall', id: 'original-call-id', name: 'read', arguments: { path: 'note.txt', offset: 1, limit: 5 } }])
    expect(calls[0]).toBe(message.content[0])
  })

  it('returns an empty call list for a completed text response', async () => {
    const run = createModelStream(credentials, { fetch: async () => response([chunk({ content: '只有文字。' }), chunk({}, 'stop')]) })

    const { message, calls } = await receive(run(model, input))

    expect(message).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: '只有文字。' }] })
    expect(calls).toEqual([])
  })

  it.each([['length', 'length'], ['content_filter', 'error']])('withholds calls after %s while preserving received parameters', async (finish, reason) => {
    const run = createModelStream(credentials, { fetch: async () => response([toolChunk(), chunk({}, finish)]) })

    const { message, calls } = await receive(run(model, input))

    expect(message).toMatchObject({
      stopReason: reason,
      content: [{ type: 'toolCall', id: 'original-call-id', name: 'read', arguments: { path: 'note.txt', offset: 1, limit: 5 } }],
    })
    expect(calls).toEqual([])
  })

  it('withholds a call cancelled after its arguments arrive and keeps the original message', async () => {
    const controller = new AbortController()
    const run = createModelStream(credentials, { fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(body) { body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(toolChunk())}\n\n`)) },
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    const stream = run(model, input, { signal: controller.signal })
    for await (const event of stream) {
      if (event.type === 'toolcall_delta') controller.abort()
    }
    const message = await stream.result()

    expect(controller.signal.aborted).toBe(true)
    expect(message).toMatchObject({
      stopReason: 'aborted',
      content: [{ type: 'toolCall', id: 'original-call-id', name: 'read', arguments: { path: 'note.txt', offset: 1, limit: 5 } }],
    })
    expect(deliveredCalls(message)).toEqual([])
  })
})
