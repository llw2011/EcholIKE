import type { DesktopBootstrap } from './tauri'
import { backendErrorDiagnostic } from './userErrors'

export const DESKTOP_AUTH_TOKEN_KEY = 'echolike.v2.authToken'
export const DESKTOP_AUTH_STATE_CHANGED_EVENT = 'desktop-auth:state-changed'

export type DesktopAuthStatus = 'unknown' | 'authenticated' | 'rejected'

export type DesktopBootstrapIdentity =
  | { kind: 'public'; token: null }
  | { kind: 'authenticated'; token: string; email: string }
  | { kind: 'rejected'; token: string }
  | { kind: 'stale' }

export function normalizeDesktopAuthToken(token: string | null | undefined): string | null {
  return token?.trim() || null
}

export function readDesktopAuthToken(): string | null {
  return readDesktopAuthTokenResult().token
}

export function readDesktopAuthTokenResult():
  | { ok: true; token: string | null }
  | { ok: false; token: null; error: unknown } {
  try {
    return {
      ok: true,
      token: normalizeDesktopAuthToken(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)),
    }
  } catch (error) {
    console.warn('Desktop auth token read skipped:', error)
    return { ok: false, token: null, error }
  }
}

export function saveDesktopAuthToken(token: string): void {
  const normalized = normalizeDesktopAuthToken(token)
  if (!normalized) return
  localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, normalized)
}

export function clearDesktopAuthToken(): void {
  localStorage.removeItem(DESKTOP_AUTH_TOKEN_KEY)
}

export function clearDesktopAuthTokenIfCurrent(expectedToken: string): boolean {
  const normalized = normalizeDesktopAuthToken(expectedToken)
  if (!normalized) return false
  const current = readDesktopAuthTokenResult()
  if (!current.ok) throw current.error
  if (current.token !== normalized) return false
  clearDesktopAuthToken()
  return true
}

export function desktopBootstrapEmail(bootstrap: DesktopBootstrap | null): string | null {
  return bootstrap?.user?.email?.trim() || null
}

export function classifyDesktopBootstrapIdentity(
  bootstrap: DesktopBootstrap,
  requestedToken: string | null | undefined,
  authorityToken: string | null | undefined,
): DesktopBootstrapIdentity {
  const requested = normalizeDesktopAuthToken(requestedToken)
  const authority = normalizeDesktopAuthToken(authorityToken)
  if (requested !== authority) return { kind: 'stale' }
  if (!requested)
    return desktopBootstrapEmail(bootstrap) ? { kind: 'stale' } : { kind: 'public', token: null }

  const email = desktopBootstrapEmail(bootstrap)
  return email
    ? { kind: 'authenticated', token: requested, email }
    : { kind: 'rejected', token: requested }
}

export function isDesktopAuthSessionAuthenticated(
  bootstrap: DesktopBootstrap | null,
  token: string | null | undefined,
  status: DesktopAuthStatus,
  bootstrapToken: string | null | undefined,
): boolean {
  const normalizedToken = normalizeDesktopAuthToken(token)
  return Boolean(
    status === 'authenticated' &&
    normalizedToken &&
    normalizedToken === normalizeDesktopAuthToken(bootstrapToken) &&
    desktopBootstrapEmail(bootstrap),
  )
}

export function isRejectedDesktopCredential(error: unknown): boolean {
  const diagnostic = backendErrorDiagnostic(error)
  if (!diagnostic) return false
  return (
    diagnostic.status === 401 ||
    diagnostic.code === 'unauthorized' ||
    diagnostic.code === 'invalid_credentials' ||
    diagnostic.code === 'invalid_token'
  )
}
