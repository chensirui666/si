import type { SubmitMessageAccepted } from '@agent-learning/server/protocol'
export type { ConversationMessage } from '@agent-learning/server/protocol'

export type LocalSubmission = {
  kind: 'message' | 'compaction'
  sessionId: string
  clientMessageId: string
  modelId: string
  text: string
  afterMessageId?: string
  state: 'pending' | 'failed' | 'unconfirmed'
  errorMessage?: string
  accepted?: SubmitMessageAccepted
}
