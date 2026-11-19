import { useCallback, useEffect, useRef, useState } from 'react'
import { errorNotice, type Notice } from '../i18n/messages'
import { uploadAttachment, type Attachment, type AttachmentScope } from './client'

const imageTypes = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']])
const textExtensions = new Set('txt md markdown csv tsv json jsonl ndjson log yaml yml toml ini cfg conf xml js jsx mjs cjs ts tsx mts cts py rb go rs java kt kts swift php c h cpp hpp cs lua dart vue svelte sql html htm css scss sass less sh bash zsh fish ps1'.split(' '))
const textNames = new Set(['.env', '.editorconfig', '.gitignore', 'dockerfile', 'makefile', 'gemfile', 'readme', 'license'])
const maxBytes = 50 * 1024 * 1024

type PendingAttachment = { key: string; file: File; preview: string; image: boolean }
export type AttachmentDraft = PendingAttachment & (
  | { status: 'uploading'; controller: AbortController }
  | { status: 'ready'; attachment: Attachment }
  | { status: 'failed'; error: Notice }
)

const emptyDraft: AttachmentDraft[] = []

export function useAttachmentDrafts() {
  const drafts = useRef(new Map<string, AttachmentDraft[]>())
  const [view, setView] = useState(() => new Map(drafts.current))

  const update = useCallback((key: string, next: AttachmentDraft[]) => {
    if (next.length) drafts.current.set(key, next)
    else drafts.current.delete(key)
    setView(new Map(drafts.current))
  }, [])

  const upload = useCallback((draftKey: string, scope: AttachmentScope, entry: PendingAttachment) => {
    const current = drafts.current.get(draftKey) ?? emptyDraft
    const previous = current.find(item => item.key === entry.key)
    if (previous?.status === 'uploading') previous.controller.abort()
    const controller = new AbortController()
    const uploading: AttachmentDraft = { key: entry.key, file: entry.file, preview: entry.preview, image: entry.image, status: 'uploading', controller }
    update(draftKey, previous ? current.map(item => item === previous ? uploading : item) : [...current, uploading])
    const settle = (next: AttachmentDraft) => {
      const items = drafts.current.get(draftKey)
      if (items?.includes(uploading)) update(draftKey, items.map(item => item === uploading ? next : item))
    }
    void uploadAttachment(scope, entry.file, controller.signal).then(
      attachment => settle({ ...entry, status: 'ready', attachment }),
      error => settle({ ...entry, status: 'failed', error: errorNotice('attachment.uploadFailed', error) }),
    )
  }, [update])

  const add = (draftKey: string, scope: AttachmentScope, files: File[]) => {
    let notice: Notice | undefined
    for (const file of files) {
      const name = file.name.toLowerCase()
      const extension = name.split('.').at(-1) ?? ''
      const mediaType = imageTypes.get(extension)
        ?? Array.from(imageTypes.values()).find(type => type === file.type)
      if (!mediaType && !textExtensions.has(extension) && !textNames.has(name)) {
        notice = { key: 'attachment.formats' }
        continue
      }
      if (file.size > maxBytes) {
        notice = { key: 'attachment.tooLarge' }
        continue
      }
      // A local preview of uploaded code must open as plain text at our origin.
      const preview = URL.createObjectURL(file.slice(0, file.size, mediaType ?? 'text/plain; charset=utf-8'))
      upload(draftKey, scope, { key: crypto.randomUUID(), file, preview, image: Boolean(mediaType) })
    }
    return notice
  }

  const remove = useCallback((draftKey: string, predicate: (item: AttachmentDraft) => boolean) => {
    const current = drafts.current.get(draftKey)
    if (!current) return
    const next = current.filter(item => {
      if (!predicate(item)) return true
      if (item.status === 'uploading') item.controller.abort()
      URL.revokeObjectURL(item.preview)
      return false
    })
    if (current.length !== next.length) update(draftKey, next)
  }, [update])

  const rebind = (from: string, to: string, scope: AttachmentScope) => {
    const current = drafts.current.get(from)
    if (!current?.length) return
    if (from !== to) {
      for (const entry of current) if (entry.status === 'uploading') entry.controller.abort()
      update(from, [])
    }
    for (const entry of current) upload(to, scope, entry)
  }

  useEffect(() => {
    const entries = drafts.current
    return () => {
      for (const items of entries.values()) {
        for (const item of items) {
          if (item.status === 'uploading') item.controller.abort()
          URL.revokeObjectURL(item.preview)
        }
      }
      entries.clear()
    }
  }, [])

  return {
    items: (key: string) => view.get(key) ?? emptyDraft,
    read: (key: string) => drafts.current.get(key) ?? emptyDraft,
    add, remove, rebind,
    retry: (draftKey: string, scope: AttachmentScope, id: string) => {
      const item = drafts.current.get(draftKey)?.find(item => item.key === id)
      if (item?.status === 'failed') upload(draftKey, scope, item)
    },
  }
}
