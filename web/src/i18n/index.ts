import { useSyncExternalStore } from 'react'
import type { InterfaceLanguage } from '@agent-learning/server/protocol'
import { getLanguage, saveLanguage } from '../chat/client'
import { i18n } from './copy'
import { RequestError } from './messages'

type Status = 'idle' | 'loading' | 'saving' | 'readFailed' | 'saveFailed' | 'unconfirmed'
const listeners = new Set<() => void>()
let state: { language: InterfaceLanguage; status: Status; detail?: string } = { language: 'en', status: 'idle' }
let confirmed: InterfaceLanguage | undefined

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot() { return state }

export function useLanguage() {
  return useSyncExternalStore(subscribe, getSnapshot)
}

function update(language: InterfaceLanguage, status: Status, error?: unknown) {
  state = { language, status, detail: error instanceof RequestError ? error.notice.detail : undefined }
  if (language !== i18n.language) void i18n.changeLanguage(language)
  document.documentElement.lang = language
  document.title = i18n.t('app.title')
  for (const listener of listeners) listener()
}

const busy = () => state.status === 'loading' || state.status === 'saving'

export async function loadLanguage() {
  if (busy()) return
  update(state.language, 'loading')
  try {
    confirmed = await getLanguage()
    update(confirmed, 'idle')
  } catch (error) {
    update(state.language, 'readFailed', error)
  }
}

export async function selectLanguage(language: InterfaceLanguage) {
  if (busy() || language === state.language && state.status === 'idle') return
  update(language, 'saving')
  try {
    await saveLanguage(language)
    confirmed = language
    update(language, 'idle')
  } catch (error) {
    const status = error instanceof RequestError ? error.notice.status : undefined
    if (status !== undefined && [400, 401, 403, 413, 415].includes(status)) {
      update(confirmed ?? 'en', 'saveFailed', error)
      return
    }
    try {
      confirmed = await getLanguage()
      if (confirmed === language) update(confirmed, 'idle')
      else update(confirmed, 'unconfirmed', error)
    } catch (readError) {
      update(confirmed ?? 'en', 'unconfirmed', error instanceof RequestError ? error : readError)
    }
  }
}
