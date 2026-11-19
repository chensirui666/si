import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import {
  completeMcpSignIn, McpClient, McpRequestFailedError, startMcpSignIn, type McpFetch, type McpOAuthState, type McpSignInOptions,
} from '../src/index.js'

const serverUrl = 'https://mcp.example.test/mcp'
const issuer = 'https://login.example.test'
const redirectUrl = 'http://127.0.0.1:3000/api/mcp/oauth/callback/test'

function fixture({ tokenEndpoint = `${issuer}/token`, register = true, supportsIssuer = true }: {
  tokenEndpoint?: string; register?: boolean; supportsIssuer?: boolean
} = {}) {
  let state: McpOAuthState | undefined
  const registerRequests: Record<string, unknown>[] = []
  const exchanges: URLSearchParams[] = []
  const requests: string[] = []
  const fetch: McpFetch = async (target, init) => {
    expect(init?.redirect).toBe('error')
    const url = new URL(target)
    requests.push(url.href)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return Response.json({ resource: serverUrl, authorization_servers: [issuer] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return Response.json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: tokenEndpoint,
        ...(register ? { registration_endpoint: `${issuer}/register` } : {}),
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: supportsIssuer,
      })
    }
    if (url.pathname === '/register') {
      const registration = JSON.parse(String(init?.body)) as Record<string, unknown>
      registerRequests.push(registration)
      return Response.json({ ...registration, client_id: 'dynamic-client' })
    }
    if (url.pathname === '/token') {
      exchanges.push(new URLSearchParams(String(init?.body)))
      const refreshing = exchanges.at(-1)?.get('grant_type') === 'refresh_token'
      return Response.json(refreshing ? { access_token: 'rotated-token', token_type: 'Bearer' }
        : { access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer' })
    }
    throw new Error(`Unexpected request ${url}`)
  }
  const options: McpSignInOptions = {
    serverUrl, redirectUrl, clientName: 'Fixture', settings: {}, fetch,
    store: {
      load: () => state && structuredClone(state),
      save: value => { state = structuredClone(value) },
      withRefreshLock: fn => fn(),
    },
  }
  return { options, registerRequests, exchanges, requests }
}

it('uses an exact callback, exchanges only once, and binds token to resource and issuer', async () => {
  const { options, registerRequests, exchanges } = fixture()
  const authorization = await startMcpSignIn(options)
  if (authorization.kind !== 'redirect') throw new Error('Expected redirect')
  const query = new URL(authorization.authorizationUrl).searchParams
  expect(registerRequests).toEqual([expect.objectContaining({ application_type: 'native', redirect_uris: [redirectUrl] })])
  expect(query.get('code_challenge_method')).toBe('S256')
  expect(query.get('resource')).toBe(serverUrl)
  const response = { code: 'test-code', state: authorization.state, iss: issuer }
  await expect(completeMcpSignIn({ ...options, authorization, response: { ...response, iss: 'https://wrong.example.test' } })).rejects.toThrow()
  expect(exchanges).toHaveLength(0)
  await completeMcpSignIn({ ...options, authorization, response })
  await expect(completeMcpSignIn({ ...options, authorization, response })).rejects.toThrow()
  expect(exchanges).toHaveLength(1)
  expect(exchanges[0].get('resource')).toBe(serverUrl)
  expect(exchanges[0].get('redirect_uri')).toBe(redirectUrl)
  expect(createHash('sha256').update(exchanges[0].get('code_verifier')!).digest('base64url')).toBe(query.get('code_challenge'))
  expect(await options.store.load()).toMatchObject({ tokens: { access_token: 'access-token' } })
  expect((await options.store.load())?.codeVerifier).toBeUndefined()
})

it('uses configured IDs before compatible registrations, then CIMD before DCR', async () => {
  const { options, registerRequests } = fixture()
  const getClient = async (signInOptions: McpSignInOptions) => {
    const result = await startMcpSignIn(signInOptions)
    return result.kind === 'redirect' && new URL(result.authorizationUrl).searchParams.get('client_id')
  }
  const documents = { baseUrl: 'https://si.example.test/oauth', listsRedirectUrl: () => true }
  const withDocuments = { ...options, clientMetadataDocuments: documents }
  expect(await getClient({ ...withDocuments, settings: { clientId: 'configured' } })).toBe('configured')
  expect(await getClient(withDocuments)).toBe(`${documents.baseUrl}/client.json`)
  expect(await getClient(options)).toBe('dynamic-client')
  expect(await getClient(withDocuments)).toBe('dynamic-client')
  expect(registerRequests).toHaveLength(1)
})

it.each([true, false])('uses the public document callback through token exchange and refresh (issuer supported: %s)', async supportsIssuer => {
  const { options, registerRequests, exchanges } = fixture({ supportsIssuer })
  const baseUrl = 'https://si.example.test/oauth'
  const callback = 'http://127.0.0.1:3000/api/mcp/oauth/callback'
  const signIn: McpSignInOptions = {
    ...options, clientMetadataRedirectUrl: callback,
    clientMetadataDocuments: { baseUrl, listsRedirectUrl: (url: string) => url === callback },
  }
  const id = createHash('sha256').update(serverUrl).digest().subarray(0, 9).toString('base64url')
  const suffix = supportsIssuer ? '' : `/${id}`
  const authorization = await startMcpSignIn(signIn)
  if (authorization.kind !== 'redirect') throw new Error('Expected redirect')
  expect(new URL(authorization.authorizationUrl).searchParams.get('client_id')).toBe(`${baseUrl}${suffix}/client.json`)
  expect(authorization.redirectUrl).toBe(`${callback}${suffix}`)
  await completeMcpSignIn({
    ...signIn, authorization,
    response: { code: 'test-code', state: authorization.state, ...(supportsIssuer && { iss: issuer }) },
  })
  await expect(startMcpSignIn(signIn)).resolves.toEqual({ kind: 'authorized' })
  expect(registerRequests).toHaveLength(0)
  expect(exchanges.map(form => form.get('client_id'))).toEqual(Array(2).fill(`${baseUrl}${suffix}/client.json`))
  expect(exchanges[0].get('redirect_uri')).toBe(`${callback}${suffix}`)
})

it('rejects an insecure token endpoint before requesting browser authorization', async () => {
  const { options, requests } = fixture({ tokenEndpoint: 'http://login.example.test/token' })
  await expect(startMcpSignIn(options)).rejects.toThrow()
  expect(requests.some(url => url.endsWith('/register') || url.endsWith('/token'))).toBe(false)
})

it('shares OAuth refresh after concurrent 401s and never automatically resends tool POSTs', async () => {
  const { options, exchanges } = fixture()
  const authorization = await startMcpSignIn(options)
  if (authorization.kind !== 'redirect') throw new Error('Expected redirect')
  await completeMcpSignIn({ ...options, authorization, response: { code: 'test-code', state: authorization.state, iss: issuer } })
  let authenticated = false
  let calls = 0
  let challenges = 0
  let releaseUnauthorized: () => void = () => {}
  const bothRejected = new Promise<void>(resolve => { releaseUnauthorized = resolve })
  const fetch: McpFetch = async (url, init) => {
    if (new URL(url).pathname === '/token') {
      const response = await options.fetch!(url, init)
      authenticated = true
      return response
    }
    if (init?.method === 'GET' || init?.method === 'DELETE') return new Response(null, { status: 405 })
    const message = JSON.parse(String(init?.body)) as { method: string; id?: number }
    if (message.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      } })
    }
    if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 })
    calls++
    if (authenticated) {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer rotated-token')
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { content: [] } })
    }
    if (calls === 2) releaseUnauthorized()
    await bothRejected
    return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } })
  }
  const client = new McpClient({ url: serverUrl, oauth: { ...options, fetch }, fetch, onChallenge: () => { challenges++ }, timeoutMs: 500 })
  try {
    await client.connect()
    await Promise.all(['one', 'two'].map(name => expect(client.callTool(name, {})).rejects.toBeInstanceOf(McpRequestFailedError)))
    expect(challenges).toBe(2)
    expect(exchanges.map(exchange => exchange.get('grant_type'))).toEqual(['authorization_code', 'refresh_token'])
    expect((await options.store.load())?.tokens).toMatchObject({ access_token: 'rotated-token', refresh_token: 'refresh-token' })
    expect(calls).toBe(2)
    await expect(client.callTool('new-call', {})).resolves.toEqual({ content: [] })
    expect(calls).toBe(3)
  } finally {
    await client.close()
  }
})

it('never follows a token POST redirect with the authorization code and PKCE verifier', async () => {
  let origin = ''
  let redirectedRequests = 0
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/.well-known/oauth-protected-resource/mcp') {
      response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }))
    } else if (request.url === '/.well-known/oauth-authorization-server') {
      response.end(JSON.stringify({
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      }))
    } else if (request.url === '/token') {
      response.writeHead(307, { location: '/redirected' }).end()
    } else {
      if (request.url === '/redirected') redirectedRequests++
      response.writeHead(404).end()
    }
  }).listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback TCP listener')
    origin = `http://127.0.0.1:${address.port}`
    const { options } = fixture()
    const local = { ...options, serverUrl: `${origin}/mcp`, settings: { clientId: 'known-client' }, fetch: undefined }
    const authorization = await startMcpSignIn(local)
    if (authorization.kind !== 'redirect') throw new Error('Expected redirect')
    await expect(completeMcpSignIn({
      ...local, authorization, response: { code: 'test-code', state: authorization.state },
    })).rejects.toThrow()
    expect(redirectedRequests).toBe(0)
    expect((await options.store.load())?.tokens).toBeUndefined()
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
