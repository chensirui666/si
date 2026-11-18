import type { AssistantMessage, JsonObject, ModelMessage, ModelUsage, ModelFailureKind, ContextEstimate, ModelSelection, ToolCall } from '@agent-learning/model'

import type { ExtensionMessage } from './extensions/runtime.js'
import type { SkillInvocation } from './skills.js'
import type { PermissionMode } from './permissions.js'
import type { MessageAttachment } from './session-attachments.js'
import type { SessionReference } from './session-references.js'

export type SubmissionSources = { attachmentIds?: string[]; referenceSessionIds?: string[] }

export type SubmissionInput = Pick<ModelSelection, 'modelId'> & Partial<ModelSelection> & SubmissionSources
  & { clientMessageId: string; text: string; permissionMode?: PermissionMode }

export function sameSubmissionSources(before: SubmissionSources, after: SubmissionSources): boolean {
  return JSON.stringify(before.attachmentIds ?? []) === JSON.stringify(after.attachmentIds ?? [])
    && JSON.stringify([...new Set(before.referenceSessionIds)]) === JSON.stringify([...new Set(after.referenceSessionIds)])
}

type ToolLocation = {
  assistantMessageId: string
  contentIndex: number
  actualArguments?: JsonObject
}

export type ConversationMessage = {
  id: string
  clientMessageId?: string
  toolCall?: ToolLocation
  toolErrorCode?: string
  imageOmitted?: true
  skillInvocation?: SkillInvocation
  attachments?: MessageAttachment[]
  references?: SessionReference[]
  extension?: Omit<ExtensionMessage, 'content'>
  fileOperation?: { kind: 'read' | 'modified'; path: string }
  message: ModelMessage
}

export type SubmissionHandled = { kind: 'handled'; clientMessageId: string; notices: ExtensionNotice[] }
export type SubmissionAccepted = { clientMessageId: string; acceptedSeq: number } & (
  | { kind: 'message'; userMessageId: string }
  | { kind: 'compaction'; compactionId: string }
)

export type ModelRetryState = {
  phase: 'waiting' | 'retrying'
  retryAt?: number
  incomplete?: true
} & (
  | { mode: 'connection'; reason: 'connection' }
  | { mode: 'limited'; reason: ModelFailureKind; attempt: number; maxAttempts: 5; status?: number }
)

export type RunningState = null | {
  kind: 'task'
  runId: string
  assistantMessageId: string
  phase: 'model' | 'tools' | 'compaction'
  activeTools: ToolLocation[]
  retry?: ModelRetryState
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

export type PlanState = { state: 'planning' } | { state: 'review'; assistantMessageId: string; steps: string[] }

export type ConversationSnapshot = {
  seq: number
  permissionMode: PermissionMode
  plan?: PlanState | null
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
    | { type: 'notice'; notice: ExtensionNotice }
    | { type: 'permission'; permissionMode: PermissionMode }
    | { type: 'plan'; plan: PlanState | null }
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
  | { type: 'replace'; runId: string; message: AssistantMessage; activeContent: ActiveContent[] }
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

export type ExtensionNotice = { message: string; level: 'info' | 'warning' | 'error' }
