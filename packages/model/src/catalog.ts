import { Credentials } from '@agent-learning/credentials'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels, createProvider, getSupportedThinkingLevels, hasApi } from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { googleProvider } from '@earendil-works/pi-ai/providers/google'
import { minimaxCnProvider } from '@earendil-works/pi-ai/providers/minimax-cn'
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral'
import { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { qwenTokenPlanCnProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan-cn'
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelDiscovery, ModelInfo, ModelSelection, ReasoningEffort } from './types.js'

const qwen = qwenTokenPlanCnProvider()
const glm = zaiCodingCnProvider()
const moonshot = moonshotaiCnProvider()
const minimax = minimaxCnProvider()
const google = googleProvider()
// Gemini 3.7 Flash (2026-08-13) is the release cutoff. Use fixed model IDs.
const googleModelIds = new Set([
  'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen',
])
const googleModels = google.getModels().filter(model => googleModelIds.has(model.id))

// Google publishes new model IDs before the pinned Pi catalog catches up.
const gemini4 = googleModels.find(model => model.id === 'gemini-4-argon')!
const newGeminiModels: Model<'google-generative-ai'>[] = [
  { ...gemini4, id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { ...gemini4, id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', maxTokens: 65_536,
    cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 } },
]

const providers = [
  openaiProvider(), anthropicProvider(),
  createProvider({ ...google, api: googleGenerativeAIApi(),
    models: [...googleModels, ...newGeminiModels.filter(model => !googleModels.some(item => item.id === model.id))],
  }),
  mistralProvider(),
  createProvider({ ...moonshot, api: openAICompletionsApi(),
    models: moonshot.getModels().filter(model => ['kimi-k3', 'kimi-k3.1-pro'].includes(model.id)),
  }),
  createProvider({
    id: 'qwen', name: '阿里千问（百炼中国）', auth: qwen.auth, api: openAICompletionsApi(),
    models: qwen.getModels().filter(model => /^qwen3\.[678]-/.test(model.id)).map(model => ({
      ...model, provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })),
  }),
  createProvider({ ...minimax, api: anthropicMessagesApi(),
    models: minimax.getModels().filter(model => ['MiniMax-M3', 'MiniMax-M3.1-Flash'].includes(model.id)),
  }),
  deepseekProvider(),
  createProvider({
    id: 'zai', name: '智谱 GLM（开放平台）', auth: glm.auth, api: openAICompletionsApi(),
    models: glm.getModels().filter(model => model.id !== 'glm-5.3-highspeed').map(model => ({
      ...model, provider: 'zai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    })),
  }),
]

export const piModels = createModels()
for (const provider of providers) piModels.setProvider(provider)

function info(model: Model<Api>): ModelInfo {
  const { id, name, provider, api, contextWindow, maxTokens } = model
  const nativeLevels = getSupportedThinkingLevels(model)
  const supported = hasApi(model, 'anthropic-messages') && model.compat?.forceAdaptiveThinking && nativeLevels.includes('low')
    ? nativeLevels.filter(level => level !== 'minimal' ||
      (model.thinkingLevelMap?.minimal ?? 'low') !== (model.thinkingLevelMap?.low ?? 'low'))
    : nativeLevels
  // Some compatibility endpoints can switch thinking on and off but ignore effort values.
  const enabled = supported.find(level => level === 'high') ?? supported.find(level => level !== 'off')
  const levels: ReasoningEffort[] = hasApi(model, 'openai-completions') && model.compat?.supportsReasoningEffort === false
    ? supported.includes('off') && enabled ? ['off', enabled] : []
    : supported
  const defaultReasoningEffort = levels.includes('high') && provider === 'deepseek' ? 'high'
    : levels.includes('medium') ? 'medium' : levels.find(level => level !== 'off') ?? levels[0]
  return {
    id, name: provider === 'deepseek' && id === 'deepseek-flash' ? 'DeepSeek Flash' : name,
    provider, api, contextWindow,
    // Some catalog entries allow output as long as their entire context window.
    maxTokens: Math.min(maxTokens, 65_536, Math.max(1, Math.floor(contextWindow / 4))),
    ...(model.reasoning && levels.length > 1 && { reasoningEfforts: levels, defaultReasoningEffort }),
  }
}

function supportsCoding(model: Model<Api>) {
  if (!model.input.includes('text')) return false
  if (model.provider === 'openai') return !model.id.startsWith('gpt-realtime')
  return true
}

export function findModel(modelId: string, provider = 'deepseek'): ModelInfo | undefined {
  const model = piModels.getModel(provider, modelId)
  return model && supportsCoding(model) ? info(model) : undefined
}

export function isModelProvider(id: string): boolean {
  return providers.some(provider => provider.id === id)
}

export function defaultSelection(model: ModelInfo): ModelSelection {
  return {
    provider: model.provider, modelId: model.id,
    ...(model.defaultReasoningEffort && { reasoningEffort: model.defaultReasoningEffort }),
  }
}

export function sameSelection(left: ModelSelection | undefined, right: ModelSelection | undefined): boolean {
  return left?.provider === right?.provider && left?.modelId === right?.modelId && left?.reasoningEffort === right?.reasoningEffort
}

export async function discoverModels(credentials: Pick<Credentials, 'readStatus'> = new Credentials()): Promise<ModelDiscovery> {
  const statuses = await Promise.all(providers.map(async ({ id, name }) => ({ id, name, status: await credentials.readStatus(id) })))
  return {
    providers: statuses,
    models: statuses.flatMap(({ id, status }) => status.state === 'configured'
      ? piModels.getModels(id).filter(supportsCoding).map(info) : []),
  }
}
