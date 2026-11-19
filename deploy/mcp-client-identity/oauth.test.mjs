import assert from 'node:assert/strict'
import test from 'node:test'

test('serves canonical SI identity documents for the shared and server-specific callbacks', async () => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'si-oauth.example.com'
  const { default: { fetch } } = await import('./api/oauth.mjs')
  const origin = 'https://si-oauth.example.com'

  for (const [path, callback] of [
    ['/oauth/client.json', 'http://127.0.0.1/api/mcp/oauth/callback'],
    ['/oauth/Abc-Def_1234/client.json', 'http://127.0.0.1/api/mcp/oauth/callback/Abc-Def_1234'],
  ]) {
    const clientId = origin + path
    const response = fetch(new Request(clientId))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'application/json')
    assert.deepEqual(await response.json(), {
      client_id: clientId,
      client_name: 'SI',
      application_type: 'native',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  }

  for (const url of [
    `${origin}/oauth/short/client.json`,
    `${origin}/oauth/Abc+Def_1234/client.json`,
    `${origin}/oauth/client.json?callback=other`,
    `${origin}/api/oauth`,
    'https://preview.example.com/oauth/client.json',
  ]) assert.equal(fetch(new Request(url)).status, 404)

  const forwarded = fetch(new Request('http://si-oauth.example.com/oauth/client.json'))
  assert.equal(forwarded.status, 200)
  assert.equal((await forwarded.json()).client_id, `${origin}/oauth/client.json`)
})
