import { watch as watchFile } from 'chokidar';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { validateHeaderValue } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { readCredentialFile, withCredentialFileLock, writeCredentialFile } from './credential-file.js';
import type { AuthFile, BrowserAuthFile, CredentialStatus } from './types.js';

function parseSecret(contents: string): Buffer {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Browser signing file contains invalid JSON. Repair the file before restarting.');
  }
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
    || !('secret' in value) || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)) {
    throw new Error('Browser signing file has an invalid version or secret format.');
  }
  const secret = Buffer.from(value.secret, 'base64url');
  if (secret.byteLength !== 32 || secret.toString('base64url') !== value.secret) {
    throw new Error('Browser signing file contains an invalid secret.');
  }
  return secret;
}

export async function loadOrCreateBrowserSecret(
  filename = join(homedir(), '.agent-learning', 'browser-auth.json'),
): Promise<Buffer> {
  const existing = await readCredentialFile(filename);
  if (existing !== undefined) return parseSecret(existing);
  return withCredentialFileLock(filename, async () => {
    const current = await readCredentialFile(filename);
    if (current !== undefined) return parseSecret(current);
    const secret = randomBytes(32);
    const file: BrowserAuthFile = { version: 1, secret: secret.toString('base64url') };
    await writeCredentialFile(filename, `${JSON.stringify(file)}\n`);
    return secret;
  });
}


function validateApiKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !key.trim()) throw new Error('API Key must be a non-empty string.');
  try {
    validateHeaderValue('Authorization', `Bearer ${key}`);
  } catch {
    throw new Error('API Key contains characters that cannot be used in an authentication header.');
  }
}

function parseAuthFile(contents: string | undefined): AuthFile {
  if (contents === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Model credential file contains invalid JSON. Repair it before updating credentials.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Model credential file must contain an object.');
  }
  return value as AuthFile;
}

function providerEntry(file: AuthFile, providerId: string): { type: 'api_key'; key: string } | undefined {
  if (!/^[a-z][a-z0-9-]*$/.test(providerId)) throw new Error('Invalid credential provider.');
  if (!Object.hasOwn(file, providerId)) return undefined;
  const entry = file[providerId];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
    || !('type' in entry) || entry.type !== 'api_key' || !('key' in entry)) {
    throw new Error('Provider credentials must contain an API Key.');
  }
  validateApiKey(entry.key);
  return { type: 'api_key', key: entry.key };
}

export class Credentials {
  private readonly filename: string;

  constructor(filename = join(homedir(), '.agent-learning', 'auth.json')) {
    this.filename = filename;
  }

  private async read(): Promise<AuthFile> {
    return parseAuthFile(await readCredentialFile(this.filename));
  }

  async readStatus(providerId: string): Promise<CredentialStatus> {
    try {
      return { state: providerEntry(await this.read(), providerId) ? 'configured' : 'missing' };
    } catch (error) {
      return { state: 'error', message: (error as Error).message };
    }
  }

  async readApiKey(providerId: string): Promise<string> {
    const entry = providerEntry(await this.read(), providerId);
    if (!entry) throw new Error(`${providerId} API Key is not configured.`);
    return entry.key;
  }

  async saveApiKey(providerId: string, key: string): Promise<void> {
    validateApiKey(key);
    await withCredentialFileLock(this.filename, async () => {
      const file = await this.read();
      providerEntry(file, providerId);
      file[providerId] = { type: 'api_key', key };
      await writeCredentialFile(this.filename, `${JSON.stringify(file, null, 2)}\n`);
    });
  }

  async deleteApiKey(providerId: string): Promise<void> {
    await withCredentialFileLock(this.filename, async () => {
      const file = await this.read();
      if (!providerEntry(file, providerId)) return;
      delete file[providerId];
      await writeCredentialFile(this.filename, `${JSON.stringify(file, null, 2)}\n`);
    });
  }

  watch(onChange: () => void): () => void {
    let active = true;
    const notify = () => { if (active) onChange(); };
    const filename = resolve(this.filename);
    let directory = dirname(filename);
    while (!existsSync(directory)) directory = dirname(directory);
    const watcher = watchFile(directory, {
      ignoreInitial: true,
      followSymlinks: false,
      // Watch an existing ancestor so initial creation cannot race missing-path setup.
      ignored: path => {
        const candidate = resolve(path);
        return candidate !== filename && !filename.startsWith(`${candidate}${sep}`);
      },
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    const parent = dirname(filename);
    const modes = new Map<string, number>();
    watcher.on('all', (_event, path, stats) => {
      const target = resolve(path);
      if (target !== filename && target !== parent) return;
      if (stats) modes.set(target, stats.mode);
      else modes.delete(target);
      if (target === filename) notify();
    });
    // Chokidar can suppress chmod after a read; raw metadata checks preserve permission updates.
    watcher.on('raw', (_event, _path, details) => {
      const target = (details as { watchedPath?: string })?.watchedPath;
      if (target !== filename && target !== parent) return;
      void lstat(target).then(stats => {
        const changed = modes.has(target) && modes.get(target) !== stats.mode;
        modes.set(target, stats.mode);
        if (changed) notify();
      }, () => {});
    });
    // Recheck after setup to cover edits between the first read and watcher readiness.
    watcher.on('ready', () => {
      void Promise.all([filename, parent].map(async path => {
        try { modes.set(path, (await lstat(path)).mode); } catch {}
      })).then(notify);
    });
    watcher.on('error', notify);
    return () => {
      if (!active) return;
      active = false;
      void watcher.close().catch(notify);
      watcher.on('error', notify);
    };
  }
}
