import type { AssistantMessage, JsonObject, ModelContext, ModelEvent, ModelInfo, ModelMessage, ModelStreamOptions, ReasoningEffort, Tool, ToolCall, ToolResultMessage } from '@agent-learning/model'

export type ExecutableTool = Tool & {
  executionMode?: 'parallel' | 'sequential'
  nestedExecution?: true
  validateArguments?(arguments_: JsonObject): boolean
  execute(arguments_: JsonObject, context: ToolExecutionContext):
    Promise<string | ToolResultMessage['content'] | (Pick<ToolResultMessage, 'content' | 'isError'> & { errorCode?: string })>
}

export type ToolExecutionContext = {
  signal: AbortSignal
  toolCallId: string
  contentIndex: number
  nestedToolCallId?: string
  recordDetails(details: unknown): void
  nestedTools?(): readonly ExecutableTool[]
  executeTool?(name: string, args: unknown, signal: AbortSignal): Promise<NestedToolOutcome>
}

export type NestedToolOutcome = {
  result: ToolResultMessage
  details: unknown[]
  executed: boolean
  errorCode?: string
  actualArguments?: JsonObject
  rewritten: boolean
}

export type NestedToolCheckpoint = {
  contentIndex: number
  id: string
  name: string
  arguments: JsonObject
} & (
  | { status: 'running' }
  | { status: 'succeeded' | 'failed' | 'not-executed' | 'stopped'; outcome: NestedToolOutcome }
)

export type AgentObservations = {
  agent_start: Record<never, never>
  agent_end: { messages: ModelMessage[] }
  turn_start: { turnIndex: number; timestamp: number }
  message_start: { message: ModelMessage }
  message_update: { message: AssistantMessage; assistantMessageEvent: ModelEvent }
  tool_execution_start: { toolCallId: string; toolName: string; args: JsonObject }
  tool_execution_end: { toolCallId: string; toolName: string; result: ToolResultMessage; isError: boolean }
}

export type AgentRunInput = {
  model: ModelInfo
  reasoningEffort?: ReasoningEffort
  context: ModelContext
  tools?: ExecutableTool[]
  signal: AbortSignal
  saveToolCheckpoint?(checkpoint:
    | { type: 'assistant'; message: AssistantMessage }
    | (Extract<AgentEvent, { type: 'tool_result' }> & { executed: boolean })
  ): void | Promise<void>
  resolveNestedTools?(): readonly ExecutableTool[]
  saveNestedToolCheckpoint?(checkpoint: NestedToolCheckpoint): void | Promise<void>
  afterStep?(reply: AssistantMessage, hasTools: boolean): boolean | Promise<boolean>
  beforeToolCall?(call: ToolCall, tool?: ExecutableTool, nested?: boolean): { code: string; message: string } | undefined
  prepareToolCall?(call: ToolCall, tool: ExecutableTool, nested?: boolean, signal?: AbortSignal): Promise<{ arguments: JsonObject; denial?: string }>
  rewriteToolResult?(call: ToolCall, result: ToolResultMessage, tool?: ExecutableTool, signal?: AbortSignal): Promise<ToolResultMessage>
  observe?<K extends keyof AgentObservations>(type: K, event: AgentObservations[K]): void | Promise<void>
  userMessage?: ModelMessage
  streamOptions?(): Pick<ModelStreamOptions, 'onProviderStreamEvent' | 'onProviderResponse' | 'snapshotPartials'> | undefined
  resolveTools?(): ExecutableTool[]
  finalizeContext?(context: ModelContext): ModelContext | { error: string } | Promise<ModelContext | { error: string }>
  prepareContext?(context: ModelContext): ModelContext | { error: string } | Promise<ModelContext | { error: string }>
}

export type AgentEvent =
  | { type: 'model'; event: ModelEvent; context: ModelContext }
  | { type: 'tool_start'; contentIndex: number; actualArguments?: JsonObject }
  | { type: 'tool_result'; contentIndex: number; result: ToolResultMessage; details: unknown[]; errorCode?: string; actualArguments?: JsonObject }

export type AgentResult =
  | { type: 'response'; message: AssistantMessage }
  | { type: 'failure'; reason: 'error' | 'aborted'; message: string; afterReply: boolean }
