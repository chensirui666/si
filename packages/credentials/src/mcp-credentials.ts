import { join } from 'node:path';
import { readCredentialFile, withCredentialFileLock, writeCredentialFile } from './credential-file.js';

export type McpCredentialBinding = {
  id: string;
  serverId: string;
  url: string;
  authMode: 'token' | 'oauth';
};

type McpCredential<T> = McpCredentialBinding & {
  accessToken?: string;
  clientSecret?: string;
  state?: T;
};

export class McpCredentialStore<T extends { serverUrl: string }> {
  private readonly filename: string;

  constructor(directory: string) {
    this.filename = join(directory, 'mcp-auth.json');
  }

  async load(binding: McpCredentialBinding): Promise<McpCredential<T>> {
    return this.match(await this.read(), binding);
  }

  async create(credential: McpCredential<T>): Promise<void> {
    await this.change(records => {
      if (records.some(record => record.id === credential.id)) throw new Error('MCP credential already exists.');
      records.push(credential);
      return true;
    });
  }

  async updateOAuth(binding: McpCredentialBinding, state: T): Promise<void> {
    await this.change(records => {
      const credential = this.match(records, binding);
      if (credential.authMode !== 'oauth' || state.serverUrl !== binding.url) {
        throw new Error('MCP OAuth state does not match the saved service.');
      }
      credential.state = state;
      return true;
    });
  }

  async prune(references: ReadonlySet<string>): Promise<void> {
    await this.change(records => {
      const retained = records.filter(record => references.has(record.id));
      if (retained.length === records.length) return false;
      records.splice(0, records.length, ...retained);
      return true;
    });
  }

  private match(records: McpCredential<T>[], binding: McpCredentialBinding): McpCredential<T> {
    const found = records.find(record => record.id === binding.id);
    if (found?.serverId !== binding.serverId || found.url !== binding.url || found.authMode !== binding.authMode) {
      throw new Error('MCP credential is missing or does not match the saved service.');
    }
    return found;
  }

  private async read(): Promise<McpCredential<T>[]> {
    const content = await readCredentialFile(this.filename);
    if (content === undefined) return [];
    try {
      const file = JSON.parse(content);
      if (file.version === 1 && Array.isArray(file.records) && file.records.every(validRecord)
        && new Set(file.records.map((record: McpCredential<T>) => record.id)).size === file.records.length) {
        return file.records;
      }
    } catch {
      // Report a fixed error without including contents of the credential file.
    }
    throw new Error('MCP credential file is invalid.');
  }

  private async change(change: (records: McpCredential<T>[]) => boolean): Promise<void> {
    let committed = false;
    try {
      await withCredentialFileLock(this.filename, async () => {
        const records = await this.read();
        if (!change(records)) return;
        await writeCredentialFile(this.filename, JSON.stringify({ version: 1, records }) + '\n');
        committed = true;
      });
    } catch (error) {
      if (!committed) throw error;
    }
  }
}

function validRecord(record: McpCredential<{ serverUrl: string }> | null): boolean {
  if (!record || typeof record.id !== 'string' || typeof record.serverId !== 'string' || typeof record.url !== 'string') {
    return false;
  }
  if (record.authMode === 'token') {
    return typeof record.accessToken === 'string' && record.accessToken.length > 0
      && record.clientSecret === undefined && record.state === undefined;
  }
  return record.authMode === 'oauth' && record.accessToken === undefined
    && (record.clientSecret === undefined || typeof record.clientSecret === 'string')
    && (record.state === undefined || record.state?.serverUrl === record.url);
}
