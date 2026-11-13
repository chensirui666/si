import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'

export function CodeBlock({ code, language }: { code: string; language?: string | null }) {
  const { t } = useTranslation()
  const [feedback, setFeedback] = useState<{ code: string; copied: boolean }>()
  const result = feedback?.code === code ? feedback.copied : undefined

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setFeedback({ code, copied: true })
    } catch {
      setFeedback({ code, copied: false })
    }
  }

  return <div className="markdown-code">
    <div className="markdown-code-header">
      <span>{language}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => { void copy() }}>
        {t(result === true ? 'markdown.copied' : 'markdown.copy')}
      </Button>
      <span className="sr-only" role="status">{result === true ? t('markdown.copied') : ''}</span>
    </div>
    {result === false && <div className="markdown-copy-error configuration-error" role="alert">{t('markdown.copyFailed')}</div>}
    <pre><code>{code}</code></pre>
  </div>
}
