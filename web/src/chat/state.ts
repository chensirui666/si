import type { CompactionRecord, ConversationMessage, ConversationSnapshot, RunRecord, SaveFailure, ServerFrame } from '@agent-learning/server/protocol'
import type { AssistantMessage, ModelMessage } from '@agent-learning/model'
import type { LocalSubmission } from '../types'

export type ConnectionState = 'connecting' | 'awaitingSnapshot' | 'ready' | 'disconnected'
export type ChatState = {
  sessionId: string | null
  connection: ConnectionState
  snapshot: ConversationSnapshot | null
  slow: boolean
  error: string | null
}
export type Subscription = (() => void) & { requestSnapshot?: () => void; setSession: (sessionId: string | null) => void }
export type Subscribe = (onState: (state: ChatState) => void, onModelsChanged?: () => void, onWorkspacesChanged?: () => void, onWebSettingsChanged?: () => void, onSessionsChanged?: () => void) => Subscription
export const initialState: ChatState = { sessionId: null, connection: 'connecting', snapshot: null, slow: false, error: null }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const textContent = (value: unknown) => record(value) && value.type === 'text' && typeof value.text === 'string'
const toolPosition = (value: unknown) => record(value) && typeof value.assistantMessageId === 'string' && sequence(value.contentIndex)
const runningState = (value: unknown) => record(value) && typeof value.runId === 'string' && value.runId.length > 0 && (
  value.kind === 'compaction' ? value.phase === 'compaction'
  : value.kind === 'task' && typeof value.assistantMessageId === 'string'
    && ['model', 'tools', 'compaction'].includes(value.phase as string)
    && Array.isArray(value.activeTools) && value.activeTools.every(toolPosition)
    && (value.phase === 'tools' || value.activeTools.length === 0)
)
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0
const usage = (value: unknown) => record(value) && ['input', 'output', 'total'].every(key => value[key] === undefined || nonnegative(value[key]))
const contextUsage = (value: unknown) => value === null || record(value)
  && (value.tokens === undefined || nonnegative(value.tokens))
  && (value.contextWindow === undefined || nonnegative(value.contextWindow) && value.contextWindow > 0)
  && record(value.breakdown) && ['systemTokens', 'toolsTokens', 'messageTokens'].every(key => nonnegative((value.breakdown as Record<string, unknown>)[key]))
const filePath = (value: unknown) => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const fileOperations = (value: unknown) => record(value)
  && Array.isArray(value.readFiles) && value.readFiles.every(filePath)
  && Array.isArray(value.modifiedFiles) && value.modifiedFiles.every(filePath)
function fileOperation(value: unknown, message: ModelMessage): boolean {
  if (value === undefined) return true
  if (message.role !== 'toolResult' || !record(value) || !filePath(value.path)) return false
  return value.kind === 'read' ? message.toolName === 'read'
    : value.kind === 'modified' && (message.toolName === 'write' || message.toolName === 'edit')
}
function compactionRecord(value: unknown): value is CompactionRecord {
  if (!record(value) || typeof value.id !== 'string' || !value.id || !['manual', 'auto', 'overflow'].includes(value.trigger as string)
    || !finite(value.startedAt) || (value.clientMessageId !== undefined && typeof value.clientMessageId !== 'string')
    || (value.summaryUsage !== undefined && !usage(value.summaryUsage))
    || (value.fileOperations !== undefined && (value.status !== 'success' || !fileOperations(value.fileOperations)))) return false
  if (value.status === 'running') return true
  if (!finite(value.finishedAt)) return false
  if (['failed', 'aborted', 'skipped', 'interrupted'].includes(value.status as string)) return typeof value.reason === 'string'
  return value.status === 'success' && typeof value.summary === 'string' && !!value.summary.trim()
    && typeof value.firstKeptMessageId === 'string' && typeof value.contextLastMessageId === 'string'
    && nonnegative(value.estimatedBefore) && nonnegative(value.estimatedAfter) && value.estimatedAfter < value.estimatedBefore
    && (value.followupMessageId === undefined || typeof value.followupMessageId === 'string')
}

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
    && typeof value.model === 'string' && (value.errorMessage === undefined || typeof value.errorMessage === 'string') && ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted'].includes(value.stopReason as string)
    && (value.usage === undefined || usage(value.usage)) && (value.errorCode === undefined || value.errorCode === 'context_overflow')
    && Array.isArray(value.content) && value.content.every(block => record(block) && (
      textContent(block) || (block.type === 'thinking' && typeof block.thinking === 'string')
      || (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string' && record(block.arguments) && (block.argumentsError === undefined || typeof block.argumentsError === 'string'))
    ))
}

