export default {
  fetch(request) {
    const url = new URL(request.url)
    const match = /^\/oauth\/(?:([A-Za-z0-9_-]{12})\/)?client\.json$/.exec(url.pathname)
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
    if (!match || !host || url.host !== host || url.href !== url.origin + url.pathname) {
      return new Response(null, { status: 404 })
    }
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })

    const callback = 'http://127.0.0.1/api/mcp/oauth/callback'
    return Response.json({
      // Vercel terminates TLS before invoking this function.
      client_id: `https://${host}${url.pathname}`,
      client_name: 'SI',
      application_type: 'native',
      redirect_uris: [match[1] ? `${callback}/${match[1]}` : callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }, { headers: { 'Cache-Control': 'public, max-age=300' } })
  },
}
