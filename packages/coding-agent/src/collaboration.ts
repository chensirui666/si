import type { MessageAttachment } from './session-attachments.js'
import type { SubmissionAccepted, SubmissionHandled, SubmissionInput } from './types.js'

export type PendingMessage = {
  clientMessageId: string
  text: string
  attachments?: MessageAttachment[]
}

export type PendingSubmission = {
  input: SubmissionInput
  text: string
  status: 'queued' | 'steering' | 'deleted' | 'started' | 'delivered'
  acceptedSeq: number
  steeringSeq?: number
  attachments?: MessageAttachment[]
  receipt?: SubmissionAccepted | SubmissionHandled
}

export type SubmissionPending = { clientMessageId: string; acceptedSeq: number } &
  ({ kind: 'queued' } | { kind: 'steering' })

export type QueueAction = { action: 'edit'; text: string } | { action: 'steer' | 'delete' }
export type QueueResult = { status: PendingSubmission['status'] | 'missing' | 'unavailable' }

export type UserQuestion = {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multi_select?: boolean
}

export type QuestionAnswer = { id: string; selected: string[]; custom?: string }
export type QuestionWaitSettings = { timeout: 120 | -1 }
export type QuestionReply = { kind: 'answered' | 'late' | 'closed'; replyId: string }

export type UserQuestionBatch = {
  id: string
  runId: string
  assistantMessageId: string
  toolCallId: string
  questions: UserQuestion[]
  status: 'waiting' | 'answered' | 'timed-out' | 'closed' | 'aborted'
  deadlineAt?: number
  answers?: QuestionAnswer[]
  replyId?: string
  replyKind?: QuestionReply['kind']
}

export type InteractionState = {
  queue: { items: PendingMessage[]; paused: string | null }
  steering: PendingMessage[]
  questions: UserQuestionBatch[]
}