function conversationMessage(value: unknown): value is ConversationMessage {
  return record(value) && typeof value.id === 'string' && (value.clientMessageId === undefined || typeof value.clientMessageId === 'string') && modelMessage(value.message)
    && (value.message.role === 'toolResult' ? toolPosition(value.toolCall) : value.toolCall === undefined)
    && (value.toolErrorCode === undefined || (typeof value.toolErrorCode === 'string' && value.message.role === 'toolResult' && value.message.isError))
    && fileOperation(value.fileOperation, value.message)
}

function validRelations(messages: ConversationMessage[], running: ConversationSnapshot['running']): boolean {
  if (new Set(messages.map(entry => entry.id)).size !== messages.length) return false
  const results = new Set<string>()
  for (const [index, entry] of messages.entries()) {
    if (entry.message.role !== 'toolResult' || !entry.toolCall) continue
    const { assistantMessageId, contentIndex } = entry.toolCall
    const assistantIndex = messages.findIndex(item => item.id === assistantMessageId)
    const assistant = messages[assistantIndex]?.message
    const call = assistant?.role === 'assistant' ? assistant.content[contentIndex] : undefined
    const key = `${assistantMessageId}:${contentIndex}`
    if (assistantIndex >= index || call?.type !== 'toolCall' || call.id !== entry.message.toolCallId || call.name !== entry.message.toolName || results.has(key)) return false
    const previous = messages[index - 1]?.toolCall
    if (index > assistantIndex + 1 && (!previous || previous.assistantMessageId !== assistantMessageId || previous.contentIndex >= contentIndex)) return false
    results.add(key)
  }
  if (running?.kind === 'task') {
    const userIndex = messages.findIndex(entry => entry.id === running.runId)
    const assistantIndex = messages.findIndex(entry => entry.id === running.assistantMessageId)
    if (userIndex < 0 || messages[userIndex]?.message.role !== 'user' || messages.slice(userIndex + 1).some(entry => entry.message.role === 'user')) return false
    if (assistantIndex < 0) {
      if (running.phase !== 'model' && running.phase !== 'compaction') return false
    } else if (assistantIndex <= userIndex || messages[assistantIndex]?.message.role !== 'assistant') return false
  }
  const active = new Set<string>()
  for (const location of running?.kind === 'task' ? running.activeTools : []) {
    const assistant = messages.find(item => item.id === location.assistantMessageId)?.message
    const key = `${location.assistantMessageId}:${location.contentIndex}`
    if ((running?.kind !== 'task' || location.assistantMessageId !== running.assistantMessageId) || assistant?.role !== 'assistant' || assistant.content[location.contentIndex]?.type !== 'toolCall' || results.has(key) || active.has(key)) return false
    active.add(key)
  }
  return true
}

function runRecord(value: unknown): value is RunRecord {
  return record(value) && ['id', 'sessionId', 'clientMessageId', 'modelId'].every(key => typeof value[key] === 'string' && value[key] !== '')
    && (value.kind === 'task' || value.kind === 'compaction')
    && ['running', 'completed', 'failed', 'aborted', 'interrupted'].includes(value.status as string)
    && finite(value.startedAt) && (value.finishedAt === undefined || finite(value.finishedAt))
    && (value.restored === undefined || value.restored === true)
}

