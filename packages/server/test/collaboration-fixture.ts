import { fork, type ChildProcess } from 'node:child_process'
import { on, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionSummary } from '@agent-learning/coding-agent'
import { afterEach, expect, vi } from 'vitest'
import WebSocket from 'ws'
import { startModelServer } from '../../../web/tests/e2e/model-server.js'
import type { ConversationSnapshot, ServerFrame, SubmitMessageRequest } from '../src/webserver/protocol.js'

const fixturePath = fileURLToPath(new URL('../../../web/tests/e2e/server-fixture.mjs', import.meta.url))
const fixtureKey = 'controlled-stage3-key'
export const deepseek = { modelId: 'deepseek-flash' }
export const vision = { provider: 'qwen', modelId: 'qwen3.6-plus', reasoningEffort: 'high' } as const
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

export async function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode]
  const exited = once(child, 'exit')
  child.kill(signal)
  const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { return await exited }
  finally { clearTimeout(deadline) }
}

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-collaboration-webserver-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const provider = await startModelServer()
  cleanup.push(provider.close)
  const requestNumber = async (number: number) => {
    await vi.waitFor(() => expect(provider.exchanges).toHaveLength(number), { timeout: 4000 })
    return provider.exchanges[number - 1]!
  }
  const start = async () => {
    const child = fork(fixturePath, ['0', join(directory, 'browser-auth.json')], {
      env: { ...process.env, AGENT_LEARNING_E2E_MODEL_BASE_URL: provider.baseURL, AGENT_LEARNING_E2E_MODEL_CLOCK: '' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    cleanup.push(() => stop(child, 'SIGKILL'))
    const [startup] = await once(child, 'message', { signal: AbortSignal.timeout(6000) }) as [{ type: string; result: { url: string; authUrl: string } }]
    expect(startup.type).toBe('started')
    const { url, authUrl } = startup.result
    const auth = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    expect(auth.status).toBe(303)
    const cookie = auth.headers.getSetCookie()[0]!.split(';')[0]!
    const request = (path: string, init: RequestInit = {}) => fetch(url + path, {
      signal: AbortSignal.timeout(6000), ...init, headers: { Cookie: cookie, ...init.headers },
    })
    const call = (path: string, body?: unknown, method = 'POST') => request(path, {
      method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    })
    const pick = async () => {
      const response = await call('/api/workspaces/pick')
      expect(response.status).toBe(200)
      return (await response.json() as { workspaceId: string }).workspaceId
    }
    const create = async (workspaceId: string) => {
      const response = await call('/api/sessions', { workspaceId })
      expect(response.status).toBe(201)
      return (await response.json() as SessionSummary).id
    }
    const saveKey = async (providerId = 'deepseek') => {
      expect((await call(`/api/providers/${providerId}`, { apiKey: fixtureKey }, 'PUT')).status).toBe(200)
    }
    const snapshot = async (sessionId: string): Promise<ConversationSnapshot> => {
      const signal = AbortSignal.timeout(3000)
      const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/events', { headers: { Cookie: cookie } })
      try {
        await once(socket, 'open', { signal })
        const frames = on(socket, 'message', { signal })
        socket.send(JSON.stringify({ type: 'subscribe', sessionId, subscriptionId: 'collaboration' }))
        for await (const [data] of frames) {
          const frame = JSON.parse(String(data)) as ServerFrame
          if (frame.type === 'snapshot') return frame.snapshot
          if (frame.type === 'subscription_error') throw new Error(frame.error)
        }
        throw new Error('会话未发送快照')
      } finally { socket.terminate() }
    }
    const send = (sessionId: string, clientMessageId: string, text = clientMessageId,
      options: Partial<SubmitMessageRequest> = {}) => call('/api/messages', { sessionId, clientMessageId, text, ...deepseek, ...options })
    const accept = async (...args: Parameters<typeof send>) => {
      const res = await send(...args)
      const receipt = await res.json() as { kind: string; clientMessageId: string; userMessageId?: string }
      expect(res.status, JSON.stringify(receipt)).toBe(202)
      return receipt
    }
    const queue = (sessionId: string, clientMessageId: string, action?: { action: 'edit'; text: string } | { action: 'steer' }) =>
      call(`/api/sessions/${sessionId}/queue/${clientMessageId}`, action, action ? 'PATCH' : 'DELETE')
    return { child, request, call, pick, create, saveKey, snapshot, accept, queue }
  }
  return { directory, provider, requestNumber, start }
}

export type Exchange = Awaited<ReturnType<typeof startModelServer>>['exchanges'][number]
export function finish(exchange: Exchange, content = '已完成。') {
  exchange.delta({ role: 'assistant', content })
  exchange.finish()
}
export function toolCall(exchange: Exchange, name: string, args: object) {
  exchange.delta({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] })
  exchange.finish('tool_calls')
}
export function userTexts(exchange: Exchange) {
  return exchange.body.messages.filter(message => message.role === 'user').map(message => message.content)
}
