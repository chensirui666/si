import { createElement, type ReactNode } from 'react'
import type { Definition, FootnoteDefinition, Nodes } from 'mdast'

export type RenderContext = { definitions: Map<string, Definition>; footnotes: Map<string, FootnoteDefinition>; prefix: string }
export function createContext(nodes: readonly Nodes[], prefix: string): RenderContext {
  const context: RenderContext = { definitions: new Map(), footnotes: new Map(), prefix }
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
  const children = 'children' in node ? node.children.map((child, index) => renderNode(child, index, context)) : null
  switch (node.type) {
    case 'text': return node.value
    case 'paragraph': return <p key={key}>{children}</p>
    case 'heading': return createElement(`h${node.depth}`, { key }, children)
    case 'strong': return <strong key={key}>{children}</strong>
    case 'emphasis': return <em key={key}>{children}</em>
    case 'delete': return <del key={key}>{children}</del>
    case 'inlineCode': return <code key={key}>{node.value}</code>
    case 'code': return <pre key={key}><code>{node.value}</code></pre>
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>
    case 'break': return <br key={key} />
    case 'thematicBreak': return <hr key={key} />
    case 'list': return node.ordered ? <ol key={key} start={node.start ?? undefined}>{children}</ol> : <ul key={key}>{children}</ul>
    case 'listItem': return <li key={key}>{node.checked !== null && node.checked !== undefined && <input type="checkbox" checked={node.checked} disabled aria-label={node.checked ? '已完成' : '未完成'} />}{children}</li>
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
    case 'table': return <div className="markdown-table" key={key}><table><thead><tr>{node.children[0]?.children.map((cell, index) => <th key={index} style={{ textAlign: node.align?.[index] ?? undefined }}>{cell.children.map((child, i) => renderNode(child, i, context))}</th>)}</tr></thead><tbody>{node.children.slice(1).map((row, index) => <tr key={index}>{row.children.map((cell, i) => <td key={i} style={{ textAlign: node.align?.[i] ?? undefined }}>{cell.children.map((child, j) => renderNode(child, j, context))}</td>)}</tr>)}</tbody></table></div>
    case 'footnoteReference': return <sup key={key}><a href={`#${context.prefix}-${encodeURIComponent(node.identifier)}`} aria-label={`脚注 ${node.label ?? node.identifier}`}>{node.label ?? node.identifier}</a></sup>
    case 'html': case 'definition': case 'footnoteDefinition': return null
    default: return children
  }
}

export function renderFootnotes(context: RenderContext): ReactNode {
  if (!context.footnotes.size) return null
  return <section className="markdown-footnotes" aria-label="脚注" key="footnotes"><ol>{[...context.footnotes].map(([id, node]) => <li id={`${context.prefix}-${encodeURIComponent(id)}`} key={id}>{node.children.map((child, index) => renderNode(child, index, context))}</li>)}</ol></section>
}
