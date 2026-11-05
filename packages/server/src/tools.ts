import { Type, type Static } from 'typebox'
import type { Tool } from '@agent-learning/model'

const readParameters = Type.Object({
  path: Type.String({ description: '要读取的文本文件路径' }),
  offset: Type.Optional(Type.Number({ description: '起始行号，从 1 开始' })),
  limit: Type.Optional(Type.Number({ description: '最多读取的行数' })),
})

const bashParameters = Type.Object({
  command: Type.String({ description: '要运行的 Bash 命令' }),
  timeout: Type.Optional(Type.Number({ description: '超时时间，单位为秒' })),
})

const editParameters = Type.Object({
  path: Type.String({ description: '要修改的文本文件路径' }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ description: '在原文件中唯一匹配、且不与其他替换重叠的原文' }),
    newText: Type.String({ description: '替换后的文本' }),
  }), { description: '对同一原文件提出的一处或多处替换，不按前一处替换后的内容匹配' }),
})

const writeParameters = Type.Object({
  path: Type.String({ description: '要创建或覆盖的文本文件路径' }),
  content: Type.String({ description: '要写入的文本内容，允许为空字符串' }),
})

export const defaultTools: Tool[] = [
  { name: 'read', description: '请求读取文本文件，可指定起始行和最多读取行数。', parameters: readParameters },
  { name: 'bash', description: '请求在工作目录运行 Bash 命令，可指定超时秒数。', parameters: bashParameters },
  { name: 'edit', description: '请求对同一文本文件进行一处或多处精确文本替换。', parameters: editParameters },
  { name: 'write', description: '请求创建或覆盖文本文件。', parameters: writeParameters },
]

export type ReadParams = Static<typeof readParameters>
export type BashParams = Static<typeof bashParameters>
export type EditParams = Static<typeof editParameters>
export type WriteParams = Static<typeof writeParameters>
