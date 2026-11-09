import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import * as modelApi from '../src/index.js'
import type { AssistantMessage, ModelContext } from '../src/index.js'

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
    if (result.role === 'toolResult') result.content[0].text = ''
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
})
