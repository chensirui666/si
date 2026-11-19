import type { McpOAuthServerStore, McpOAuthState, McpSignInRedirect } from '@agent-learning/mcp';

export interface McpOAuthStartView {
  attemptId: string;
  authorizationUrl: string;
}

export function temporaryOAuthStore(durable: McpOAuthServerStore, state: McpOAuthState | undefined) {
  return {
    withRefreshLock: <T>(operation: () => Promise<T>) => durable.withRefreshLock(operation),
    load: () => state,
    save: (next: McpOAuthState) => { state = next; },
  };
}

export function durableOAuthState(state: McpOAuthState): McpOAuthState {
  const { codeVerifier: _verifier, oauthState: _state, ...durable } = state;
  return durable;
}

export function oauthCallback(
  redirect: McpSignInRedirect,
  oauth: McpOAuthState | undefined,
  path: string,
  query: URLSearchParams,
): { code: string; state: string; iss?: string } | 'denied' | undefined {
  if (new URL(redirect.redirectUrl).pathname !== path || new Set(query.keys()).size !== query.size) return;
  const state = query.get('state');
  const iss = query.get('iss');
  const discovery = oauth?.discovery;
  const metadata = discovery?.authorizationServerMetadata;
  const issuer = metadata?.issuer ?? discovery?.authorizationServerUrl;
  if (state !== redirect.state || !issuer || (iss !== null && iss !== issuer) ||
      (iss === null && metadata?.authorization_response_iss_parameter_supported)) return;

  const code = query.get('code');
  const error = query.get('error');
  if (code && error === null) return { code, state, ...(iss !== null && { iss }) };
  if (error && code === null) return 'denied';
}

export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = () => signal.removeEventListener('abort', abort);
    const abort = () => reject(interrupted());
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void pending.then(value => { settle(); resolve(value); }, error => { settle(); reject(error); });
  });
}

export function interrupted(): Error {
  return Object.assign(new Error('任务已停止，MCP 工具请求未发送。'), { code: 'interrupted' });
}
