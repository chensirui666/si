import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Credentials, loadOrCreateBrowserSecret } from '../src/index.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));

const exec = promisify(execFile);
let scratch: string;
let filename: string;
const fileContent = (secret = 'A'.repeat(43)) => JSON.stringify({ version: 1, secret });

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'agent-learning-credentials-'));
  filename = join(scratch, 'private', 'browser-auth.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.chmod(dirname(filename), 0o700).catch(() => {});
  await fs.rm(scratch, { recursive: true, force: true });
});

async function existing(contents = fileContent(), mode = 0o600) {
  await fs.mkdir(dirname(filename), { mode: 0o700 });
  await fs.writeFile(filename, contents, { mode });
}

describe('loadOrCreateBrowserSecret', () => {
  it('creates a canonical 32-byte secret with owner-only directory and file permissions', async () => {
    const secret = await loadOrCreateBrowserSecret(filename);
    expect(Buffer.isBuffer(secret)).toBe(true);
    expect(secret.byteLength).toBe(32);
    expect(await fs.readFile(filename, 'utf8')).toBe(`${JSON.stringify({ version: 1, secret: secret.toString('base64url') })}\n`);
    expect(secret.toString('base64url')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await fs.stat(dirname(filename))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dirname(filename))).toEqual(['browser-auth.json']);
  });

  it('returns one value to simultaneous callers without leaving lock or temporary files', async () => {
    const secrets = await Promise.all(Array.from({ length: 16 }, () => loadOrCreateBrowserSecret(filename)));
    expect(new Set(secrets.map(secret => secret.toString('hex'))).size).toBe(1);
    expect(await fs.readdir(dirname(filename))).toEqual(['browser-auth.json']);
  });

  it('shares the first secret across real Node processes', async () => {
    const source = new URL('../src/index.ts', import.meta.url).href;
    const program = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        return next(specifier.startsWith('.') && specifier.endsWith('.js') && !context.parentURL?.includes('/node_modules/') ? specifier.slice(0, -3) + '.ts' : specifier, context);
      }});
      const { loadOrCreateBrowserSecret } = await import(${JSON.stringify(source)});
      console.log((await loadOrCreateBrowserSecret(process.argv[1])).toString('hex'));
    `;
    const children = await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, ['--input-type=module', '-e', program, filename])));
    expect(new Set(children.map(child => child.stdout.trim())).size).toBe(1);
    expect(children[0].stdout.trim()).toMatch(/^[a-f0-9]{64}$/);
    expect(await fs.readdir(dirname(filename))).toEqual(['browser-auth.json']);
  });

  it('does not rewrite an existing valid file or change its modification time', async () => {
    const text = fileContent(randomBytes(32).toString('base64url'));
    await existing(text);
    await fs.utimes(filename, 1_000, 1_000);
    const before = await fs.stat(filename);
    const secret = await loadOrCreateBrowserSecret(filename);
    expect(secret.toString('base64url')).toBe(JSON.parse(text).secret);
    expect(await fs.readFile(filename, 'utf8')).toBe(text);
    expect((await fs.stat(filename)).mtimeMs).toBe(before.mtimeMs);
  });

  it.each([
    ['bad JSON', '{"secret":"do-not-print-me",'],
    ['wrong version', JSON.stringify({ version: 2, secret: 'A'.repeat(43) })],
    ['missing version', JSON.stringify({ secret: 'A'.repeat(43) })],
    ['non-object', 'null'],
    ['wrong secret type', JSON.stringify({ version: 1, secret: 123 })],
    ['short secret', fileContent('A'.repeat(42))],
    ['long secret', fileContent('A'.repeat(44))],
    ['padded base64', fileContent(`${'A'.repeat(43)}=`)],
    ['non-url alphabet', fileContent(`${'A'.repeat(42)}+`)],
    ['non-canonical final bits', fileContent(`${'A'.repeat(42)}B`)],
  ])('rejects %s and preserves the original file', async (_description, text) => {
    await existing(text);
    await expect(loadOrCreateBrowserSecret(filename)).rejects.toThrow(/invalid/i);
    expect(await fs.readFile(filename, 'utf8')).toBe(text);
    expect(await fs.readdir(dirname(filename))).toEqual(['browser-auth.json']);
  });

  it.each([0o644, 0o660, 0o600 & ~0o400])('rejects file permissions %i without rewriting', async (mode) => {
    await existing();
    await fs.chmod(filename, mode);
    await expect(loadOrCreateBrowserSecret(filename)).rejects.toThrow(/permission/i);
    expect((await fs.stat(filename)).mode & 0o777).toBe(mode);
  });

  it('rejects a shared directory rather than silently changing its permissions', async () => {
    await existing();
    await fs.chmod(dirname(filename), 0o755);
    await expect(loadOrCreateBrowserSecret(filename)).rejects.toThrow(/permission/i);
    expect((await fs.stat(dirname(filename))).mode & 0o777).toBe(0o755);
  });

  it('rejects a symlinked credential file and leaves its referent unchanged', async () => {
    await fs.mkdir(dirname(filename), { mode: 0o700 });
    const other = join(scratch, 'other.json');
    await fs.writeFile(other, fileContent(), { mode: 0o600 });
    await fs.symlink(other, filename);
    await expect(loadOrCreateBrowserSecret(filename)).rejects.toThrow(/regular file/i);
    expect((await fs.lstat(filename)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(other, 'utf8')).toBe(fileContent());
  });

  it('rejects a symlinked credential directory without creating a file in its referent', async () => {
    const other = join(scratch, 'other');
    await fs.mkdir(other, { mode: 0o700 });
    await fs.symlink(other, dirname(filename));
    await expect(loadOrCreateBrowserSecret(filename)).rejects.toThrow(/directory/i);
    expect(await fs.readdir(other)).toEqual([]);
  });

  it('rejects a non-regular credential path without waiting on it', async () => {
    await fs.mkdir(filename, { recursive: true, mode: 0o700 });
    await expect(loadOrCreateBrowserSecret(filename)).rejects.toThrow(/regular file/i);
  });

  it('re-reads under a contended lock and preserves the holder’s committed value', async () => {
    await fs.mkdir(dirname(filename), { mode: 0o700 });
    const lock = `${filename}.lock`;
    await fs.writeFile(lock, 'holder\n', { mode: 0o600 });
    const loading = loadOrCreateBrowserSecret(filename);
    await new Promise(resolve => setTimeout(resolve, 80));
    await fs.writeFile(filename, fileContent(), { mode: 0o600 });
    await fs.rm(lock);
    expect(await loading).toEqual(Buffer.alloc(32));
    expect(await fs.readdir(dirname(filename))).toEqual(['browser-auth.json']);
  });

  it('times out on a leftover lock without deleting an unowned lock', async () => {
    await fs.mkdir(dirname(filename), { mode: 0o700 });
    const lock = `${filename}.lock`;
    await fs.writeFile(lock, 'leftover\n', { mode: 0o600 });
    await expect(loadOrCreateBrowserSecret(filename)).rejects.toThrow(/lock/i);
    expect(await fs.readFile(lock, 'utf8')).toBe('leftover\n');
    expect(await fs.readdir(dirname(filename))).toEqual(['browser-auth.json.lock']);
  });

  it('reports unreadable file failures without exposing file content or an underlying error', async () => {
    await existing();
    vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('do-not-print-me'));
    const failure = await loadOrCreateBrowserSecret(filename).then(() => undefined, error => error);
    expect(String(failure)).toMatch(/read/i);
    expect(String(failure)).not.toContain('do-not-print-me');
    expect(await fs.readFile(filename, 'utf8')).toBe(fileContent());
  });

  it('rejects an unwritable directory before creating a lock even for privileged users', async () => {
    await fs.mkdir(dirname(filename), { mode: 0o500 });
    await expect(loadOrCreateBrowserSecret(filename)).rejects.toThrow(/permission/i);
    expect(await fs.readdir(dirname(filename))).toEqual([]);
  });

  it('cleans its lock and temporary file when atomic rename fails, without exposing the error', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('do-not-print-me'));
    const failure = await loadOrCreateBrowserSecret(filename).then(() => undefined, error => error);
    expect(String(failure)).toMatch(/write/i);
    expect(String(failure)).not.toContain('do-not-print-me');
    expect(await fs.readdir(dirname(filename))).toEqual([]);
  });

  it('does not expose a read handle close failure', async () => {
    await existing();
    const file = await fs.open(filename, 'r');
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementationOnce(async () => {
      await close();
      throw new Error('do-not-print-me');
    });
    vi.spyOn(fs, 'open').mockResolvedValueOnce(file);
    const failure = await loadOrCreateBrowserSecret(filename).then(() => undefined, error => error);
    expect(String(failure)).toMatch(/close/i);
    expect(String(failure)).not.toContain('do-not-print-me');
    expect(await fs.readFile(filename, 'utf8')).toBe(fileContent());
  });

  it('still removes its lock when closing the lock handle reports a failure', async () => {
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).endsWith('.lock')) {
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementationOnce(async () => {
          await close();
          throw new Error('do-not-print-me');
        });
      }
      return file;
    });
    const failure = await loadOrCreateBrowserSecret(filename).then(() => undefined, error => error);
    expect(String(failure)).toMatch(/lock/i);
    expect(String(failure)).not.toContain('do-not-print-me');
    expect(await fs.readdir(dirname(filename))).toEqual(['browser-auth.json']);
  });

  it('removes a partial temporary file when writing its contents fails', async () => {
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        vi.spyOn(file, 'writeFile').mockRejectedValueOnce(new Error('do-not-print-me'));
      }
      return file;
    });
    const failure = await loadOrCreateBrowserSecret(filename).then(() => undefined, error => error);
    expect(String(failure)).toMatch(/write/i);
    expect(String(failure)).not.toContain('do-not-print-me');
    expect(await fs.readdir(dirname(filename))).toEqual([]);
  });
});


describe('model credentials', () => {
  let credentials: Credentials;
  beforeEach(() => {
    filename = join(scratch, 'private', 'auth.json');
    credentials = new Credentials(filename);
  });

  it('starts missing without creating files, and saves, replaces, rereads and deletes the current Key', async () => {
    expect(await credentials.readStatus()).toEqual({ state: 'missing' });
    await expect(credentials.readApiKey()).rejects.toThrow(/not configured/i);
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
    await credentials.saveApiKey('first-test-key');
    expect((await fs.stat(dirname(filename))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect(await credentials.readStatus()).toEqual({ state: 'configured' });
    expect(await credentials.readApiKey()).toBe('first-test-key');
    await credentials.saveApiKey('replacement-test-key');
    expect(await new Credentials(filename).readApiKey()).toBe('replacement-test-key');
    await credentials.deleteApiKey();
    expect(await credentials.readStatus()).toEqual({ state: 'missing' });
    await expect(credentials.readApiKey()).rejects.toThrow(/not configured/i);
    expect(await fs.readdir(dirname(filename))).toEqual(['auth.json']);
  });

  it.each(['', '   ', 'bad\nkey', 'bad\rkey', 'bad\0key', '模型密钥'])('rejects invalid Key %j without creating a file', async key => {
    await expect(credentials.saveApiKey(key)).rejects.toThrow(/key/i);
    expect(await credentials.readStatus()).toEqual({ state: 'missing' });
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['invalid JSON', '{"deepseek":{"key":"secret-do-not-print"},'],
    ['non-object', 'null'],
    ['array', '[]'],
    ['invalid provider', '{"deepseek":null}'],
    ['wrong type', '{"deepseek":{"type":"oauth","key":"secret-do-not-print"}}'],
    ['non-string Key', '{"deepseek":{"type":"api_key","key":123}}'],
    ['empty Key', '{"deepseek":{"type":"api_key","key":""}}'],
    ['invalid header', '{"deepseek":{"type":"api_key","key":"bad\\nkey"}}'],
  ])('reports %s without exposing or overwriting the file', async (_name, text) => {
    await existing(text);
    const status = await credentials.readStatus();
    expect(status.state).toBe('error');
    expect(JSON.stringify(status)).not.toContain('secret-do-not-print');
    await expect(credentials.readApiKey()).rejects.toThrow();
    await expect(credentials.saveApiKey('new-key')).rejects.toThrow();
    await expect(credentials.deleteApiKey()).rejects.toThrow();
    expect(await fs.readFile(filename, 'utf8')).toBe(text);
    expect(await fs.readdir(dirname(filename))).toEqual(['auth.json']);
  });

  it('preserves other provider entries under contended concurrent writes', async () => {
    await existing('{"other":{"type":"api_key","key":"unrelated-key"}}');
    const lock = `${filename}.lock`;
    await fs.writeFile(lock, 'holder\n', { mode: 0o600 });
    const saving = credentials.saveApiKey('new-key');
    await new Promise(resolve => setTimeout(resolve, 60));
    await fs.writeFile(filename, '{"other":{"type":"api_key","key":"updated-by-lock-holder"}}');
    await fs.rm(lock);
    await saving;
    await Promise.all(Array.from({ length: 8 }, (_, index) => credentials.saveApiKey(`key-${index}`)));
    const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    expect(saved.other).toEqual({ type: 'api_key', key: 'updated-by-lock-holder' });
    expect(saved.deepseek.key).toMatch(/^key-[0-7]$/);
    await credentials.deleteApiKey();
    expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual({ other: { type: 'api_key', key: 'updated-by-lock-holder' } });
    expect(await fs.readdir(dirname(filename))).toEqual(['auth.json']);
  });

  it('serializes real process writers without dropping unrelated entries', async () => {
    await existing('{"other":{"type":"api_key","key":"unrelated-key"}}');
    const source = new URL('../src/index.ts', import.meta.url).href;
    const program = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        return next(specifier.startsWith('.') && specifier.endsWith('.js') && !context.parentURL?.includes('/node_modules/') ? specifier.slice(0, -3) + '.ts' : specifier, context);
      }});
      const { Credentials } = await import(${JSON.stringify(source)});
      await new Credentials(process.argv[1]).saveApiKey(process.argv[2]);
    `;
    await Promise.all(Array.from({ length: 4 }, (_, index) => exec(process.execPath, ['--input-type=module', '-e', program, filename, `process-${index}`])));
    const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    expect(saved.other.key).toBe('unrelated-key');
    expect(saved.deepseek.key).toMatch(/^process-[0-3]$/);
    expect(await fs.readdir(dirname(filename))).toEqual(['auth.json']);
  });

  it.each([0o644, 0o660, 0o200])('rejects unsafe file permissions %i without changing them', async mode => {
    await existing('{"deepseek":{"type":"api_key","key":"private-key"}}');
    await fs.chmod(filename, mode);
    expect(await credentials.readStatus()).toMatchObject({ state: 'error' });
    await expect(credentials.saveApiKey('new-key')).rejects.toThrow(/permission/i);
    await expect(credentials.deleteApiKey()).rejects.toThrow(/permission/i);
    expect((await fs.stat(filename)).mode & 0o777).toBe(mode);
  });

  it('rejects unsafe directories and symbolic links for both reads and writes', async () => {
    await existing('{}');
    await fs.chmod(dirname(filename), 0o755);
    expect(await credentials.readStatus()).toMatchObject({ state: 'error' });
    await expect(credentials.saveApiKey('new-key')).rejects.toThrow(/permission/i);
    await fs.chmod(dirname(filename), 0o700);
    await fs.rename(filename, join(scratch, 'referent.json'));
    await fs.symlink(join(scratch, 'referent.json'), filename);
    expect(await credentials.readStatus()).toMatchObject({ state: 'error' });
    await expect(credentials.saveApiKey('new-key')).rejects.toThrow(/regular file/i);
    expect(await fs.readFile(join(scratch, 'referent.json'), 'utf8')).toBe('{}');
  });

  it('reports filesystem failures without exposing the cause and preserves existing data', async () => {
    await credentials.saveApiKey('private-key');
    const text = await fs.readFile(filename, 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('private-key'));
    const failure = await credentials.saveApiKey('replacement').then(() => undefined, error => error);
    expect(String(failure)).toMatch(/write/i);
    expect(String(failure)).not.toContain('private-key');
    expect(await fs.readFile(filename, 'utf8')).toBe(text);
    expect(await fs.readdir(dirname(filename))).toEqual(['auth.json']);
    vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('private-key'));
    const status = await credentials.readStatus();
    expect(status).toMatchObject({ state: 'error' });
    expect(JSON.stringify(status)).not.toContain('private-key');
  });

  it('does not return the previous Key after external corruption, removal or replacement', async () => {
    await credentials.saveApiKey('old-key');
    expect(await credentials.readApiKey()).toBe('old-key');
    await fs.writeFile(filename, '{');
    expect(await credentials.readStatus()).toMatchObject({ state: 'error' });
    await expect(credentials.readApiKey()).rejects.toThrow();
    await fs.rm(filename);
    expect(await credentials.readStatus()).toEqual({ state: 'missing' });
    await expect(credentials.readApiKey()).rejects.toThrow(/not configured/i);
    await fs.writeFile(filename, '{"deepseek":{"type":"api_key","key":"external-key"}}', { mode: 0o600 });
    expect(await credentials.readApiKey()).toBe('external-key');
  });

  it('watches external creation, atomic replacement, permissions, invalid JSON, repair and deletion, then stops', async () => {
    let changes = 0;
    const stop = credentials.watch(() => { changes++; });
    try {
      await vi.waitFor(() => expect(changes).toBeGreaterThan(0), { timeout: 3_000 });
      async function changed(operation: () => Promise<unknown>, state: string) {
        const before = changes;
        await operation();
        await vi.waitFor(() => expect(changes).toBeGreaterThan(before), { timeout: 3_000 });
        expect(await credentials.readStatus()).toMatchObject({ state });
      }
      await changed(async () => {
        await fs.mkdir(dirname(filename), { mode: 0o700 });
        await fs.writeFile(filename, '{"deepseek":{"type":"api_key","key":"outside-key"}}', { mode: 0o600 });
      }, 'configured');
      await changed(async () => {
        const temporary = `${filename}.outside`;
        await fs.writeFile(temporary, '{"deepseek":{"type":"api_key","key":"replaced-key"}}', { mode: 0o600 });
        await fs.rename(temporary, filename);
      }, 'configured');
      expect(await credentials.readApiKey()).toBe('replaced-key');
      await changed(() => fs.chmod(dirname(filename), 0o755), 'error');
      await changed(() => fs.chmod(dirname(filename), 0o700), 'configured');
      await changed(() => fs.chmod(filename, 0o644), 'error');
      await changed(() => fs.chmod(filename, 0o600), 'configured');
      await changed(() => fs.writeFile(filename, '{'), 'error');
      await changed(() => fs.writeFile(filename, '{}'), 'missing');
      await changed(() => fs.rm(filename), 'missing');
      stop();
      const before = changes;
      await fs.writeFile(filename, '{}', { mode: 0o600 });
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(changes).toBe(before);
    } finally {
      stop();
    }
  });
});
