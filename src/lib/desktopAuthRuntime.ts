import { useAppStore } from '../stores/appStore'
import {
  classifyDesktopBootstrapIdentity,
  clearDesktopAuthTokenIfCurrent,
  isDesktopAuthSessionAuthenticated,
  isRejectedDesktopCredential,
  normalizeDesktopAuthToken,
  readDesktopAuthTokenResult,
  saveDesktopAuthToken,
} from './desktopAuth'
import { isBootstrapCacheUsable } from './desktopBootstrap'
import { backendErrorDiagnostic } from './userErrors'
import {
  beginDesktopAuthCandidate,
  beginDesktopAuthCandidateForLogin,
  clearDesktopAuthAuthority,
  commitDesktopAuthCandidate,
  confirmDesktopAuthRuntime,
  fetchDesktopBootstrap,
  invalidateDesktopAuthRuntime,
  loadDesktopAuthSnapshot,
  type DesktopAuthSnapshot,
  type DesktopBootstrap,
} from './tauri'

export interface DesktopAuthRequestContext {
  token: string | null
  snapshot: DesktopAuthSnapshot
}

export interface DesktopAuthRequestOptions {
  allowPublic?: boolean
}

export interface DesktopAuthLoginExpectation {
  generation: number | null
  authorityToken: string | null
  localToken: string | null
}

export interface DesktopAuthStartupSyncOptions extends DesktopAuthRequestOptions {
  bootstrapUrl: string
  currentVersion: string
  isCancelled?: () => boolean
  maxAttempts?: number
  retryDelayMs?: number
  retryWindowMs?: number
}

export type DesktopBootstrapApplyResult =
  | { kind: 'public' | 'authenticated'; cacheError: null }
  | { kind: 'cache-error'; cacheError: unknown }
  | { kind: 'rejected' | 'stale'; cacheError: null }

export type DesktopAuthStartupSyncResult =
  | DesktopBootstrapApplyResult
  | { kind: 'cancelled' | 'skipped'; error: null }
  | { kind: 'failed'; error: unknown }

const INITIAL_DESKTOP_AUTH_GENERATION = 0
const DEFAULT_STARTUP_SYNC_ATTEMPTS = 2
const DEFAULT_STARTUP_RETRY_DELAY_MS = 250
const DEFAULT_STARTUP_RETRY_WINDOW_MS = 4_000

function sameToken(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizeDesktopAuthToken(left) === normalizeDesktopAuthToken(right)
}

function recoverableNativeAuthority(snapshot: DesktopAuthSnapshot): string | null {
  const authority = normalizeDesktopAuthToken(snapshot.authorityToken)
  const cachedIdentity = normalizeDesktopAuthToken(snapshot.rawCachedAuthToken)
  if (
    !authority ||
    snapshot.generation === INITIAL_DESKTOP_AUTH_GENERATION ||
    (cachedIdentity !== null && cachedIdentity !== authority)
  ) {
    return null
  }
  return authority
}

function waitForDesktopAuthRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, delayMs)))
}

function hasDesktopAuthIdentityCandidate(): boolean {
  const local = readDesktopAuthTokenResult()
  return Boolean(
    (local.ok && local.token) || useAppStore.getState().desktopAuthSnapshot?.authorityToken,
  )
}

function isRetryableDesktopAuthStartupError(error: unknown): boolean {
  const diagnostic = backendErrorDiagnostic(error)
  if (!diagnostic) return false
  if (
    diagnostic.status !== null &&
    diagnostic.status >= 400 &&
    diagnostic.status <= 499 &&
    diagnostic.status !== 408
  ) {
    return false
  }
  if (
    diagnostic.service === 'desktop-bootstrap' &&
    diagnostic.stage === 'response' &&
    (diagnostic.code === 'desktop_bootstrap_invalid_response' ||
      diagnostic.code === 'desktop_bootstrap_response_too_large')
  ) {
    return false
  }
  if (
    diagnostic.service === 'desktop-bootstrap' &&
    diagnostic.stage === 'transport' &&
    (diagnostic.code === 'desktop_bootstrap_timeout' ||
      diagnostic.code === 'desktop_bootstrap_transport')
  ) {
    return true
  }
  if (diagnostic.status !== null) {
    return diagnostic.status === 408 || (diagnostic.status >= 500 && diagnostic.status <= 599)
  }
  return false
}