function saveFailure(value: unknown): value is SaveFailure {
  return record(value) && typeof value.runId === 'string' && value.runId.length > 0
    && ['tool-call', 'tool-result', 'answer', 'compaction', 'finish'].includes(value.stage as string)
    && ['storage-full', 'write-failed', 'unconfirmed'].includes(value.reason as string)
    && (value.toolCall === undefined || value.stage === 'tool-result' && toolPosition(value.toolCall))
}

function validSnapshot(value: unknown): value is ConversationSnapshot {
  return record(value) && sequence(value.seq) && Array.isArray(value.messages) && value.messages.every(conversationMessage)
    && (value.running === null || runningState(value.running)) && Array.isArray(value.activeContent)
    && value.activeContent.every(block => record(block) && typeof block.messageId === 'string' && sequence(block.contentIndex)
      && (block.type === 'text' || block.type === 'thinking' || (block.type === 'toolCall' && typeof block.argumentsText === 'string')))
    && Array.isArray(value.compactions) && value.compactions.every(compactionRecord)
    && new Set(value.compactions.map(item => item.id)).size === value.compactions.length
    && (value.runs === undefined || Array.isArray(value.runs) && value.runs.every(runRecord))
    && (value.saveFailures === undefined || Array.isArray(value.saveFailures) && value.saveFailures.every(saveFailure))
    && contextUsage(value.contextUsage)
    && (value.running === null || !record(value.running) || value.running.kind !== 'compaction' || value.compactions.some(item => item.id === (value.running as Record<string, unknown>).runId))
    && validRelations(value.messages as ConversationMessage[], value.running as ConversationSnapshot['running'])
}

