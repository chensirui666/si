import type { SubmitMessageAccepted } from '@agent-learning/server/protocol'
export type { ConversationMessage } from '@agent-learning/agent'

export type LocalSubmission = {
  clientMessageId: string
  modelId: string
  text: string
  afterMessageId?: string
  state: 'pending' | 'failed' | 'unconfirmed'
  errorMessage?: string
  accepted?: SubmitMessageAccepted
}
