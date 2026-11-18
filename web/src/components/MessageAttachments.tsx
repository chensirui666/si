import { FileTextIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AttachmentDraft } from '../chat/attachment-drafts'
import { attachmentPath, type Attachment } from '../chat/client'
import { NoticeText } from '../i18n/messages'
import { Button } from './ui/button'

function PreviewLink({ url, name, image }: { url: string; name: string; image: boolean }) {
  return <a className={image ? 'attachment-preview' : 'attachment-file'} href={url} target="_blank" rel="noreferrer" title={name}>
    {image ? <img src={url} alt={name} /> : <><FileTextIcon aria-hidden="true" /><span>{name}</span></>}
  </a>
}

export function DraftAttachments({ items, remove, retry }: {
  items: readonly AttachmentDraft[]; remove: (id: string) => void; retry: (id: string) => void
}) {
  const { t } = useTranslation()
  if (!items.length) return null
  return <div className="attachment-list" role="group" aria-label={t('attachment.draft')}>
    {items.map(item => <div className="draft-attachment" key={item.key}>
      <PreviewLink url={item.preview} image={item.image} name={item.file.name} />
      {item.status === 'uploading' && <span role="status">{t('attachment.uploading')}</span>}
      {item.status === 'failed' && <>
        <span className="attachment-error" role="alert"><NoticeText notice={item.error} /></span>
        <Button variant="ghost" size="icon-sm" type="button" aria-label={t('attachment.retry', { name: item.file.name })} onClick={() => retry(item.key)}>
          <RotateCcwIcon aria-hidden="true" />
        </Button>
      </>}
      <Button variant="ghost" size="icon-sm" type="button" aria-label={t('attachment.remove', { name: item.file.name })} onClick={() => remove(item.key)}>
        <XIcon aria-hidden="true" />
      </Button>
    </div>)}
  </div>
}

export function SentAttachments({ attachments }: { attachments: readonly Attachment[] }) {
  const { t } = useTranslation()
  if (!attachments.length) return null
  return <div className="attachment-list" role="group" aria-label={t('attachment.sent')}>
    {attachments.map(attachment => <PreviewLink key={attachment.id} url={attachmentPath(attachment.id)}
      name={attachment.name} image={attachment.mediaType.startsWith('image/')} />)}
  </div>
}
