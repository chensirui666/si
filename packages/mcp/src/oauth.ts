import { createHash, randomBytes } from 'node:crypto'
import { McpConnectionClosedError, type AuthProvider, type McpFetch } from '@earendil-works/pi-mcp'
import {
  discoverOAuthServerInfo, exchangeAuthorizationCode, McpOAuthAuthorizationRequiredError, McpRefreshLockBusyError,
  McpSignInCancelledError, OAuthError, OAuthIssuerMismatchError, parseWwwAuthenticate, refreshAuthorization,
  registerClient, selectResource, startAuthorization, stepUpScope,
  type McpAuthorizationResponse, type McpOAuthState, type McpSignInOptions as PiSignInOptions,
  type McpSignInRedirect, type McpSignInStart, type OAuthChallenge, type OAuthClientInformationMixed,
  type OAuthDiscoveryState, type OAuthTokens,
} from '@earendil-works/pi-mcp/oauth'

export interface McpSignInOptions extends PiSignInOptions {
  fetch?: McpFetch
  clientMetadataRedirectUrl?: string
}

const OAUTH_TIMEOUT_MS = 15_000
const REFRESH_SKEW_MS = 30_000

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

function checkEndpoint(input: string | URL, serverUrl: string): URL {
  const url = new URL(input)
  const local = isLoopback(url) && isLoopback(new URL(serverUrl))
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new TypeError('OAuth endpoints must use HTTPS or HTTP on the configured loopback host')
  }
  if (isLoopback(url) && !local) throw new TypeError('A remote MCP service cannot use a loopback OAuth endpoint')
  return url
}

