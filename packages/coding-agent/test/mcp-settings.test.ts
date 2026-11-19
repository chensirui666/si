import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { credentialBinding, McpSettingsStore } from '../src/mcp/settings.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));

let directory: string;
let store: McpSettingsStore;
const input = { name: 'GitHub', url: 'https://example.test/mcp', authMode: 'token', token: 'first-token' };

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'mcp-settings-'));
  store = new McpSettingsStore(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('keeps the credential and recovery flag on rename, changing both on replacement', async () => {
  const { value: first } = await store.save(input, undefined);
  expect(first).toMatchObject({ enabled: false, connectRequested: false });
  expect(await fs.readFile(join(directory, 'mcp.json'), 'utf8')).not.toContain(input.token);
  expect((await store.setEnabled(first.id, true)).value).toMatchObject({ enabled: true, connectRequested: true });

  const { value: renamed } = await store.save({ ...input, name: 'Issues', token: '' }, first.id);
  expect(renamed).toMatchObject({ credentialRef: first.credentialRef, connectRequested: true });
  await expect(store.save({ ...input, url: 'https://other.test/mcp', token: '' }, first.id)).rejects.toThrow(/token/);

  const { value: changed } = await store.save({ ...input, token: 'replacement-token' }, first.id);
  expect(changed.id).toBe(first.id);
  expect(changed.credentialRef).not.toBe(first.credentialRef);
  expect(changed).toMatchObject({ enabled: false, connectRequested: false });
  await expect(store.credentials.load(credentialBinding(first))).rejects.toThrow(/missing/);
});

it('loads a legacy untouched service off and records the first enable for restart', async () => {
  const { value: saved } = await store.save(input, undefined);
  await fs.writeFile(join(directory, 'mcp.json'), JSON.stringify({
    version: 1, servers: [{ ...saved, enabled: true, connectRequested: undefined }],
  }));
  expect((await store.load()).value[0].enabled).toBe(false);
  await store.setEnabled(saved.id, true);
  expect((await store.load()).value[0]).toMatchObject({ enabled: true, connectRequested: true });
});

it.each(['mcp-auth.json', 'mcp.json'])('preserves prior settings when replacing %s fails', async failedFile => {
  const { value: first } = await store.save(input, undefined);
  const original = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation((source, destination) => {
    if (basename(String(destination)) === failedFile) return Promise.reject(new Error('injected write failure'));
    return original(source, destination);
  });
  await expect(store.save({ ...input, token: 'replacement-token' }, first.id)).rejects.toThrow(/preserved/);
  expect((await store.load()).value[0]).toEqual(first);
  expect((await store.credentials.load(credentialBinding(first))).accessToken).toBe(input.token);

  vi.restoreAllMocks();
  await store.load();
  expect(await fs.readFile(join(directory, 'mcp-auth.json'), 'utf8')).not.toContain('replacement-token');
});

it('reports cleanup failure after commit and retries it on startup without reverting the saved configuration', async () => {
  const { value: first } = await store.save(input, undefined);
  vi.spyOn(store.credentials, 'prune').mockRejectedValueOnce(new Error('injected cleanup failure'));
  const result = await store.save({ ...input, token: 'replacement-token' }, first.id);
  expect(result.error).toContain('could not be cleaned up');
  expect(await store.load()).toEqual({ value: [result.value] });
  await expect(store.credentials.load(credentialBinding(first))).rejects.toThrow(/missing/);

  vi.spyOn(store.credentials, 'prune').mockRejectedValueOnce(new Error('injected cleanup failure'));
  expect((await store.remove(first.id)).error).toContain('could not be cleaned up');
  expect((await store.load()).value).toEqual([]);
  await expect(store.credentials.load(credentialBinding(result.value))).rejects.toThrow(/missing/);
});

it('retains the configuration after a failed enable or disable write', async () => {
  const { value: server } = await store.save(input, undefined);
  await store.setEnabled(server.id, true);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected configuration failure'));
  await expect(store.setEnabled(server.id, false)).rejects.toThrow(/preserved/);
  expect((await store.load()).value[0].enabled).toBe(true);
});
