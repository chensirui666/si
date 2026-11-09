import type { ConversationSnapshot, ConversationUpdate, SubmissionAccepted } from '@agent-learning/agent'

export type { WorkspaceView } from '../workspaces.js'
export type { WebSettingsView } from '../web-settings.js'

export type SubmitMessageRequest = { clientMessageId: string; modelId: string; text: string; workspaceId: string }
export type SubmitMessageAccepted = SubmissionAccepted
export type AbortRequest = { runId: string }
export type AbortResult = { runId: string; handled: boolean }

export type ClientFrame =
  | { type: 'subscribe'; subscriptionId: string }
  | { type: 'unsubscribe'; subscriptionId: string }

export type ServerFrame =
  | { type: 'snapshot'; subscriptionId: string; snapshot: ConversationSnapshot }
  | { type: 'update'; subscriptionId: string; update: ConversationUpdate }
  | { type: 'models_changed' | 'workspaces_changed' | 'web_settings_changed' }

export type BrowserCookiePayload = {
  version: 1
  authority: string
  issuedAt: number
  expiresAt: number
}