function adoptSnapshot(snapshot: DesktopAuthSnapshot, localToken: string | null): boolean {
  const store = useAppStore.getState()
  if (!store.setDesktopAuthSnapshot(snapshot)) return false
  store.setDesktopAuthToken(localToken)
  if (!sameToken(snapshot.authorityToken, localToken)) {
    store.markDesktopAuthUnknown(localToken)
    return false
  }
  if (isBootstrapCacheUsable(snapshot.cache, localToken)) {
    return store.acceptDesktopBootstrap(snapshot.cache.bootstrap, localToken)
  }
  store.markDesktopAuthUnknown(localToken)
  return false
}

function failClosedDesktopAuthView(snapshot?: DesktopAuthSnapshot): void {
  const store = useAppStore.getState()
  if (snapshot) store.setDesktopAuthSnapshot(snapshot)
  store.clearDesktopAuthState()
}

async function failClosedDesktopAuthRuntime(snapshot?: DesktopAuthSnapshot): Promise<void> {
  const expected = snapshot ?? useAppStore.getState().desktopAuthSnapshot
  if (expected) {
    await invalidateDesktopAuthRuntime(expected.generation, expected.authorityToken).catch(
      (error) => {
        console.warn('Desktop auth runtime fence invalidation skipped:', error)
      },
    )
  }
  failClosedDesktopAuthView(snapshot)
}

async function recoverNativeAuthorityRequest(
  snapshot: DesktopAuthSnapshot,
  recoveryAuthority: string,
  expectedLocalToken: string | null,
): Promise<DesktopAuthRequestContext | null> {
  const candidate = await beginDesktopAuthCandidate(snapshot.generation, recoveryAuthority)
  if (!candidate) {
    await refreshDesktopAuthSnapshot()
    return null
  }
  if (recoverableNativeAuthority(candidate) !== recoveryAuthority) {
    await invalidateDesktopAuthRuntime(candidate.generation, candidate.authorityToken)
    return null
  }

  const latestLocal = readDesktopAuthTokenResult()
  if (!latestLocal.ok) {
    await failClosedDesktopAuthRuntime(candidate)
    throw latestLocal.error
  }
  if (!sameToken(latestLocal.token, expectedLocalToken)) {
    await invalidateDesktopAuthRuntime(candidate.generation, candidate.authorityToken)
    return null
  }

  try {
    saveDesktopAuthToken(recoveryAuthority)
  } catch (error) {
    await failClosedDesktopAuthRuntime(candidate)
    throw error
  }

  const afterSaveLocal = readDesktopAuthTokenResult()
  if (!afterSaveLocal.ok) {
    try {
      clearDesktopAuthTokenIfCurrent(recoveryAuthority)
    } catch {
      // The fail-closed view below remains authoritative when browser storage is unavailable.
    }
    await failClosedDesktopAuthRuntime(candidate)
    throw afterSaveLocal.error
  }
  if (!sameToken(afterSaveLocal.token, recoveryAuthority)) {
    await invalidateDesktopAuthRuntime(candidate.generation, candidate.authorityToken)
    return null
  }

  const store = useAppStore.getState()
  if (!store.setDesktopAuthSnapshot(candidate)) {
    const latest = await refreshDesktopAuthSnapshot().catch(() => null)
    const currentLocal = readDesktopAuthTokenResult()
    const newerSameIdentity = Boolean(
      latest &&
      currentLocal.ok &&
      latest.generation > candidate.generation &&
      sameToken(latest.authorityToken, recoveryAuthority) &&
      sameToken(currentLocal.token, recoveryAuthority),
    )
    if (!newerSameIdentity) {
      try {
        clearDesktopAuthTokenIfCurrent(recoveryAuthority)
      } catch {
        await failClosedDesktopAuthRuntime()
      }
    }
    return null
  }

  adoptSnapshot(candidate, recoveryAuthority)
  if (!(await confirmDesktopAuthRuntime(candidate.generation, candidate.authorityToken))) {
    const latest = await refreshDesktopAuthSnapshot().catch(() => null)
    const currentLocal = readDesktopAuthTokenResult()
    const newerSameIdentity = Boolean(
      latest &&
      currentLocal.ok &&
      latest.generation > candidate.generation &&
      sameToken(latest.authorityToken, recoveryAuthority) &&
      sameToken(currentLocal.token, recoveryAuthority),
    )
    if (newerSameIdentity) return null

    try {
      clearDesktopAuthTokenIfCurrent(recoveryAuthority)
    } catch {
      await failClosedDesktopAuthRuntime(candidate)
    }
    const afterClearLocal = readDesktopAuthTokenResult()
    const state = useAppStore.getState()
    if (
      (!latest || latest.generation <= candidate.generation) &&
      afterClearLocal.ok &&
      !afterClearLocal.token &&
      state.desktopAuthToken === recoveryAuthority
    ) {
      state.clearDesktopAuthState()
    }
    return null
  }
  return { token: recoveryAuthority, snapshot: candidate }
}

