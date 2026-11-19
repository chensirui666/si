import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpClient, McpOutcomeUnknownError } from '@agent-learning/mcp';
import { McpManager, type McpToolCatalog } from '../src/mcp/manager.js';

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}

let directory: string;
let manager: McpManager;
const closeServers: (() => void)[] = [];
const active = new AbortController().signal;
const definition = {
  name: 'lookup',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-manager-'));
  manager = new McpManager(directory);
  await manager.start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await manager.close();
  for (const close of closeServers.splice(0)) close();
  await rm(directory, { recursive: true, force: true });
});

interface Message { method: string; id: number; params?: unknown }

async function fixture(options: {
  oauth?: boolean;
  instructions?: string;
  rejectToken?: () => boolean;
  initializeStatus?: () => number | undefined;
  stream?: (res: ServerResponse) => void;
  list?: () => unknown | Promise<unknown>;
  call?: (req: IncomingMessage, res: ServerResponse, message: Message) => void | Promise<void>;
  token?: (params: URLSearchParams) => object | Promise<object>;
} = {}) {
  const requests: { method: string; session: string | undefined; authorization: string | undefined }[] = [];
  const exchanges: URLSearchParams[] = [];
  const registrations: object[] = [];
  let origin: string;
  let sessions = 0;
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      return json(res, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (req.url === '/register') {
      const registration = JSON.parse(body);
      registrations.push(registration);
      return json(res, { ...registration, client_id: 'fixture-client' });
    }
    if (req.url === '/token') {
      const form = new URLSearchParams(body);
      exchanges.push(form);
      return json(res, await options.token?.(form) ?? { access_token: 'authorized', token_type: 'Bearer' });
    }
    if (req.method === 'GET' && options.stream) { options.stream(res); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const message = JSON.parse(body) as Message;
    requests.push({
      method: message.method,
      session: req.headers['mcp-session-id'] as string | undefined,
      authorization: req.headers.authorization,
    });
    if ((options.oauth && !req.headers.authorization) || options.rejectToken?.()) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }).end();
      return;
    }
    if (message.method === 'initialize') {
      const status = options.initializeStatus?.();
      if (status) { res.writeHead(status).end(); return; }
      res.setHeader('mcp-session-id', String(++sessions));
      return result(res, message, {
        protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: { listChanged: true } },
        ...(options.instructions && { instructions: options.instructions }),
      });
    }
    if (message.method === 'tools/list') return result(res, message, { tools: options.list ? await options.list() : [definition] });
    if (message.method === 'tools/call') {
      if (options.call) return options.call(req, res, message);
      return result(res, message, { content: [{ type: 'text', text: 'found' }] });
    }
    res.writeHead(202).end();
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  closeServers.push(() => { server.closeAllConnections(); server.close(); });
  return { origin, url: `${origin}/mcp`, requests, exchanges, registrations };
}

