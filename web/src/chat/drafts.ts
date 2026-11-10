import { useCallback, useRef, useState } from 'react'
import type { StartSessionRequest } from '@agent-learning/server/protocol'

export const recentSessionKey = 'agent-learning:recent-session'
export const recentWorkspaceKey = 'agent-learning:recent-workspace'
export const newSessionDraft = 'new-session'
const firstSendKey = 'agent-learning:first-send'

export function readFirstSend(): StartSessionRequest | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(firstSendKey) ?? 'null')
    if (value && typeof value.workspaceId === 'string' && typeof value.clientMessageId === 'string'
      && typeof value.modelId === 'string' && typeof value.text === 'string') return value
  } catch { /* Drafts still work within the page when storage is unavailable. */ }
}

export function writeFirstSend(input: StartSessionRequest | null) {
  try {
    if (input) sessionStorage.setItem(firstSendKey, JSON.stringify(input))
    else sessionStorage.removeItem(firstSendKey)
  } catch { /* The current page retains the request for retries. */ }
}
export const draftKey = (sessionId: string) => `agent-learning:draft:${sessionId}`

type Draft = { text: string; revision: number; lastStored?: string | null; unsaved?: boolean }

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
    const persisted = entry?.unsaved ? undefined : read(draftKey(sessionId))
    const text = (persisted === undefined ? entry?.text : persisted) ?? ''
    entries.current.set(sessionId, {
      text,
      revision: (entry?.revision ?? 0) + Number(!!entry && text !== entry.text),
      lastStored: persisted === undefined ? entry?.lastStored : persisted,
      unsaved: entry?.unsaved,
    })
    setDraft({ text })
  }, [read])

  const save = useCallback((sessionId: string, text: string) => {
    const previous = entries.current.get(sessionId)
    if (previous?.text === text) return
    const value = text || null
    const unsaved = !write(draftKey(sessionId), value)
    entries.current.set(sessionId, {
      text, revision: (previous?.revision ?? 0) + 1,
      lastStored: unsaved ? previous?.lastStored : value, unsaved,
    })
  }, [write])

  const restore = useCallback((sessionId: string, text: string, clearedRevision: number, visible: boolean) => {
    const entry = entries.current.get(sessionId)
    if (entry?.revision !== clearedRevision || entry.text) return
    const persisted = read(draftKey(sessionId))
    if (persisted && persisted !== entry.lastStored) return
    save(sessionId, text)
    if (visible) setDraft({ text })
  }, [read, save])

  const clearSent = useCallback((sessionId: string, text: string, revision: number) => {
    const entry = entries.current.get(sessionId)
    if (entry?.revision !== revision || entry.text !== text) return false
    const persisted = read(draftKey(sessionId))
    if (persisted && persisted !== entry.lastStored) return false
    save(sessionId, '')
    return true
  }, [read, save])
  const revision = useCallback((sessionId: string) => entries.current.get(sessionId)?.revision ?? 0, [])
  return { draft, storageUnavailable, load, save, restore, read, write, revision, clearSent }
}
