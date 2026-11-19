import { createHash } from 'node:crypto'
import type OpenAI from 'openai'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { piModels } from './catalog.js'
import type { Api, AssistantMessage as PiMessage, Context, Model } from '@earendil-works/pi-ai'
import type { ContextEstimate, ImageContent, ModelContext, ModelMessage, ModelInfo, ToolCall, UserMessage } from './types.js'
import { omittedRequestImages } from './request-images.js'

const emptyUsage: PiMessage['usage'] = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function userContent(content: UserMessage['content'], omitted = 0): UserMessage['content'] {
  if (typeof content === 'string' || omitted === 0) return content
  return content.map(block => {
    if (block.type !== 'image' || omitted === 0) return block
    omitted--
    return { type: 'text', text: '[图片因请求预算已省略。]' }
  })
}

function imagePart({ mimeType, data }: ImageContent): OpenAI.Chat.Completions.ChatCompletionContentPartImage {
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
}

export function toPiContext(context: ModelContext, target?: Model<Api>): Context {
  // Gemini 4 rejects foreign tool records without a native thought signature.
  const gemini4 = target?.api === 'google-generative-ai' && target.id.startsWith('gemini-4-')
  const foreignToolIds = new Set<string>()
  const omittedImages = omittedRequestImages(context)
  return {
    ...context,
    messages: context.messages.map((message, index) => {
      if (message.role === 'toolResult') {
        const content = omittedImages.toolResults.has(index) ? [
          ...message.content.filter(block => block.type === 'text'),
          { type: 'text' as const, text: '[图片因请求预算已省略。]' },
        ] : message.content
        if (gemini4 && foreignToolIds.delete(message.toolCallId)) {
          return {
            role: 'user', timestamp: message.timestamp,
            content: [
              { type: 'text', text: `Previous tool ${message.toolName} (${message.toolCallId}) ${message.isError ? 'failed' : 'returned'}:` },
              ...content,
            ],
          }
        }
        return { ...message, content }
      }
      if (message.role === 'user') {
        const { uploadMessageId: _uploadMessageId, ...user } = message
        return { ...user, content: userContent(user.content, omittedImages.userMessages.get(index)) }
      }
      if (message.role !== 'assistant') return message
      const { usage, ...history } = message
      if (gemini4 && (history.provider !== target.provider || history.model !== target.id)) {
        const calls = history.content.filter(block => block.type === 'toolCall')
        if (calls.length) {
          for (const call of calls) foreignToolIds.add(call.id)
          history.content = [
            ...history.content.filter(block => block.type === 'text'),
            ...calls.map(call => ({
              type: 'text' as const,
              text: `Previous tool call ${call.name} (${call.id}): ${JSON.stringify(call.arguments)}`,
            })),
          ]
          history.stopReason = 'stop'
        }
      }
      return {
        ...history, usage: {
          ...emptyUsage, input: usage?.input ?? 0, output: usage?.output ?? 0, totalTokens: usage?.total ?? 0,
        },
      }
    }),
  }
}

