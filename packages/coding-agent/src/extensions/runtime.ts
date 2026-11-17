import type { AssistantMessage, JsonObject, ModelEvent, ModelInfo, ModelMessage, ReasoningEffort, TextContent, ToolResultMessage } from '@agent-learning/model'
import type { CodingTool } from '../tools.js'
import type { CompactionRecord, ExtensionNotice } from '../types.js'

type MaybePromise<T> = T | Promise<T>

export type ExtensionMessage = {
  customType: string
  content: string | TextContent[]
  display: false
  details?: unknown
}
export type ExtensionMessageEntry = ExtensionMessage & { type: 'custom_message' }
export type ExtensionContext = Readonly<{
  sessionId: string
  cwd: string
  model?: ModelInfo
  thinkingLevel?: ReasoningEffort
  signal?: AbortSignal
  hasUI: boolean
  ui: { notify(message: string, level?: ExtensionNotice['level']): void }
}>

type ToolIdentity = { toolCallId: string; toolName: string }
type CompactionEvent = { reason: 'manual' | 'threshold' | 'overflow'; fromExtension: false; willRetry: boolean }
type Settle = { entries: ExtensionMessageEntry[]; continue: boolean }
export type ExtensionEvents = {
  session_start: { reason: 'new' | 'resume' }
  input: { text: string; source: 'rpc' }
  before_agent_start: { messageType: 'user'; prompt: string; systemPrompt: string }
  turn_start: { turnIndex: number; timestamp: number }
  context: { messages: ModelMessage[] }
  tool_call: ToolIdentity & { input: JsonObject }
  tool_result: ToolIdentity & { input: JsonObject; content: ToolResultMessage['content']; isError: boolean }
  tool_execution_end: ToolIdentity & { result: ToolResultMessage; isError: boolean }
  agent_before_settle: Settle & { outcome: 'completed' | 'aborted' | 'error'; context: { llmMessages: ModelMessage[]; canContinue: boolean } }
  agent_settled: { aborted: boolean }
  session_shutdown: { reason: 'quit' }
  agent_start: Record<never, never>
  agent_end: { messages: ModelMessage[] }
  message_start: { message: ModelMessage }
  message_update: { message: AssistantMessage; assistantMessageEvent: ModelEvent }
  tool_execution_start: ToolIdentity & { args: JsonObject }
  session_compact: CompactionEvent & { compactionEntry: Extract<CompactionRecord, { status: 'success' }> }
  session_compact_failed: CompactionEvent & { aborted: boolean; errorMessage?: string }
  model_select: { model: ModelInfo; previousModel: ModelInfo | undefined; source: 'set' }
  thinking_level_select: { level: ReasoningEffort | undefined; previousLevel: ReasoningEffort | undefined }
  provider_stream_event: { provider: string; api: string; model: string; data: unknown }
  after_provider_response: { status: number; headers: Record<string, string> }
}

type ExtensionResults = {
  input: { action: 'continue' | 'handled' } | { action: 'transform'; text: string }
  before_agent_start: { systemPrompt?: string; message?: ExtensionMessage }
  context: { messages?: ModelMessage[] }
  tool_call: { block?: boolean; reason?: string }
  tool_result: { content?: ToolResultMessage['content']; isError?: boolean }
  agent_before_settle: Partial<Settle>
}

const eventNames = {
  session_start: true, input: true, before_agent_start: true, turn_start: true, context: true,
  tool_call: true, tool_result: true, tool_execution_end: true, agent_before_settle: true, agent_settled: true,
  session_shutdown: true, agent_start: true, agent_end: true, message_start: true, message_update: true,
  tool_execution_start: true, session_compact: true, session_compact_failed: true, model_select: true,
  thinking_level_select: true, provider_stream_event: true, after_provider_response: true,
} satisfies Record<keyof ExtensionEvents, true>

type Hook = keyof ExtensionEvents
type Event<K extends Hook> = Readonly<{ type: K } & ExtensionEvents[K]>
type Result<K extends Hook> = K extends keyof ExtensionResults ? ExtensionResults[K] | void : void
type Handler<K extends Hook> = (event: Event<K>, ctx: ExtensionContext) => MaybePromise<Result<K>>
type Registration = { owner: ExtensionEntry; fn: Handler<Hook> }
const terminalHooks = new Set<Hook>(['agent_end', 'agent_settled', 'tool_execution_end', 'session_compact_failed', 'session_shutdown'])

export type ExtensionAPI = {
  on<K extends Hook>(type: K, fn: Handler<K>): () => void
  registerTool(tool: CodingTool): void
}
export type ExtensionEntry = { path: string; entry(api: ExtensionAPI): MaybePromise<void> }

export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function extensionMessage(value: unknown): value is ExtensionMessage {
  return object(value) && typeof value.customType === 'string' && value.customType.trim().length > 0
    && value.display === false && (typeof value.content === 'string' || Array.isArray(value.content)
      && value.content.every(block => object(block) && block.type === 'text' && typeof block.text === 'string'))
    && (value.details === undefined || isJson(value.details))
}

export function isJson(value: unknown): boolean {
  const seen = new Set<object>()
  const check = (item: unknown): boolean => {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (!item || typeof item !== 'object' || seen.has(item)) return false
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false
    seen.add(item)
    const valid = (Array.isArray(item) ? Array.from(item) : Object.values(item)).every(check)
    seen.delete(item)
    return valid
  }
  return check(value)
}

