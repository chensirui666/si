import { normalizeMcpInputSchema, toLlmContent, validateMcpArguments, type CallToolResult } from '@agent-learning/mcp'
import { IMAGE_BUDGET_BYTES, type JsonObject, type Tool, type ToolResultMessage } from '@agent-learning/model'
import { imageMimeType } from '../read-image.js'
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from '../tool-runtime.js'
import type { CodingTool } from '../tools.js'
import type { McpManager, McpToolBinding, McpToolIdentity } from './manager.js'

export type McpToolSource = Pick<McpManager, 'callTool' | 'isCurrentTool' | 'listDiscoveryServers' | 'listToolsForAgent'
  | 'subscribeToolCatalog' | 'waitForToolDiscovery'>

export function mcpToolIdentity({ serverId, credentialRef, tool }: McpToolBinding): McpToolIdentity {
  return { serverId, credentialRef, remoteToolName: tool.name }
}

export function mcpToolKey({ serverId, credentialRef, remoteToolName }: McpToolIdentity): string {
  return JSON.stringify([serverId, credentialRef, remoteToolName])
}

function boundedContent(result: CallToolResult): ToolResultMessage['content'] {
  const failure = '远端 MCP 工具报告失败。\n'
  const truncation = '\n[MCP 工具结果已截断。]'
  const content: ToolResultMessage['content'] = result.isError ? [{ type: 'text', text: failure }] : []
  let bytesLeft = MAX_OUTPUT_BYTES - Buffer.byteLength(truncation) - (result.isError ? Buffer.byteLength(failure) : 0)
  let linesLeft = MAX_OUTPUT_LINES - (result.isError ? 2 : 1)
  let imageBytesLeft = IMAGE_BUDGET_BYTES
  let truncated = false
  for (const block of toLlmContent(result)) {
    if (block.type === 'image') {
      if (block.data.length > imageBytesLeft) { truncated = true; continue }
      const mimeType = imageMimeType(Buffer.from(block.data.slice(0, 16), 'base64'))
      if (mimeType === block.mimeType) {
        content.push({ ...block, mimeType })
        imageBytesLeft -= block.data.length
        continue
      }
    }
    const text = block.type === 'text' ? block.text : '[MCP 图片格式不受支持，已省略。]'
    if (bytesLeft <= 0 || linesLeft <= 0) { truncated = true; break }
    const lines = text.split('\n', linesLeft + 1)
    const bytes = Buffer.from(lines.slice(0, linesLeft).join('\n'))
    const limited = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, bytesLeft), { stream: true })
    content.push({ type: 'text', text: limited })
    bytesLeft -= bytes.length
    linesLeft -= lines.length
    if (limited !== text) { truncated = true; break }
  }
  if (truncated) content.push({ type: 'text', text: truncation })
  return content
}

export function createMcpTools(local: CodingTool[], bindings: readonly McpToolBinding[], source: McpToolSource,
  checkPermission: (name: string, args: JsonObject) => void): CodingTool[] {
  const names = new Set(local.map(tool => tool.name))
  const tools: CodingTool[] = []
  for (const binding of bindings) {
    const { name, tool } = binding
    if (names.has(name)) continue
    names.add(name)
    const schema = normalizeMcpInputSchema(tool.inputSchema)
    tools.push({
      name, description: tool.description?.trim() || `远程 MCP 工具 ${tool.name}`,
      parameters: schema as unknown as Tool['parameters'],
      preserveFailure: true,
      validateArguments: args => validateMcpArguments(tool.inputSchema, args),
      async execute(args, { signal }) {
        const result = await source.callTool(binding, args, signal, () => checkPermission(name, args))
        return { content: boundedContent(result), isError: result.isError === true }
      },
    })
  }
  return tools
}
