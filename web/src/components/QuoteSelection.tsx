import { useEffect, useState, type RefObject } from 'react'
import { QuoteIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'

export function QuoteSelection({ list, onQuote }: {
  list: RefObject<HTMLElement | null>
  onQuote: (text: string) => void
}) {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)

  useEffect(() => {
    const root = list.current
    if (!root) return
    const scroll = root.closest('.chat-main') ?? root
    const composer = scroll.querySelector('.composer-stack')
    function update() {
      const selected = window.getSelection()
      if (!selected || selected.isCollapsed || !selected.rangeCount) return setSelection(null)
      const range = selected.getRangeAt(0)
      const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
      const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
      const reply = start?.closest('[data-response-text]')
      const text = selected.toString()
      if (!root?.contains(reply ?? null) || reply !== end?.closest('[data-response-text]')
        || start?.closest('[data-copy-exclude]') || end?.closest('[data-copy-exclude]')
        || !text.trim()) return setSelection(null)
      const bounds = scroll.getBoundingClientRect()
      const bottom = Math.min(bounds.bottom, composer?.getBoundingClientRect().top ?? bounds.bottom)
      const visible = [...range.getClientRects()].find(rect => rect.width > 0 && rect.right > bounds.left && rect.left < bounds.right
        && rect.bottom > bounds.top && rect.top < bottom)
      if (!visible) return setSelection(null)
      const center = (Math.max(visible.left, bounds.left) + Math.min(visible.right, bounds.right)) / 2
      setSelection({
        text,
        x: Math.max(84, Math.min(innerWidth - 84, center)),
        y: visible.top - bounds.top >= 52 ? visible.top - 50 : visible.bottom + 4,
      })
    }
    document.addEventListener('selectionchange', update)
    document.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [list])

  if (!selection) return null
  return <div className="quote-selection" style={{ left: selection.x, top: selection.y }} data-copy-exclude>
    <Button type="button" variant="ghost" size="sm"
      onPointerDown={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        window.getSelection()?.removeAllRanges()
        list.current?.focus({ preventScroll: true })
      }}
      onClick={() => {
        window.getSelection()?.removeAllRanges()
        setSelection(null)
        onQuote(selection.text)
      }}>
      <QuoteIcon aria-hidden="true" />{t('chat.quoteSelection')}
    </Button>
  </div>
}
