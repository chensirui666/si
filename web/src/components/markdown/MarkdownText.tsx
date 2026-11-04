import { memo, useId, useMemo, useRef, type ReactNode } from 'react'
import { IncrementalMarkdownParser, parseMarkdown, type MarkdownBlock } from './incremental'
import { createContext, renderFootnotes, renderNode } from './render'

export const MarkdownText = memo(function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const prefix = useId()
  const parser = useRef(new IncrementalMarkdownParser())
  const cache = useRef(new Map<MarkdownBlock, ReactNode>())
  const children = useMemo(() => {
    const blocks = streaming ? parser.current.update(text) : parseMarkdown(text).children.map((node, index) => ({ node, key: node.position?.start.offset ?? index }))
    const context = createContext(blocks.map(block => block.node), prefix)
    const nextCache = new Map<MarkdownBlock, ReactNode>()
    const result = blocks.map(block => {
      const rendered = streaming && cache.current.has(block) ? cache.current.get(block) : renderNode(block.node, block.key, context)
      nextCache.set(block, rendered)
      return rendered
    })
    cache.current = streaming ? nextCache : new Map()
    return [...result, renderFootnotes(context)]
  }, [text, streaming, prefix])
  return <div className="markdown-text">{children}</div>
})
