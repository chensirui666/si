import type { ModelInfo, stream } from '@agent-learning/model'

const MAX_TITLE_CHARACTERS = 40
export const numberedSessionTitle = /^会话 [1-9][0-9]*$/

export function temporarySessionTitle(text: string): string {
  return Array.from(text.trim().replace(/\s+/gu, ' ')).slice(0, MAX_TITLE_CHARACTERS).join('')
}

const titlePrompt = '你是会话标题生成器。只根据首条用户消息生成一个简短的单行标题。沿用用户的语言。只输出标题，无需引号、Markdown、编号或解释。'

export async function generateSessionTitle(call: typeof stream, model: ModelInfo, text: string, signal: AbortSignal): Promise<string | undefined> {
  if (!text.trim() || signal.aborted) return
  const reasoningEffort = model.reasoningEfforts?.[0]
  try {
    const result = await call({ ...model, defaultReasoningEffort: reasoningEffort, maxTokens: Math.min(1024, model.maxTokens) }, {
      systemPrompt: titlePrompt,
      messages: [{ role: 'user', timestamp: 0, content: text }],
    }, { reasoningEffort, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }).result()
    if (signal.aborted || result.stopReason !== 'stop' || result.content.some(block => block.type === 'toolCall')) return
    const title = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
    if (!title || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title) || Array.from(title).length > MAX_TITLE_CHARACTERS || numberedSessionTitle.test(title)) return
    return title
  } catch { return undefined }
}
