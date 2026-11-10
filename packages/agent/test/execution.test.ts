import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { findModel, type AssistantMessage, type ModelContext, type ModelEventStream } from '@agent-learning/model'
import { Agent } from '../src/index.js'
import type { AgentEvent, ExecutableTool } from '../src/index.js'

const model = findModel('deepseek-flash')!
const context: ModelContext = {
  systemPrompt: 'Use the supplied tools.',
  messages: [{ role: 'user', timestamp: 0, content: 'What is two plus three?' }],
}
const reply = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1, content, stopReason,
})
function output(message: AssistantMessage): ModelEventStream {
  return {
    result: async () => message,
    async *[Symbol.asyncIterator]() {
      if (message.stopReason === 'error') yield { type: 'error', reason: 'error', error: message }
      else yield { type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }
    },
  }
}

describe('generic Agent', () => {
  it('runs a tool, feeds the result back and publishes the associated details', async () => {
    const requests: ModelContext[] = []
    const events: AgentEvent[] = []
    const calls: string[] = []
    const tool: ExecutableTool = {
      name: 'add_numbers', description: 'Add two numbers.',
      parameters: Type.Object({ left: Type.Number(), right: Type.Number() }),
      async execute({ left, right }, { recordDetails }) {
        calls.push('sum')
        recordDetails({ calculation: `${left}+${right}` })
        return String(Number(left) + Number(right))
      },
    }
    const agent = new Agent({ stream: (_model, input) => {
      requests.push(input)
      return output(requests.length === 1
        ? reply([{ type: 'toolCall', id: 'sum', name: tool.name, arguments: { left: 2, right: 3 } }], 'toolUse')
        : reply([{ type: 'text', text: '5' }]))
    } })
    const unsubscribe = agent.subscribe(event => events.push(event))
    const result = await agent.run({ model, context, tools: [tool], signal: new AbortController().signal })
    unsubscribe()

    expect(calls).toEqual(['sum'])
    expect(requests[0]).toMatchObject({ systemPrompt: context.systemPrompt, tools: [{ name: tool.name }] })
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'sum', content: [{ text: '5' }] })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result', contentIndex: 0, result: expect.objectContaining({ toolCallId: 'sum' }),
      details: [{ calculation: '2+3' }],
    }))
    expect(result).toMatchObject({ type: 'response', message: { stopReason: 'stop', content: [{ text: '5' }] } })
  })

  it('hands an overflow response to the caller without retrying', async () => {
    let calls = 0
    const overflow: AssistantMessage = { ...reply([], 'error'), errorCode: 'context_overflow' }
    const agent = new Agent({ stream: () => { calls++; return output(overflow) } })
    expect(await agent.run({ model, context, signal: new AbortController().signal })).toEqual({ type: 'response', message: overflow })
    expect(calls).toBe(1)
  })
})