export function convertMessages(context: ModelContext, includeThinking = Boolean(context.tools?.length), repairTools = true, model?: ModelInfo): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  if (context.systemPrompt !== undefined) messages.push({ role: 'system', content: context.systemPrompt })
  let pending: ToolCall[] = []
  const received = new Set<string>()
  const wireIds = new Map<string, string>()
  const heldSystems: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  const omittedImages = omittedRequestImages(context)
  let attachments: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
  const closeTools = () => {
    for (const call of pending) {
      if (repairTools && !received.has(call.id)) messages.push({ role: 'tool', tool_call_id: wireIds.get(call.id) ?? call.id, content: 'No result provided' })
    }
    pending = []
    received.clear()
    wireIds.clear()
    // Attach images after every tool call in the batch has its paired result.
    if (attachments.length) messages.push({ role: 'user', content: attachments })
    attachments = []
    messages.push(...heldSystems)
    heldSystems.length = 0
  }
  for (const [index, message] of context.messages.entries()) {
    if (message.role === 'assistant' || message.role === 'user') closeTools()
    if (message.role === 'system') {
      const content = typeof message.content === 'string' ? message.content : message.content.map((block) => block.text).join('')
      if (pending.length) heldSystems.push({ role: 'system', content })
      else messages.push({ role: 'system', content })
    } else if (message.role === 'user') {
      const content = userContent(message.content, omittedImages.userMessages.get(index))
      messages.push({ role: 'user', content: typeof content === 'string' ? content
        : content.some(block => block.type === 'image')
          ? content.map(block => block.type === 'text' ? { type: 'text', text: block.text } : imagePart(block))
          : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') })
    } else if (message.role === 'toolResult') {
      received.add(message.toolCallId)
      const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      const omitted = omittedImages.toolResults.has(index)
      const attached = omitted ? [] : message.content.filter(block => block.type === 'image')
      const content = omitted ? `${text}\n[图片因请求预算已省略。]`.trimStart() : text
      messages.push({ role: 'tool', tool_call_id: wireIds.get(message.toolCallId) ?? message.toolCallId, content })
      if (attached.length) {
        attachments.push({ type: 'text', text: `工具 ${message.toolName}（${message.toolCallId}）返回的图片。${text}` })
        attachments.push(...attached.map(imagePart))
      }
    } else {
      const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      const tools = message.content.filter((block) => block.type === 'toolCall')
      pending = tools
      if (!text && !tools.length) continue
      const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
        role: 'assistant', content: text || null,
      }
      const sameModel = !model || message.provider === model.provider && message.model === model.id && message.api === model.api
      if (includeThinking) {
        assistant.reasoning_content = sameModel
          ? message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('') : ''
      }
      if (tools.length) {
        assistant.tool_calls = tools.map(tool => {
          const id = sameModel || /^[a-zA-Z0-9_-]{1,40}$/.test(tool.id)
            ? tool.id : 'call_' + createHash('sha256').update(tool.id).digest('hex').slice(0, 32)
          wireIds.set(tool.id, id)
          return { id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }
        })
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

function estimateVisibleMessage(message: OpenAI.Chat.Completions.ChatCompletionMessageParam): number {
  if (message.role !== 'user' || !Array.isArray(message.content)) return estimateSerialized(message)
  const text = message.content.filter(block => block.type === 'text')
  // DeepSeek Flash uses at most 1024 tokens per image based on its dimensions.
  return estimateSerialized({ ...message, content: text }) + (message.content.length - text.length) * 1024
}

function targetModel(model?: ModelInfo) {
  return model && !(model.provider === 'deepseek' && model.id === 'deepseek-flash')
    ? piModels.getModel(model.provider, model.id) : undefined
}

function estimatePiMessage(message: ReturnType<typeof toPiContext>['messages'][number]): number {
  if (message.role === 'toolResult' || message.role === 'user' && Array.isArray(message.content)) {
    const content = message.content
    if (typeof content !== 'string') {
      const text = content.filter(block => block.type !== 'image')
      return estimateSerialized({ ...message, content: text }) + (content.length - text.length) * 1024
    }
  }
  if (message.role !== 'assistant') return estimateSerialized(message)
  return estimateSerialized({ role: message.role, content: message.content })
}

export function estimateMessageTokens(message: ModelMessage, includeThinking: boolean, model?: ModelInfo): number {
  const target = targetModel(model)
  if (target) return transformMessages(toPiContext({ messages: [message] }, target).messages, target).reduce((sum, entry) => sum + estimatePiMessage(entry), 0)
  return convertMessages({ messages: [message] }, includeThinking && model?.defaultReasoningEffort !== 'off', false, model)
    .reduce((tokens, visible) => tokens + estimateVisibleMessage(visible), 0)
}

export function estimateContextTokens(context: ModelContext, model?: ModelInfo): ContextEstimate {
  const target = targetModel(model)
  if (target) {
    return {
      systemTokens: context.systemPrompt ? estimateSerialized(context.systemPrompt) : 0,
      toolsTokens: context.tools?.length ? estimateSerialized(context.tools) : 0,
      messageTokens: transformMessages(toPiContext(context, target).messages, target).reduce((sum, entry) => sum + estimatePiMessage(entry), 0),
    }
  }
  const messages = convertMessages(context, model?.defaultReasoningEffort !== 'off' && Boolean(context.tools?.length), true, model)
  let lastSystem = -1
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' && message.content !== '') lastSystem = index
  }
  let systemTokens = 0
  let messageTokens = 0
  for (const [index, message] of messages.entries()) {
    if (index === lastSystem) systemTokens += estimateSerialized(message)
    else messageTokens += estimateVisibleMessage(message)
  }
  const tools = convertTools(context.tools)
  return { systemTokens, toolsTokens: tools.length ? estimateSerialized(tools) : 0, messageTokens }
}
