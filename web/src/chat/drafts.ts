import { useCallback, useRef, useState } from 'react'
import { isPermissionMode, type PermissionMode, type StartSessionRequest, type SubmitMessageRequest } from '@agent-learning/server/protocol'

export const recentSessionKey = 'agent-learning:recent-session'
export const recentWorkspaceKey = 'agent-learning:recent-workspace'
export const newSessionDraft = 'new-session'
const draftPermissionKey = 'agent-learning:draft-permission'

export function readDraftPermission(): PermissionMode | null {
  try {
    const value = sessionStorage.getItem(draftPermissionKey)
    if (isPermissionMode(value)) return value
  } catch { /* In-memory state remains usable. */ }
  return null
}

export function writeDraftPermission(value: PermissionMode | null) {
  try {
    if (value) sessionStorage.setItem(draftPermissionKey, value)
    else sessionStorage.removeItem(draftPermissionKey)
  } catch { /* In-memory state remains usable. */ }
}

const extensionDraftKey = (workspaceId: string) => `agent-learning:extension-draft:${workspaceId}`

export function readExtensionDraft(workspaceId: string) {
  try { return sessionStorage.getItem(extensionDraftKey(workspaceId)) ?? undefined }
  catch { return undefined }
}

export function writeExtensionDraft(workspaceId: string, id?: string) {
  try {
    if (id) sessionStorage.setItem(extensionDraftKey(workspaceId), id)
    else sessionStorage.removeItem(extensionDraftKey(workspaceId))
  } catch { /* The current page retains the draft identifier. */ }
}

const firstSendKey = 'agent-learning:first-send'
type FirstSendSource = 'schedule'

export function readFirstSend(): (StartSessionRequest & { source?: FirstSendSource }) | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(firstSendKey) ?? 'null')
    if (value && typeof value.workspaceId === 'string' && typeof value.clientMessageId === 'string'
      && typeof value.modelId === 'string' && typeof value.text === 'string'
      && (value.draftSessionId === undefined || typeof value.draftSessionId === 'string')
      && (value.permissionMode === undefined || isPermissionMode(value.permissionMode))
      && (value.source === undefined || value.source === 'schedule')) return value
  } catch { /* Drafts still work within the page when storage is unavailable. */ }
}

export function writeFirstSend(input: StartSessionRequest | null, source?: FirstSendSource) {
  try {
    if (input) sessionStorage.setItem(firstSendKey, JSON.stringify({ ...input, source }))
    else sessionStorage.removeItem(firstSendKey)
  } catch { /* The current page retains the request for retries. */ }
}
type PlanDraft = { id: string; permissionMode: PermissionMode }
const planDraftKey = (workspaceId: string) => `agent-learning:plan-draft:${workspaceId}`

export function readPlanDraft(workspaceId: string): PlanDraft | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(planDraftKey(workspaceId)) ?? 'null')
    if (typeof value?.id === 'string' && isPermissionMode(value.permissionMode)) return value
  } catch { /* The active page still retains the created session. */ }
}

export function writePlanDraft(workspaceId: string, draft?: PlanDraft) {
  try {
    if (draft) sessionStorage.setItem(planDraftKey(workspaceId), JSON.stringify(draft))
    else sessionStorage.removeItem(planDraftKey(workspaceId))
  } catch { /* The active page still retains the created session. */ }
}

export type StoredSourceSend = { input: SubmitMessageRequest; text: string; edited?: true; afterMessageId?: string }
const sourceSendsKey = 'agent-learning:source-sends'

export function readSourceSends(): StoredSourceSend[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(sourceSendsKey) ?? 'null')
    if (Array.isArray(value)) return value.filter(item => {
      const input = item?.input
      return typeof item?.text === 'string' && typeof input?.sessionId === 'string'
        && typeof input.clientMessageId === 'string' && typeof input.modelId === 'string' && typeof input.text === 'string'
    })
  } catch { /* The active page retains requests if per-tab storage is unavailable. */ }
  return []
}

