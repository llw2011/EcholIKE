import type { AppConfig } from '../stores/appStore'
import type { DesktopBootstrap, DesktopBootstrapCache } from './tauri'
import { desktopBootstrapEmail, normalizeDesktopAuthToken } from './desktopAuth'

export function bootstrapConfigPatch(_bootstrap: DesktopBootstrap): Partial<AppConfig> {
  // Backend bootstrap must never seed provider credentials into local user config.
  return {}
}

export function isBootstrapCacheUsable(
  cache: DesktopBootstrapCache | null,
  authorityToken: string | null = null,
): cache is DesktopBootstrapCache {
  if (!cache) return false
  const cachedAt = Date.parse(cache.cachedAt)
  const expectedToken = normalizeDesktopAuthToken(authorityToken)
  const cachedToken = normalizeDesktopAuthToken(cache.authToken)
  const authenticatedIdentityMatches = expectedToken
    ? cachedToken === expectedToken && Boolean(desktopBootstrapEmail(cache.bootstrap))
    : cachedToken === null && desktopBootstrapEmail(cache.bootstrap) === null
  return (
    Number.isFinite(cachedAt) &&
    Boolean(cache.packageVersion) &&
    Boolean(cache.bootstrap?.schemaVersion && cache.bootstrap.apiBaseUrl) &&
    authenticatedIdentityMatches
  )
}