function oauthFetch(options: McpSignInOptions): McpFetch {
  const fetch = options.fetch ?? globalThis.fetch
  return (input, init) => {
    const timeout = AbortSignal.timeout(OAUTH_TIMEOUT_MS)
    const signal = init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout
    return fetch(checkEndpoint(input, options.serverUrl), { ...init, signal, redirect: 'error' })
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new McpSignInCancelledError()
}

async function load(options: McpSignInOptions): Promise<McpOAuthState> {
  const serverUrl = new URL(options.serverUrl).href
  const state = await options.store.load()
  return state?.serverUrl === serverUrl ? state : { serverUrl }
}

function checkDiscovery(discovery: OAuthDiscoveryState, serverUrl: string): void {
  const metadata = discovery.authorizationServerMetadata
  for (const endpoint of [discovery.authorizationServerUrl, metadata?.issuer, metadata?.authorization_endpoint,
    metadata?.token_endpoint, metadata?.registration_endpoint]) {
    if (endpoint) checkEndpoint(endpoint, serverUrl)
  }
  selectResource(serverUrl, discovery.resourceMetadata)
}

async function discover(options: McpSignInOptions, stored?: OAuthDiscoveryState): Promise<OAuthDiscoveryState> {
  const metadataUrl = options.challenge?.resourceMetadataUrl?.href
  const discovery = stored && (!metadataUrl || metadataUrl === stored.resourceMetadataUrl) ? stored : {
    ...await discoverOAuthServerInfo(options.serverUrl, {
      fetch: oauthFetch(options), signal: options.signal, resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
      authorizationServerMetadataUrl: options.settings.authServerMetadataUrl,
    }),
    resourceMetadataUrl: metadataUrl,
  }
  checkDiscovery(discovery, options.serverUrl)
  return discovery
}

function sameGrant(left: OAuthDiscoveryState | undefined, right: OAuthDiscoveryState): boolean {
  return left !== undefined && left.authorizationServerUrl === right.authorizationServerUrl
    && left.resourceMetadata?.resource === right.resourceMetadata?.resource
}

interface Identity {
  client: OAuthClientInformationMixed
  redirectUrl: string
  registration?: OAuthClientInformationMixed
}

function selectIdentity(options: McpSignInOptions, discovery: OAuthDiscoveryState, state: McpOAuthState): Identity | undefined {
  const { settings, redirectUrl, clientMetadataDocuments: documents } = options
  if (settings.clientId) {
    return { client: { client_id: settings.clientId, client_secret: settings.clientSecret }, redirectUrl }
  }
  const registered = state.clientInformation
  if (sameGrant(state.discovery, discovery) && registered && 'redirect_uris' in registered
    && registered.redirect_uris.includes(redirectUrl)) {
    return { client: registered, redirectUrl, registration: registered }
  }
  const metadata = discovery.authorizationServerMetadata
  const documentRedirectUrl = options.clientMetadataRedirectUrl ?? redirectUrl
  const canUseDocument = documents?.listsRedirectUrl(documentRedirectUrl) && settings.clientRegistration !== 'dcr'
    && metadata?.client_id_metadata_document_supported && metadata.token_endpoint_auth_methods_supported?.includes('none')
  if (documents && canUseDocument) {
    const base = checkEndpoint(documents.baseUrl, options.serverUrl)
    if (base.protocol !== 'https:') throw new Error('A client identity document requires HTTPS')
    const document = base.href.replace(/\/$/, '')
    if (metadata.authorization_response_iss_parameter_supported) {
      return { client: { client_id: `${document}/client.json` }, redirectUrl: documentRedirectUrl }
    }
    const id = createHash('sha256').update(new URL(options.serverUrl).href).digest().subarray(0, 9).toString('base64url')
    const callback = new URL(documentRedirectUrl)
    callback.pathname = `${callback.pathname.replace(/\/$/, '')}/${id}`
    return { client: { client_id: `${document}/${id}/client.json` }, redirectUrl: callback.href }
  }
  return undefined
}

function tokenOptions(options: McpSignInOptions, discovery: OAuthDiscoveryState, identity: Identity) {
  return {
    metadata: discovery.authorizationServerMetadata,
    clientInformation: identity.client,
    resource: selectResource(options.serverUrl, discovery.resourceMetadata) ?? new URL(options.serverUrl).href,
    fetch: oauthFetch(options),
  }
}

function withTokens(state: McpOAuthState, tokens: OAuthTokens, scope?: string): McpOAuthState {
  return {
    ...state, tokens: { ...tokens, scope: tokens.scope ?? scope },
    tokensExpireAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1_000,
  }
}

export async function startMcpSignIn(options: McpSignInOptions): Promise<McpSignInStart> {
  throwIfCancelled(options.signal)
  const state = await load(options)
  const stepUp = options.challenge?.error === 'insufficient_scope'
  if (!options.challenge && state.tokens?.refresh_token) {
    try {
      await refresh(options, state.tokens.access_token)
      throwIfCancelled(options.signal)
      return { kind: 'authorized' }
    } catch (error) {
      if (!(error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpRefreshLockBusyError)) throw error
    }
  }

  const current = await load(options)
  const discovery = await discover(options, current.discovery)
  throwIfCancelled(options.signal)
  let identity = selectIdentity(options, discovery, current)
  if (!identity) {
    if (options.settings.clientRegistration === 'cimd') throw new Error('OAuth client identity document is unavailable')
    const registration = await registerClient(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientMetadata: {
        client_name: options.settings.clientName ?? options.clientName,
        redirect_uris: [options.redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none',
      },
      fetch: oauthFetch(options), signal: options.signal,
    })
    identity = { client: registration, registration, redirectUrl: options.redirectUrl }
  }
  const challenged = stepUp ? stepUpScope(current.tokens?.scope, options.challenge?.scope) : options.challenge?.scope
  const scope = [...new Set([options.settings.scope, challenged].flatMap(value => value?.split(/\s+/).filter(Boolean) ?? []))].join(' ')
    || discovery.resourceMetadata?.scopes_supported?.join(' ')
  const oauthState = randomBytes(32).toString('hex')
  const authorization = await startAuthorization(discovery.authorizationServerUrl, {
    ...tokenOptions(options, discovery, identity), redirectUrl: identity.redirectUrl, state: oauthState, scope,
  })
  checkEndpoint(authorization.authorizationUrl, options.serverUrl)
  throwIfCancelled(options.signal)
  const clientInformation = identity.registration ?? { client_id: identity.client.client_id }
  const latest = await load(options)
  const retainGrant = sameGrant(latest.discovery, discovery) && latest.clientInformation?.client_id === clientInformation.client_id
  throwIfCancelled(options.signal)
  await options.store.save({
    ...(retainGrant ? latest : { serverUrl: current.serverUrl }),
    discovery, clientInformation, oauthState, codeVerifier: authorization.codeVerifier,
  })
  return { kind: 'redirect', authorizationUrl: authorization.authorizationUrl.href, redirectUrl: identity.redirectUrl, state: oauthState, scope }
}

export async function completeMcpSignIn(options: McpSignInOptions & {
  authorization: McpSignInRedirect
  response: McpAuthorizationResponse
}): Promise<void> {
  throwIfCancelled(options.signal)
  const { authorization, response } = options
  const state = await load(options)
  if (response.state !== authorization.state || state.oauthState !== authorization.state || !state.codeVerifier || !state.discovery) {
    throw new Error('The OAuth authorization attempt is no longer valid')
  }
  const discovery = state.discovery
  checkDiscovery(discovery, options.serverUrl)
  const metadata = discovery.authorizationServerMetadata
  if ((response.iss !== undefined || metadata?.authorization_response_iss_parameter_supported) && response.iss !== metadata?.issuer) {
    throw new OAuthIssuerMismatchError(metadata?.issuer, response.iss)
  }
  const identity = selectIdentity(options, discovery, state)
  if (!identity || identity.redirectUrl !== authorization.redirectUrl
    || new URL(authorization.authorizationUrl).searchParams.get('client_id') !== identity.client.client_id) {
    throw new Error('The OAuth client identity changed before the callback')
  }
  const tokens = await exchangeAuthorizationCode(discovery.authorizationServerUrl, {
    ...tokenOptions(options, discovery, identity), code: response.code, codeVerifier: state.codeVerifier,
    redirectUrl: authorization.redirectUrl, signal: options.signal,
  })
  throwIfCancelled(options.signal)
  const current = await load(options)
  if (current.oauthState !== authorization.state) throw new Error('The OAuth authorization attempt changed during the callback')
  await options.store.save(withTokens({ ...current, oauthState: undefined, codeVerifier: undefined }, tokens, authorization.scope))
}

async function refresh(options: McpSignInOptions, staleToken: string | undefined, challenge?: OAuthChallenge): Promise<void> {
  await options.store.withRefreshLock(async () => {
    const state = await load(options)
    if (state.tokens?.access_token !== staleToken && state.tokens?.access_token) return
    if (!state.tokens?.refresh_token || !state.discovery) throw new McpOAuthAuthorizationRequiredError()
    // A refresh may rotate the token. Persist its result even if the initiating tool stopped waiting.
    const settings = { ...options, signal: undefined, challenge: challenge ?? options.challenge }
    const discovery = await discover(settings, state.discovery)
    const identity = selectIdentity(settings, discovery, state)
    if (!identity || identity.client.client_id !== state.clientInformation?.client_id || !sameGrant(state.discovery, discovery)) {
      throw new McpOAuthAuthorizationRequiredError()
    }
    try {
      const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
        ...tokenOptions(settings, discovery, identity), refreshToken: state.tokens.refresh_token,
      })
      const current = await load(options)
      if (current.tokens?.access_token === staleToken) {
        await options.store.save(withTokens(current, tokens, state.tokens.scope))
      }
    } catch (error) {
      if (!(error instanceof OAuthError) || !['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)) throw error
      const current = await load(options)
      if (current.tokens?.access_token === staleToken) {
        await options.store.save({
          ...current, tokens: undefined, tokensExpireAt: undefined,
          clientInformation: error.code === 'invalid_grant' || current.oauthState ? current.clientInformation : undefined,
        })
      }
      throw new McpOAuthAuthorizationRequiredError()
    }
  })
}

export function oauthAuthProvider(
  options: McpSignInOptions,
  onChallenge?: (challenge: OAuthChallenge) => void,
): AuthProvider & { settle(): Promise<void> } {
  let refreshInFlight: Promise<void> | undefined
  let closing = false
  const refreshOnce = (stale: string | undefined, challenge?: OAuthChallenge) => {
    if (closing) throw new McpConnectionClosedError()
    refreshInFlight ??= refresh(options, stale, challenge).finally(() => { refreshInFlight = undefined })
    return refreshInFlight
  }
  return {
    settle: async () => {
      closing = true
      await refreshInFlight?.catch(() => {})
    },
    token: async () => {
      const state = await load(options)
      if (state.tokens?.refresh_token && state.tokensExpireAt !== undefined && state.tokensExpireAt - Date.now() < REFRESH_SKEW_MS) {
        await refreshOnce(state.tokens.access_token)
        return (await load(options)).tokens?.access_token
      }
      return state.tokens?.access_token
    },
    onUnauthorized: async context => {
      const challenge = parseWwwAuthenticate(context.response.headers.get('www-authenticate'))
      onChallenge?.(challenge)
      if (challenge.error === 'insufficient_scope') throw new McpOAuthAuthorizationRequiredError()
      await refreshOnce(context.token, challenge)
    },
  }
}
