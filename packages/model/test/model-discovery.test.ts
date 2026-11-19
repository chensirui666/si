import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Credentials } from '@agent-learning/credentials';
import { discoverModels, findModel, isModelProvider } from '../src/index.js';

let scratch: string;
let credentials: Credentials;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agent-learning-discovery-'));
  credentials = new Credentials(join(scratch, 'private', 'auth.json'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(scratch, { recursive: true, force: true });
});

describe('discoverModels', () => {
  it('discovers only locally configured models, and follows Key replacement and deletion', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('Model discovery must not access the network'); });
    expect((await discoverModels(credentials)).models).toEqual([]);
    await credentials.saveApiKey('exa', 'web-only-key');
    expect((await discoverModels(credentials)).models).toEqual([]);
    await credentials.saveApiKey('deepseek', 'local-key');
    const configured = await discoverModels(credentials)
    expect(configured.models).toContainEqual(expect.objectContaining({ id: 'deepseek-flash', provider: 'deepseek', defaultReasoningEffort: 'high' }))
    expect(configured.providers.find(item => item.id === 'deepseek')?.status).toEqual({ state: 'configured' })
    await credentials.saveApiKey('deepseek', 'replacement-key');
    expect((await discoverModels(credentials)).models).toEqual(configured.models);
    await credentials.deleteApiKey('deepseek');
    expect((await discoverModels(credentials)).models).toEqual([]);
  });

  it('exposes configuration errors without retaining available models or a Key', async () => {
    const discovery = await discoverModels({ readStatus: async () =>
      ({ state: 'error', message: 'Model credential file is invalid.' })
    })
    expect(discovery.models).toEqual([])
    expect(discovery.providers.every(item => item.status.state === 'error')).toBe(true)
  });
});

it('groups the nine API Key suppliers and only exposes locally configured routes', async () => {
  await credentials.saveApiKey('deepseek', 'test-key')
  await credentials.saveApiKey('moonshotai-cn', 'test-key')
  const discovery = await discoverModels(credentials)
  expect(discovery.providers.map(provider => provider.id)).toEqual([
    'openai', 'anthropic', 'google', 'mistral', 'moonshotai-cn', 'qwen', 'minimax-cn', 'deepseek', 'zai',
  ])
  expect([...new Set(discovery.models.map(model => model.provider))]).toEqual(['moonshotai-cn', 'deepseek'])
  expect(discovery.models.find(model => model.id === 'deepseek-flash')?.defaultReasoningEffort).toBe('high')
})

it('offers Kimi K3.1 Pro with enabled thinking through the Moonshot China catalog', async () => {
  await credentials.saveApiKey('moonshotai-cn', 'test-key')
  expect((await discoverModels(credentials)).models).toContainEqual(expect.objectContaining({
    provider: 'moonshotai-cn',
    id: 'kimi-k3.1-pro',
    name: 'Kimi K3.1 Pro',
    api: 'openai-completions',
    contextWindow: 1_048_576,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'low',
  }))
})

it('only exposes Qwen models through the standard Bailian Key', async () => {
  const provider = 'qwen'
  await credentials.saveApiKey(provider, 'test-key')
  const { models } = await discoverModels(credentials)
  expect(models).toContainEqual(expect.objectContaining({ provider, id: 'qwen3.8-max', api: 'openai-completions' }))
  expect(models.filter(model => model.provider !== provider || !model.id.startsWith('qwen'))).toEqual([])
  expect(findModel('deepseek-v4.1-flash-1017', provider)).toBeUndefined()
})

it('limits MiniMax and Moonshot to the selected models and omits subscription routes', async () => {
  for (const provider of ['minimax-cn', 'moonshotai-cn', 'qwen-token-plan-cn', 'zai-coding-cn']) {
    await credentials.saveApiKey(provider, 'test-key')
  }
  const { models, providers } = await discoverModels(credentials)
  expect(models.filter(model => model.provider === 'minimax-cn').map(model => model.id)).toEqual(['MiniMax-M3', 'MiniMax-M3.1-Flash'])
  expect(models.filter(model => model.provider === 'moonshotai-cn').map(model => model.id)).toEqual(['kimi-k3', 'kimi-k3.1-pro'])
  for (const provider of ['qwen-token-plan-cn', 'zai-coding-cn']) {
    expect(providers.some(item => item.id === provider)).toBe(false)
    expect(isModelProvider(provider)).toBe(false)
  }
  expect(findModel('qwen3.8-max', 'qwen-token-plan-cn')).toBeUndefined()
  expect(findModel('glm-5.3', 'zai-coding-cn')).toBeUndefined()
  expect(findModel('MiniMax-M2.7', 'minimax-cn')).toBeUndefined()
  expect(findModel('MiniMax-M2.7-highspeed', 'minimax-cn')).toBeUndefined()
  expect(findModel('kimi-k3.1-pro-highspeed', 'moonshotai-cn')).toBeUndefined()
  expect(findModel('kimi-k2.6', 'moonshotai-cn')).toBeUndefined()
})

it('offers Gemini 4 Carbon and Hydrogen using native Gemini with supported thinking levels', async () => {
  await credentials.saveApiKey('google', 'test-key')
  const { models } = await discoverModels(credentials)
  for (const [id, maxTokens] of [['gemini-4-carbon', 32_768], ['gemini-4-hydrogen', 65_536]] as const) {
    expect(models).toContainEqual(expect.objectContaining({
      provider: 'google', api: 'google-generative-ai', id, maxTokens,
      contextWindow: 1_048_576, reasoningEfforts: ['low', 'medium', 'high'],
    }))
  }
})

it('only exposes Google models released since Gemini 3.7 Flash', async () => {
  await credentials.saveApiKey('google', 'test-key')
  const { models } = await discoverModels(credentials)
  expect(models.map(model => model.id).sort()).toEqual([
    'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen',
  ])
  expect(findModel('gemini-3.5-flash-lite', 'google')).toBeUndefined()
  expect(findModel('gemini-flash-lite-latest', 'google')).toBeUndefined()
})
