import type { ConversationSnapshot } from '@agent-learning/agent'
import type { ModelMessage } from '@agent-learning/model'
import type { ServerFrame } from '@agent-learning/server/protocol'

export type ConnectionState = 'connecting' | 'awaitingSnapshot' | 'ready' | 'disconnected'
export type ChatState = {
  connection: ConnectionState
  snapshot: ConversationSnapshot | null
  slow: boolean
  error: string | null
}
export type Subscribe = (onState: (state: ChatState) => void, onModelsChanged?: () => void) => () => void
export const initialState: ChatState = { connection: 'connecting', snapshot: null, slow: false, error: null }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const textContent = (value: unknown) => record(value) && value.type === 'text' && typeof value.text === 'string'
const runningState = (value: unknown) => record(value) && typeof value.userMessageId === 'string' && typeof value.assistantMessageId === 'string'

function modelMessage(value: unknown): value is ModelMessage {
  if (!record(value) || !finite(value.timestamp)) return false
  if (value.role === 'system' || value.role === 'user') {
    return typeof value.content === 'string' || (Array.isArray(value.content) && value.content.every(textContent))
  }
  if (value.role === 'toolResult') {
    return typeof value.toolCallId === 'string' && typeof value.toolName === 'string' && typeof value.isError === 'boolean'
      && Array.isArray(value.content) && value.content.every(textContent)
  }
  return value.role === 'assistant' && typeof value.api === 'string' && typeof value.provider === 'string'
    && typeof value.model === 'string' && ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted'].includes(value.stopReason as string)
    && Array.isArray(value.content) && value.content.every(block => record(block) && (
      textContent(block) || (block.type === 'thinking' && typeof block.thinking === 'string')
      || (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string' && record(block.arguments))
    ))
}

function conversationMessage(value: unknown) {
  return record(value) && typeof value.id === 'string' && (value.clientMessageId === undefined || typeof value.clientMessageId === 'string') && modelMessage(value.message)
}

function validSnapshot(value: unknown): value is ConversationSnapshot {
  return record(value) && sequence(value.seq) && Array.isArray(value.messages) && value.messages.every(conversationMessage)
    && (value.running === null || runningState(value.running)) && Array.isArray(value.activeContent)
    && value.activeContent.every(block => record(block) && typeof block.messageId === 'string' && sequence(block.contentIndex)
      && (block.type === 'text' || block.type === 'thinking' || (block.type === 'toolCall' && typeof block.argumentsText === 'string')))
}

export function applyFrame(state: ChatState, frame: unknown, subscriptionId: string): { state: ChatState; resubscribe: boolean } {
  const unchanged = { state, resubscribe: false }
  if (!record(frame) || frame.subscriptionId !== subscriptionId) return unchanged
  if (frame.type === 'snapshot') {
    if (!validSnapshot(frame.snapshot)) return unchanged
    if (state.connection === 'ready' && state.snapshot && frame.snapshot.seq <= state.snapshot.seq) return unchanged
    const valid = frame as Extract<ServerFrame, { type: 'snapshot' }>
    return { state: { connection: 'ready', snapshot: valid.snapshot, slow: false, error: null }, resubscribe: false }
  }
  if (frame.type !== 'update' || state.connection !== 'ready' || !state.snapshot || !record(frame.update) || !sequence(frame.update.seq)) return unchanged
  if (frame.update.seq <= state.snapshot.seq) return unchanged
  if (frame.update.seq !== state.snapshot.seq + 1) return { state, resubscribe: true }
  const change = frame.update.change
  if (!record(change)) return unchanged
  // shortcut: 阶段一不应用模型流式块，阶段三接入生成时改为逐块更新。
  if (change.type === 'model') return { state, resubscribe: true }
  if (change.type !== 'accepted' || !conversationMessage(change.user) || !record(change.user)
    || !record(change.user.message) || change.user.message.role !== 'user' || !runningState(change.running)) return unchanged
  const valid = frame as Extract<ServerFrame, { type: 'update' }>
  if (valid.update.change.type !== 'accepted') return unchanged
  return { state: { ...state, snapshot: {
    ...state.snapshot,
    seq: valid.update.seq,
    messages: [...state.snapshot.messages, valid.update.change.user],
    running: valid.update.change.running,
  } }, resubscribe: false }
}
