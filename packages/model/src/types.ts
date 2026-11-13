import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { CredentialStatus } from '@agent-learning/credentials'
import type { TSchema } from 'typebox'

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
  providerThinkingLevel?: string
  stopReason: 'pending' | ModelStopReason
  errorMessage?: string
  errorCode?: 'context_overflow'
  usage?: ModelUsage
  timestamp: number
  durationMs?: number
}

export type ToolResultMessage = {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  imageResultId?: string
  content: (TextContent | ImageContent)[]
  isError: boolean
  timestamp: number
}

export type TextContent = {
  type: 'text'
  text: string
  textSignature?: string
}

export type ImageContent = {
  type: 'image'
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  data: string
}

export type ThinkingContent = {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}

export type ToolCall = {
  type: 'toolCall'
  id: string
  name: string
  arguments: JsonObject
  argumentsError?: string
  thoughtSignature?: string
  namespace?: string
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


export type ModelInfo = {
  id: string
  name: string
  provider: string
  api: string
  contextWindow: number
  maxTokens: number
  reasoningEfforts?: ReasoningEffort[]
  defaultReasoningEffort?: ReasoningEffort
}

export type ReasoningEffort = ModelThinkingLevel

export type ModelSelection = {
  provider: string
  modelId: string
  reasoningEffort?: ReasoningEffort
}

export type ModelStreamOptions = { signal?: AbortSignal; reasoningEffort?: ReasoningEffort }

export type ModelDiscovery = {
  models: ModelInfo[]
  providers: { id: string; name: string; status: CredentialStatus }[]
  defaultSelection?: ModelSelection
}

export type ContextEstimate = {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

export type ModelContext = {
  systemPrompt?: string
  messages: ModelMessage[]
  tools?: Tool[]
  omittedToolImageResults?: ReadonlySet<string>
}

export type Tool<TParameters extends TSchema = TSchema> = {
  name: string
  description: string
  parameters: TParameters
}

export type ModelEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: AssistantMessage }
  | { type: 'error'; reason: 'error' | 'aborted'; error: AssistantMessage }

export interface ModelEventStream extends AsyncIterable<ModelEvent> {
  result(): Promise<AssistantMessage>
}
