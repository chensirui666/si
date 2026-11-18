import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import dropArt from './drop-art/file-drop.svg'
import unavailableArt from './drop-art/file-drop-unavailable.svg'
import './chat-file-drop.css'

export function ChatFileDrop({ onAddFiles, onDirectoryDrop }: {
  onAddFiles?: (files: File[]) => void
  onDirectoryDrop: () => void
}) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setDragging(false)
  }, [])

  useEffect(() => {
    if (!dragging) return
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      reset()
    }
    // External file drags can end outside the document. Normal pointer events resume after the drag.
    window.addEventListener('pointermove', reset)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointermove', reset)
      window.removeEventListener('keydown', escape, true)
    }
  }, [dragging, reset])

  useEffect(() => {
    function handle(event: DragEvent) {
      const data = event.dataTransfer
      if (!data?.types.includes('Files')) return
      event.preventDefault()
      switch (event.type) {
        case 'dragenter':
          depth.current++
          setDragging(true)
          break
        case 'dragover':
          data.dropEffect = onAddFiles ? 'copy' : 'none'
          break
        case 'dragleave':
          depth.current = Math.max(0, depth.current - 1)
          if (!depth.current || (event.target === document.body || event.target === document.documentElement)
            && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) reset()
          break
        case 'drop': {
          // A file over the editor belongs to the attachment draft, even if it also carries text.
          event.stopPropagation()
          reset()
          if (!onAddFiles) return
          const items = Array.from(data.items).filter(item => item.kind === 'file')
          const files: File[] = []
          let hasDirectory = false
          for (const item of items) {
            if (item.webkitGetAsEntry?.()?.isDirectory) {
              hasDirectory = true
            } else {
              const file = item.getAsFile()
              if (file) files.push(file)
            }
          }
          if (!items.length) files.push(...data.files)
          if (files.length) onAddFiles(files)
          if (hasDirectory) onDirectoryDrop()
          break
        }
      }
    }

    const events = ['dragenter', 'dragover', 'dragleave', 'drop'] as const
    for (const event of events) document.addEventListener(event, handle, true)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      for (const event of events) document.removeEventListener(event, handle, true)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [onAddFiles, onDirectoryDrop, reset])

  return dragging && createPortal(<div className="chat-file-drop" role="status">
    <div className="chat-file-drop-content">
      <img src={onAddFiles ? dropArt : unavailableArt} width={115} height={84} alt="" draggable={false} />
      <span className="chat-file-drop-title">{t(onAddFiles ? 'attachment.drop' : 'attachment.dropUnavailable')}</span>
      {onAddFiles && <span className="chat-file-drop-detail">{t('attachment.dropDetails')}</span>}
    </div>
  </div>, document.body)
}
