import { useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'

export function CopyMarkdownButton({ label, markdown, getElements }: {
  label: string
  markdown: string
  getElements: () => Iterable<Element>
}) {
  const { t } = useTranslation()
  const [feedback, setFeedback] = useState<{ markdown: string; copied: boolean }>()
  const result = feedback?.markdown === markdown ? feedback.copied : undefined

  async function copy() {
    try {
      const content = document.createElement('div')
      for (const element of getElements()) content.append(element.cloneNode(true))
      content.querySelectorAll('[data-copy-exclude]').forEach(element => element.remove())
      if (typeof ClipboardItem === 'function' && navigator.clipboard.write && content.innerHTML) {
        try {
          await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([markdown], { type: 'text/plain' }),
            'text/html': new Blob([content.innerHTML], { type: 'text/html' }),
          })])
        } catch {
          await navigator.clipboard.writeText(markdown)
        }
      } else await navigator.clipboard.writeText(markdown)
      setFeedback({ markdown, copied: true })
    } catch {
      setFeedback({ markdown, copied: false })
    }
  }

  const Icon = result === true ? CheckIcon : CopyIcon
  const title = result === true ? t('markdown.copied') : label
  return <span className="markdown-copy" data-copy-exclude>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={title} title={title} onClick={() => { void copy() }}>
      <Icon aria-hidden="true" />
    </Button>
    <span className={result === false ? 'configuration-error markdown-copy-feedback' : 'sr-only'} role="status">
      {result === true ? t('markdown.copied') : result === false ? t('markdown.copyContentFailed') : ''}
    </span>
  </span>
}
