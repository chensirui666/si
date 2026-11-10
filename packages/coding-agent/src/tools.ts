import { Type, type Static, type TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { ExecutableTool } from '@agent-learning/agent'
import type { Tool } from '@agent-learning/model'
import { createLocalTools, type LocalToolContext } from './local-tools.js'
import type { WebTools } from './web-tools.js'
import type { ToolRuntime } from './tool-runtime.js'

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
    oldText: Type.String({ description: '在原文件中唯一匹配的原文。先精确查找，未命中时仅忽略行尾普通空格。替换范围不得重叠' }),
    newText: Type.String({ description: '替换后的文本' }),
  }), { description: '对同一原文件提出的一处或多处替换，不按前一处替换后的内容匹配' }),
})

const writeParameters = Type.Object({
  path: Type.String({ description: '要创建或覆盖的文本文件路径' }),
  content: Type.String({ description: '要写入的文本内容，允许为空字符串' }),
})

const findParameters = Type.Object({
  pattern: Type.String({ description: "文件名或路径通配规则，例如 '*.txt' 或 'src/**/*.ts'" }),
  path: Type.Optional(Type.String({ description: '搜索目录，默认当前工作区目录' })),
  limit: Type.Optional(Type.Number({ description: '结果条数上限，默认 1000' })),
})

const grepParameters = Type.Object({
  pattern: Type.String({ description: '要查找的正则表达式或字面文本' }),
  path: Type.Optional(Type.String({ description: '搜索文件或目录，默认当前工作区目录' })),
  glob: Type.Optional(Type.String({ description: "文件筛选规则，例如 '*.txt'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: '忽略大小写，默认 false' })),
  literal: Type.Optional(Type.Boolean({ description: '按字面文本匹配，默认 false' })),
  context: Type.Optional(Type.Number({ description: '每条命中前后各显示的行数，默认 0' })),
  limit: Type.Optional(Type.Number({ description: '命中行数上限，默认 100' })),
})

const webSearchParameters = Type.Object({
  query: Type.String({ description: '要搜索的网页关键词或问题' }),
  limit: Type.Optional(Type.Number({ description: '结果条数上限，默认 5' })),
})

const webFetchParameters = Type.Object({
  urls: Type.Array(Type.String(), { description: '要获取正文的公网 HTTP(S) 网址，一次可提供 1 到 5 个' }),
  char_limit: Type.Optional(Type.Number({ description: '每页正文字符预算，默认 15000，允许 2000 到 500000' })),
})

const declarations = {
  read: { name: 'read', description: '读取 UTF-8 文本文件，可指定起始行和最多读取行数。', parameters: readParameters },
  bash: { name: 'bash', description: '在工作目录运行 Bash 命令，可指定超时秒数。', parameters: bashParameters },
  edit: { name: 'edit', description: '对同一原文件进行一处或多处文本替换，先精确匹配，未命中时忽略行尾普通空格。', parameters: editParameters },
  write: { name: 'write', description: '创建或完整覆盖文本文件。', parameters: writeParameters },
  find: { name: 'find', description: '按通配规则查找文件或目录，返回相对于搜索目录的路径。', parameters: findParameters },
  grep: { name: 'grep', description: '在文件中搜索文本，返回文件路径、行号、命中文本及可选的上下文。', parameters: grepParameters },
  web_search: { name: 'web_search', description: '搜索网页并返回标题、链接和相关片段。', parameters: webSearchParameters },
  web_fetch: { name: 'web_fetch', description: '获取指定网页的正文。', parameters: webFetchParameters },
} satisfies Record<string, Tool>

export type CodingTool = ExecutableTool & { promptSnippet?: string }

const promptSnippets: Record<string, string> = {
  bash: '在当前工作目录执行 Bash 命令。',
  edit: '通过精确匹配原文来修改文件，一次调用可修改同一文件中多处互不重叠的内容。',
  grep: '搜索文件内容，返回文件路径、行号、命中文本及可选的上下文。',
  web_search: '搜索网页，返回标题、链接和相关片段。',
  web_fetch: '获取指定公网网页的正文。',
}

export const defaultTools: Tool[] = Object.values(declarations)

export type ReadParams = Static<typeof readParameters>
export type BashParams = Static<typeof bashParameters>
export type EditParams = Static<typeof editParameters>
export type WriteParams = Static<typeof writeParameters>
export type FindParams = Static<typeof findParameters>
export type GrepParams = Static<typeof grepParameters>
export type WebSearchParams = Static<typeof webSearchParameters>
export type WebFetchParams = Static<typeof webFetchParameters>

function executable<Schema extends TSchema>(
  declaration: Tool<Schema>,
  execute: (params: Static<Schema>, context: LocalToolContext) => Promise<string>,
  cwd: string,
  fileKind?: 'read' | 'modified',
): CodingTool {
  return {
    ...declaration,
    promptSnippet: promptSnippets[declaration.name],
    async execute(args, { signal, recordDetails }) {
      try {
        signal.throwIfAborted()
        if (!Check(declaration.parameters, args)) throw new Error(`${declaration.name} 工具参数不符合声明`)
        return await execute(args, { cwd, signal,
          ...(fileKind && { recordFileOperation: path => recordDetails({ kind: fileKind, path }) }),
        })
      } catch (error) {
        if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason))) {
          throw Object.assign(new Error(error instanceof Error ? error.message : '任务已取消', { cause: error }), { code: 'interrupted' })
        }
        throw error
      }
    },
  }
}

export function createTools(runtime: ToolRuntime, web: WebTools, cwd: string): CodingTool[] {
  const local = createLocalTools(runtime)
  return [
    executable(declarations.read, local.read, cwd, 'read'),
    executable(declarations.bash, local.bash, cwd),
    executable(declarations.edit, local.edit, cwd, 'modified'),
    executable(declarations.write, local.write, cwd, 'modified'),
    executable(declarations.find, local.find, cwd),
    executable(declarations.grep, local.grep, cwd),
    executable(declarations.web_search, web.web_search, cwd),
    executable(declarations.web_fetch, web.web_fetch, cwd),
  ]
}