export function applyFrame(state: ChatState, frame: unknown, subscriptionId: string): { state: ChatState; resubscribe: boolean } {
  const unchanged = { state, resubscribe: false }
  if (!state.sessionId || !record(frame) || frame.sessionId !== state.sessionId || frame.subscriptionId !== subscriptionId) return unchanged
  if (frame.type === 'subscription_error' && typeof frame.error === 'string') {
    return { state: { ...state, connection: 'ready', snapshot: null, slow: false, error: frame.error }, resubscribe: false }
  }
  if (frame.type === 'snapshot') {
    if (!validSnapshot(frame.snapshot) || frame.snapshot.runs?.some(run => run.sessionId !== state.sessionId)) return unchanged
    if (state.connection === 'ready' && state.snapshot && frame.snapshot.seq <= state.snapshot.seq) return unchanged
    const valid = frame as Extract<ServerFrame, { type: 'snapshot' }>
    return { state: { ...state, connection: 'ready', snapshot: valid.snapshot, slow: false, error: null }, resubscribe: false }
  }
  if (frame.type !== 'update' || state.connection !== 'ready' || !state.snapshot || !record(frame.update) || !sequence(frame.update.seq)) return unchanged
  if (frame.update.seq <= state.snapshot.seq) return unchanged
  if (frame.update.seq !== state.snapshot.seq + 1) return { state, resubscribe: true }
  if (frame.update.contextUsage !== undefined && !contextUsage(frame.update.contextUsage)) return { state, resubscribe: true }
  const { run, saveFailure: failure } = frame.update
  if (run !== undefined && (!runRecord(run) || run.sessionId !== state.sessionId)
    || failure !== undefined && (!saveFailure(failure) || failure.runId !== state.snapshot.running?.runId)) return { state, resubscribe: true }
  const metadata = {
    ...(run && { runs: [...(state.snapshot.runs ?? []).filter(item => item.id !== run.id), run] }),
    ...(failure && { saveFailures: [...state.snapshot.saveFailures ?? [], failure] }),
  }
  const capacity = frame.update.contextUsage === undefined ? state.snapshot.contextUsage : frame.update.contextUsage as ConversationSnapshot['contextUsage']
  const change = frame.update.change
  if (!record(change)) return { state, resubscribe: true }
  if (change.type === 'model') {
    const snapshot = applyModel(state.snapshot, change.messageId, change.event)
    return snapshot ? { state: { ...state, snapshot: { ...snapshot, ...metadata, seq: frame.update.seq, contextUsage: capacity } }, resubscribe: false } : { state, resubscribe: true }
  }
  const valid = frame as Extract<ServerFrame, { type: 'update' }>
  const update = valid.update.change
  if (update.type === 'accepted') {
    if (!conversationMessage(change.user) || change.user.message.role !== 'user' || !runningState(change.running) || !record(change.running) || change.running.kind !== 'task') return { state, resubscribe: true }
    const messages = [...state.snapshot.messages, update.user]
    if (!validRelations(messages, update.running)) return { state, resubscribe: true }
    return { state: { ...state, snapshot: {
      ...state.snapshot, ...metadata, seq: valid.update.seq, messages, running: update.running, contextUsage: capacity,
    } }, resubscribe: false }
  }
  if (update.type === 'compaction') {
    if (!compactionRecord(change.record) || !(change.running === null || runningState(change.running))) return { state, resubscribe: true }
    const compactions = state.snapshot.compactions.some(item => item.id === update.record.id)
      ? state.snapshot.compactions.map(item => item.id === update.record.id ? update.record : item)
      : [...state.snapshot.compactions, update.record]
    const snapshot = { ...state.snapshot, ...metadata, seq: valid.update.seq, compactions, running: update.running, contextUsage: capacity }
    if (!validSnapshot(snapshot)) return { state, resubscribe: true }
    return { state: { ...state, snapshot }, resubscribe: false }
  }
  if (update.type === 'task') {
    if (!(change.running === null || runningState(change.running))) return { state, resubscribe: true }
    const messages = [...state.snapshot.messages]
    if (change.message !== undefined || change.messageIndex !== undefined) {
      if (!conversationMessage(change.message) || change.message.message.role !== 'toolResult'
        || !sequence(change.messageIndex) || change.messageIndex > messages.length) return { state, resubscribe: true }
      messages.splice(change.messageIndex, 0, change.message)
    }
    if (!validRelations(messages, update.running)) return { state, resubscribe: true }
    return { state: { ...state, snapshot: {
      ...state.snapshot, ...metadata, seq: valid.update.seq, running: update.running, messages, contextUsage: capacity,
    } }, resubscribe: false }
  }
  return unchanged
}

