import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { withCredentialFileLock } from '@agent-learning/credentials';
import {
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpConnectionClosedError,
  McpHttpError,
  McpOAuthAuthorizationRequiredError,
  McpSessionExpiredError,
  McpTimeoutError,
  completeMcpSignIn,
  createMcpToolName,
  startMcpSignIn,
  validateMcpArguments,
  type CallToolResult,
  type McpClientMetadataDocuments,
  type McpOAuthState,
  type McpSignInOptions,
  type McpSignInRedirect,
  type OAuthChallenge,
  type Tool,
} from '@agent-learning/mcp';
import { abortable, durableOAuthState, interrupted, oauthCallback, temporaryOAuthStore } from './oauth.js';
import type { McpOAuthStartView } from './oauth.js';
import { credentialBinding, McpSettingsError, McpSettingsStore, type StoredMcpServer } from './settings.js';

export type { McpOAuthStartView } from './oauth.js';

type McpStatus = 'not_connected' | 'connecting' | 'connected' | 'connection_failed'
  | 'authorization_required' | 'authorizing' | 'disconnected' | 'recovering' | 'disabled';

type ConnectionReason = 'enable' | 'restore' | 'recover' | 'authorized';

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authMode: StoredMcpServer['authMode'];
  clientId?: string;
  hasCredential: boolean;
  status: McpStatus;
  tools: { name: string; description?: string }[];
  error?: string;
  attemptId?: string;
}

export interface McpToolBinding {
  name: string;
  serverId: string;
  credentialRef: string;
  revision: number;
  tool: Tool;
}

export interface McpToolIdentity {
  serverId: string;
  credentialRef: string;
  remoteToolName: string;
}

export interface McpToolCatalog {
  serverId: string;
  credentialRef: string;
  remoteToolNames: readonly string[];
}

interface Connection {
  client: McpClient;
  calls: number;
  closed?: boolean;
  closing?: Promise<void>;
  refreshPending?: boolean;
  refreshing?: boolean;
}

interface OAuthAttempt {
  id: string;
  controller: AbortController;
  timer: NodeJS.Timeout;
  preparation?: Promise<McpOAuthStartView>;
  redirect?: McpSignInRedirect;
  options?: McpSignInOptions;
  claimed?: boolean;
}

interface Runtime {
  config: StoredMcpServer;
  revision: number;
  status: McpStatus;
  hasCredential: boolean;
  error?: string;
  instructions?: string;
  tools: Map<string, { tool: Tool; lifetime: symbol }>;
  connections: Set<Connection>;
  client?: Connection;
  connecting?: { controller: AbortController; pending: Promise<void> };
  cleanup?: Promise<void>;
  challenge?: OAuthChallenge;
  oauth?: OAuthAttempt;
}

const authorizationRequired = (error: unknown) =>
  error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError;
const unavailable = () => Object.assign(new Error('MCP 工具当前不可用，请检查服务连接与权限。'), { code: 'mcp_unavailable' });
const authorizationFailed = 'MCP authorization failed or expired. Start authorization again.';
const cleanupFailed = 'The previous MCP connection could not be closed.';
const rejectedToken = 'The MCP service rejected its access token.';
const catalogRefreshFailed = 'Unable to refresh the MCP tool list.';
const catalogStorageFailed = 'Unable to update saved MCP tool selections.';
const retryDelays = [250, 1_000];
const connectTimeout = 15_000;

function transientConnectionError(error: unknown): boolean {
  if (error instanceof McpSessionExpiredError) return true;
  if (error instanceof McpHttpError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
  }
  return error instanceof TypeError || error instanceof McpTimeoutError || error instanceof McpConnectionClosedError;
}

export class McpManager {
  private readonly settings: McpSettingsStore;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly toolNameOwners = new Map<string, string>();
  private readonly bindingLifetimes = new WeakMap<McpToolBinding, symbol>();
  private readonly listeners = new Set<() => void>();
  private readonly catalogListeners = new Set<(catalog: McpToolCatalog) => void>();
  private mutations: Promise<unknown> = Promise.resolve();
  private closed = false;
  private loadError?: McpSettingsError;

