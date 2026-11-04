import type { JsonObject, ToolCall } from './types.js'

export function parseToolArguments(text: string): Pick<ToolCall, 'arguments' | 'argumentsError'> {
  if (!text.trim()) return { arguments: {} }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { arguments: {}, argumentsError: `Tool arguments must be a JSON object.\n\nReceived arguments:\n${text}` }
    }
    return { arguments: value as JsonObject }
  } catch {
    return { arguments: {}, argumentsError: `Tool arguments are not valid JSON.\n\nReceived arguments:\n${text}` }
  }
}