function json(res: ServerResponse, payload: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function result(res: ServerResponse, message: Message, payload: unknown) {
  return json(res, { jsonrpc: '2.0', id: message.id, result: payload });
}

const add = (url: string, name = 'First') => manager.saveServer({ name, url, authMode: 'token', token: 'test-token' });
const status = (id: string, expected: string) =>
  vi.waitFor(() => expect(manager.listServers().find(server => server.id === id)?.status).toBe(expected), { timeout: 3_000 });

it('saves without connecting, publishes tools only after discovery, and keeps the connection on rename', async () => {
  const list = gate();
  const remote = await fixture({ list: async () => { await list.waiting; return [definition]; } });
  const saved = await add(remote.url);
  expect(saved).toMatchObject({ status: 'disabled', enabled: false, tools: [], hasCredential: true });
  expect(JSON.stringify(saved)).not.toContain('test-token');
  expect(remote.requests).toEqual([]);
  await Promise.all([manager.setEnabled(saved.id, true), manager.setEnabled(saved.id, true)]);
  await vi.waitFor(() => expect(remote.requests.some(request => request.method === 'tools/list')).toBe(true));
  await status(saved.id, 'connecting');
  list.release();
  await status(saved.id, 'connected');
  const other = await fixture();
  await manager.saveServer({ name: 'Renamed', url: remote.url, authMode: 'token' }, saved.id);
  expect(manager.listToolsForAgent()[0].name).toBe('mcp__Renamed__lookup');
  expect(remote.requests.filter(request => request.method === 'initialize')).toHaveLength(1);
  await manager.saveServer({ name: 'Renamed', url: other.url, authMode: 'token', token: 'replacement' }, saved.id);
  expect(manager.listToolsForAgent()).toHaveLength(0);
  expect(other.requests).toEqual([]);
  await status(saved.id, 'disabled');
});

it('restores only enabled services manually contacted with their current configuration, and deletion persists', async () => {
  const [automatic, saved, disabled, deleted, changed] = await Promise.all(Array.from({ length: 5 }, () => fixture()));
  const keep = await add(automatic.url, 'restore');
  await add(saved.url, 'saved');
  const stop = await add(disabled.url, 'disabled');
  const remove = await add(deleted.url, 'deleted');
  const edit = await add(changed.url, 'edited');
  await Promise.all([keep, stop, remove, edit].map(server => manager.setEnabled(server.id, true)));
  await Promise.all([keep, stop, remove, edit].map(server => status(server.id, 'connected')));
  await manager.setEnabled(stop.id, false);
  await manager.removeServer(remove.id);
  await manager.saveServer({ name: 'edited', url: changed.url, authMode: 'token', token: 'replacement' }, edit.id);
  await manager.close();
  manager = new McpManager(directory);
  await manager.start();
  await status(keep.id, 'connected');
  expect(manager.listServers().map(server => [server.name, server.status])).toEqual([
    ['restore', 'connected'], ['saved', 'disabled'], ['disabled', 'disabled'], ['edited', 'disabled'],
  ]);
  expect([automatic, saved, disabled, deleted, changed].map(remote =>
    remote.requests.filter(request => request.method === 'initialize').length)).toEqual([2, 0, 1, 1, 1]);
});

it('does not dispatch stale bindings after disable, preserves an uncertain call, then establishes a shared connection', async () => {
  const called = gate();
  const remote = await fixture({ call: () => { called.release(); } });
  const saved = await add(remote.url);
  await manager.connectServer(saved.id);
  await status(saved.id, 'connected');
  const [binding] = manager.listToolsForAgent();
  const pending = manager.callTool(binding, { query: 'x' }, active, () => {});
  const error = expect(pending).rejects.toBeInstanceOf(McpOutcomeUnknownError);
  await called.waiting;
  await manager.setEnabled(saved.id, false);
  await error;
  expect(manager.listToolsForAgent()).toEqual([]);
  await expect(manager.callTool(binding, { query: 'x' }, active, () => {})).rejects.toThrow(/不可用/);
  await manager.setEnabled(saved.id, true);
  await status(saved.id, 'connected');
  await expect(manager.callTool(binding, { query: 'x' }, active, () => {})).rejects.toThrow(/不可用/);
  expect(remote.requests.filter(request => request.method === 'initialize')).toHaveLength(2);
  expect(remote.requests.filter(request => request.method === 'tools/call')).toHaveLength(1);
});

it('drops results from a connection replaced while discovering tools', async () => {
  const secondList = gate();
  let lists = 0;
  const remote = await fixture({ list: async () => {
    if (++lists > 1) await secondList.waiting;
    return [definition];
  } });
  const saved = await add(remote.url);
  await manager.connectServer(saved.id);
  await status(saved.id, 'connected');
  await manager.reconnectServer(saved.id);
  await vi.waitFor(() => expect(lists).toBe(2));
  await manager.setEnabled(saved.id, false);
  secondList.release();
  await status(saved.id, 'disabled');
  expect(manager.listToolsForAgent()).toEqual([]);
});

it('automatically recovers a dropped connection, shares recovery and revalidates the refreshed schema', async () => {
  const secondList = gate();
  let lists = 0;
  let calls = 0;
  const remote = await fixture({
    list: async () => {
      if (++lists === 1) return [definition];
      await secondList.waiting;
      return [{ ...definition, inputSchema: { ...definition.inputSchema, properties: { query: { type: 'integer' } } } }];
    },
    call: (req, res, message) => {
      if (++calls === 1) { req.socket.destroy(); return; }
      result(res, message, { content: [{ type: 'text', text: 'refreshed' }] });
    },
  });
  const saved = await add(remote.url);
  await manager.connectServer(saved.id);
  await status(saved.id, 'connected');
  const [binding] = manager.listToolsForAgent();
  await expect(manager.callTool(binding, { query: 'x' }, active, () => {})).rejects.toBeInstanceOf(McpOutcomeUnknownError);
  await vi.waitFor(() => expect(lists).toBe(2));
  expect(manager.listServers()[0]).toMatchObject({
    status: 'recovering', enabled: true, tools: [{ name: expect.stringContaining('lookup') }],
  });
  const stop = new AbortController();
  const waiting = manager.callTool(binding, { query: 2 }, stop.signal, () => {});
  const cancelled = expect(waiting).rejects.toMatchObject({ code: 'interrupted' });
  const invalid = expect(manager.callTool(binding, { query: 'x' }, active, () => {})).rejects.toThrow(/参数/);
  let permitted = true;
  const revoked = expect(manager.callTool(binding, { query: 2 }, active, () => {
    if (!permitted) throw new Error('permission revoked');
  })).rejects.toThrow('permission revoked');
  const next = manager.callTool(binding, { query: 3 }, active, () => {});
  permitted = false;
  stop.abort();
  await cancelled;
  secondList.release();
  await invalid;
  await revoked;
  expect(await next).toMatchObject({ content: [{ text: 'refreshed' }] });
  expect(remote.requests.filter(request => request.method === 'initialize')).toHaveLength(2);
  expect(calls).toBe(2);
});

it('refreshes a live catalog sequentially and rejects obsolete bindings and arguments', async () => {
  const onToolsChanged = McpClient.prototype.onToolsChanged;
  let notifications = 0;
  const snapshots: McpToolCatalog[] = [];
  manager.subscribeToolCatalog(catalog => snapshots.push(catalog));
  vi.spyOn(McpClient.prototype, 'onToolsChanged').mockImplementation(function (this: McpClient, listener) {
    return onToolsChanged.call(this, () => { notifications++; listener(); });
  });
  const firstRefresh = gate();
  let catalog = [definition, { ...definition, name: 'lookup_other' }];
  let lists = 0;
  let stream: ServerResponse | undefined;
  const remote = await fixture({
    stream: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      stream = res;
    },
    list: async () => {
      const tools = catalog;
      if (++lists === 2) await firstRefresh.waiting;
      return tools;
    },
  });
  const saved = await add(remote.url);
  await manager.connectServer(saved.id);
  await status(saved.id, 'connected');
  await vi.waitFor(() => expect(stream).toBeDefined());
  const [lookup, other] = manager.listToolsForAgent();
  const notify = () => stream!.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  notify();
  await vi.waitFor(() => expect(lists).toBe(2));
  catalog = [{
    ...definition, inputSchema: { ...definition.inputSchema, properties: { query: { type: 'integer' } } },
  }, { ...definition, name: 'new_tool' }];
  notify();
  notify();
  await vi.waitFor(() => expect(notifications).toBe(3));
  expect(lists).toBe(2);
  firstRefresh.release();
  await vi.waitFor(() => expect(manager.listToolsForAgent().map(binding => binding.tool.name)).toEqual(['lookup', 'new_tool']));
  await expect(manager.callTool(other, { query: 'old' }, active, () => {})).rejects.toThrow(/不可用/);
  await expect(manager.callTool(lookup, { query: 'old' }, active, () => {})).rejects.toThrow(/参数/);
  expect(remote.requests.filter(request => request.method === 'tools/call')).toHaveLength(0);
  expect(remote.requests.filter(request => request.method === 'initialize')).toHaveLength(1);
  expect(lists).toBe(3);
  catalog = [...catalog, other.tool];
  notify();
  await vi.waitFor(() => expect(manager.listToolsForAgent()).toHaveLength(3));
  const renewed = manager.listToolsForAgent().find(binding => binding.tool.name === other.tool.name)!;
  await expect(manager.callTool(other, { query: 'old' }, active, () => {})).rejects.toThrow(/不可用/);
  await expect(manager.callTool(renewed, { query: 'new' }, active, () => {})).resolves.toMatchObject({
    content: [{ text: 'found' }],
  });
  expect(remote.requests.filter(request => request.method === 'tools/call')).toHaveLength(1);
  expect(snapshots.map(({ remoteToolNames }) => remoteToolNames)).toEqual([
    ['lookup', 'lookup_other'], ['lookup', 'lookup_other'], ['lookup', 'new_tool'], ['lookup', 'new_tool', 'lookup_other'],
  ]);
  expect(snapshots[2]).toMatchObject({ serverId: saved.id, credentialRef: lookup.credentialRef });
  await manager.setEnabled(saved.id, false);
  expect(snapshots).toHaveLength(4);
});