function applyModel(snapshot: ConversationSnapshot, messageId: unknown, event: unknown): ConversationSnapshot | null {
  if (typeof messageId !== 'string' || !record(event)) return null
  const existing = snapshot.messages.find(item => item.id === messageId)
  let message: AssistantMessage
  let activeContent = snapshot.activeContent
  if (event.type === 'done' || event.type === 'error') {
    const final = event.type === 'done' ? event.message : event.error
    const reasons = event.type === 'done' ? ['stop', 'length', 'toolUse'] : ['error', 'aborted']
    if (!modelMessage(final) || final.role !== 'assistant' || !reasons.includes(event.reason as string) || final.stopReason !== event.reason) return null
    message = final
    activeContent = activeContent.filter(item => item.messageId !== messageId)
  } else if (event.type === 'start') {
    const initial = event.initial
    if (existing || !record(initial) || initial.role !== 'assistant' || !['api', 'provider', 'model'].every(key => typeof initial[key] === 'string') || !finite(initial.timestamp)) return null
    message = { ...(initial as AssistantMessage), content: [], stopReason: 'pending' }
  } else {
    if (!existing || existing.message.role !== 'assistant' || existing.message.stopReason !== 'pending' || !sequence(event.contentIndex)) return null
    const index = event.contentIndex
    message = { ...existing.message, content: [...existing.message.content] }
    const active = activeContent.find(item => item.messageId === messageId && item.contentIndex === index)
    if (['text_start', 'thinking_start', 'toolcall_start'].includes(event.type as string)) {
      if (index !== message.content.length || active) return null
      const type = event.type === 'text_start' ? 'text' : event.type === 'thinking_start' ? 'thinking' : 'toolCall'
      message.content.push(type === 'text' ? { type, text: '' } : type === 'thinking' ? { type, thinking: '' } : { type, id: '', name: '', arguments: {} })
      activeContent = [...activeContent, type === 'toolCall' ? { messageId, contentIndex: index, type, argumentsText: '' } : { messageId, contentIndex: index, type }]
    } else {
      const block = message.content[index]
      if (!block || !active) return null
      if (event.type === 'text_delta' && block.type === 'text' && typeof event.delta === 'string') message.content[index] = { ...block, text: block.text + event.delta }
      else if (event.type === 'thinking_delta' && block.type === 'thinking' && typeof event.delta === 'string') message.content[index] = { ...block, thinking: block.thinking + event.delta }
      else if (event.type === 'toolcall_delta' && active.type === 'toolCall' && typeof event.delta === 'string') activeContent = activeContent.map(item => item === active ? { ...active, argumentsText: active.argumentsText + event.delta } : item)
      else if (event.type === 'text_end' && block.type === 'text' && typeof event.content === 'string') message.content[index] = { ...block, text: event.content }
      else if (event.type === 'thinking_end' && block.type === 'thinking' && typeof event.content === 'string') message.content[index] = { ...block, thinking: event.content }
      else if (event.type === 'toolcall_end' && block.type === 'toolCall' && record(event.toolCall) && event.toolCall.type === 'toolCall' && typeof event.toolCall.id === 'string' && typeof event.toolCall.name === 'string' && record(event.toolCall.arguments) && (event.toolCall.argumentsError === undefined || typeof event.toolCall.argumentsError === 'string')) message.content[index] = event.toolCall as AssistantMessage['content'][number]
      else return null
      if (['text_end', 'thinking_end', 'toolcall_end'].includes(event.type as string)) activeContent = activeContent.filter(item => item !== active)
    }
  }
  const entry: ConversationMessage = { id: messageId, message }
  return { ...snapshot, messages: existing ? snapshot.messages.map(item => item.id === messageId ? entry : item) : [...snapshot.messages, entry], activeContent }
}

export function mergeSubmissions(messages: readonly ConversationMessage[], submissions: readonly LocalSubmission[], compactions: readonly CompactionRecord[] = []): (ConversationMessage | LocalSubmission)[] {
  const unresolved = submissions.filter(local => local.kind === 'compaction'
    ? !compactions.some(item => item.clientMessageId === local.clientMessageId || local.accepted?.kind === 'compaction' && item.id === local.accepted.compactionId)
    : !messages.some(item => item.message.role === 'user' && (item.clientMessageId === local.clientMessageId || local.accepted?.kind === 'message' && item.id === local.accepted.userMessageId)))
  const formalIds = new Set(messages.map(item => item.id))
  const anchored = new Map<string | undefined, LocalSubmission[]>()
  for (const local of unresolved) {
    const anchor = local.afterMessageId && formalIds.has(local.afterMessageId) ? local.afterMessageId : undefined
    const group = anchored.get(anchor) ?? []
    group.push(local)
    anchored.set(anchor, group)
  }
  return [...(anchored.get(undefined) ?? []), ...messages.flatMap(item => [item, ...(anchored.get(item.id) ?? [])])]

}

export function settleSubmission(submissions: readonly LocalSubmission[], clientMessageId: string, patch: Partial<LocalSubmission>): LocalSubmission[] {
  return submissions.map(item => item.clientMessageId !== clientMessageId || (item.accepted && !patch.accepted) ? item : { ...item, ...patch })
}
