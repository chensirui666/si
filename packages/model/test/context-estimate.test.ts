import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { piModels } from '../src/catalog.js'
import { toPiContext } from '../src/context.js'
import * as modelApi from '../src/index.js'
import type { AssistantMessage, ModelContext, ToolResultMessage } from '../src/index.js'
import { convertMessages } from '../src/context.js'

const assistant: AssistantMessage = {
  role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'x'.repeat(400) }],
  api: 'openai-completions', model: 'deepseek-flash', provider: 'deepseek', timestamp: 1, stopReason: 'stop',
}
const tools = [{ name: 'read', description: 'Read file', parameters: Type.Object({ path: Type.String() }) }]

describe('model-visible context estimates', () => {
  it('includes historical thinking only when tools make it model-visible', () => {
    const plain = { ...assistant, content: assistant.content.filter(block => block.type !== 'thinking') }
    expect(modelApi.estimateMessageTokens(assistant, false)).toBe(modelApi.estimateMessageTokens(plain, false))
    expect(modelApi.estimateMessageTokens(assistant, true)).toBe(modelApi.estimateMessageTokens(plain, true) + 100)
    expect(modelApi.estimateContextTokens({ messages: [assistant] })).toEqual(modelApi.estimateContextTokens({ messages: [plain] }))
    expect(modelApi.estimateContextTokens({ messages: [assistant], tools }).messageTokens)
      .toBe(modelApi.estimateContextTokens({ messages: [plain], tools }).messageTokens + 100)
  })

  it('separates declarations from tool calls and results and ignores record metadata', () => {
    const context: ModelContext = {
      systemPrompt: '只操作当前目录', tools,
      messages: [
        { role: 'user', content: 'Read notes', timestamp: 1 },
        { ...assistant, content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'notes.txt' } }] },
        { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(400) }], isError: false, timestamp: 1 },
      ],
    }
    const original = structuredClone(context)
    const estimate = modelApi.estimateContextTokens(context)
    expect(estimate.systemTokens).toBeGreaterThan(0)
    expect(estimate.toolsTokens).toBeGreaterThan(0)
    const shorter = structuredClone(context)
    const result = shorter.messages[2]
    if (result.role === 'toolResult' && result.content[0].type === 'text') result.content[0].text = ''
    const shortEstimate = modelApi.estimateContextTokens(shorter)
    expect(estimate.messageTokens).toBe(shortEstimate.messageTokens + 100)
    expect(estimate.toolsTokens).toBe(shortEstimate.toolsTokens)
    expect(estimate.systemTokens).toBe(shortEstimate.systemTokens)
    const metadata = { ...assistant, timestamp: 99999999999, responseId: 'x'.repeat(500), usage: { input: 99 }, durationMs: 20000 }
    expect(modelApi.estimateMessageTokens(metadata, true)).toBe(modelApi.estimateMessageTokens(assistant, true))
    expect(context).toEqual(original)
  })

  it('classifies only the last nonempty system prompt as system, retaining older ones in messages', () => {
    const initial = modelApi.estimateContextTokens({ systemPrompt: 'old', messages: [] })
    const combined = modelApi.estimateContextTokens({ systemPrompt: 'old', messages: [{ role: 'system', content: 'new prompt', timestamp: 1 }] })
    const newest = modelApi.estimateContextTokens({ systemPrompt: 'new prompt', messages: [] })
    expect(combined.systemTokens).toBe(newest.systemTokens)
    expect(combined.messageTokens).toBe(initial.systemTokens)
    expect(modelApi.estimateContextTokens({ messages: [] })).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('prices protocol repair for missing tool results without changing source history', () => {
    const turn: AssistantMessage = { ...assistant, content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: {} }] }
    const original = structuredClone(turn)
    const missing = modelApi.estimateContextTokens({ messages: [turn], tools })
    const explicit = modelApi.estimateContextTokens({ messages: [turn, {
      role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: 'No result provided' }], isError: true, timestamp: 1,
    }], tools })
    expect(missing).toEqual(explicit)
    expect(turn).toEqual(original)
  })

  it('counts image inputs independently of their encoded byte length', () => {
    const text: ToolResultMessage = {
      role: 'toolResult', toolCallId: 'r1', toolName: 'read', isError: false, timestamp: 1,
      content: [{ type: 'text', text: 'Read screenshot.png' }],
    }
    const estimate = (data: string) => modelApi.estimateMessageTokens({ ...text, content: [
      ...text.content, { type: 'image', mimeType: 'image/png', data },
    ] }, true)
    expect(estimate('AAAA')).toBeGreaterThan(modelApi.estimateMessageTokens(text, true))
    expect(estimate('AAAA'.repeat(1024 * 1024))).toBe(estimate('AAAA'))
  })

  it.each([
    { count: 48, last: 500_000, omitted: 0 },
    { count: 48, last: 500_004, omitted: 8 },
    { count: 49, last: 500_000, omitted: 8 },
    { count: 56, last: 500_000, omitted: 8 },
    { count: 57, last: 500_000, omitted: 16 },
  ])('omits $omitted oldest tool images with $count images and $last final bytes', ({ count, last, omitted }) => {
    const data = 'A'.repeat(500_000)
    const calls = Array.from({ length: count }, (_, index) => ({
      type: 'toolCall' as const, id: `read-${index}`, name: 'read', arguments: { path: `${index}.png` },
    }))
    const results: ToolResultMessage[] = calls.map(call => ({
      role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false, timestamp: 1,
      content: [{ type: 'text', text: call.arguments.path }, { type: 'image', mimeType: 'image/png',
        data: call === calls.at(-1) ? 'A'.repeat(last) : data }],
    }))
    const messages = convertMessages({ messages: [{ ...assistant, content: calls }, ...results] })
    expect(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(calls.map(call => call.id))
    const outcomes = messages.filter(message => message.role === 'tool')
    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.content).toContain(`${index}.png`)
      expect(outcome.content.includes('已省略')).toBe(index < omitted)
    }
    const attachment = messages.at(-1)
    expect(attachment?.role === 'user' && Array.isArray(attachment.content)
      && attachment.content.filter(block => block.type === 'image_url')).toHaveLength(count - omitted)
  })

  it('keeps previously omitted images out without confusing repeated call ids', () => {
    const turn: AssistantMessage = { ...assistant, content: [{ type: 'toolCall', id: 'same', name: 'read', arguments: {} }] }
    const result = (id: string): ToolResultMessage => ({
      role: 'toolResult', toolCallId: 'same', toolName: 'read', imageResultId: id, isError: false, timestamp: 1,
      content: [{ type: 'text', text: `${id}.png` }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }],
    })
    const omittedToolImageResults = new Set(['previous'])
    const context: ModelContext = { messages: [turn, result('previous'), turn, result('current')], omittedToolImageResults }
    modelApi.estimateContextTokens(context)
    expect(omittedToolImageResults).toEqual(new Set(['previous']))
    const sent = convertMessages(context)
    expect(sent.filter(message => message.role === 'tool').map(message => message.content)).toEqual([
      expect.stringMatching(/previous\.png.*\n.*已省略/), 'current.png',
    ])
    expect(sent.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it.each([false, true])('keeps current uploads across tool calls and spends the shared budget on the newest history (overflowing history: %s)', overflow => {
    const image = (marker: string, bytes: number) => ({
      type: 'image' as const, mimeType: 'image/png' as const, data: marker.repeat(bytes),
    })
    const uploads = {
      old: image('O', 3_000_000),
      newer: image('N', 11_000_000),
      recent: image('R', 8_000_000),
      current: image('C', 4_000_000),
    }
    const calls = Array.from({ length: 6 }, (_, index) => ({
      type: 'toolCall' as const, id: `read-${index}`, name: 'read', arguments: { path: `tool-${index}.png` },
    }))
    const results = calls.map((call, index): ToolResultMessage => ({
      role: 'toolResult', toolCallId: call.id, toolName: call.name, timestamp: 1, isError: false,
      content: [{ type: 'text', text: call.arguments.path }, image(String(index), 3_000_000)],
    }))
    const context: ModelContext = {
      currentUserMessageId: 'current',
      messages: [
        ...(overflow ? [{
          role: 'user' as const, timestamp: 1, content: [
            { type: 'text' as const, text: 'old.png and newer.png' }, uploads.old, uploads.newer,
          ],
        }] : []),
        { role: 'user', timestamp: 2, content: [{ type: 'text', text: 'recent.png' }, uploads.recent] },
        { role: 'user', timestamp: 3, uploadMessageId: 'current', content: [{ type: 'text', text: 'current.png' }, uploads.current] },
        { role: 'user', timestamp: 4, content: 'An extension supplied this message.' },
        { ...assistant, stopReason: 'toolUse', content: calls },
        ...results,
      ],
    }
    const wire = convertMessages(context)
    const pi = toPiContext(context)
    const wireImages = wire.flatMap(message => message.role === 'user' && Array.isArray(message.content)
      ? message.content.flatMap(block => block.type === 'image_url' ? [block.image_url.url.at(-1)] : [])
      : [])
    const piImages = pi.messages.flatMap(message => (message.role === 'user' || message.role === 'toolResult') && Array.isArray(message.content)
      ? message.content.flatMap(block => block.type === 'image' ? [block.data[0]] : []) : [])
    expect(wireImages).toEqual(overflow ? ['N', 'R', 'C'] : ['R', 'C', '2', '3', '4', '5'])
    expect(piImages).toEqual(wireImages)
    expect(wire.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(calls.map(call => call.id))
    expect(wire.filter(message => message.role === 'tool').map(message => String(message.content).split('\n')[0]))
      .toEqual(calls.map(call => call.arguments.path))
    expect(JSON.stringify(wire)).toContain('recent.png')
    if (overflow) expect(JSON.stringify(wire[0])).toContain('old.png and newer.png')
  })

  it('reports whether each DeepSeek route accepts images', () => {
    expect(modelApi.findModel('deepseek-flash')?.supportsImages).toBe(true)
    expect(modelApi.findModel('deepseek-v4-pro')?.supportsImages).toBeFalsy()
  })
})


it('replays foreign Gemini 4 tool history as text and preserves native call and result pairs', () => {
  const gemini = piModels.getModel('google', 'gemini-4-hydrogen')!
  const foreignCall: AssistantMessage = {
    ...assistant, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'foreign', name: 'read', arguments: { path: 'index.txt' } }],
  }
  const nativeCall: AssistantMessage = {
    ...assistant, provider: 'google', model: gemini.id, api: gemini.api, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'native', name: 'read', arguments: { path: 'note.txt' }, thoughtSignature: 'aGVsbG8=' }],
  }
  const context: ModelContext = { messages: [
    foreignCall,
    { role: 'toolResult', toolCallId: 'foreign', toolName: 'read', isError: true, timestamp: 2,
      content: [{ type: 'text', text: 'index.txt was missing' }] },
    nativeCall,
    { role: 'toolResult', toolCallId: 'native', toolName: 'read', isError: false, timestamp: 3,
      content: [{ type: 'text', text: 'note contents' }] },
  ] }
  const snapshot = structuredClone(context)
  const messages = toPiContext(context, gemini).messages
  expect(messages[0]).toMatchObject({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: expect.stringContaining('index.txt') }] })
  expect(messages[1]).toMatchObject({ role: 'user', content: [
    { type: 'text', text: 'Previous tool read (foreign) failed:' },
    { type: 'text', text: 'index.txt was missing' },
  ] })
  expect(messages[2]).toMatchObject(nativeCall)
  expect(messages[3]).toEqual(context.messages[3])
  expect(context).toEqual(snapshot)
})