it('queues a catalog refresh during first discovery and supports independent search cancellation', async () => {
  const initial = gate();
  let lists = 0;
  let stream: ServerResponse | undefined;
  const onToolsChanged = McpClient.prototype.onToolsChanged;
  const notified = gate();
  vi.spyOn(McpClient.prototype, 'onToolsChanged').mockImplementation(function (this: McpClient, listener) {
    return onToolsChanged.call(this, () => { listener(); notified.release(); });
  });
  const remote = await fixture({
    instructions: 'Directory lookup',
    stream: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      stream = res;
    },
    list: async () => {
      if (++lists > 1) return [{ ...definition, name: 'ready_lookup' }];
      await initial.waiting;
      return [definition];
    },
  });
  const saved = await add(remote.url);
  expect(manager.listDiscoveryServers()).toEqual([]);
  await manager.connectServer(saved.id);
  expect(manager.listDiscoveryServers()).toEqual([{ id: saved.id, name: 'First' }]);
  const stop = new AbortController();
  const cancelled = expect(manager.waitForToolDiscovery(stop.signal)).rejects.toMatchObject({ code: 'interrupted' });
  stop.abort();
  await cancelled;
  await vi.waitFor(() => expect(stream).toBeDefined());
  stream!.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  await notified.waiting;
  initial.release();
  await manager.waitForToolDiscovery(active);
  await vi.waitFor(() => expect(manager.listToolsForAgent().map(binding => binding.tool.name)).toEqual(['ready_lookup']));
  expect(manager.listDiscoveryServers()).toEqual([{ id: saved.id, name: 'First', instructions: 'Directory lookup' }]);
  expect(remote.requests.filter(request => request.method === 'initialize')).toHaveLength(1);
});

