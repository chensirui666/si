import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { RootContent } from 'mdast'

export const parseMarkdown = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
export type MarkdownBlock = { node: RootContent; key: number }

// 沿用 dsh 的源码偏移键与最后两个不稳定块。
// shortcut: 跨冻结边界的引用在终值完整解析时校准，需要流中实时解析时增加全局引用表。
export class IncrementalMarkdownParser {
  private previous = ''
  private tailStart = 0
  private frozen: MarkdownBlock[] = []
  private result: MarkdownBlock[] = []

  update(text: string): MarkdownBlock[] {
    if (text === this.previous) return this.result
    if (!text.startsWith(this.previous)) { this.tailStart = 0; this.frozen = [] }
    this.previous = text
    const base = this.tailStart
    const nodes = parseMarkdown(text.slice(base)).children
    const freezeCount = Math.max(0, nodes.length - 2)
    const blocks = nodes.map((node, index) => ({ node, key: base + (node.position?.start.offset ?? index) }))
    if (freezeCount) {
      const end = nodes[freezeCount - 1].position?.end.offset
      if (end !== undefined) {
        this.frozen = [...this.frozen, ...blocks.slice(0, freezeCount)]
        this.tailStart = base + end
        this.result = [...this.frozen, ...blocks.slice(freezeCount)]
        return this.result
      }
    }
    this.result = [...this.frozen, ...blocks]
    return this.result
  }
}