export function writeSourceSends(requests: Iterable<StoredSourceSend>) {
  try {
    const entries = Array.from(requests, ({ input, text, edited, afterMessageId }) => ({ input, text, edited, afterMessageId }))
    if (entries.length) sessionStorage.setItem(sourceSendsKey, JSON.stringify(entries))
    else sessionStorage.removeItem(sourceSendsKey)
  } catch { /* The active page retains requests if per-tab storage is unavailable. */ }
}

export const draftKey = (sessionId: string) => `agent-learning:draft:${sessionId}`

const tabDraftKey = (sessionId: string) => `agent-learning:tab-draft:${sessionId}`
type Draft = { text: string; revision: number; lastStored?: string | null; unsaved?: boolean; tabLocal?: boolean }

function readTabDraft(sessionId: string): string | null {
  try { return sessionStorage.getItem(tabDraftKey(sessionId)) }
  catch { return null }
}

export function useDrafts() {
  const entries = useRef(new Map<string, Draft>())
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [draft, setDraft] = useState({ text: '' })

  const read = useCallback((key: string) => {
    try { return localStorage.getItem(key) }
    catch { setStorageUnavailable(true); return undefined }
  }, [])

  const write = useCallback((key: string, text: string | null) => {
    try {
      if (text === null) localStorage.removeItem(key)
      else localStorage.setItem(key, text)
      return true
    } catch { setStorageUnavailable(true); return false }
  }, [])

  const load = useCallback((sessionId: string | null) => {
    if (!sessionId) { setDraft({ text: '' }); return }
    const entry = entries.current.get(sessionId)
    const tabDraft = entry?.tabLocal ? entry.text : readTabDraft(sessionId)
    const persisted = tabDraft !== null || entry?.unsaved ? undefined : read(draftKey(sessionId))
    const text = tabDraft ?? (persisted === undefined ? entry?.text : persisted) ?? ''
    entries.current.set(sessionId, {
      text,
      revision: (entry?.revision ?? 0) + Number(!!entry && text !== entry.text),
      lastStored: persisted === undefined ? entry?.lastStored : persisted,
      unsaved: entry?.unsaved, tabLocal: tabDraft !== null,
    })
    setDraft({ text })
  }, [read])

  const save = useCallback((sessionId: string, text: string) => {
    const previous = entries.current.get(sessionId)
    if (previous?.text === text) return
    const value = text || null
    if (previous?.tabLocal) {
      try { sessionStorage.setItem(tabDraftKey(sessionId), text) }
      catch { setStorageUnavailable(true) }
      entries.current.set(sessionId, { ...previous, text, revision: previous.revision + 1 })
      return
    }
    const unsaved = !write(draftKey(sessionId), value)
    entries.current.set(sessionId, {
      text, revision: (previous?.revision ?? 0) + 1,
      lastStored: unsaved ? previous?.lastStored : value, unsaved,
    })
  }, [write])

  const restore = useCallback((sessionId: string, text: string, clearedRevision: number, visible: boolean, keepInTab = false) => {
    const entry = entries.current.get(sessionId)
    if (entry?.revision !== clearedRevision || entry.text) return false
    const persisted = read(draftKey(sessionId))
    if (!entry.tabLocal && persisted && persisted !== entry.lastStored) {
      if (!keepInTab) return false
      entries.current.set(sessionId, { ...entry, tabLocal: true })
    }
    save(sessionId, text)
    if (visible) setDraft({ text })
    return true
  }, [read, save])

  const clearSent = useCallback((sessionId: string, text: string, revision: number) => {
    const entry = entries.current.get(sessionId)
    if (entry?.revision !== revision || entry.text !== text) return false
    const persisted = read(draftKey(sessionId))
    if (!entry.tabLocal && persisted && persisted !== entry.lastStored) return false
    save(sessionId, '')
    return true
  }, [read, save])
  const revision = useCallback((sessionId: string) => entries.current.get(sessionId)?.revision ?? 0, [])
  const currentText = useCallback((key: string) => entries.current.get(key)?.text ?? '', [])
  return { draft, currentText, storageUnavailable, load, save, restore, read, write, revision, clearSent }
}
