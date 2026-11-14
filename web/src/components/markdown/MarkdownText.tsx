import { useTranslation } from 'react-i18next'
import { memo, useId, useMemo, useRef, type ReactNode } from 'react'
import { IncrementalMarkdownParser, parseMarkdown, type MarkdownBlock } from './incremental'
import { createContext, renderFootnotes, renderNode } from './render'

export const MarkdownText = memo(function MarkdownText({ text, streaming = false, response = false }: {
  text: string; streaming?: boolean; response?: boolean
}) {
  const { t } = useTranslation()
  const prefix = useId()
  const parser = useRef(new IncrementalMarkdownParser())
  const cache = useRef(new Map<MarkdownBlock, ReactNode>())
  const previousTranslation = useRef(t)
  const children = useMemo(() => {
    if (previousTranslation.current !== t) {
      cache.current.clear()
      previousTranslation.current = t
    }
    const blocks = streaming ? parser.current.update(text) : parseMarkdown(text).children.map((node, index) => ({ node, key: node.position?.start.offset ?? index }))
    const context = createContext(blocks.map(block => block.node), prefix, t, text)
    const nextCache = new Map<MarkdownBlock, ReactNode>()
    const result = blocks.map(block => {
      const sourceOffset = block.key - (block.node.position?.start.offset ?? block.key)
      const rendered = streaming && cache.current.has(block) ? cache.current.get(block) : renderNode(block.node, block.key, { ...context, sourceOffset })
      nextCache.set(block, rendered)
      return rendered
    })
    cache.current = streaming ? nextCache : new Map()
    return [...result, renderFootnotes(context)]
  }, [text, streaming, prefix, t])
  return <div className="markdown-text" data-response-text={response || undefined}>{children}</div>
})
