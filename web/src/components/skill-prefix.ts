import type { RootNode, TextNode } from 'lexical'

export const skillPrefix = /^\s*(\/skill:([a-z0-9]+(?:-[a-z0-9]+)*))(?=\s|$)/
const prefixStyle = 'color: var(--skill-prefix-color);'

export function $styleSkillPrefix(root: RootNode, knownSkills: ReadonlySet<string>) {
  const match = skillPrefix.exec(root.getTextContent())
  let highlighted: TextNode | undefined
  if (match && knownSkills.has(match[2])) {
    const first = root.getAllTextNodes().find(node => node.getTextContent().trimStart())
    if (first) {
      const text = first.getTextContent()
      const start = text.length - text.trimStart().length
      const end = start + match[1].length
      if (text.startsWith(match[1], start)) {
        highlighted = start === 0 && end === text.length ? first : first.splitText(start, end)[start === 0 ? 0 : 1]
        if (highlighted.getStyle() !== prefixStyle) highlighted.setStyle(prefixStyle)
      }
    }
  }

  for (const node of root.getAllTextNodes()) {
    if (node.getKey() !== highlighted?.getKey() && node.getStyle() === prefixStyle) node.setStyle('')
  }
}
