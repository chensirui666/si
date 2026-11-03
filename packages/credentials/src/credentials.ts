import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readCredentialFile, withCredentialFileLock, writeCredentialFile } from './credential-file.js';
import type { BrowserAuthFile } from './types.js';

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
