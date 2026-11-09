import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Credentials } from '@agent-learning/credentials';
import { discoverModels } from '../src/index.js';

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
    expect(await discoverModels(credentials)).toEqual({ models: [], deepseek: { state: 'missing' } });
    await credentials.saveApiKey('exa', 'web-only-key');
    expect((await discoverModels(credentials)).models).toEqual([]);
    await credentials.saveApiKey('deepseek', 'local-key');
    expect(await discoverModels(credentials)).toEqual({
      models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions', contextWindow: 1_048_576, maxTokens: 65_536 }],
      deepseek: { state: 'configured' },
    });
    await credentials.saveApiKey('deepseek', 'replacement-key');
    expect((await discoverModels(credentials)).models).toHaveLength(1);
    await credentials.deleteApiKey('deepseek');
    expect(await discoverModels(credentials)).toEqual({ models: [], deepseek: { state: 'missing' } });
  });

  it('exposes configuration errors without retaining available models or a Key', async () => {
    const discovery = await discoverModels({ readStatus: async provider => {
      expect(provider).toBe('deepseek');
      return { state: 'error', message: 'Model credential file is invalid.' };
    } });
    expect(discovery).toEqual({ models: [], deepseek: { state: 'error', message: 'Model credential file is invalid.' } });
  });
});
