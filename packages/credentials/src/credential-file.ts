import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function inspectDirectory(directory: string, writable = false): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if (missing(error)) return false;
    throw new Error('Unable to read browser signing directory.');
  }
  if (!stats.isDirectory()) throw new Error('Browser signing directory must be a real directory.');
  const required = writable ? 0o700 : 0o500;
  if ((stats.mode & 0o077) !== 0 || (stats.mode & required) !== required) {
    throw new Error('Browser signing directory permissions must allow only its owner to access it.');
  }
  return true;
}

function inspectFile(stats: Stats): void {
  if (!stats.isFile()) throw new Error('Browser signing path must be a regular file, without symbolic links.');
  if ((stats.mode & 0o077) !== 0 || (stats.mode & 0o400) === 0) {
    throw new Error('Browser signing file permissions must be owner-only and readable.');
  }
}

export async function readCredentialFile(filename: string): Promise<string | undefined> {
  if (!await inspectDirectory(dirname(filename))) return undefined;
  let stats: Stats;
  try {
    stats = await lstat(filename);
  } catch (error) {
    if (missing(error)) return undefined;
    throw new Error('Unable to read browser signing file.');
  }
  inspectFile(stats);
  let file: FileHandle | undefined;
  try {
    // O_NOFOLLOW closes the symlink race; O_NONBLOCK prevents a swapped FIFO from hanging startup.
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    inspectFile(await file.stat());
    return await file.readFile('utf8');
  } catch {
    throw new Error('Unable to read browser signing file.');
  } finally {
    try {
      await file?.close();
    } catch {
      throw new Error('Unable to close browser signing file.');
    }
  }
}

export async function withCredentialFileLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  try {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  } catch {
    throw new Error('Unable to create browser signing directory.');
  }
  await inspectDirectory(dirname(filename), true);
  const lockPath = `${filename}.lock`;
  const deadline = performance.now() + 2_000;
  let lock: FileHandle;
  for (;;) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw new Error('Unable to acquire browser signing file lock.');
      }
      // shortcut: crashed-process locks need manual recovery; add proven-owner takeover if this becomes frequent.
      if (performance.now() >= deadline) throw new Error('Timed out waiting for browser signing file lock.');
      await wait(25);
    }
  }
  try {
    try {
      await lock.writeFile(`${process.pid}\n`);
    } catch {
      throw new Error('Unable to write browser signing file lock.');
    }
    return await operation();
  } finally {
    try {
      try {
        await lock.close();
      } finally {
        await rm(lockPath);
      }
    } catch {
      throw new Error('Unable to release browser signing file lock.');
    }
  }
}

export async function writeCredentialFile(filename: string, contents: string): Promise<void> {
  const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
  let file: FileHandle | undefined;
  let created = false;
  let committed = false;
  try {
    file = await open(temporary, 'wx', 0o600);
    created = true;
    await file.writeFile(contents, 'utf8');
    await file.close();
    file = undefined;
    await rename(temporary, filename);
    committed = true;
  } catch {
    throw new Error('Unable to write browser signing file. The existing file was preserved.');
  } finally {
    try {
      try {
        await file?.close();
      } finally {
        if (created && !committed) await rm(temporary, { force: true });
      }
    } catch {
      throw new Error('Unable to clean up browser signing temporary file.');
    }
  }
}
