import type { SubmitMessageRequest, SubmitMessageResult, MessageAttachment } from '@agent-learning/server/protocol'
import type { Notice } from './i18n/messages'
export type { ConversationMessage } from '@agent-learning/server/protocol'

export type LocalSubmission = {
  kind: 'message' | 'compaction'
  sessionId: string
  clientMessageId: string
  modelId: string
  text: string
  afterMessageId?: string
  mode?: SubmitMessageRequest['mode']
  deferred?: boolean
  attachments?: MessageAttachment[]
  attachmentPreviews?: ReadonlyMap<string, string>
  state: 'pending' | 'failed' | 'unconfirmed'
  errorMessage?: Notice
  accepted?: Exclude<SubmitMessageResult, { kind: 'handled' }>
}
