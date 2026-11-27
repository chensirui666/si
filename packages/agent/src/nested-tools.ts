import type { JsonObject, ToolCall } from '@agent-learning/model'
import type { ExecutableTool, NestedToolOutcome } from './types.js'

export function createNestedToolRunner(parentId: string, resolve: () => readonly ExecutableTool[],
  run: (call: ToolCall, tool: ExecutableTool | undefined, signal: AbortSignal) => Promise<NestedToolOutcome>) {
  let bindings: Map<string, ExecutableTool> | undefined
  let counter = 0
  let barrier: Promise<unknown> = Promise.resolve()
  const pending = new Set<Promise<NestedToolOutcome>>()
  const stopped = new AbortController()
  let failure: { error: unknown } | undefined
  const nestedTools = () => [...(bindings ??= new Map(resolve().map(tool => [tool.name, tool]))).values()]

  return {
    signal: stopped.signal,
    context: {
      nestedTools,
      executeTool(name: string, args: unknown, signal: AbortSignal) {
        if (stopped.signal.aborted) return Promise.reject(stopped.signal.reason)
        nestedTools()
        const tool = bindings!.get(name)
        const id = `${parentId}/${++counter}`
        const valid = args !== null && typeof args === 'object' && !Array.isArray(args)
        const call: ToolCall = { type: 'toolCall', id, name, arguments: valid ? args as JsonObject : {},
          ...(!valid && { argumentsError: '工具参数必须为 JSON 对象。' }) }
        const combined = AbortSignal.any([signal, stopped.signal])
        const ready = tool?.executionMode === 'sequential' ? Promise.allSettled([...pending]) : barrier
        const promise = ready.then(() => {
          if (failure) throw failure.error
          return run(call, tool, combined)
        })
        if (tool?.executionMode === 'sequential') barrier = promise
        pending.add(promise)
        const settled = () => { pending.delete(promise) }
        void promise.then(settled, error => {
          settled()
          failure ??= { error }
          stopped.abort(error)
        })
        return promise
      },
    },
    async finish() {
      stopped.abort(new Error('程序已结束'))
      await Promise.allSettled([...pending])
      if (failure) throw failure.error
    },
  }
}
