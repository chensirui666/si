import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { McpCredentialStore } from '../src/index.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mcp-auth-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const oauth = { id: 'old', serverId: 'server', url: 'https://example.test/mcp', authMode: 'oauth' } as const;

it('binds credentials to the referenced service and never recreates a pruned record', async () => {
  const store = new McpCredentialStore<{ serverUrl: string; token: string }>(directory);
  await store.create(oauth);
  await store.create({ ...oauth, id: 'new', url: 'https://other.test/mcp', clientSecret: 'secret' });
  await expect(store.load({ ...oauth, url: 'https://other.test/mcp' })).rejects.toThrow(/match/);
  await store.updateOAuth(oauth, { serverUrl: oauth.url, token: 'oauth-token' });
  expect(await store.load(oauth)).toMatchObject({ state: { token: 'oauth-token' } });

  await store.prune(new Set(['new']));
  await expect(store.updateOAuth(oauth, { serverUrl: oauth.url, token: 'late' })).rejects.toThrow(/match/);
  expect(await readFile(join(directory, 'mcp-auth.json'), 'utf8')).not.toMatch(/oauth-token|late/);
  expect((await stat(join(directory, 'mcp-auth.json'))).mode & 0o777).toBe(0o600);
});