function checkResult(value: unknown) {
  if (value !== undefined && !object(value)) throw new Error('Hook 返回值必须是对象')
}

export class ExtensionRuntime {
  private readonly hooks = new Map<Hook, Registration[]>()
  private readonly registeredTools = new Map<string, { owner: ExtensionEntry; tool: CodingTool }>()

  constructor(private readonly entries: readonly ExtensionEntry[],
    private readonly report: (message: string, error: unknown) => void = console.error) {}

  has(type: Hook) { return !!this.hooks.get(type)?.length }
  tools() { return [...this.registeredTools.values()].map(item => item.tool) }

  async initialize(ctx: ExtensionContext, reserved: readonly string[]) {
    for (const owner of this.entries) {
      if (ctx.signal?.aborted) break
      const { path, entry } = owner
      const registrations: { type: Hook; registration: Registration }[] = []
      const tools = new Map<string, CodingTool>()
      let initialized = false
      let failed = false
      try {
        await entry({
          on: (type, fn) => {
            if (!Object.hasOwn(eventNames, type) || typeof fn !== 'function') throw new Error('无效 Hook 登记：' + type)
            const registration = { owner, fn: fn as unknown as Handler<Hook> }
            const item = { type, registration }
            if (!initialized) registrations.push(item)
            else if (!failed) this.add(type, registration)
            return () => {
              const list = this.hooks.get(type)
              const index = list?.indexOf(registration) ?? -1
              if (index >= 0) list!.splice(index, 1)
              const pending = registrations.indexOf(item)
              if (pending >= 0) registrations.splice(pending, 1)
            }
          },
          registerTool: tool => {
            if (!tool || typeof tool.name !== 'string' || !tool.name.trim() || typeof tool.description !== 'string'
              || !object(tool.parameters) || typeof tool.execute !== 'function'
              || (tool.executionMode !== undefined && !['parallel', 'sequential'].includes(tool.executionMode))) throw new Error('无效的扩展工具')
            const registered = this.registeredTools.get(tool.name)
            if (reserved.includes(tool.name) || registered && registered.owner !== owner) throw new Error('工具名已被使用：' + tool.name)
            const { name, parameters, execute, description, executionMode, promptSnippet } = tool
            const registeredTool = { name, parameters: structuredClone(parameters), description, execute, executionMode, promptSnippet }
            if (!initialized) tools.set(name, registeredTool)
            else if (!failed) this.registeredTools.set(name, { owner, tool: registeredTool })
          },
        })
        for (const { type, registration } of registrations) this.add(type, registration)
        for (const [name, tool] of tools) this.registeredTools.set(name, { owner, tool })
      } catch (error) {
        failed = true
        this.report(`扩展 ${path} registration 会话 ${ctx.sessionId}`, error)
      } finally {
        initialized = true
        registrations.length = 0
        tools.clear()
      }
    }
  }

  private add(type: Hook, registration: Registration) {
    const list = this.hooks.get(type) ?? []
    const ownerIndex = this.entries.indexOf(registration.owner)
    const index = list.findIndex(item => this.entries.indexOf(item.owner) > ownerIndex)
    list.splice(index < 0 ? list.length : index, 0, registration)
    this.hooks.set(type, list)
  }

  async emit<K extends Hook>(type: K, event: ExtensionEvents[K], ctx: ExtensionContext, runId?: string) {
    await this.chain(type, ctx, event, () => event, () => event, { runId, observe: true })
  }

  async chain<K extends Hook, S>(type: K, ctx: ExtensionContext, initial: S,
    eventFor: (state: S) => ExtensionEvents[K], apply: (state: S, event: Event<K>, result: Result<K>) => S,
    options: { runId?: string; stop?: (state: S) => boolean; onError?: (state: S) => S; observe?: boolean } = {}): Promise<S> {
    let state = initial
    for (const { owner: { path }, fn } of [...this.hooks.get(type) ?? []]) {
      if (!terminalHooks.has(type) && ctx.signal?.aborted) break
      const data = eventFor(state)
      try {
        const event = { type, ...structuredClone(data) } as Event<K>
        const result = await (fn as unknown as Handler<K>)(event, { ...ctx, model: structuredClone(ctx.model), ui: { ...ctx.ui } })
        if (!options.observe) {
          if (ctx.signal?.aborted) break
          checkResult(result)
        }
        state = apply(state, event, result)
        if (options.stop?.(state)) break
      } catch (error) {
        if (ctx.signal?.aborted && !terminalHooks.has(type)) break
        const call = 'toolCallId' in data ? ` 工具调用 ${data.toolCallId}` : ''
        this.report(`扩展 ${path} ${type} 会话 ${ctx.sessionId}${options.runId ? ` 任务 ${options.runId}` : ''}${call}`, error)
        if (options.onError) return options.onError(state)
      }
    }
    return state
  }

  input(text: string, ctx: ExtensionContext) {
    return this.chain('input', ctx, { text, handled: false }, state => ({ text: state.text, source: 'rpc' }),
      (state, _event, result) => {
        if (!result || result.action === 'continue') return state
        if (result.action === 'handled') return { ...state, handled: true }
        if (result.action === 'transform' && typeof result.text === 'string' && result.text.trim()) return { text: result.text, handled: false }
        throw new Error('无效的输入改写')
      }, { stop: state => state.handled })
  }
}