it.each(['invalid list', 'storage failure'])('keeps the prior catalog when a live refresh encounters %s', async failure => {
  let catalog = [definition];
  let stream: ServerResponse | undefined;
  manager.subscribeToolCatalog(({ remoteToolNames }) => {
    if (remoteToolNames.includes('blocked_lookup')) throw new Error('Storage unavailable');
  });
  const remote = await fixture({
    stream: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      stream = res;
    },
    list: () => catalog,
  });
  const saved = await add(remote.url);
  await manager.connectServer(saved.id);
  await status(saved.id, 'connected');
  await vi.waitFor(() => expect(stream).toBeDefined());
  catalog = failure === 'invalid list' ? [definition, definition] : [{ ...definition, name: 'blocked_lookup' }];
  stream!.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  await vi.waitFor(() => expect(manager.listServers()[0]).toMatchObject({ status: 'connected', error: expect.any(String) }));
  expect(manager.listToolsForAgent().map(binding => binding.tool.name)).toEqual(['lookup']);
  catalog = [{ ...definition, name: 'recovered_lookup' }];
  stream!.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  await vi.waitFor(() => expect(manager.listToolsForAgent().map(binding => binding.tool.name)).toEqual(['recovered_lookup']));
  expect(manager.listServers()[0].error).toBeUndefined();
});

