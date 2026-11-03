export type ModelMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage

export type SystemMessage = {
  role: 'system'
  content: string | TextContent[]
  timestamp: number
}

export type UserMessage = {
  role: 'user'
  content: string | TextContent[]
  timestamp: number
}

export type AssistantMessage = {
  role: 'assistant'
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: string
  provider: string
  model: string
  responseId?: string
  responseModel?: string
  stopReason: 'pending' | ModelStopReason
  errorMessage?: string
  usage?: ModelUsage
  timestamp: number
  durationMs?: number
}

export type ToolResultMessage = {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: TextContent[]
  isError: boolean
  timestamp: number
}

export type TextContent = {
  type: 'text'
  text: string
}

export type ThinkingContent = {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
}

export type ToolCall = {
  type: 'toolCall'
  id: string
  name: string
  arguments: JsonObject
  argumentsError?: string
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export type JsonObject = {
  [key: string]: JsonValue
}

export type ModelUsage = {
  input?: number
  output?: number
  total?: number
}

export type ModelStopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
