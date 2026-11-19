import { describe, expect, it } from 'vitest'
import {
  McpClient, McpOutcomeUnknownError, McpRequestFailedError, McpSessionExpiredError,
  validateMcpArguments, type McpFetch,
} from '../src/index.js'

const url = 'https://mcp.example.test/mcp'
const definition = { name: 'lookup', inputSchema: { type: 'object', required: ['query'] } }

type RpcMessage = { id?: number; method: string; params?: unknown }
type Reply = (message: RpcMessage, init?: RequestInit) => Response | Promise<Response>

function rpcResult(id: number | undefined, result: unknown, headers?: Record<string, string>) {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers })
}

async function connected(reply: Reply, session = 'test-session') {
  const calls: RpcMessage[] = []
  const fetch: McpFetch = async (target, init) => {
    expect(String(target)).toBe(url)
    expect(init?.redirect).toBe('error')
    if (init?.method === 'GET' || init?.method === 'DELETE') return new Response(null, { status: 405 })
    const message = JSON.parse(String(init?.body)) as RpcMessage
    if (message.method === 'initialize') {
      return rpcResult(message.id, {
        protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      }, session ? { 'mcp-session-id': session } : undefined)
    }
    if (message.method === 'tools/list') return rpcResult(message.id, { tools: [definition] })
    if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 })
    calls.push(message)
    return reply(message, init)
  }
  const client = new McpClient({ url, token: 'fixture-token', fetch, timeoutMs: 500 })
  await client.connect()
  return { client, calls }
}

describe('Streamable HTTP', () => {
  it('discovers tools and checks permission at the actual tool send', async () => {
    const args = { query: 'title' }
    const { client, calls } = await connected((message, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token')
      return rpcResult(message.id, { content: [{ type: 'text', text: 'found' }] })
    })
    try {
      expect(await client.listTools()).toEqual([definition])
      const blocked = new Error('permission changed')
      await expect(client.callTool('lookup', args, { beforeSend: () => { throw blocked } })).rejects.toBe(blocked)
      expect(calls).toHaveLength(0)
      await expect(client.callTool('lookup', args)).resolves.toEqual({ content: [{ type: 'text', text: 'found' }] })
      expect(calls).toHaveLength(1)
      expect(calls[0].params).toEqual({ name: 'lookup', arguments: args })
    } finally {
      await client.close()
    }
  })

  it('records an unknown result on network loss and closes the local transport once', async () => {
    const { client, calls } = await connected(() => { throw new TypeError('fetch failed') })
    let closes = 0
    client.onClose(() => { closes++ })
    await expect(client.callTool('lookup', {})).rejects.toBeInstanceOf(McpOutcomeUnknownError)
    await client.close()
    expect(closes).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('preserves explicit remote error results without disconnecting', async () => {
    const { client, calls } = await connected(message => rpcResult(message.id, {
      isError: true, content: [{ type: 'text', text: 'resource not found' }],
    }))
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(client.callTool('lookup', {})).resolves.toMatchObject({ isError: true })
      }
      expect(calls).toHaveLength(2)
    } finally {
      await client.close()
    }
  })

  it('classifies a 404 as session expiry only when the request carries a valid session ID', async () => {
    for (const session of ['test-session', '', 'invalid session']) {
      const { client, calls } = await connected(() => new Response(null, { status: 404 }), session)
      try {
        await expect(client.callTool('lookup', {})).rejects.toBeInstanceOf(
          session === 'test-session' ? McpSessionExpiredError : McpRequestFailedError,
        )
        expect(calls).toHaveLength(1)
      } finally {
        await client.close()
      }
    }
  })
})

describe('MCP argument validation', () => {
  it('checks schema constraints and resolves only local references', () => {
    const schema = {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { $ref: '#/$defs/query' } },
      $defs: { query: { type: 'string', minLength: 3 } },
    }
    expect(validateMcpArguments(schema, { query: 'title' })).toBe(true)
    expect(validateMcpArguments(schema, { query: 'x' })).toBe(false)
    expect(validateMcpArguments(schema, { query: 'title', extra: 'x' })).toBe(false)
    expect(validateMcpArguments({ $ref: 'https://mcp.example.test/schema' }, {})).toBe(false)
    expect(validateMcpArguments({ type: 'object' }, [])).toBe(false)
  })
})

it('does not send after the final guard cancels the call', async () => {
  const { client, calls } = await connected(message => rpcResult(message.id, { content: [] }))
  const controller = new AbortController()
  try {
    await expect(client.callTool('lookup', {}, { signal: controller.signal, beforeSend: () => controller.abort() })).rejects.toHaveProperty('name', 'AbortError')
    expect(calls).toHaveLength(0)
  } finally {
    await client.close()
  }
})

it('reports a malformed remote result as unknown', async () => {
  const { client } = await connected(message => rpcResult(message.id, { content: [null] }))
  try {
    await expect(client.callTool('lookup', {})).rejects.toBeInstanceOf(McpOutcomeUnknownError)
  } finally {
    await client.close()
  }
})
