import type { AssistantMessage, JsonObject, ModelMessage, Tool, ToolCall } from '@agent-learning/model'

export type ExecutableTool = Tool & {
  executionMode?: 'parallel' | 'sequential'
  execute(arguments_: JsonObject, context: { cwd: string; signal: AbortSignal }): Promise<string>
}

type ToolLocation = {
  assistantMessageId: string
  contentIndex: number
}

export type ConversationMessage = {
  id: string
  clientMessageId?: string
  toolCall?: ToolLocation
  toolErrorCode?: string
  message: ModelMessage
}

export type RunningState = null | {
  userMessageId: string
  assistantMessageId: string
  phase: 'model' | 'tools'
  activeTools: ToolLocation[]
}

export type ConversationSnapshot = {
  seq: number
  messages: ConversationMessage[]
  running: RunningState
  activeContent: ActiveContent[]
}

export type ConversationUpdate = {
  seq: number
  change:
    | { type: 'accepted'; user: ConversationMessage; running: Exclude<RunningState, null> }
    | { type: 'model'; messageId: string; event: ModelFrame }
    | ({ type: 'task'; running: RunningState } & ({ message: ConversationMessage; messageIndex: number } | { message?: never; messageIndex?: never }))
}

export type ActiveContent = {
  messageId: string
  contentIndex: number
} & (
  | { type: 'text' | 'thinking' }
  | { type: 'toolCall'; argumentsText: string }
)

export type ModelFrame =
  | { type: 'start'; initial: Pick<AssistantMessage, 'role' | 'api' | 'provider' | 'model' | 'timestamp'> }
  | { type: 'text_start' | 'thinking_start' | 'toolcall_start'; contentIndex: number }
  | { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'text_end' | 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: AssistantMessage }
  | { type: 'error'; reason: 'error' | 'aborted'; error: AssistantMessage }

export type AgentSubscriptionEvent =
  | { type: 'snapshot'; snapshot: ConversationSnapshot }
  | { type: 'update'; update: ConversationUpdate }
