import type OpenAI from 'openai'
import type { ContextEstimate, ModelContext, ModelMessage, ToolCall } from './types.js'

export function convertMessages(context: ModelContext, includeThinking = Boolean(context.tools?.length), repairTools = true): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  if (context.systemPrompt !== undefined) messages.push({ role: 'system', content: context.systemPrompt })
  let pending: ToolCall[] = []
  const received = new Set<string>()
  const heldSystems: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  const closeTools = () => {
    for (const call of pending) {
      if (repairTools && !received.has(call.id)) messages.push({ role: 'tool', tool_call_id: call.id, content: 'No result provided' })
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
      }
      if (includeThinking) {
        assistant.reasoning_content = message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('')
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


export function convertTools(tools: ModelContext['tools']) {
  return tools?.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: { ...tool.parameters } },
  })) ?? []
}

// shortcut: fixed character density can undercount Chinese and JSON; use reported input usage when available.
function estimateSerialized(value: unknown): number {
  return 4 + Math.ceil(JSON.stringify(value).length / 4)
}

export function estimateMessageTokens(message: ModelMessage, includeThinking: boolean): number {
  return convertMessages({ messages: [message] }, includeThinking, false)
    .reduce((tokens, visible) => tokens + estimateSerialized(visible), 0)
}

export function estimateContextTokens(context: ModelContext): ContextEstimate {
  const messages = convertMessages(context)
  let lastSystem = -1
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' && message.content !== '') lastSystem = index
  }
  let systemTokens = 0
  let messageTokens = 0
  for (const [index, message] of messages.entries()) {
    if (index === lastSystem) systemTokens += estimateSerialized(message)
    else messageTokens += estimateSerialized(message)
  }
  const tools = convertTools(context.tools)
  return { systemTokens, toolsTokens: tools.length ? estimateSerialized(tools) : 0, messageTokens }
}
