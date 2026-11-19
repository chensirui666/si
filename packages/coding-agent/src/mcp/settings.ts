import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  McpCredentialStore,
  readCredentialFile,
  withCredentialFileLock,
  writeCredentialFile,
} from '@agent-learning/credentials';
import type { McpOAuthState } from '@agent-learning/mcp';

export interface StoredMcpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  connectRequested?: boolean;
  authMode: 'token' | 'oauth';
  clientId?: string;
  credentialRef: string;
}

export class McpSettingsError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

type StoredMcpOAuthState = McpOAuthState & { redirectUrl?: string };

type Change<T> = { value: T; write: boolean };
type Committed<T> = { value: T; error?: string };

const cleanupError = 'The MCP settings were saved, but local credentials could not be cleaned up.';
const lockError = 'The MCP settings were saved, but the local configuration lock could not be released.';
const uuid = /^[a-f0-9-]{36}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function serverUrl(value: unknown): string {
  if (typeof value === 'string' && value.length <= 2048) {
    try {
      const url = new URL(value);
      const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
      if (!url.username && !url.password && !url.hash &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return url.href;
    } catch {
      // Do not include the supplied URL in validation errors.
    }
  }
  throw new McpSettingsError('Enter an HTTPS MCP URL or an HTTP loopback URL without embedded credentials.');
}

function field(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new McpSettingsError(`Invalid MCP ${label}.`);
  }
  return value.trim() || undefined;
}

function validServer(server: unknown): server is StoredMcpServer {
  if (!isRecord(server) || typeof server.id !== 'string' || !uuid.test(server.id) ||
      typeof server.credentialRef !== 'string' || !uuid.test(server.credentialRef) ||
      typeof server.name !== 'string' || !server.name.trim() || server.name.length > 80 ||
      typeof server.enabled !== 'boolean' ||
      (server.connectRequested !== undefined && typeof server.connectRequested !== 'boolean') ||
      (server.authMode !== 'token' && server.authMode !== 'oauth') ||
      (server.clientId !== undefined && (server.authMode !== 'oauth' || typeof server.clientId !== 'string'))) return false;
  return serverUrl(server.url) === server.url;
}

export function credentialBinding(server: StoredMcpServer) {
  return { id: server.credentialRef, serverId: server.id, url: server.url, authMode: server.authMode };
}

export class McpSettingsStore {
  private readonly filename: string;
  readonly credentials: McpCredentialStore<StoredMcpOAuthState>;

  constructor(directory: string) {
    this.filename = join(directory, 'mcp.json');
    this.credentials = new McpCredentialStore(directory);
  }

  async load(): Promise<Committed<StoredMcpServer[]>> {
    return this.change(value => ({ value, write: false }), true);
  }

  async save(input: unknown, id: string | undefined, onCommit?: (server: StoredMcpServer) => void): Promise<Committed<StoredMcpServer>> {
    if (!isRecord(input)) throw new McpSettingsError('Invalid MCP service settings.');
    const { authMode } = input;
    if (authMode !== 'token' && authMode !== 'oauth') throw new McpSettingsError('Choose an MCP authorization method.');
    const name = field(input.name, 'service name', 80);
    if (!name) throw new McpSettingsError('Enter an MCP service name.');
    const url = serverUrl(input.url);
    const token = field(input.token, 'access token', 8192);
    const clientId = field(input.clientId, 'OAuth Client ID', 1024);
    const secret = field(input.clientSecret, 'OAuth client secret', 8192);
    if ((authMode === 'token' && (clientId || secret)) || (authMode === 'oauth' && token) || (secret && !clientId)) {
      throw new McpSettingsError('The credential fields do not match the MCP authorization method.');
    }
    return this.change(async servers => {
      const index = id === undefined ? -1 : servers.findIndex(server => server.id === id);
      if (id !== undefined && index < 0) throw new McpSettingsError('MCP service not found.', 404);
      if (servers.some(server => server.id !== id && server.name.toLowerCase() === name.toLowerCase())) {
        throw new McpSettingsError('An MCP service with that name already exists.', 409);
      }
      const previous = servers[index];
      const sameConnection = previous?.url === url && previous.authMode === authMode && previous.clientId === clientId;
      let current: StoredMcpServer;
      if (previous && sameConnection && !token && !secret) {
        current = { ...previous, name };
      } else {
        if (authMode === 'token' && !token) throw new McpSettingsError('Enter an access token for this MCP URL.');
        current = {
          id: previous?.id ?? randomUUID(), name, url, authMode, clientId,
          enabled: false, connectRequested: false, credentialRef: randomUUID(),
        };
        await this.credentials.create({ ...credentialBinding(current), accessToken: token, clientSecret: secret });
      }
      if (index < 0) servers.push(current);
      else servers[index] = current;
      return { value: current, write: true };
    }, true, onCommit);
  }

