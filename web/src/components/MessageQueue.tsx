import { useState } from 'react'
import { ArrowUpIcon, CheckIcon, MessageSquareTextIcon, PencilIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { InteractionState, QueueAction } from '@agent-learning/server/protocol'
import { updateQueuedMessage } from '../chat/client'
import { errorNotice, NoticeText, type Notice } from '../i18n/messages'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import './conversation-interaction.css'

export function MessageQueue({ value, sessionId, disabled, canSteer, onSync }: {
  value: InteractionState['queue']
  sessionId: string
  disabled: boolean
  canSteer: boolean
  onSync(): void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<{ id: string; text: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Notice>()

  async function apply(id: string, action: QueueAction) {
    setBusy(true)
    setError(undefined)
    try {
      const result = await updateQueuedMessage(sessionId, id, action)
      if (result.status === 'unavailable') setError({ key: 'queue.unavailable' })
      if (action.action === 'edit' && result.status !== 'unavailable') setEditing(undefined)
    } catch (error) {
      setError(errorNotice('queue.updateFailed', error))
    } finally {
      setBusy(false)
      onSync()
    }
  }

  if (!value.items.length && !value.paused) return null
  return <section className="message-queue" aria-label={t('queue.label')}>
    {value.paused && <p className="interaction-note" role="status">{t('queue.paused')} · {value.paused}</p>}
    {value.items.length > 0 && <ul>
      {value.items.map(item => {
        const id = item.clientMessageId
        const attachments = item.attachments ?? []
        const text = [...attachments.map(attachment => attachment.mediaType.startsWith('image/') ? '[image]' : `[${attachment.name}]`), item.text].filter(Boolean).join(' ')
        const edit = editing?.id === id ? editing : undefined
        return <li key={id} data-queue-id={id}>
          <MessageSquareTextIcon className="queue-leading" aria-hidden="true" />
          {edit ? <Textarea aria-label={t('queue.edit')} autoFocus rows={1} value={edit.text} disabled={busy}
            onChange={event => setEditing({ id, text: event.target.value })}
            onKeyDown={event => { if (event.key === 'Escape') setEditing(undefined) }} /> : <span className="queue-text" title={text}>{text}</span>}
          <div className="queue-actions">
            {edit ? <>
              <Button type="button" variant="ghost" size="icon-sm" title={t('common.save')} aria-label={t('common.save')}
                disabled={disabled || busy || !edit.text.trim()} onClick={() => void apply(id, { action: 'edit', text: edit.text })}><CheckIcon /></Button>
              <Button type="button" variant="ghost" size="icon-sm" title={t('common.cancel')} aria-label={t('common.cancel')}
                disabled={busy} onClick={() => setEditing(undefined)}><XIcon /></Button>
            </> : <>
              <Button type="button" variant="ghost" size="icon-sm" title={t('queue.edit')} aria-label={t('queue.edit')}
                disabled={disabled || busy || attachments.length > 0} onClick={() => setEditing({ id, text: item.text })}><PencilIcon /></Button>
              <Button type="button" variant="ghost" size="icon-sm" title={t('queue.remove')} aria-label={t('queue.remove')}
                disabled={disabled || busy} onClick={() => void apply(id, { action: 'delete' })}><Trash2Icon /></Button>
              <Button type="button" variant="ghost" size="icon-sm" title={t('queue.steer')} aria-label={t('queue.steer')}
                disabled={disabled || busy || !canSteer} onClick={() => void apply(id, { action: 'steer' })}><ArrowUpIcon /></Button>
            </>}
          </div>
        </li>
      })}
    </ul>}
    {error && <p role="alert" className="configuration-error"><NoticeText notice={error} /></p>}
  </section>
}