it('keeps declaration names owned by the same tools when a colliding tool is withdrawn', async () => {
  const first = { ...definition, name: 'find-page' };
  const second = { ...definition, name: 'find_page' };
  let catalog = [first, second];
  let stream: ServerResponse | undefined;
  const remote = await fixture({
    stream: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      stream = res;
    },
    list: () => catalog,
  });
  const saved = await add(remote.url);
  await manager.connectServer(saved.id);
  await status(saved.id, 'connected');
  await vi.waitFor(() => expect(stream).toBeDefined());
  const [, previous] = manager.listToolsForAgent();
  catalog = [second];
  stream!.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  await vi.waitFor(() => expect(manager.listToolsForAgent()).toHaveLength(1));
  expect(manager.listToolsForAgent()[0].name).toBe(previous.name);
});

it.each(['exhaust', 'disable', 'shutdown'])('recovers an idle stream drop with bounded retries (%s)', async action => {
  let stream: ServerResponse | undefined;
  let down = false;
  const remote = await fixture({
    stream: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      stream = res;
    },
    initializeStatus: () => down ? 503 : undefined,
  });
  const saved = await add(remote.url);
  await manager.setEnabled(saved.id, true);
  await status(saved.id, 'connected');
  await vi.waitFor(() => expect(stream).toBeDefined());
  down = true;
  stream!.end();
  const count = () => remote.requests.filter(request => request.method === 'initialize').length;
  await vi.waitFor(() => expect(count()).toBe(2));
  expect(manager.listServers()[0]).toMatchObject({ status: 'recovering', enabled: true });
  if (action === 'shutdown') {
    await manager.close();
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(count()).toBe(2);
    down = false;
    manager = new McpManager(directory);
    await manager.start();
    await status(saved.id, 'connected');
    expect(count()).toBe(3);
    return;
  }
  if (action === 'disable') {
    await manager.setEnabled(saved.id, false);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(count()).toBe(2);
  } else {
    await status(saved.id, 'connection_failed');
    expect(count()).toBe(4);
  }
  expect(manager.listServers()[0]).toMatchObject({ enabled: false, hasCredential: true, tools: [] });
  await manager.close();
  manager = new McpManager(directory);
  await manager.start();
  await status(saved.id, 'disabled');
  expect(count()).toBe(action === 'disable' ? 2 : 4);
});

it('turns off on a rejected access token and keeps the saved credential', async () => {
  const remote = await fixture({ rejectToken: () => true });
  const saved = await add(remote.url);
  await manager.setEnabled(saved.id, true);
  await status(saved.id, 'connection_failed');
  expect(manager.listServers()[0]).toMatchObject({
    enabled: false, hasCredential: true, error: 'The MCP service rejected its access token.', tools: [],
  });
  expect(remote.requests.filter(request => request.method === 'initialize')).toHaveLength(1);
});

it('turns off a stalled discovery and discards its late tools', async () => {
  const list = gate();
  const remote = await fixture({ list: async () => { await list.waiting; return [definition]; } });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const shorten = vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => timeout(delay === 15_000 ? 250 : delay));
  try {
    const saved = await add(remote.url);
    await manager.setEnabled(saved.id, true);
    await vi.waitFor(() => expect(remote.requests.some(request => request.method === 'tools/list')).toBe(true));
    await status(saved.id, 'connection_failed');
    expect(manager.listServers()[0]).toMatchObject({ enabled: false, tools: [] });
    list.release();
    expect(manager.listToolsForAgent()).toEqual([]);
  } finally {
    list.release();
    shorten.mockRestore();
  }
});

it.each([false, true])('retries a confirmed expired tool request once (replacement also expires: %s)', async expiresAgain => {
  const remote = await fixture({ call: (req, res, message) => {
    if (req.headers['mcp-session-id'] === '1' || expiresAgain) { res.writeHead(404).end(); return; }
    result(res, message, { content: [{ type: 'text', text: 'renewed' }] });
  } });
  const saved = await add(remote.url);
  await manager.connectServer(saved.id);
  await status(saved.id, 'connected');
  const [binding] = manager.listToolsForAgent();
  const pending = manager.callTool(binding, { query: 'x' }, active, () => {});
  if (expiresAgain) await expect(pending).rejects.toThrow(/过期/);
  else expect(await pending).toMatchObject({ content: [{ text: 'renewed' }] });
  expect(remote.requests.filter(request => request.method === 'tools/call').map(request => request.session)).toEqual(['1', '2']);
});

