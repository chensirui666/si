import { useId, useRef } from 'react'
import { LightbulbIcon, PaperclipIcon, PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'

export function ComposerAddMenu({ onAddFiles, onPlan }: {
  onAddFiles?: (files: File[]) => void
  onPlan?: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const popover = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  return <>
    <input type="file" multiple hidden ref={fileInput} onChange={event => {
      const files = Array.from(event.currentTarget.files ?? [])
      event.currentTarget.value = ''
      if (files.length) onAddFiles?.(files)
    }} />
    <Button type="button" variant="ghost" size="icon-sm" className="composer-add-trigger" popoverTarget={id}
      aria-label={t('chat.add')} title={t('chat.add')} aria-haspopup="menu" disabled={!onAddFiles && !onPlan}>
      <PlusIcon aria-hidden="true" />
    </Button>
    <div id={id} ref={popover} className="composer-add-menu" popover="auto" role="menu" aria-label={t('chat.add')}
      onToggle={event => {
        if (event.newState === 'open') event.currentTarget.querySelector<HTMLButtonElement>('button:enabled')?.focus()
      }}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.hidePopover()
      }}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1)
        items[(next + items.length) % items.length]?.focus()
      }}>
      <div className="model-picker-label">{t('chat.add')}</div>
      <Button type="button" role="menuitem" variant="ghost" size="sm" disabled={!onAddFiles}
        title={t('attachment.tooLarge')} onClick={() => {
          popover.current?.hidePopover()
          fileInput.current?.click()
        }}><PaperclipIcon aria-hidden="true" />{t('attachment.add')}</Button>
      <Button type="button" role="menuitem" variant="ghost" size="sm" disabled={!onPlan} onClick={() => {
        popover.current?.hidePopover()
        onPlan?.()
      }}><LightbulbIcon aria-hidden="true" />{t('plan.mode')}</Button>
    </div>
  </>
}
