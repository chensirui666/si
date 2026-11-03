import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { BrowserCookiePayload } from './protocol.js'

const lifetime = 30 * 86400000
function same(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b)
}
function decode(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') === value) return bytes
}

export function trustedRequest(headers: IncomingHttpHeaders, origins: ReadonlySet<string>, secure = false): boolean {
  const host = headers.host
  if (!host || !origins.has(`${secure ? 'https' : 'http'}://${host}`)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  return origin === undefined || origin === `${secure ? 'https' : 'http'}://${host}`
}

export class BrowserAuth {
  private readonly token = randomBytes(32).toString('base64url')
  constructor(private readonly secret: Buffer, private readonly now: () => number = Date.now) {}

  authenticatedUrl(url: string): string {
    const result = new URL(url)
    result.searchParams.set('token', this.token)
    return result.href
  }
  matchesToken(value: string): boolean {
    return same(Buffer.from(value), Buffer.from(this.token))
  }
  private cookieName(authority: string): string {
    return `agent-auth-${createHash('sha256').update(authority).digest('base64url')}`
  }
  private signature(body: string): Buffer {
    return createHmac('sha256', this.secret).update(body).digest()
  }
  issue(authority: string, secure = false): string {
    const issuedAt = this.now()
    const expiresAt = issuedAt + lifetime
    const payload: BrowserCookiePayload = { version: 1, authority, issuedAt, expiresAt }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const value = `v1.${body}.${this.signature(body).toString('base64url')}`
    return `${this.cookieName(authority)}=${value}; Max-Age=${lifetime / 1000}; Expires=${new Date(expiresAt).toUTCString()}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  }
  authenticated(authority: string, cookie: string | undefined): boolean {
    if (!cookie) return false
    const name = this.cookieName(authority)
    const values = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='))
    if (values.length !== 1) return false
    const [version, body, mac, extra] = values[0]!.slice(name.length + 1).split('.')
    if (version !== 'v1' || !body || !mac || extra !== undefined) return false
    const signature = decode(mac)
    const bytes = decode(body)
    if (!signature || !bytes || !same(signature, this.signature(body))) return false
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (!value || typeof value !== 'object') return false
      const p = value as Partial<BrowserCookiePayload>
      const now = this.now()
      return p.version === 1 && p.authority === authority && Number.isSafeInteger(p.issuedAt)
        && Number.isSafeInteger(p.expiresAt) && p.issuedAt! <= now && p.expiresAt! > now
        && p.expiresAt! > p.issuedAt! && p.expiresAt! - p.issuedAt! <= lifetime
    } catch { return false }
  }
}