it('validates OAuth callback path and issuer, cancels stale attempts, and exchanges only once', async () => {
  const remote = await fixture({ oauth: true });
  const saved = await manager.saveServer({ name: 'OAuth fixture', url: remote.url, authMode: 'oauth' });
  await manager.connectServer(saved.id);
  await status(saved.id, 'authorization_required');
  const base = 'http://127.0.0.1:3000/api/mcp/oauth/callback';
  const first = await manager.startOAuth(saved.id, base);
  expect(await manager.startOAuth(saved.id, base)).toEqual(first);
  const firstQuery = new URL(first.authorizationUrl).searchParams;
  const path = new URL(firstQuery.get('redirect_uri')!).pathname;
  const callback = (state: string, issuer = remote.origin) => new URLSearchParams({ state, code: 'fixture-code', iss: issuer });
  await manager.cancelOAuth(saved.id, first.attemptId);
  expect(await manager.finishOAuth(path, callback(firstQuery.get('state')!))).toBe(false);
  await status(saved.id, 'disabled');
  expect(manager.listServers()[0].enabled).toBe(false);
  await manager.setEnabled(saved.id, true);
  await status(saved.id, 'authorization_required');

  const second = await manager.startOAuth(saved.id, base);
  const auth = new URL(second.authorizationUrl);
  const state = auth.searchParams.get('state')!;
  expect(remote.registrations).toHaveLength(1);
  expect(await manager.finishOAuth(path + '/wrong', callback(state))).toBe(false);
  expect(await manager.finishOAuth(path, callback(state, 'https://wrong.test'))).toBe(false);
  const duplicate = callback(state);
  duplicate.append('state', state);
  expect(await manager.finishOAuth(path, duplicate)).toBe(false);
  expect(remote.exchanges).toHaveLength(0);
  expect(JSON.stringify(manager.listServers())).not.toContain(state);
  expect((await readFile(join(directory, 'mcp-auth.json'), 'utf8'))).not.toContain(state);

  expect((await Promise.all([
    manager.finishOAuth(path, callback(state)), manager.finishOAuth(path, callback(state)),
  ])).sort()).toEqual([false, true]);
  expect(remote.exchanges).toHaveLength(1);
  expect(createHash('sha256').update(remote.exchanges[0].get('code_verifier')!).digest('base64url'))
    .toBe(auth.searchParams.get('code_challenge'));
  await status(saved.id, 'connected');
  expect(manager.listServers()[0]).toMatchObject({ hasCredential: true, tools: [{ name: expect.stringContaining('lookup') }] });
});

async function startAuthorization(url: string) {
  const service = await manager.saveServer({ name: 'OAuth fixture', url, authMode: 'oauth' });
  await manager.connectServer(service.id);
  await status(service.id, 'authorization_required');
  return service.id;
}

async function callbackFor(id: string, issuer: string) {
  const attempt = await manager.startOAuth(id, 'http://127.0.0.1:3000/api/mcp/oauth/callback');
  const query = new URL(attempt.authorizationUrl).searchParams;
  return {
    path: new URL(query.get('redirect_uri')!).pathname,
    query: new URLSearchParams({ code: 'fixture-code', state: query.get('state')!, iss: issuer }),
  };
}

it('expires the browser authorization, turns off and rejects its late callback', async () => {
  const remote = await fixture({ oauth: true });
  const id = await startAuthorization(remote.url);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = await callbackFor(id, remote.origin);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await manager.finishOAuth(pending.path, pending.query)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
  expect(manager.listServers()[0]).toMatchObject({ status: 'connection_failed', enabled: false, tools: [] });
  expect(remote.exchanges).toHaveLength(0);
});

