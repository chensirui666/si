import type { ConversationSnapshot, ConversationUpdate } from '@agent-learning/agent'

export type SubmitMessageRequest = { clientMessageId: string; modelId: string; text: string }
export type SubmitMessageAccepted = { clientMessageId: string; userMessageId: string; acceptedSeq: number }

export type ClientFrame =
  | { type: 'subscribe'; subscriptionId: string }
  | { type: 'unsubscribe'; subscriptionId: string }

export type ServerFrame =
  | { type: 'snapshot'; subscriptionId: string; snapshot: ConversationSnapshot }
  | { type: 'update'; subscriptionId: string; update: ConversationUpdate }
  | { type: 'models_changed' }

export type BrowserCookiePayload = {
  version: 1
  authority: string
  issuedAt: number
  expiresAt: number
}
