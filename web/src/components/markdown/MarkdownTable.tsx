import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Maximize2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../ui/dialog'
import { CopyMarkdownButton } from './CopyMarkdownButton'

export function MarkdownTable({ children, markdown }: { children: ReactNode; markdown: string }) {
  const { t } = useTranslation()
  const scroll = useRef<HTMLDivElement>(null)
  const table = useRef<HTMLTableElement>(null)
  const [overflow, setOverflow] = useState(false)
  useEffect(() => {
    const wrapper = scroll.current
    const content = table.current
    if (!wrapper || !content) return
    const measure = () => setOverflow(wrapper.scrollWidth > wrapper.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(wrapper)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return <Dialog>
    <div className="markdown-table">
      <div className="markdown-table-actions" data-copy-exclude>
        <CopyMarkdownButton label={t('markdown.copyTable')} markdown={markdown} getElements={() => table.current ? [table.current] : []} />
        {overflow && <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t('markdown.expandTable')} title={t('markdown.expandTable')}>
            <Maximize2Icon aria-hidden="true" />
          </Button>
        </DialogTrigger>}
      </div>
      <div className="markdown-table-scroll" ref={scroll} tabIndex={overflow ? 0 : undefined}
        role={overflow ? 'region' : undefined} aria-label={overflow ? t('markdown.scrollTable') : undefined}>
        <table ref={table}>{children}</table>
      </div>
    </div>
    <DialogContent className="markdown-table-preview" closeLabel={t('markdown.closeTablePreview')} aria-describedby={undefined}>
      <DialogTitle className="markdown-table-preview-title">{t('markdown.tablePreview')}</DialogTitle>
      <div className="markdown-table-scroll" role="region" aria-label={t('markdown.scrollTable')} tabIndex={0}>
        <table>{children}</table>
      </div>
    </DialogContent>
  </Dialog>
}