it('turns off when an idle OAuth connection cannot recover its grant and needs a fresh enable', async () => {
  let stream: ServerResponse | undefined;
  let revoked = false;
  const remote = await fixture({
    oauth: true,
    rejectToken: () => revoked,
    stream: res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      stream = res;
    },
  });
  const id = await startAuthorization(remote.url);
  const accepted = await callbackFor(id, remote.origin);
  expect(await manager.finishOAuth(accepted.path, accepted.query)).toBe(true);
  await status(id, 'connected');
  await vi.waitFor(() => expect(stream).toBeDefined());
  revoked = true;
  stream!.end();
  await status(id, 'authorization_required');
  expect(manager.listServers()[0]).toMatchObject({ enabled: false, tools: [] });
  await expect(callbackFor(id, remote.origin)).rejects.toMatchObject({ statusCode: 409 });

  await manager.setEnabled(id, true);
  await status(id, 'authorization_required');
  const declined = await callbackFor(id, remote.origin);
  const denied = new URLSearchParams(declined.query);
  denied.delete('code');
  denied.set('error', 'access_denied');
  expect(await manager.finishOAuth(declined.path, denied)).toBe(false);
  await status(id, 'connection_failed');
  expect(manager.listServers()[0]).toMatchObject({ enabled: false, error: 'MCP authorization was declined.' });
  expect(await manager.finishOAuth(declined.path, declined.query)).toBe(false);
  expect(remote.exchanges).toHaveLength(1);
});

it('does not claim OAuth success if tokens cannot be written and can authorize again', async () => {
  const remote = await fixture({ oauth: true });
  const id = await startAuthorization(remote.url);
  const { path, query } = await callbackFor(id, remote.origin);
  const authFile = join(directory, 'mcp-auth.json');
  await chmod(authFile, 0o644);
  expect(await manager.finishOAuth(path, query)).toBe(false);
  await chmod(authFile, 0o600);
  await status(id, 'connection_failed');
  expect(manager.listServers()[0]).toMatchObject({ enabled: false, hasCredential: false });
  expect(await manager.finishOAuth(path, query)).toBe(false);
  await manager.setEnabled(id, true);
  await status(id, 'authorization_required');
  const retry = await callbackFor(id, remote.origin);
  expect(await manager.finishOAuth(retry.path, retry.query)).toBe(true);
  await status(id, 'connected');
  expect(remote.exchanges).toHaveLength(2);
});

it('keeps a saved grant if tool discovery fails and reconnects without a browser', async () => {
  let failDiscovery = true;
  const remote = await fixture({ oauth: true, list: () => failDiscovery ? 'invalid' : [definition] });
  const id = await startAuthorization(remote.url);
  const { path, query } = await callbackFor(id, remote.origin);
  expect(await manager.finishOAuth(path, query)).toBe(true);
  await status(id, 'connection_failed');
  expect(manager.listServers()[0]).toMatchObject({ enabled: false, hasCredential: true, tools: [] });
  failDiscovery = false;
  await manager.setEnabled(id, true);
  await status(id, 'connected');
  expect(remote.exchanges).toHaveLength(1);
});

it('refreshes the expired OAuth token in the current credential record, retaining its refresh token', async () => {
  const remote = await fixture({ oauth: true, token: params => params.get('grant_type') === 'refresh_token'
    ? { access_token: 'refreshed', token_type: 'Bearer', expires_in: 600 }
    : { access_token: 'initial', token_type: 'Bearer', expires_in: 1, refresh_token: 'refresh' } });
  const id = await startAuthorization(remote.url);
  const { path, query } = await callbackFor(id, remote.origin);
  const settingsFile = join(directory, 'mcp.json');
  const original = await readFile(settingsFile, 'utf8');
  expect(await manager.finishOAuth(path, query)).toBe(true);
  await status(id, 'connected');
  expect(remote.exchanges.map(form => form.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
  expect(remote.requests.filter(request => request.method === 'tools/list').map(request => request.authorization))
    .toEqual(['Bearer refreshed']);
  expect(await readFile(settingsFile, 'utf8')).toBe(original);
  const stored = JSON.parse(await readFile(join(directory, 'mcp-auth.json'), 'utf8'));
  expect(stored.records).toEqual([expect.objectContaining({
    state: expect.objectContaining({ tokens: expect.objectContaining({ access_token: 'refreshed', refresh_token: 'refresh' }) }),
  })]);
});
