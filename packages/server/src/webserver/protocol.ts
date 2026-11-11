import type { ConversationSnapshot, ConversationUpdate, SessionSummary, SubmissionAccepted } from '@agent-learning/coding-agent'
import type { WorkspaceRegistration } from '../workspaces.js'

export type {
  ActiveContent, CompactionRecord, ContextUsage, ConversationMessage, ConversationSnapshot,
  ConversationUpdate, ModelFrame, RunRecord, RunningState, SaveFailure, SessionSummary, SubmissionAccepted,
} from '@agent-learning/coding-agent'
export type { WorkspaceView } from '../workspaces.js'
export type { WebSettingsView } from '../web-settings.js'

export type WorkspacePick = { cancelled: true } | ({ cancelled: false } & WorkspaceRegistration)
export type CreateSessionRequest = { workspaceId: string }
export type SessionList = { sessions: SessionSummary[] }
export type SubmitMessageRequest = { clientMessageId: string; modelId: string; text: string; sessionId: string }
export type SubmitMessageAccepted = SubmissionAccepted & { sessionId: string }
export type StartSessionRequest = Omit<SubmitMessageRequest, 'sessionId'> & { workspaceId: string }
export type StartSessionAccepted = { session: SessionSummary; accepted: SubmitMessageAccepted }
export type AbortRequest = { sessionId: string; runId: string }
export type AbortResult = AbortRequest & { handled: boolean }

type SubscriptionTarget = { sessionId: string; subscriptionId: string }

export type ClientFrame =
  | ({ type: 'subscribe' } & SubscriptionTarget)
  | { type: 'unsubscribe'; subscriptionId: string }

export type ServerFrame =
  | ({ type: 'snapshot'; snapshot: ConversationSnapshot } & SubscriptionTarget)
  | ({ type: 'update'; update: ConversationUpdate } & SubscriptionTarget)
  | ({ type: 'subscription_error'; error: string } & SubscriptionTarget)
  | { type: 'models_changed' | 'workspaces_changed' | 'sessions_changed' | 'web_settings_changed' }

export type BrowserCookiePayload = {
  version: 1
  authority: string
  issuedAt: number
  expiresAt: number
}
