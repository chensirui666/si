import type { ModelSelection } from '@agent-learning/model'
import type {
  ConversationMessage as StoredMessage, ConversationSnapshot as StoredSnapshot, ConversationUpdate as StoredUpdate,
  PermissionMode, SessionSummary, SkillInvocation, SkillSummary, SubmissionAccepted, SubmissionHandled, SubmissionSources,
} from '@agent-learning/coding-agent'
import type { WorkspaceRegistration } from '../workspaces.js'

export type {
  ExtensionNotice, ActiveContent, CompactionRecord, ContextUsage, ModelFrame, ModelRetryState, PermissionMode, RunRecord, RunningState, SaveFailure,
  SessionSummary, SkillSource, SubmissionAccepted, MessageAttachment, PlanState,
} from '@agent-learning/coding-agent'
export { isPermissionMode } from '@agent-learning/coding-agent/permissions'
export type { WorkspaceView } from '../workspaces.js'
export type { WebSettingsView } from '../web-settings.js'

export type WorkspaceSkills = { skills: Omit<SkillSummary, 'path'>[]; complete: boolean }
export type SkillInvocationView = Pick<SkillInvocation, 'name' | 'source'> &
  ({ status: 'loaded' } | { status: 'failed'; reason: string })
export type ConversationMessage = Omit<StoredMessage, 'skillInvocation' | 'references'> & {
  skillInvocation?: SkillInvocationView
  references?: Pick<NonNullable<StoredMessage['references']>[number], 'sourceSessionId' | 'label'>[]
}
export type ConversationSnapshot = Omit<StoredSnapshot, 'messages'> & { messages: ConversationMessage[] }
type Change = StoredUpdate['change']
type Accepted = Extract<Change, { type: 'accepted' }>
export type ConversationUpdate = Omit<StoredUpdate, 'change'> & {
  change: Exclude<Change, { type: 'accepted' | 'task' }>
    | (Omit<Accepted, 'user'> & { user: ConversationMessage })
    | ({ type: 'task'; running: StoredSnapshot['running'] }
      & ({ message: ConversationMessage; messageIndex: number } | { message?: never; messageIndex?: never }))
}

export type WorkspacePick = { cancelled: true } | ({ cancelled: false } & WorkspaceRegistration)
export type CreateSessionRequest = { workspaceId: string; permissionMode?: PermissionMode }
export type SessionList = { sessions: SessionSummary[] }
export type SubmitMessageRequest = Pick<ModelSelection, 'modelId'> & Partial<ModelSelection> & SubmissionSources
  & { clientMessageId: string; text: string; sessionId: string }
export type SaveModelSelectionRequest = ModelSelection & { sessionId?: string }
export type SubmitMessageAccepted = SubmissionAccepted & { sessionId: string }
export type SubmitMessageResult = SubmitMessageAccepted | (SubmissionHandled & { sessionId: string })
export type StartSessionRequest = Omit<SubmitMessageRequest, 'sessionId'> & { workspaceId: string; permissionMode?: PermissionMode; draftSessionId?: string }
export type PermissionSettings = { defaultPermissionMode: PermissionMode }
export type SessionPermission = { permissionMode: PermissionMode }
export type StartSessionAccepted = { session: SessionSummary; accepted: SubmitMessageAccepted }
export type StartSessionResult = StartSessionAccepted | (SubmissionHandled & { draftSessionId: string })
export type AbortRequest = { sessionId: string; runId: string }
export type AbortResult = AbortRequest & { handled: boolean }
export type InterfaceLanguage = 'en' | 'zh-CN'
export type LanguageSettings = { language: InterfaceLanguage }

type SubscriptionTarget = { sessionId: string; subscriptionId: string }

export type ClientFrame =
  | ({ type: 'subscribe' } & SubscriptionTarget)
  | { type: 'unsubscribe'; subscriptionId: string }

export type ServerFrame =
  | ({ type: 'snapshot'; snapshot: ConversationSnapshot } & SubscriptionTarget)
  | ({ type: 'update'; update: ConversationUpdate } & SubscriptionTarget)
  | ({ type: 'subscription_error'; error: string } & SubscriptionTarget)
  | { type: 'models_changed' | 'workspaces_changed' | 'sessions_changed' | 'web_settings_changed' | 'permission_settings_changed' }

export type BrowserCookiePayload = {
  version: 1
  authority: string
  issuedAt: number
  expiresAt: number
}