  setEnabled(id: string, enabled: boolean, onCommit?: (server: StoredMcpServer) => void): Promise<Committed<StoredMcpServer>> {
    return this.update(id, server => server.enabled === enabled && server.connectRequested === enabled
      ? server
      : { ...server, enabled, connectRequested: enabled }, onCommit);
  }

  remove(id: string, onCommit?: () => void): Promise<Committed<undefined>> {
    return this.change(servers => {
      const index = servers.findIndex(server => server.id === id);
      if (index >= 0) servers.splice(index, 1);
      return { value: undefined, write: index >= 0 };
    }, true, onCommit);
  }

  private update(
    id: string,
    update: (server: StoredMcpServer) => StoredMcpServer,
    onCommit?: (server: StoredMcpServer) => void,
  ) {
    return this.change(servers => {
      const index = servers.findIndex(server => server.id === id);
      if (index < 0) throw new McpSettingsError('MCP service not found.', 404);
      const previous = servers[index];
      const value = update(previous);
      servers[index] = value;
      return { value, write: value !== previous };
    }, false, onCommit);
  }

  private async read(): Promise<StoredMcpServer[]> {
    const content = await readCredentialFile(this.filename);
    if (content === undefined) return [];
    try {
      const file = JSON.parse(content);
      if (file.version === 1 && Array.isArray(file.servers) && file.servers.every(validServer)
        && new Set(file.servers.map((server: StoredMcpServer) => server.id)).size === file.servers.length
        && new Set(file.servers.map((server: StoredMcpServer) => server.credentialRef)).size === file.servers.length
        && new Set(file.servers.map((server: StoredMcpServer) => server.name.toLowerCase())).size === file.servers.length) {
        // Earlier versions saved new services as enabled before the user connected them.
        return file.servers.map((server: StoredMcpServer) => server.enabled && !server.connectRequested
          ? { ...server, enabled: false }
          : server);
      }
    } catch {
      // Leave malformed settings in place for the owner to repair.
    }
    throw new Error('The local MCP settings file is invalid.');
  }

  private async change<T>(
    update: (servers: StoredMcpServer[]) => Change<T> | Promise<Change<T>>,
    prune = false,
    onCommit?: (value: T) => void,
  ): Promise<Committed<T>> {
    let committed: Committed<T> | undefined;
    try {
      return await withCredentialFileLock(this.filename, async () => {
        const servers = await this.read();
        const { value, write } = await update(servers);
        if (write) await writeCredentialFile(this.filename, JSON.stringify({ version: 1, servers }) + '\n');
        committed = { value };
        onCommit?.(value);
        if (prune) {
          try {
            await this.credentials.prune(new Set(servers.map(server => server.credentialRef)));
          } catch {
            committed.error = cleanupError;
          }
        }
        return committed;
      });
    } catch (error) {
      if (committed) return { value: committed.value, error: lockError };
      throw error;
    }
  }
}
