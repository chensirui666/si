import type { AssistantMessage, ModelMessage, ModelUsage, ContextEstimate, ModelSelection, ToolCall } from '@agent-learning/model'

import type { SkillInvocation } from './skills.js'
import type { PermissionMode } from './permissions.js'

type ToolLocation = {
  assistantMessageId: string
  contentIndex: number
}

export type ConversationMessage = {
  id: string
  clientMessageId?: string
  toolCall?: ToolLocation
  toolErrorCode?: string
  imageOmitted?: true
  skillInvocation?: SkillInvocation
  fileOperation?: { kind: 'read' | 'modified'; path: string }
  message: ModelMessage
}

export type SubmissionAccepted = { clientMessageId: string; acceptedSeq: number } & (
  | { kind: 'message'; userMessageId: string }
  | { kind: 'compaction'; compactionId: string }
)

export type RunningState = null | {
  kind: 'task'
  runId: string
  assistantMessageId: string
  phase: 'model' | 'tools' | 'compaction'
  activeTools: ToolLocation[]
} | { kind: 'compaction'; runId: string; phase: 'compaction' }

export type CompactionRecord = {
  id: string
  trigger: 'manual' | 'auto' | 'overflow'
  clientMessageId?: string
  startedAt: number
  summaryUsage?: ModelUsage
} & (
  | { status: 'running' }
  | { status: 'failed' | 'aborted' | 'skipped' | 'interrupted'; finishedAt: number; reason: string }
  | {
    status: 'success'; finishedAt: number; summary: string
    firstKeptMessageId: string; contextLastMessageId: string
    estimatedBefore: number; estimatedAfter: number
    fileOperations?: { readFiles: string[]; modifiedFiles: string[] }
    followupMessageId?: string
  }
)

export type ContextUsage = {
  tokens?: number
  contextWindow?: number
  breakdown: ContextEstimate
}

export type ConversationSnapshot = {
  seq: number
  permissionMode: PermissionMode
  messages: ConversationMessage[]
  running: RunningState
  modelSelection?: ModelSelection
  activeContent: ActiveContent[]
  compactions: CompactionRecord[]
  contextUsage: ContextUsage | null
  runs?: RunRecord[]
  saveFailures?: SaveFailure[]
}

export type ConversationUpdate = {
  seq: number
  contextUsage?: ContextUsage | null
  modelSelection?: ModelSelection
  run?: RunRecord
  saveFailure?: SaveFailure
  change:
    | { type: 'permission'; permissionMode: PermissionMode }
    | { type: 'selection'; selection: ModelSelection }
    | { type: 'accepted'; user: ConversationMessage; running: Extract<RunningState, { kind: 'task' }> }
    | { type: 'model'; messageId: string; event: ModelFrame }
    | { type: 'compaction'; record: CompactionRecord; running: RunningState }
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

export type SessionSubscriptionEvent =
  | { type: 'snapshot'; snapshot: ConversationSnapshot }
  | { type: 'update'; update: ConversationUpdate }

export type RunRecord = {
  id: string
  sessionId: string
  clientMessageId: string
  modelId: string
  provider?: string
  reasoningEffort?: ModelSelection['reasoningEffort']
  kind: 'task' | 'compaction'
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  startedAt: number
  finishedAt?: number
  restored?: true
}

export type SaveFailure = {
  runId: string
  stage: 'tool-call' | 'tool-result' | 'answer' | 'compaction' | 'finish'
  reason: 'storage-full' | 'write-failed' | 'unconfirmed'
  toolCall?: ToolLocation
}
