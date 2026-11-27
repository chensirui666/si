import { CodemodeSandbox, type CodemodeJsonSchema, type CodemodeOutputItem } from '@earendil-works/pi-codemode'
import type { ExecutableTool } from '@agent-learning/agent'
import { IMAGE_BUDGET_BYTES, type ToolResultMessage } from '@agent-learning/model'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { imageMimeType } from './read-image.js'
import { rankCandidates, type McpToolSearchCandidate } from './mcp/tool-search.js'
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from './tool-runtime.js'
import type { CodingTool } from './tools.js'

export const CODEMODE_TOOL = 'codemode'
const DEFAULT_TIMEOUT = 300_000
const MAX_TIMEOUT = 600_000
const MAX_WORKER_WAIT = 60_000
const MAX_WORKERS = 2
const MAX_MEMORY = 256 * 1024 * 1024

const parameters = Type.Object({
  code: Type.String({ minLength: 1, description: 'JavaScript async function body. Top-level await and return are supported.' }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT, description: 'Total time in milliseconds, defaults to 300000.' })),
}, { additionalProperties: false })

// Hold each reservation until the SDK confirms worker exit, including during cancellation.
let reservedWorkers = 0
const waiting = new Set<() => void>()
async function reserve(signal: AbortSignal): Promise<() => void> {
  while (reservedWorkers >= MAX_WORKERS) {
    signal.throwIfAborted()
    await new Promise<void>(resolve => {
      const wake = () => {
        waiting.delete(wake)
        signal.removeEventListener('abort', wake)
        resolve()
      }
      waiting.add(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  }
  signal.throwIfAborted()
  reservedWorkers++
  return () => {
    reservedWorkers--
    waiting.values().next().value?.()
  }
}

function boundedOutput(items: CodemodeOutputItem[]): ToolResultMessage['content'] {
  const marker = '\n[Code Mode 输出已截断。]'
  const output: ToolResultMessage['content'] = []
  let bytes = MAX_OUTPUT_BYTES - Buffer.byteLength(marker)
  let lines = MAX_OUTPUT_LINES - 1
  let imageBudget = IMAGE_BUDGET_BYTES
  let truncated = false
  for (const item of items) {
    if (item.type === 'image') {
      const mimeType = imageMimeType(Buffer.from(item.data.slice(0, 16), 'base64'))
      if (mimeType && mimeType === item.mimeType && item.data.length <= imageBudget) {
        output.push({ type: 'image', mimeType, data: item.data })
        imageBudget -= item.data.length
      } else truncated = true
      continue
    }
    if (bytes <= 0 || lines <= 0) { truncated = true; continue }
    const selected = item.text.split('\n', lines + 1).slice(0, lines)
    const buffer = Buffer.from(selected.join('\n'))
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buffer.subarray(0, bytes), { stream: true })
    output.push({ type: 'text', text })
    if (text !== item.text) truncated = true
    bytes -= Buffer.byteLength(text)
    lines -= selected.length
  }
  if (truncated) output.push({ type: 'text', text: marker })
  return output
}

export function createCodeModeTool(discover?: (tools: readonly ExecutableTool[]) => McpToolSearchCandidate[]): CodingTool {
  return {
    name: CODEMODE_TOOL,
    parameters,
    description: 'Run JavaScript in an isolated environment to combine tool calls and select what comes back. '
      + 'Use await tools.read({path}), tools.find({pattern}), or other tools listed in ALL_TOOLS as {name, description}. '
      + 'Text tools return strings. Calls reject on failure. Return a value or use text(value) and image(block) to emit output. '
      + 'For delegation, use tools.subagent({action:"run", background:false, tasks:[...]}). The returned tasks are in request order. Each item has sessionId (when created), status, and reply or error.'
      + (discover ? ' Use await searchTools(query, {limit:8}) to find MCP tools, await describeTool(name) for the input schema, then await tools[name](args).' : ''),
    promptSnippet: '用 JavaScript 组合工具并筛选结果。脚本用 await 处理有先后依赖的调用。',
    nestedExecution: true,
    executionMode: 'sequential',
    validateArguments: args => Check(parameters, args) && Boolean(args.code.trim()),
    async execute(args, execution) {
      if (!Check(parameters, args) || !args.code.trim()) throw new Error('Code Mode 需要非空代码，timeoutMs 必须为 1 至 600000 的整数。')
      const { signal, executeTool, nestedTools } = execution
      if (!executeTool || !nestedTools) throw new Error('Code Mode 缺少会话工具入口。')
      const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT
      const start = performance.now()
      const waitingFor = Math.min(MAX_WORKER_WAIT, timeout)
      const admission = AbortSignal.any([signal, AbortSignal.timeout(waitingFor)])
      let release: (() => void) | undefined
      try { release = await reserve(admission) }
      catch {
        signal.throwIfAborted()
        throw new Error(waitingFor === timeout ? `Code Mode 超时（${timeout} 毫秒）。` : '60 秒内没有空闲的 Code Mode 执行线程。')
      }
      let sandbox: CodemodeSandbox | undefined
      try {
        const bindings = nestedTools()
        const remaining = Math.ceil(timeout - (performance.now() - start))
        if (remaining <= 0) throw new Error(`Code Mode 超时（${timeout} 毫秒）。`)
        const currentMcp = () => discover?.(bindings) ?? []
        sandbox = new CodemodeSandbox({
          timeoutMs: remaining,
          memoryLimitBytes: MAX_MEMORY,
          acquireWorker() {
            if (!release) throw new Error('Code Mode 已经结束。')
            const acquired = release
            release = undefined
            return acquired
          },
          tools: bindings.map(tool => ({
            name: tool.name, description: tool.description, inputSchema: tool.parameters as CodemodeJsonSchema,
            async execute(input, { signal: toolSignal }) {
              const outcome = await executeTool(tool.name, input === undefined ? {} : input, toolSignal)
              const blocks = outcome.result.content
              const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
              if (outcome.result.isError) throw new Error(text || `${tool.name} 未成功执行。`)
              const structured = tool.name === 'subagent' && outcome.details.find(isScriptDelegation)
              if (structured && !outcome.rewritten) return { tasks: structured.tasks }
              if (blocks.every(block => block.type === 'text')) return text
              return blocks.length === 1 ? blocks[0] : blocks
            },
          })),
          globals: [{
            name: 'searchTools', spread: true,
            execute(args) {
              const [query, options] = args as [unknown, { limit?: unknown }?]
              if (typeof query !== 'string') throw new Error('searchTools 需要字符串查询。')
              const limit = options?.limit ?? 8
              if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('limit 必须为正整数。')
              return rankCandidates(query, currentMcp(), limit).map(({ binding, description }) =>
                ({ name: binding.name, description: description.split('\n', 1)[0] }))
            },
          }, {
            name: 'describeTool',
            execute(name) {
              if (typeof name !== 'string') throw new Error('describeTool 需要工具名称。')
              const candidate = currentMcp().find(item => item.binding.name === name)
              if (!candidate) return undefined
              const { binding } = candidate
              return { name, description: binding.tool.description ?? '', inputSchema: binding.tool.inputSchema }
            },
          }],
        })
        const result = await sandbox.execute(args.code, { signal })
        const selected = [...result.output]
        if (result.ok && result.value !== undefined) {
          selected.push({ type: 'text', text: typeof result.value === 'string' ? result.value : JSON.stringify(result.value) })
        }
        const content = boundedOutput(selected)
        if (!result.ok) content.push({
          type: 'text', text: `Code Mode ${result.error.kind === 'timeout' ? '超时' : result.error.kind === 'aborted' ? '已停止' : '失败'}：${result.error.message.slice(0, 2000)}`,
        })
        return { content, isError: !result.ok, ...(!result.ok && result.error.kind === 'aborted' && { errorCode: 'interrupted' }) }
      } finally {
        try { await sandbox?.close() }
        finally {
          const unused = release
          release = undefined
          unused?.()
        }
      }
    },
  }
}

type ScriptDelegation = { kind: 'codemode-delegation'; tasks: unknown[] }
function isScriptDelegation(value: unknown): value is ScriptDelegation {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'codemode-delegation'
    && 'tasks' in value && Array.isArray(value.tasks)
}