  constructor(
    private readonly directory: string,
    private readonly clientMetadataDocuments?: McpClientMetadataDocuments,
  ) {
    this.settings = new McpSettingsStore(directory);
  }

  async start(): Promise<void> {
    try {
      const { value, error } = await this.settings.load();
      for (const config of value) {
        if (this.closed) return;
        const runtime = this.register(config);
        await this.readCredential(runtime);
        if (this.closed) return;
        runtime.error ??= error;
        if (config.enabled) this.connect(runtime, 'restore');
      }
    } catch {
      this.loadError = new McpSettingsError('Unable to load local MCP settings. Check the configuration file.', 500);
    }
  }

  async close(): Promise<void> {
    const cleanup = await this.mutate(() => {
      this.closed = true;
      this.listeners.clear();
      this.catalogListeners.clear();
      return [...this.runtimes.values()].map(runtime => this.retire(runtime));
    });
    await Promise.allSettled(cleanup);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeToolCatalog(listener: (catalog: McpToolCatalog) => void): () => void {
    this.catalogListeners.add(listener);
    return () => { this.catalogListeners.delete(listener); };
  }

  listServers(): McpServerView[] {
    if (this.loadError) throw this.loadError;
    return [...this.runtimes.values()].map(runtime => this.view(runtime));
  }

  listDiscoveryServers(): { id: string; name: string; instructions?: string }[] {
    return [...this.runtimes.values()].flatMap(({ config, instructions }) => config.enabled
      ? [{ id: config.id, name: config.name, ...(instructions && { instructions }) }]
      : []);
  }

  async waitForToolDiscovery(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw interrupted();
    const pending = [...this.runtimes.values()].flatMap(({ config, connecting }) => config.enabled && connecting
      ? [connecting.pending] : []);
    if (pending.length) await abortable(Promise.allSettled(pending), signal);
  }

  saveServer(input: unknown, id?: string): Promise<McpServerView> {
    return this.mutate(async () => {
      this.checkOpen();
      let runtime: Runtime | undefined;
      const { error } = await this.settings.save(input, id, config => {
        runtime = this.runtimes.get(config.id);
        if (!runtime) {
          runtime = this.register(config);
        } else {
          const replaced = runtime.config.credentialRef !== config.credentialRef;
          if (replaced) {
            const previous = runtime.config;
            runtime.config = config;
            this.retire(runtime);
            runtime.status = 'disabled';
            runtime.hasCredential = config.authMode === 'token';
            runtime.error = this.clearCatalog(previous);
          } else {
            runtime.config = { ...runtime.config, name: config.name };
          }
        }
        this.changed();
      });
      if (!runtime) throw new Error('The MCP service could not be registered.');
      if (error) runtime.error = error;
      this.changed();
      return this.view(runtime);
    });
  }

  connectServer(id: string): Promise<McpServerView> {
    return this.setEnabled(id, true);
  }

  reconnectServer(id: string): Promise<McpServerView> {
    return this.mutate(async () => {
      const runtime = this.runtime(id);
      if (!runtime.config.enabled) return this.enable(runtime);
      if (!runtime.connecting && !runtime.oauth && runtime.status !== 'authorization_required') {
        this.retire(runtime);
        this.connect(runtime, 'enable');
      }
      return this.view(runtime);
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<McpServerView> {
    return this.mutate(async () => {
      const runtime = this.runtime(id);
      if (runtime.config.enabled === enabled) return this.view(runtime);
      if (enabled) return this.enable(runtime);
      await this.disable(runtime, 'disabled');
      return this.view(runtime);
    });
  }

  private async enable(runtime: Runtime): Promise<McpServerView> {
    const { error } = await this.settings.setEnabled(runtime.config.id, true, config => {
      runtime.config = config;
      this.connect(runtime, 'enable');
    });
    if (error) {
      runtime.error = error;
      this.changed();
    }
    return this.view(runtime);
  }

  private async disable(runtime: Runtime, status: McpStatus, failure?: string, automatic = false): Promise<void> {
    const publish = (config: StoredMcpServer, error = failure) => {
      runtime.config = config;
      this.retire(runtime);
      runtime.status = status;
      runtime.error = error;
      this.changed();
    };
    try {
      const { error } = await this.settings.setEnabled(runtime.config.id, false, config => publish(config));
      if (error) {
        runtime.error = error;
        this.changed();
      }
    } catch (error) {
      if (!automatic) throw error;
      publish({ ...runtime.config, enabled: false, connectRequested: false },
        'The MCP connection stopped, but the local settings could not be updated.');
    }
  }

  async removeServer(id: string): Promise<{ removed: true; error?: string }> {
    const { error, cleanup } = await this.mutate(async () => {
      this.checkOpen();
      let cleanup: Promise<void> | undefined;
      let catalogError: string | undefined;
      const { error } = await this.settings.remove(id, () => {
        const runtime = this.runtimes.get(id);
        if (runtime) {
          this.runtimes.delete(id);
          cleanup = this.retire(runtime);
          catalogError = this.clearCatalog(runtime.config);
          this.changed();
        }
      });
      return { error: error ?? catalogError, cleanup };
    });
    try {
      await cleanup;
      return { removed: true, error };
    } catch {
      return { removed: true, error: error ?? cleanupFailed };
    }
  }

  listToolsForAgent(): McpToolBinding[] {
    const bindings: McpToolBinding[] = [];
    for (const runtime of this.runtimes.values()) {
      const config = runtime.config;
      if (!config.enabled) continue;
      for (const { tool, lifetime } of runtime.tools.values()) {
        const name = this.toolName(config, tool.name);
        const binding = {
          name, tool, serverId: config.id, credentialRef: config.credentialRef, revision: runtime.revision,
        };
        this.bindingLifetimes.set(binding, lifetime);
        bindings.push(binding);
      }
    }
    return bindings;
  }

  isCurrentTool(binding: McpToolBinding): boolean {
    const runtime = this.runtimes.get(binding.serverId);
    const lifetime = this.bindingLifetimes.get(binding);
    return runtime !== undefined && lifetime !== undefined && this.current(runtime, binding.revision)
      && runtime.config.credentialRef === binding.credentialRef
      && runtime.tools.get(binding.tool.name)?.lifetime === lifetime;
  }

  private toolName(config: StoredMcpServer, remoteName: string): string {
    const owner = JSON.stringify([config.id, remoteName]);
    const taken = (name: string) => {
      const current = this.toolNameOwners.get(name);
      return current !== undefined && current !== owner;
    };
    const preferred = createMcpToolName(config.name, remoteName, taken);
    let name = preferred;
    for (let serial = 2; taken(name); serial++) {
      const suffix = `_${serial}`;
      name = preferred.slice(0, 64 - suffix.length) + suffix;
    }
    this.toolNameOwners.set(name, owner);
    return name;
  }

  async callTool(
    binding: McpToolBinding,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
    checkPermission: () => void,
  ): Promise<CallToolResult> {
    const runtime = this.runtimes.get(binding.serverId);
    if (!runtime) throw unavailable();
    const check = () => {
      if (signal.aborted) throw interrupted();
      checkPermission();
      if (!this.isCurrentTool(binding)) throw unavailable();
    };
    check();
    for (let attempt = 0; ; attempt++) {
      if (runtime.connecting) await abortable(runtime.connecting.pending, signal);
      check();
      const connection = runtime.client;
      if (!connection || runtime.status !== 'connected') throw unavailable();
      connection.calls++;
      try {
        return await connection.client.callTool(binding.tool.name, parameters, {
          signal,
          beforeSend: () => {
            check();
            const latest = runtime.tools.get(binding.tool.name)?.tool;
            if (runtime.client !== connection || !latest) throw unavailable();
            if (!validateMcpArguments(latest.inputSchema, parameters)) {
              throw new Error('MCP 工具参数不符合当前工具定义。');
            }
          },
        });
      } catch (error) {
        if (authorizationRequired(error)) {
          await this.mutate(async () => {
            if (!this.current(runtime, binding.revision) || runtime.client !== connection) return;
            if (runtime.config.authMode === 'oauth') {
              await this.readCredential(runtime);
              await this.disable(runtime, 'authorization_required', undefined, true);
            } else {
              await this.disable(runtime, 'connection_failed', rejectedToken, true);
            }
          });
        }
        if (error instanceof McpAbortError && signal.aborted) throw interrupted();
        if (!(error instanceof McpSessionExpiredError)) throw error;
        if (this.current(runtime, binding.revision)) this.recover(runtime, connection);
        if (attempt > 0) throw new Error('MCP 会话已过期，请重新连接后再试。');
        check();
      } finally {
        connection.calls--;
        if (connection.calls === 0 && runtime.client !== connection) {
          void this.closeConnection(runtime, connection).catch(() => {});
        }
      }
    }
  }

  async startOAuth(id: string, callbackBase: string): Promise<McpOAuthStartView> {
    const { pending } = await this.mutate(() => {
      const runtime = this.enabledRuntime(id);
      if (runtime.oauth?.preparation) return { pending: runtime.oauth.preparation };
      if (runtime.status !== 'authorization_required' || runtime.config.authMode !== 'oauth') {
        throw new McpSettingsError('This MCP service is not waiting for authorization.', 409);
      }
      const controller = new AbortController();
      const attemptId = randomUUID();
      const timer = setTimeout(() => { void this.failOAuth(runtime, attempt).catch(() => {}); }, 300_000);
      timer.unref();
      const attempt: OAuthAttempt = { id: attemptId, controller, timer };
      runtime.oauth = attempt;
      runtime.status = 'authorizing';
      runtime.error = undefined;
      this.changed();
      attempt.preparation = this.prepareOAuth(runtime, attempt, callbackBase);
      return { pending: attempt.preparation };
    });
    return pending;
  }

  async cancelOAuth(id: string, attemptId: string): Promise<void> {
    await this.mutate(async () => {
      const runtime = this.runtimes.get(id);
      if (runtime?.oauth?.id !== attemptId) return;
      await this.disable(runtime, 'disabled', undefined, true);
    });
  }

  async finishOAuth(path: string, params: URLSearchParams): Promise<boolean> {
    const pending = await this.mutate(async () => {
      const state = params.get('state');
      if (!state) return;
      for (const runtime of this.runtimes.values()) {
        const attempt = runtime.oauth;
        if (!attempt?.redirect || !attempt.options || attempt.redirect.state !== state || attempt.claimed) continue;
        const response = oauthCallback(attempt.redirect, await attempt.options.store.load(), path, params);
        if (response === undefined) return;
        if (response === 'denied') {
          await this.disable(runtime, 'connection_failed', 'MCP authorization was declined.', true);
          return;
        }
        attempt.claimed = true;
        return { runtime, attempt, options: attempt.options, authorization: attempt.redirect, response };
      }
    });
    if (!pending) return false;
    const { runtime, attempt, options } = pending;
    try {
      await completeMcpSignIn({ ...options, authorization: pending.authorization, response: pending.response });
      return await this.mutate(async () => {
        if (runtime.oauth !== attempt || this.closed) return false;
        const state = await options.store.load();
        if (!state?.tokens?.access_token) throw new Error('MCP OAuth did not return an access token.');
        await this.writeOAuth(runtime.config, state, options.redirectUrl);
        this.clearOAuth(runtime);
        runtime.hasCredential = true;
        this.connect(runtime, 'authorized');
        return true;
      });
    } catch {
      await this.failOAuth(runtime, attempt);
      return false;
    }
  }

  private async prepareOAuth(runtime: Runtime, attempt: OAuthAttempt, callbackBase: string): Promise<McpOAuthStartView> {
    try {
      const config = runtime.config;
      const credential = await this.settings.credentials.load(credentialBinding(config));
      const base = new URL(callbackBase);
      base.pathname = `${base.pathname}/${config.id}`;
      const durable = this.oauthOptions(config, credential.clientSecret, base.href);
      const options = {
        ...durable,
        store: temporaryOAuthStore(durable.store, credential.state),
        challenge: runtime.challenge,
        signal: attempt.controller.signal,
      };
      const result = await startMcpSignIn(options);
      const saved = await this.mutate(async () => {
        if (runtime.oauth !== attempt || this.closed) throw new McpSettingsError('MCP authorization was cancelled.', 409);
        const state = options.store.load();
        if (state) await this.writeOAuth(config, state, options.redirectUrl);
        if (result.kind === 'authorized') {
          this.clearOAuth(runtime);
          runtime.hasCredential = Boolean(state?.tokens?.access_token);
          this.connect(runtime, 'authorized');
          return;
        }
        attempt.redirect = result;
        attempt.options = options;
        return { attemptId: attempt.id, authorizationUrl: result.authorizationUrl };
      });
      if (!saved) throw new McpSettingsError('The stored MCP authorization was refreshed. The service is connecting.', 409);
      return saved;
    } catch (error) {
      const cancelled = attempt.controller.signal.aborted;
      await this.failOAuth(runtime, attempt);
      if (error instanceof McpSettingsError) throw error;
      if (cancelled) throw new McpSettingsError('MCP authorization was cancelled.', 409);
      throw new McpSettingsError(authorizationFailed, 502);
    }
  }

  private failOAuth(runtime: Runtime, attempt: OAuthAttempt): Promise<void> {
    return this.mutate(async () => {
      if (runtime.oauth !== attempt) return;
      await this.disable(runtime, 'connection_failed', authorizationFailed, true);
    });
  }

  private clearOAuth(runtime: Runtime): void {
    const attempt = runtime.oauth;
    if (!attempt) return;
    runtime.oauth = undefined;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
  }

  private oauthOptions(config: StoredMcpServer, clientSecret?: string, redirectUrl?: string): McpSignInOptions {
    const suffix = `/${config.id}`;
    const callback = redirectUrl ?? `http://127.0.0.1/api/mcp/oauth/callback${suffix}`;
    const documentCallback = new URL(callback);
    // Preserve the callback registered by existing clients. Public documents advertise the shared path.
    if (documentCallback.pathname.endsWith(suffix)) {
      documentCallback.pathname = documentCallback.pathname.slice(0, -suffix.length);
    }
    return {
      serverUrl: config.url,
      clientName: 'SI',
      redirectUrl: callback,
      clientMetadataDocuments: this.clientMetadataDocuments,
      clientMetadataRedirectUrl: documentCallback.href,
      settings: { clientId: config.clientId, clientSecret },
      store: {
        load: async () => (await this.settings.credentials.load(credentialBinding(config))).state,
        save: state => this.writeOAuth(config, state, redirectUrl),
        withRefreshLock: operation => withCredentialFileLock(join(this.directory, `mcp-refresh-${config.credentialRef}`), operation),
      },
    };
  }

  private async writeOAuth(config: StoredMcpServer, state: McpOAuthState, redirectUrl?: string): Promise<void> {
    await this.settings.credentials.updateOAuth(credentialBinding(config), { ...durableOAuthState(state), redirectUrl });
  }

  private recover(runtime: Runtime, connection: Connection): void {
    if (runtime.client !== connection) return;
    runtime.client = undefined;
    if (connection.closed || connection.calls === 0) {
      void this.closeConnection(runtime, connection).catch(() => {});
    }
    this.connect(runtime, 'recover');
  }

  private connect(runtime: Runtime, reason: ConnectionReason): void {
    if (runtime.connecting) return;
    const revision = runtime.revision;
    const controller = new AbortController();
    runtime.status = reason === 'recover' ? 'recovering' : 'connecting';
    runtime.error = undefined;
    const pending = this.open(runtime, revision, controller.signal, reason).finally(() => {
      if (runtime.connecting?.pending === pending) runtime.connecting = undefined;
    });
    runtime.connecting = { controller, pending };
    this.changed();
  }

  private async open(runtime: Runtime, revision: number, signal: AbortSignal, reason: ConnectionReason): Promise<void> {
    const config = runtime.config;
    const retries = reason === 'recover' || reason === 'restore' ? retryDelays : [];
    for (let attempt = 0; ; attempt++) {
      let connection: Connection | undefined;
      let failure = cleanupFailed;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(connectTimeout)]);
      try {
        await abortable(runtime.cleanup ?? Promise.resolve(), deadline);
        failure = 'The MCP credential is missing or invalid. Edit the service to update it.';
        const credential = await abortable(this.settings.credentials.load(credentialBinding(config)), deadline);
        deadline.throwIfAborted();
        failure = 'Unable to complete the MCP handshake. Check the service URL and connection.';
        runtime.hasCredential = Boolean(credential.accessToken || credential.state?.tokens?.access_token);
        const oauth = config.authMode === 'oauth'
          ? this.oauthOptions(config, credential.clientSecret, credential.state?.redirectUrl)
          : undefined;
        const client = new McpClient({
          url: config.url, token: credential.accessToken, oauth,
          onChallenge: challenge => {
            if (!deadline.aborted && runtime.connecting?.controller.signal === signal) {
              runtime.challenge = challenge;
            }
          },
        });
        const opened: Connection = { client, calls: 0 };
        connection = opened;
        runtime.connections.add(opened);
        client.onToolsChanged(() => this.requestToolRefresh(runtime, opened));
        client.onClose(() => {
          opened.closed = true;
          if (this.current(runtime, revision)) this.recover(runtime, opened);
        });
        await abortable(client.connect(), deadline);
        failure = 'The MCP service connected, but its tools could not be discovered.';
        const tools = await abortable(client.listTools(), deadline);
        deadline.throwIfAborted();
        if (opened.closed) throw new McpConnectionClosedError();
        failure = catalogStorageFailed;
        this.installCatalog(runtime, tools);
        runtime.connecting = undefined;
        runtime.client = opened;
        runtime.instructions = client.instructions;
        runtime.status = 'connected';
        this.changed();
        if (opened.refreshPending) this.requestToolRefresh(runtime, opened);
        return;
      } catch (error) {
        if (connection) await abortable(this.closeConnection(runtime, connection), deadline).catch(() => {});
        if (signal.aborted || !this.current(runtime, revision)) return;
        const delay = retries[attempt];
        if (delay !== undefined && !authorizationRequired(error) && (deadline.aborted || transientConnectionError(error))) {
          try { await sleep(delay, undefined, { ref: false, signal }); }
          catch { return; }
          continue;
        }
        await this.mutate(async () => {
          if (!this.current(runtime, revision)) return;
          if (config.authMode === 'oauth' && authorizationRequired(error)) {
            await this.readCredential(runtime);
            if (reason === 'enable') {
              runtime.status = 'authorization_required';
              this.changed();
            } else {
              await this.disable(runtime, 'authorization_required', undefined, true);
            }
          } else {
            await this.disable(runtime, 'connection_failed', authorizationRequired(error) ? rejectedToken : failure, true);
          }
        });
        return;
      }
    }
  }

  private requestToolRefresh(runtime: Runtime, connection: Connection): void {
    connection.refreshPending = true;
    if (runtime.client !== connection || connection.refreshing) return;
    connection.refreshing = true;
    void this.refreshTools(runtime, connection);
  }

  private async refreshTools(runtime: Runtime, connection: Connection): Promise<void> {
    try {
      while (runtime.client === connection && connection.refreshPending) {
        connection.refreshPending = false;
        try {
          const tools = await connection.client.listTools();
          if (runtime.client !== connection) return;
          this.installCatalog(runtime, tools);
          if (runtime.error === catalogRefreshFailed) runtime.error = undefined;
        } catch {
          if (runtime.client !== connection) return;
          runtime.error = catalogRefreshFailed;
        }
        this.changed();
      }
    } finally {
      connection.refreshing = false;
    }
  }

  private installCatalog(runtime: Runtime, tools: Tool[]): void {
    this.publishCatalog(runtime.config, tools);
    runtime.tools = new Map(tools.map(tool => [
      tool.name, { tool, lifetime: runtime.tools.get(tool.name)?.lifetime ?? Symbol() },
    ]));
  }

  private publishCatalog(config: StoredMcpServer, tools: Tool[]): void {
    const catalog: McpToolCatalog = {
      serverId: config.id, credentialRef: config.credentialRef, remoteToolNames: tools.map(tool => tool.name),
    };
    for (const listener of this.catalogListeners) listener(catalog);
  }

  private clearCatalog(config: StoredMcpServer): string | undefined {
    try { this.publishCatalog(config, []); }
    catch { return catalogStorageFailed; }
  }

  private retire(runtime: Runtime): Promise<void> {
    runtime.revision++;
    runtime.tools.clear();
    runtime.instructions = undefined;
    runtime.error = undefined;
    runtime.challenge = undefined;
    this.clearOAuth(runtime);
    const connecting = runtime.connecting;
    runtime.connecting = undefined;
    connecting?.controller.abort();
    runtime.client = undefined;
    const cleanup = Promise.all([
      runtime.cleanup,
      connecting?.pending,
      ...[...runtime.connections].map(connection => this.closeConnection(runtime, connection)),
    ]).then(() => {});
    runtime.cleanup = cleanup;
    void cleanup.catch(() => {
      if (runtime.cleanup !== cleanup || !this.runtimes.has(runtime.config.id) || this.closed) return;
      runtime.error = cleanupFailed;
      this.changed();
    });
    return cleanup;
  }

  private closeConnection(runtime: Runtime, connection: Connection): Promise<void> {
    connection.closing ??= connection.client.close().then(() => { runtime.connections.delete(connection); });
    return connection.closing;
  }

  private async readCredential(runtime: Runtime): Promise<void> {
    try {
      const credential = await this.settings.credentials.load(credentialBinding(runtime.config));
      runtime.hasCredential = Boolean(credential.accessToken || credential.state?.tokens?.access_token);
    } catch {
      runtime.hasCredential = false;
      runtime.error = 'The MCP credential is missing or invalid. Edit the service to update it.';
    }
  }

  private register(config: StoredMcpServer): Runtime {
    const runtime: Runtime = {
      config, revision: 0, hasCredential: config.authMode === 'token', tools: new Map(), connections: new Set(),
      status: config.enabled ? 'not_connected' : 'disabled',
    };
    this.runtimes.set(config.id, runtime);
    return runtime;
  }

  private current(runtime: Runtime, revision: number): boolean {
    return !this.closed && this.runtimes.get(runtime.config.id) === runtime && runtime.config.enabled
      && runtime.revision === revision;
  }

  private checkOpen(): void {
    if (this.closed) throw new McpSettingsError('MCP settings are shutting down.', 503);
    if (this.loadError) throw this.loadError;
  }

  private runtime(id: string): Runtime {
    this.checkOpen();
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new McpSettingsError('MCP service not found.', 404);
    return runtime;
  }

  private enabledRuntime(id: string): Runtime {
    const runtime = this.runtime(id);
    if (!runtime.config.enabled) throw new McpSettingsError('Enable this MCP service before connecting.', 409);
    return runtime;
  }

  private view(runtime: Runtime): McpServerView {
    const { id, name, url, enabled, authMode, clientId } = runtime.config;
    return {
      id, name, url, enabled, authMode, clientId, hasCredential: runtime.hasCredential,
      status: runtime.status,
      tools: this.listToolsForAgent().filter(binding => binding.serverId === id)
        .map(({ name, tool }) => ({ name, description: tool.description })),
      error: runtime.error,
      attemptId: runtime.oauth?.id,
    };
  }

  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.catch(() => {});
    return next;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