export async function refreshDesktopAuthSnapshot(): Promise<DesktopAuthSnapshot> {
  const previousSnapshot = useAppStore.getState().desktopAuthSnapshot
  let snapshot: DesktopAuthSnapshot
  try {
    snapshot = await loadDesktopAuthSnapshot()
  } catch (error) {
    await failClosedDesktopAuthRuntime()
    throw error
  }
  const local = readDesktopAuthTokenResult()
  if (!local.ok) {
    await failClosedDesktopAuthRuntime(snapshot)
    throw local.error
  }
  adoptSnapshot(snapshot, local.token)
  // A storage/native event is observational. Only invalidate a strictly older identity;
  // a current or newer authority may be a login candidate being committed by another window.
  if (
    !sameToken(snapshot.authorityToken, local.token) &&
    previousSnapshot &&
    snapshot.generation < previousSnapshot.generation
  ) {
    await invalidateDesktopAuthRuntime(snapshot.generation, snapshot.authorityToken)
  }
  return snapshot
}

export async function beginDesktopAuthRequest(
  options: DesktopAuthRequestOptions = {},
): Promise<DesktopAuthRequestContext | null> {
  const local = readDesktopAuthTokenResult()
  if (!local.ok) {
    await failClosedDesktopAuthRuntime()
    throw local.error
  }
  useAppStore.getState().setDesktopAuthToken(local.token)

  let snapshot: DesktopAuthSnapshot
  try {
    snapshot = await loadDesktopAuthSnapshot()
  } catch (error) {
    await failClosedDesktopAuthRuntime()
    throw error
  }

  const currentLocal = readDesktopAuthTokenResult()
  if (!currentLocal.ok) {
    await failClosedDesktopAuthRuntime(snapshot)
    throw currentLocal.error
  }
  adoptSnapshot(snapshot, currentLocal.token)
  if (!sameToken(currentLocal.token, local.token)) return null
  const recoveryAuthority = recoverableNativeAuthority(snapshot)
  if (recoveryAuthority && !sameToken(currentLocal.token, recoveryAuthority)) {
    return recoverNativeAuthorityRequest(snapshot, recoveryAuthority, currentLocal.token)
  }
  const orphanedLocalToken =
    currentLocal.token && !snapshot.authorityToken && !snapshot.rawCachedAuthToken
  const initialMigrationMismatch =
    currentLocal.token &&
    snapshot.generation === INITIAL_DESKTOP_AUTH_GENERATION &&
    !sameToken(snapshot.authorityToken, currentLocal.token)
  if (orphanedLocalToken || initialMigrationMismatch) {
    const cleared = await clearRequestAuthority({ token: currentLocal.token, snapshot }, false)
    if (cleared === 'storage-error') {
      throw new Error('本机孤立授权状态清理失败。')
    }
    return null
  }
  if (!sameToken(snapshot.authorityToken, currentLocal.token)) {
    await invalidateDesktopAuthRuntime(snapshot.generation, snapshot.authorityToken)
    return null
  }
  if (!currentLocal.token && options.allowPublic === false) return null

  const candidate = await beginDesktopAuthCandidate(snapshot.generation, snapshot.authorityToken)
  if (!candidate) {
    await refreshDesktopAuthSnapshot()
    return null
  }
  const latestLocal = readDesktopAuthTokenResult()
  if (!latestLocal.ok) {
    await failClosedDesktopAuthRuntime(candidate)
    throw latestLocal.error
  }
  adoptSnapshot(candidate, latestLocal.token)
  if (!sameToken(candidate.authorityToken, latestLocal.token)) {
    await invalidateDesktopAuthRuntime(candidate.generation, candidate.authorityToken)
    return null
  }
  if (!(await confirmDesktopAuthRuntime(candidate.generation, candidate.authorityToken))) {
    await refreshDesktopAuthSnapshot()
    return null
  }
  return { token: latestLocal.token, snapshot: candidate }
}

