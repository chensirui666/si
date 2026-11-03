import { Credentials } from '@agent-learning/credentials'
import type { ModelDiscovery, ModelInfo } from './types.js'

const deepseek: ModelInfo = {
  id: 'deepseek-flash',
  name: 'DeepSeek Flash',
  provider: 'deepseek',
  api: 'openai-completions',
}

export async function discoverModels(
  credentials: Pick<Credentials, 'readStatus'> = new Credentials(),
): Promise<ModelDiscovery> {
  const status = await credentials.readStatus()
  return { models: status.state === 'configured' ? [{ ...deepseek }] : [], deepseek: status }
}
