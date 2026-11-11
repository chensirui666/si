import type { AssistantMessage, JsonObject, ModelContext, ModelEvent, ModelInfo, Tool, ToolResultMessage } from '@agent-learning/model'

export type ExecutableTool = Tool & {
  executionMode?: 'parallel' | 'sequential'
  execute(arguments_: JsonObject, context: { signal: AbortSignal; recordDetails(details: unknown): void }): Promise<string>
}

export type AgentRunInput = {
  model: ModelInfo
  context: ModelContext
  tools?: ExecutableTool[]
  signal: AbortSignal
  saveToolCheckpoint?(checkpoint:
    | { type: 'assistant'; message: AssistantMessage }
    | (Extract<AgentEvent, { type: 'tool_result' }> & { executed: boolean })
  ): void | Promise<void>
  prepareContext?(context: ModelContext): ModelContext | { error: string } | Promise<ModelContext | { error: string }>
}

export type AgentEvent =
  | { type: 'model'; event: ModelEvent; context: ModelContext }
  | { type: 'tool_start'; contentIndex: number }
  | { type: 'tool_result'; contentIndex: number; result: ToolResultMessage; details: unknown[]; errorCode?: string }

export type AgentResult =
  | { type: 'response'; message: AssistantMessage }
  | { type: 'failure'; reason: 'error' | 'aborted'; message: string; afterReply: boolean }