export async function syncDesktopAuthAtStartup(
  options: DesktopAuthStartupSyncOptions,
): Promise<DesktopAuthStartupSyncResult> {
  const requestedAttempts = Math.trunc(options.maxAttempts ?? DEFAULT_STARTUP_SYNC_ATTEMPTS)
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.min(DEFAULT_STARTUP_SYNC_ATTEMPTS, Math.max(1, requestedAttempts))
    : DEFAULT_STARTUP_SYNC_ATTEMPTS
  const requestedDelay = options.retryDelayMs ?? DEFAULT_STARTUP_RETRY_DELAY_MS
  const retryDelayMs = Number.isFinite(requestedDelay)
    ? Math.max(0, requestedDelay)
    : DEFAULT_STARTUP_RETRY_DELAY_MS
  const requestedWindow = options.retryWindowMs ?? DEFAULT_STARTUP_RETRY_WINDOW_MS
  const retryWindowMs = Number.isFinite(requestedWindow)
    ? Math.min(DEFAULT_STARTUP_RETRY_WINDOW_MS, Math.max(0, requestedWindow))
    : DEFAULT_STARTUP_RETRY_WINDOW_MS
  const startedAt = Date.now()
  let lastError: unknown = new Error('Desktop auth startup synchronization did not run.')

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.isCancelled?.()) return { kind: 'cancelled', error: null }
    if (attempt > 0) {
      await waitForDesktopAuthRetry(retryDelayMs)
      if (options.isCancelled?.()) return { kind: 'cancelled', error: null }
      if (Date.now() - startedAt > retryWindowMs) break
    }

    let request: DesktopAuthRequestContext | null
    try {
      request = await beginDesktopAuthRequest({ allowPublic: options.allowPublic })
    } catch (error) {
      lastError = error
      return { kind: 'failed', error: lastError }
    }

    if (options.isCancelled?.()) return { kind: 'cancelled', error: null }

    if (!request) {
      if (authenticatedDesktopToken()) return { kind: 'skipped', error: null }
      if (options.allowPublic === false && !hasDesktopAuthIdentityCandidate()) {
        return { kind: 'skipped', error: null }
      }
      lastError = new Error('Desktop auth startup identity changed before validation.')
      if (attempt + 1 < maxAttempts && Date.now() - startedAt <= retryWindowMs) continue
      break
    }

    let bootstrap: DesktopBootstrap
    try {
      bootstrap = await fetchDesktopBootstrap(
        options.bootstrapUrl,
        options.currentVersion,
        request.token,
      )
    } catch (error) {
      if (await handleDesktopBootstrapFailure(error, request)) {
        return { kind: 'rejected', cacheError: null }
      }
      lastError = error
      if (
        isRetryableDesktopAuthStartupError(error) &&
        attempt + 1 < maxAttempts &&
        Date.now() - startedAt <= retryWindowMs
      ) {
        continue
      }
      break
    }

    if (options.isCancelled?.()) return { kind: 'cancelled', error: null }
    const result = await applyDesktopBootstrapResponse(bootstrap, request)
    if (result.kind === 'authenticated' || result.kind === 'public' || result.kind === 'rejected') {
      return result
    }
    if (result.kind === 'stale' && authenticatedDesktopToken()) return result
    if (result.kind === 'cache-error') return result
    lastError = new Error('Desktop auth startup response became stale before commit.')
    if (attempt + 1 < maxAttempts && Date.now() - startedAt <= retryWindowMs) continue
    return result
  }

  return { kind: 'failed', error: lastError }
}

