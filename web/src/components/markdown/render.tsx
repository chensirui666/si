import type { TFunction } from 'i18next'
import { createElement, Fragment, type ReactNode } from 'react'
import type { Definition, FootnoteDefinition, Nodes, Table } from 'mdast'
import { CodeBlock } from './CodeBlock'
import { MarkdownTable } from './MarkdownTable'

export type RenderContext = {
  definitions: Map<string, Definition>; footnotes: Map<string, FootnoteDefinition>;
  prefix: string; t: TFunction; source: string; sourceOffset: number; inTable?: boolean
}
export function createContext(nodes: readonly Nodes[], prefix: string, t: TFunction, source: string): RenderContext {
  const context: RenderContext = { definitions: new Map(), footnotes: new Map(), prefix, t, source, sourceOffset: 0 }
  const visit = (node: Nodes) => {
    if (node.type === 'definition') context.definitions.set(node.identifier.toLowerCase(), node)
    else if (node.type === 'footnoteDefinition') context.footnotes.set(node.identifier.toLowerCase(), node)
    if ('children' in node) node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return context
}

function safeUrl(url: string, image = false): string | undefined {
  try {
    const parsed = new URL(url, 'https://markdown.invalid')
    return (['https:', 'http:'].includes(parsed.protocol) || (!image && parsed.protocol === 'mailto:')) ? url : undefined
  } catch { return undefined }
}

export function renderNode(node: Nodes, key: string | number, context: RenderContext): ReactNode {
  if (node.type === 'table') return renderTable(node, key, context)
  const children = 'children' in node ? node.children.map((child, index) => renderNode(child, index, context)) : null
  switch (node.type) {
    case 'text': return node.value
    case 'paragraph': return <p key={key}>{children}</p>
    case 'heading': return createElement(`h${node.depth}`, { key }, children)
    case 'strong': return <strong key={key}>{children}</strong>
    case 'emphasis': return <em key={key}>{children}</em>
    case 'delete': return <del key={key}>{children}</del>
    case 'inlineCode': return <code key={key}>{context.inTable
      ? node.value.split(/(?<=[/\\-])/).map((part, index) => <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>)
      : node.value}</code>
    case 'code': return <CodeBlock key={key} code={node.value} language={node.lang} />
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>
    case 'break': return <br key={key} />
    case 'thematicBreak': return <hr key={key} />
    case 'list': return node.ordered ? <ol key={key} start={node.start ?? undefined}>{children}</ol> : <ul key={key}>{children}</ul>
    case 'listItem': return <li key={key}>{node.checked !== null && node.checked !== undefined && <input type="checkbox" checked={node.checked} disabled aria-label={context.t(node.checked ? 'markdown.checked' : 'markdown.unchecked')} />}{children}</li>
    case 'link': {
      const href = safeUrl(node.url)
      return href ? <a key={key} href={href} title={node.title ?? undefined} target="_blank" rel="noopener noreferrer">{children}</a> : <span key={key}>{children}</span>
    }
    case 'image': {
      const src = safeUrl(node.url, true)
      return src ? <img key={key} src={src} alt={node.alt ?? ''} title={node.title ?? undefined} loading="lazy" referrerPolicy="no-referrer" /> : <span key={key}>{node.alt}</span>
    }
    case 'linkReference': {
      const target = context.definitions.get(node.identifier.toLowerCase())
      return target ? renderNode({ type: 'link', url: target.url, title: target.title, children: node.children }, key, context) : <span key={key}>{children}</span>
    }
    case 'imageReference': {
      const target = context.definitions.get(node.identifier.toLowerCase())
      return target ? renderNode({ type: 'image', url: target.url, title: target.title, alt: node.alt }, key, context) : <span key={key}>{node.alt}</span>
    }
    case 'footnoteReference': return <sup key={key}><a href={`#${context.prefix}-${encodeURIComponent(node.identifier)}`} aria-label={context.t('markdown.footnote', { label: node.label ?? node.identifier })}>{node.label ?? node.identifier}</a></sup>
    case 'html': case 'definition': case 'footnoteDefinition': return null
    default: return children
  }
}

function renderTable(node: Table, key: string | number, context: RenderContext) {
  const [heading, ...body] = node.children
  const columns = heading.children.length
  const cellContext = { ...context, inTable: true }
  const renderRow = (row: Table['children'][number], index: number, Cell: 'th' | 'td') =>
    <tr key={index}>{Array.from({ length: columns }, (_, column) => {
      const align = node.align?.[column] ?? undefined
      return <Cell key={column} scope={Cell === 'th' ? 'col' : undefined} data-align={align} style={{ textAlign: align }}>
        {row.children[column]?.children.map((child, i) => renderNode(child, i, cellContext))}
      </Cell>
    })}</tr>
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  const markdown = start === undefined || end === undefined ? '' : context.source
    .slice(context.sourceOffset + start, context.sourceOffset + end)
    .replace(/(\r?\n|\r)(?:[ \t]*>[ \t]?)+/g, '$1')
  return <MarkdownTable key={key} markdown={markdown}>
    <thead>{renderRow(heading, 0, 'th')}</thead>
    <tbody>{body.map((row, index) => renderRow(row, index, 'td'))}</tbody>
  </MarkdownTable>
}

export function renderFootnotes(context: RenderContext): ReactNode {
  if (!context.footnotes.size) return null
  return <section className="markdown-footnotes" aria-label={context.t('markdown.footnotes')} key="footnotes"><ol>{[...context.footnotes].map(([id, node]) => <li id={`${context.prefix}-${encodeURIComponent(id)}`} key={id}>{node.children.map((child, index) => renderNode(child, index, context))}</li>)}</ol></section>
}