export async function beginDesktopAuthLogin(
  nextToken: string,
  expectation: DesktopAuthLoginExpectation,
): Promise<DesktopAuthRequestContext | null> {
  const normalizedNext = normalizeDesktopAuthToken(nextToken)
  if (!normalizedNext) throw new Error('后台没有返回有效的登录凭据。')

  const candidate = await beginDesktopAuthCandidateForLogin(
    expectation.generation,
    expectation.authorityToken,
    normalizedNext,
  )
  if (!candidate) {
    await refreshDesktopAuthSnapshot()
    return null
  }

  const currentLocal = readDesktopAuthTokenResult()
  if (!currentLocal.ok) {
    await discardDesktopAuthCandidate(candidate)
    throw currentLocal.error
  }
  if (!sameToken(currentLocal.token, expectation.localToken)) {
    await discardDesktopAuthCandidate(candidate)
    return null
  }

  try {
    saveDesktopAuthToken(normalizedNext)
  } catch (error) {
    await discardDesktopAuthCandidate(candidate)
    throw error
  }

  const store = useAppStore.getState()
  store.setDesktopAuthToken(normalizedNext)
  if (!store.setDesktopAuthSnapshot(candidate)) {
    await refreshDesktopAuthSnapshot().catch(() => undefined)
    const latest = useAppStore.getState().desktopAuthSnapshot
    if (
      latest &&
      latest.generation > candidate.generation &&
      sameToken(latest.authorityToken, normalizedNext)
    ) {
      return null
    }
    try {
      clearDesktopAuthTokenIfCurrent(normalizedNext)
    } catch {
      await failClosedDesktopAuthRuntime()
    }
    await refreshDesktopAuthSnapshot().catch(() => undefined)
    return null
  }
  store.markDesktopAuthUnknown(normalizedNext)
  if (!(await confirmDesktopAuthRuntime(candidate.generation, candidate.authorityToken))) {
    const latest = await refreshDesktopAuthSnapshot().catch(() => null)
    const currentLocal = readDesktopAuthTokenResult()
    if (
      latest &&
      currentLocal.ok &&
      latest.generation > candidate.generation &&
      sameToken(latest.authorityToken, normalizedNext) &&
      sameToken(currentLocal.token, normalizedNext)
    ) {
      return null
    }
    try {
      clearDesktopAuthTokenIfCurrent(normalizedNext)
    } catch {
      await failClosedDesktopAuthRuntime()
    }
    await discardDesktopAuthCandidate(candidate)
    return null
  }
  return { token: normalizedNext, snapshot: candidate }
}

export async function captureDesktopAuthLoginExpectation(): Promise<DesktopAuthLoginExpectation> {
  const initialLocal = readDesktopAuthTokenResult()
  if (!initialLocal.ok) {
    await failClosedDesktopAuthRuntime()
    throw initialLocal.error
  }
  let snapshot: DesktopAuthSnapshot
  try {
    snapshot = await loadDesktopAuthSnapshot()
  } catch {
    const lastSnapshot = useAppStore.getState().desktopAuthSnapshot
    await failClosedDesktopAuthRuntime()
    return {
      generation: lastSnapshot?.generation ?? null,
      authorityToken: lastSnapshot?.authorityToken ?? null,
      localToken: initialLocal.token,
    }
  }
  const currentLocal = readDesktopAuthTokenResult()
  if (!currentLocal.ok) {
    await failClosedDesktopAuthRuntime(snapshot)
    throw currentLocal.error
  }
  return {
    generation: snapshot.generation,
    authorityToken: snapshot.authorityToken,
    localToken: currentLocal.token,
  }
}

async function discardDesktopAuthCandidate(candidate: DesktopAuthSnapshot): Promise<void> {
  await invalidateDesktopAuthRuntime(candidate.generation, candidate.authorityToken).catch(
    () => undefined,
  )
  await clearDesktopAuthAuthority(candidate.generation, candidate.authorityToken).catch(() => null)
  await refreshDesktopAuthSnapshot().catch(async () => {
    await failClosedDesktopAuthRuntime()
  })
}

async function clearRequestAuthority(
  request: DesktopAuthRequestContext,
  rejected: boolean,
): Promise<'cleared' | 'stale' | 'storage-error'> {
  const local = readDesktopAuthTokenResult()
  if (!local.ok) {
    await failClosedDesktopAuthRuntime()
    return 'storage-error'
  }
  if (!sameToken(local.token, request.token)) {
    await refreshDesktopAuthSnapshot().catch(() => undefined)
    return 'stale'
  }

  let cleared: DesktopAuthSnapshot | null
  try {
    cleared = await clearDesktopAuthAuthority(
      request.snapshot.generation,
      request.snapshot.authorityToken,
    )
  } catch {
    await failClosedDesktopAuthRuntime()
    return 'storage-error'
  }
  if (!cleared) {
    await refreshDesktopAuthSnapshot()
    return 'stale'
  }
  useAppStore.getState().setDesktopAuthSnapshot(cleared)

  try {
    if (request.token && !clearDesktopAuthTokenIfCurrent(request.token)) {
      await refreshDesktopAuthSnapshot()
      return 'stale'
    }
  } catch {
    await failClosedDesktopAuthRuntime(cleared)
    return 'storage-error'
  }

  if (rejected && request.token) useAppStore.getState().rejectDesktopAuthToken(request.token)
  else useAppStore.getState().clearDesktopAuthState()
  return 'cleared'
}

export async function clearCurrentDesktopAuth(
  rejected = false,
): Promise<'cleared' | 'stale' | 'storage-error'> {
  const local = readDesktopAuthTokenResult()
  if (!local.ok) {
    await failClosedDesktopAuthRuntime()
    return 'storage-error'
  }
  let snapshot: DesktopAuthSnapshot
  try {
    snapshot = await loadDesktopAuthSnapshot()
  } catch (error) {
    await failClosedDesktopAuthRuntime()
    throw error
  }
  adoptSnapshot(snapshot, local.token)
  return clearRequestAuthority({ token: local.token, snapshot }, rejected)
}

export async function applyDesktopBootstrapResponse(
  bootstrap: DesktopBootstrap,
  request: DesktopAuthRequestContext,
): Promise<DesktopBootstrapApplyResult> {
  const local = readDesktopAuthTokenResult()
  if (!local.ok) {
    await failClosedDesktopAuthRuntime()
    return { kind: 'cache-error', cacheError: local.error }
  }
  const identity = classifyDesktopBootstrapIdentity(bootstrap, request.token, local.token)
  if (identity.kind === 'stale') return { kind: 'stale', cacheError: null }
  if (identity.kind === 'rejected') {
    const cleared = await clearRequestAuthority(request, true)
    return cleared === 'cleared'
      ? { kind: 'rejected', cacheError: null }
      : cleared === 'storage-error'
        ? { kind: 'cache-error', cacheError: new Error('本地授权状态清理失败。') }
        : { kind: 'stale', cacheError: null }
  }

  try {
    const committed = await commitDesktopAuthCandidate(
      request.snapshot.generation,
      request.snapshot.authorityToken,
      request.snapshot.rawCachedAuthToken,
      bootstrap,
    )
    if (!committed) {
      await refreshDesktopAuthSnapshot()
      return { kind: 'stale', cacheError: null }
    }
    if (
      !sameToken(committed.authorityToken, identity.token) ||
      !isBootstrapCacheUsable(committed.cache, identity.token)
    ) {
      adoptSnapshot(committed, local.token)
      return { kind: 'stale', cacheError: null }
    }
    if (!adoptSnapshot(committed, local.token)) {
      return { kind: 'stale', cacheError: null }
    }
    if (!(await confirmDesktopAuthRuntime(committed.generation, committed.authorityToken))) {
      await refreshDesktopAuthSnapshot()
      return { kind: 'stale', cacheError: null }
    }
    return { kind: identity.kind, cacheError: null }
  } catch (cacheError) {
    await refreshDesktopAuthSnapshot().catch(() => undefined)
    return { kind: 'cache-error', cacheError }
  }
}

export async function handleDesktopBootstrapFailure(
  error: unknown,
  request: DesktopAuthRequestContext,
): Promise<boolean> {
  if (!request.token || !isRejectedDesktopCredential(error)) return false
  return (await clearRequestAuthority(request, true)) === 'cleared'
}

export function authenticatedDesktopToken(): string | null {
  const state = useAppStore.getState()
  return isDesktopAuthSessionAuthenticated(
    state.desktopBootstrap,
    state.desktopAuthToken,
    state.desktopAuthStatus,
    state.desktopBootstrapAuthToken,
  )
    ? state.desktopAuthToken
    : null
}
