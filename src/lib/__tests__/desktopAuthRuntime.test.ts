import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import type { DesktopAuthSnapshot, DesktopBootstrap } from '../tauri'
import { DESKTOP_AUTH_TOKEN_KEY } from '../desktopAuth'

const native = vi.hoisted(() => ({
  load: vi.fn(),
  begin: vi.fn(),
  beginLogin: vi.fn(),
  commit: vi.fn(),
  clear: vi.fn(),
  confirm: vi.fn(),
  fetch: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('../tauri', () => ({
  loadDesktopAuthSnapshot: native.load,
  beginDesktopAuthCandidate: native.begin,
  beginDesktopAuthCandidateForLogin: native.beginLogin,
  commitDesktopAuthCandidate: native.commit,
  clearDesktopAuthAuthority: native.clear,
  confirmDesktopAuthRuntime: native.confirm,
  fetchDesktopBootstrap: native.fetch,
  invalidateDesktopAuthRuntime: native.invalidate,
}))

import {
  applyDesktopBootstrapResponse,
  beginDesktopAuthLogin,
  beginDesktopAuthRequest,
  captureDesktopAuthLoginExpectation,
  handleDesktopBootstrapFailure,
  refreshDesktopAuthSnapshot,
  syncDesktopAuthAtStartup,
} from '../desktopAuthRuntime'

function bootstrap(email: string, generatedAt = '2026-07-30T02:00:00.000Z'): DesktopBootstrap {
  return {
    schemaVersion: 1,
    generatedAt,
    apiBaseUrl: 'https://example.test/echo-api',
    user: {
      email,
      name: null,
      plan: 'pro',
      subscriptionEnd: null,
    },
  }
}

function bootstrapFailure(
  code: string,
  options: { status?: number; stage?: 'transport' | 'response' } = {},
): Error {
  return new Error(
    JSON.stringify({
      service: 'desktop-bootstrap',
      status: options.status ?? null,
      code,
      message: code,
      requestId: null,
      stage: options.stage ?? 'response',
    }),
  )
}

function snapshot(
  generation: number,
  authorityToken: string | null,
  cachedBootstrap: DesktopBootstrap | null = null,
): DesktopAuthSnapshot {
  return {
    generation,
    authorityToken,
    rawCachedAuthToken: cachedBootstrap ? authorityToken : null,
    cache: cachedBootstrap
      ? {
          packageVersion: '0.2.12',
          authToken: authorityToken,
          cachedAt: '2026-07-30T02:00:00.000Z',
          bootstrap: cachedBootstrap,
        }
      : null,
  }
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(useAppStore.getInitialState())
  native.load.mockReset()
  native.begin.mockReset()
  native.beginLogin.mockReset()
  native.commit.mockReset()
  native.clear.mockReset()
  native.confirm.mockReset().mockResolvedValue(true)
  native.fetch.mockReset().mockResolvedValue(bootstrap('user@example.com'))
  native.invalidate.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('desktop auth generation runtime', () => {
  it('restores native state without acquiring a generation lease', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    native.load.mockResolvedValue(snapshot(8, 'session-token', bootstrap('user@example.com')))

    await refreshDesktopAuthSnapshot()

    expect(native.load).toHaveBeenCalledTimes(1)
    expect(native.begin).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: 'session-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'session-token',
    })
  })

  it('restores the native authority before the first request when the browser mirror is missing', async () => {
    const current = snapshot(8, 'session-token')
    current.rawCachedAuthToken = 'session-token'
    const candidate = snapshot(9, 'session-token')
    candidate.rawCachedAuthToken = 'session-token'
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)

    await expect(beginDesktopAuthRequest()).resolves.toEqual({
      token: 'session-token',
      snapshot: candidate,
    })

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('session-token')
    expect(native.begin).toHaveBeenCalledWith(8, 'session-token')
    expect(native.confirm).toHaveBeenCalledWith(9, 'session-token')
  })

  it('repairs a stale non-empty browser mirror from the generation-fenced native authority', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'stale-token')
    const current = snapshot(8, 'current-token')
    current.rawCachedAuthToken = 'current-token'
    const candidate = snapshot(9, 'current-token')
    candidate.rawCachedAuthToken = 'current-token'
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)

    await expect(beginDesktopAuthRequest()).resolves.toEqual({
      token: 'current-token',
      snapshot: candidate,
    })

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('current-token')
    expect(native.begin).toHaveBeenCalledWith(8, 'current-token')
    expect(native.confirm).toHaveBeenCalledWith(9, 'current-token')
  })

  it('preserves a newer same-identity winner when recovery confirmation loses its generation', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'stale-token')
    const current = snapshot(8, 'current-token')
    current.rawCachedAuthToken = 'current-token'
    const candidate = snapshot(9, 'current-token')
    candidate.rawCachedAuthToken = 'current-token'
    const winnerBootstrap = bootstrap('winner@example.com')
    const winner = snapshot(10, 'current-token', winnerBootstrap)
    native.load.mockResolvedValueOnce(current).mockResolvedValueOnce(winner)
    native.begin.mockResolvedValue(candidate)
    native.confirm.mockResolvedValue(false)

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('current-token')
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: 'current-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'current-token',
    })
    expect(native.clear).not.toHaveBeenCalled()
  })

  it('recovers an established login in local mode without opening an anonymous request lease', async () => {
    const current = snapshot(8, 'session-token', bootstrap('user@example.com'))
    const candidate = snapshot(9, 'session-token', bootstrap('user@example.com'))
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)

    await expect(beginDesktopAuthRequest({ allowPublic: false })).resolves.toEqual({
      token: 'session-token',
      snapshot: candidate,
    })

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('session-token')
    expect(native.begin).toHaveBeenCalledTimes(1)
  })

  it('does not rotate an anonymous generation when local mode has no durable login', async () => {
    native.load.mockResolvedValue(snapshot(8, null))

    await expect(beginDesktopAuthRequest({ allowPublic: false })).resolves.toBeNull()

    expect(native.begin).not.toHaveBeenCalled()
    expect(native.confirm).not.toHaveBeenCalled()
  })

  it('does not restore an old mirror when logout wins the native recovery CAS', async () => {
    const established = snapshot(8, 'session-token', bootstrap('user@example.com'))
    native.load
      .mockResolvedValueOnce(established)
      .mockResolvedValueOnce(snapshot(9, null, bootstrap('')))
    native.begin.mockResolvedValue(null)

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(useAppStore.getState().desktopAuthToken).toBeNull()
    expect(native.confirm).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer local login that appears after native recovery begins', async () => {
    const established = snapshot(8, 'old-token', bootstrap('old@example.com'))
    const candidate = snapshot(9, 'old-token', bootstrap('old@example.com'))
    native.load.mockResolvedValue(established)
    native.begin.mockImplementation(async () => {
      localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'new-token')
      return candidate
    })

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('new-token')
    expect(native.invalidate).toHaveBeenCalledWith(9, 'old-token')
    expect(native.confirm).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer local login that appears during mirror persistence', async () => {
    const established = snapshot(8, 'old-token', bootstrap('old@example.com'))
    const candidate = snapshot(9, 'old-token', bootstrap('old@example.com'))
    native.load.mockResolvedValue(established)
    native.begin.mockResolvedValue(candidate)
    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      originalSetItem.call(this, key, value)
      if (key === DESKTOP_AUTH_TOKEN_KEY) originalSetItem.call(this, key, 'new-token')
    })

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('new-token')
    expect(native.invalidate).toHaveBeenCalledWith(9, 'old-token')
    expect(native.confirm).not.toHaveBeenCalled()
  })

  it('restores a verified native login candidate before its first cache commit', async () => {
    const current = snapshot(8, 'session-token')
    const candidate = snapshot(9, 'session-token')
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)

    await expect(beginDesktopAuthRequest()).resolves.toEqual({
      token: 'session-token',
      snapshot: candidate,
    })

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('session-token')
    expect(native.begin).toHaveBeenCalledWith(8, 'session-token')
    expect(native.confirm).toHaveBeenCalledWith(9, 'session-token')
  })

  it('does not promote a generation-zero legacy authority when browser state is missing', async () => {
    native.load.mockResolvedValue(snapshot(0, 'legacy-token', bootstrap('legacy@example.com')))

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(native.begin).not.toHaveBeenCalled()
    expect(native.invalidate).toHaveBeenCalledWith(0, 'legacy-token')
  })

  it('fails closed without clearing native authority when browser-token recovery cannot persist', async () => {
    const established = snapshot(8, 'session-token', bootstrap('user@example.com'))
    const candidate = snapshot(9, 'session-token', bootstrap('user@example.com'))
    native.load.mockResolvedValue(established)
    native.begin.mockResolvedValue(candidate)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('browser storage is unavailable')
    })

    await expect(beginDesktopAuthRequest()).rejects.toThrow('browser storage is unavailable')

    expect(native.invalidate).toHaveBeenCalledWith(9, 'session-token')
    expect(native.clear).not.toHaveBeenCalled()
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrap: null,
    })
  })

  it('removes a restored mirror when native runtime confirmation loses the race', async () => {
    const established = snapshot(8, 'session-token', bootstrap('user@example.com'))
    const candidate = snapshot(9, 'session-token', bootstrap('user@example.com'))
    native.load.mockResolvedValue(established)
    native.begin.mockResolvedValue(candidate)
    native.confirm.mockResolvedValue(false)

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(useAppStore.getState().desktopAuthStatus).toBe('unknown')
  })

  it('still clears a recovered mirror when its next bootstrap is genuinely unauthorized', async () => {
    const established = snapshot(8, 'session-token', bootstrap('user@example.com'))
    const candidate = snapshot(9, 'session-token', bootstrap('user@example.com'))
    native.load.mockResolvedValue(established)
    native.begin.mockResolvedValue(candidate)
    native.clear.mockResolvedValue(snapshot(10, null))

    const request = await beginDesktopAuthRequest()
    expect(request?.token).toBe('session-token')

    await expect(
      handleDesktopBootstrapFailure(
        new Error(JSON.stringify({ status: 401, code: 'unauthorized' })),
        request!,
      ),
    ).resolves.toBe(true)
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(useAppStore.getState().desktopAuthToken).toBeNull()
  })

  it('does not let an older asynchronous snapshot overwrite a newer generation', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'old-token')
    let resolveOlder!: (value: DesktopAuthSnapshot) => void
    let resolveNewer!: (value: DesktopAuthSnapshot) => void
    native.load
      .mockReturnValueOnce(new Promise<DesktopAuthSnapshot>((resolve) => (resolveOlder = resolve)))
      .mockReturnValueOnce(new Promise<DesktopAuthSnapshot>((resolve) => (resolveNewer = resolve)))

    const olderRefresh = refreshDesktopAuthSnapshot()
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'new-token')
    const newerRefresh = refreshDesktopAuthSnapshot()
    resolveNewer(snapshot(2, 'new-token', bootstrap('new@example.com')))
    await newerRefresh
    resolveOlder(snapshot(1, 'old-token', bootstrap('old@example.com')))
    await olderRefresh

    expect(useAppStore.getState().desktopAuthSnapshot?.generation).toBe(2)
    expect(useAppStore.getState().desktopAuthToken).toBe('new-token')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
  })

  it('only invalidates a strictly older identity seen by a late cross-window reconciliation', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'new-token')
    const newer = snapshot(10, 'new-token', bootstrap('new@example.com'))
    useAppStore.setState({
      desktopAuthToken: 'new-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'new-token',
      desktopBootstrap: newer.cache?.bootstrap ?? null,
      desktopAuthSnapshot: newer,
    })
    native.load.mockResolvedValue(snapshot(9, 'old-token', bootstrap('old@example.com')))
    native.invalidate.mockResolvedValue(false)

    await refreshDesktopAuthSnapshot()

    expect(native.invalidate).toHaveBeenCalledWith(9, 'old-token')
    expect(useAppStore.getState().desktopAuthSnapshot?.generation).toBe(10)
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
  })

  it('does not invalidate a newer native login candidate when another window still has its old mirror', async () => {
    const older = snapshot(8, 'old-token', bootstrap('old@example.com'))
    const newer = snapshot(9, 'new-token', bootstrap('new@example.com'))
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'old-token')
    useAppStore.setState({ desktopAuthSnapshot: older })
    native.load.mockResolvedValue(newer)

    await refreshDesktopAuthSnapshot()

    expect(native.invalidate).not.toHaveBeenCalled()
    expect(useAppStore.getState().desktopAuthSnapshot?.generation).toBe(9)
  })

  it('acquires a new generation before every request even when the token is unchanged', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const current = snapshot(8, 'session-token', bootstrap('user@example.com'))
    const candidate = snapshot(9, 'session-token', current.cache?.bootstrap ?? null)
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)

    await expect(beginDesktopAuthRequest()).resolves.toEqual({
      token: 'session-token',
      snapshot: candidate,
    })
    expect(native.begin).toHaveBeenCalledWith(8, 'session-token')
    expect(native.confirm).toHaveBeenCalledWith(9, 'session-token')
  })

  it('revalidates an old-package identity and commits a current-package bootstrap at startup', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const current = snapshot(8, 'session-token')
    current.rawCachedAuthToken = 'session-token'
    const candidate = snapshot(9, 'session-token')
    candidate.rawCachedAuthToken = 'session-token'
    const upgradedBootstrap = bootstrap('upgraded@example.com')
    const committed = snapshot(10, 'session-token', upgradedBootstrap)
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)
    native.fetch.mockResolvedValue(upgradedBootstrap)
    native.commit.mockResolvedValue(committed)

    await expect(
      syncDesktopAuthAtStartup({
        bootstrapUrl: 'https://example.test/desktop/bootstrap',
        currentVersion: '0.2.30',
        allowPublic: true,
        maxAttempts: 1,
      }),
    ).resolves.toEqual({ kind: 'authenticated', cacheError: null })

    expect(native.fetch).toHaveBeenCalledWith(
      'https://example.test/desktop/bootstrap',
      '0.2.30',
      'session-token',
    )
    expect(native.commit).toHaveBeenCalledWith(
      9,
      'session-token',
      'session-token',
      upgradedBootstrap,
    )
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: 'session-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'session-token',
    })
  })

  it('stops before the startup fetch when the owner is cancelled during lease preparation', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const current = snapshot(8, 'session-token')
    current.rawCachedAuthToken = 'session-token'
    const candidate = snapshot(9, 'session-token')
    candidate.rawCachedAuthToken = 'session-token'
    let resolveLoad!: (value: DesktopAuthSnapshot) => void
    native.load.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve
      }),
    )
    native.begin.mockResolvedValue(candidate)
    let cancelled = false

    const pending = syncDesktopAuthAtStartup({
      bootstrapUrl: 'https://example.test/desktop/bootstrap',
      currentVersion: '0.2.30',
      allowPublic: true,
      isCancelled: () => cancelled,
    })
    cancelled = true
    resolveLoad(current)

    await expect(pending).resolves.toEqual({ kind: 'cancelled', error: null })
    expect(native.begin).toHaveBeenCalledTimes(1)
    expect(native.fetch).not.toHaveBeenCalled()
  })

  it('retries the complete startup lease after a transient preparation loss', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const current = snapshot(8, 'session-token')
    current.rawCachedAuthToken = 'session-token'
    const candidate = snapshot(9, 'session-token')
    candidate.rawCachedAuthToken = 'session-token'
    const refreshed = bootstrap('refreshed@example.com')
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValueOnce(null).mockResolvedValueOnce(candidate)
    native.fetch.mockResolvedValue(refreshed)
    native.commit.mockResolvedValue(snapshot(10, 'session-token', refreshed))

    await expect(
      syncDesktopAuthAtStartup({
        bootstrapUrl: 'https://example.test/desktop/bootstrap',
        currentVersion: '0.2.30',
        allowPublic: true,
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({ kind: 'authenticated', cacheError: null })

    expect(native.begin).toHaveBeenCalledTimes(2)
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
  })

  it.each([
    ['desktop_bootstrap_transport', undefined],
    ['desktop_bootstrap_timeout', undefined],
    ['desktop_bootstrap_transport', 200],
    ['desktop_bootstrap_timeout', 200],
  ] as const)(
    'retries an immediate transient startup %s at status %s with a fresh generation lease',
    async (failureCode, status) => {
      localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
      const current = snapshot(8, 'session-token')
      current.rawCachedAuthToken = 'session-token'
      const firstCandidate = snapshot(9, 'session-token')
      firstCandidate.rawCachedAuthToken = 'session-token'
      const secondCandidate = snapshot(10, 'session-token')
      secondCandidate.rawCachedAuthToken = 'session-token'
      const refreshed = bootstrap('refreshed@example.com')
      native.load.mockResolvedValueOnce(current).mockResolvedValueOnce(firstCandidate)
      native.begin.mockResolvedValueOnce(firstCandidate).mockResolvedValueOnce(secondCandidate)
      native.fetch
        .mockRejectedValueOnce(bootstrapFailure(failureCode, { stage: 'transport', status }))
        .mockResolvedValueOnce(refreshed)
      native.commit.mockResolvedValue(snapshot(11, 'session-token', refreshed))

      await expect(
        syncDesktopAuthAtStartup({
          bootstrapUrl: 'https://example.test/desktop/bootstrap',
          currentVersion: '0.2.30',
          allowPublic: true,
          retryDelayMs: 0,
        }),
      ).resolves.toEqual({ kind: 'authenticated', cacheError: null })

      expect(native.begin).toHaveBeenNthCalledWith(1, 8, 'session-token')
      expect(native.begin).toHaveBeenNthCalledWith(2, 9, 'session-token')
      expect(native.fetch).toHaveBeenCalledTimes(2)
    },
  )

  it.each([400, 403, 404, 429])(
    'does not retry a permanent startup HTTP %s response',
    async (status) => {
      localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
      const current = snapshot(8, 'session-token')
      current.rawCachedAuthToken = 'session-token'
      const candidate = snapshot(9, 'session-token')
      candidate.rawCachedAuthToken = 'session-token'
      native.load.mockResolvedValue(current)
      native.begin.mockResolvedValue(candidate)
      native.fetch.mockRejectedValue(bootstrapFailure('request_failed', { status }))

      const result = await syncDesktopAuthAtStartup({
        bootstrapUrl: 'https://example.test/desktop/bootstrap',
        currentVersion: '0.2.30',
        allowPublic: true,
        retryDelayMs: 0,
      })

      expect(result.kind).toBe('failed')
      expect(native.begin).toHaveBeenCalledTimes(1)
      expect(native.fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('does not retry a successful HTTP response with an invalid bootstrap payload', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const current = snapshot(8, 'session-token')
    current.rawCachedAuthToken = 'session-token'
    const candidate = snapshot(9, 'session-token')
    candidate.rawCachedAuthToken = 'session-token'
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)
    native.fetch.mockRejectedValue(
      bootstrapFailure('desktop_bootstrap_invalid_response', {
        status: 200,
        stage: 'response',
      }),
    )

    const result = await syncDesktopAuthAtStartup({
      bootstrapUrl: 'https://example.test/desktop/bootstrap',
      currentVersion: '0.2.30',
      allowPublic: true,
      retryDelayMs: 0,
    })

    expect(result.kind).toBe('failed')
    expect(native.begin).toHaveBeenCalledTimes(1)
    expect(native.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry an invalid bootstrap payload even when its HTTP status is 503', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const current = snapshot(8, 'session-token')
    current.rawCachedAuthToken = 'session-token'
    const candidate = snapshot(9, 'session-token')
    candidate.rawCachedAuthToken = 'session-token'
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)
    native.fetch.mockRejectedValue(
      bootstrapFailure('desktop_bootstrap_invalid_response', {
        status: 503,
        stage: 'response',
      }),
    )

    const result = await syncDesktopAuthAtStartup({
      bootstrapUrl: 'https://example.test/desktop/bootstrap',
      currentVersion: '0.2.30',
      allowPublic: true,
      retryDelayMs: 0,
    })

    expect(result.kind).toBe('failed')
    expect(native.begin).toHaveBeenCalledTimes(1)
    expect(native.fetch).toHaveBeenCalledTimes(1)
  })

  it('caps persistent retryable startup failures at two fresh leases', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const current = snapshot(8, 'session-token')
    current.rawCachedAuthToken = 'session-token'
    const firstCandidate = snapshot(9, 'session-token')
    firstCandidate.rawCachedAuthToken = 'session-token'
    const secondCandidate = snapshot(10, 'session-token')
    secondCandidate.rawCachedAuthToken = 'session-token'
    native.load.mockResolvedValueOnce(current).mockResolvedValueOnce(firstCandidate)
    native.begin.mockResolvedValueOnce(firstCandidate).mockResolvedValueOnce(secondCandidate)
    native.fetch.mockRejectedValue(bootstrapFailure('unavailable', { status: 503 }))

    const result = await syncDesktopAuthAtStartup({
      bootstrapUrl: 'https://example.test/desktop/bootstrap',
      currentVersion: '0.2.30',
      allowPublic: true,
      maxAttempts: 99,
      retryDelayMs: 0,
      retryWindowMs: 60_000,
    })

    expect(result.kind).toBe('failed')
    expect(native.begin).toHaveBeenCalledTimes(2)
    expect(native.fetch).toHaveBeenCalledTimes(2)
    expect(native.begin).toHaveBeenNthCalledWith(1, 8, 'session-token')
    expect(native.begin).toHaveBeenNthCalledWith(2, 9, 'session-token')
  })

  it('does not retry a native storage preparation failure', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    native.load.mockRejectedValue(new Error('desktop auth envelope is unreadable'))

    const result = await syncDesktopAuthAtStartup({
      bootstrapUrl: 'https://example.test/desktop/bootstrap',
      currentVersion: '0.2.30',
      allowPublic: true,
      retryDelayMs: 0,
    })

    expect(result.kind).toBe('failed')
    expect(native.load).toHaveBeenCalledTimes(1)
    expect(native.begin).not.toHaveBeenCalled()
    expect(native.fetch).not.toHaveBeenCalled()
  })

  it('does not retry a local cache commit failure after online validation', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const current = snapshot(8, 'session-token')
    current.rawCachedAuthToken = 'session-token'
    const candidate = snapshot(9, 'session-token')
    candidate.rawCachedAuthToken = 'session-token'
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)
    native.commit.mockRejectedValue(new Error('desktop auth cache is not writable'))

    await expect(
      syncDesktopAuthAtStartup({
        bootstrapUrl: 'https://example.test/desktop/bootstrap',
        currentVersion: '0.2.30',
        allowPublic: true,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({ kind: 'cache-error' })

    expect(native.begin).toHaveBeenCalledTimes(1)
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(native.commit).toHaveBeenCalledTimes(1)
  })

  it('does not retry a rejected startup credential', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'expired-token')
    const current = snapshot(8, 'expired-token')
    current.rawCachedAuthToken = 'expired-token'
    const candidate = snapshot(9, 'expired-token')
    candidate.rawCachedAuthToken = 'expired-token'
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)
    native.fetch.mockRejectedValue(new Error(JSON.stringify({ status: 401, code: 'unauthorized' })))
    native.clear.mockResolvedValue(snapshot(10, null))

    await expect(
      syncDesktopAuthAtStartup({
        bootstrapUrl: 'https://example.test/desktop/bootstrap',
        currentVersion: '0.2.30',
        allowPublic: true,
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({ kind: 'rejected', cacheError: null })

    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(native.begin).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(useAppStore.getState().desktopAuthStatus).toBe('rejected')
  })

  it('does not roll a newer login back when local storage changes during native load', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'old-token')
    let resolveSnapshot!: (value: DesktopAuthSnapshot) => void
    native.load.mockReturnValue(
      new Promise<DesktopAuthSnapshot>((resolve) => (resolveSnapshot = resolve)),
    )

    const request = beginDesktopAuthRequest()
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'new-token')
    resolveSnapshot(snapshot(9, 'new-token', bootstrap('new@example.com')))

    await expect(request).resolves.toBeNull()
    expect(native.begin).not.toHaveBeenCalled()
    expect(native.invalidate).not.toHaveBeenCalled()
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
  })

  it('uses the newer native authority instead of rotating it back to a stale browser token', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'old-token')
    const current = snapshot(9, 'new-token', bootstrap('new@example.com'))
    const candidate = snapshot(10, 'new-token', bootstrap('new@example.com'))
    native.load.mockResolvedValue(current)
    native.begin.mockResolvedValue(candidate)

    await expect(beginDesktopAuthRequest()).resolves.toEqual({
      token: 'new-token',
      snapshot: candidate,
    })

    expect(native.begin).toHaveBeenCalledWith(9, 'new-token')
    expect(native.invalidate).not.toHaveBeenCalled()
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('new-token')
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
  })

  it('clears an orphaned local token instead of leaving it permanently pending', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'orphaned-token')
    native.load.mockResolvedValue(snapshot(0, null))
    native.clear.mockResolvedValue(snapshot(1, null))

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(native.begin).not.toHaveBeenCalled()
    expect(native.clear).toHaveBeenCalledWith(0, null)
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrap: null,
    })
  })

  it('clears an orphaned token even when native storage only has a public cache', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'orphaned-token')
    native.load.mockResolvedValue(snapshot(0, null, bootstrap('')))
    native.clear.mockResolvedValue(snapshot(1, null))

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(native.begin).not.toHaveBeenCalled()
    expect(native.clear).toHaveBeenCalledWith(0, null)
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(useAppStore.getState().desktopAuthStatus).toBe('unknown')
  })

  it('clears a one-time migrated authority that disagrees with the current local token', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'new-local-token')
    native.load.mockResolvedValue(snapshot(0, 'old-native-token', bootstrap('old@example.com')))
    native.clear.mockResolvedValue(snapshot(1, null))

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(native.begin).not.toHaveBeenCalled()
    expect(native.clear).toHaveBeenCalledWith(0, 'old-native-token')
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBeNull()
    expect(useAppStore.getState().desktopAuthStatus).toBe('unknown')
  })

  it('reloads once and discards a stale request lease without retrying begin', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    native.load
      .mockResolvedValueOnce(snapshot(8, 'session-token'))
      .mockResolvedValueOnce(snapshot(9, 'session-token', bootstrap('new@example.com')))
    native.begin.mockResolvedValue(null)

    await expect(beginDesktopAuthRequest()).resolves.toBeNull()

    expect(native.begin).toHaveBeenCalledTimes(1)
    expect(native.load).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
  })

  it('uses login-only recovery after a damaged native state and stays unknown until commit', async () => {
    useAppStore.setState({ desktopAuthSnapshot: snapshot(11, 'previous-token') })
    native.load.mockRejectedValueOnce(new Error('native envelope is damaged'))
    const candidate = snapshot(12, 'verified-token')
    native.beginLogin.mockResolvedValue(candidate)
    const expectation = await captureDesktopAuthLoginExpectation()

    await expect(beginDesktopAuthLogin('verified-token', expectation)).resolves.toEqual({
      token: 'verified-token',
      snapshot: candidate,
    })

    expect(native.beginLogin).toHaveBeenCalledWith(11, 'previous-token', 'verified-token')
    expect(native.confirm).toHaveBeenCalledWith(12, 'verified-token')
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('verified-token')
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: 'verified-token',
      desktopAuthStatus: 'unknown',
      desktopBootstrap: null,
    })
  })

  it('does not change browser storage when the login generation is stale', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'current-token')
    native.load
      .mockResolvedValueOnce(snapshot(4, 'current-token'))
      .mockResolvedValueOnce(snapshot(5, 'newer-token'))
    const expectation = await captureDesktopAuthLoginExpectation()
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'newer-token')
    native.beginLogin.mockResolvedValue(null)

    await expect(beginDesktopAuthLogin('attempted-token', expectation)).resolves.toBeNull()

    expect(native.beginLogin).toHaveBeenCalledWith(4, 'current-token', 'attempted-token')
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('newer-token')
    expect(useAppStore.getState().desktopAuthToken).toBe('newer-token')
  })

  it('does not overwrite a newer local login when an older candidate returns late', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'old-token')
    const expectation = {
      generation: 4,
      authorityToken: 'old-token',
      localToken: 'old-token',
    }
    native.beginLogin.mockResolvedValue(snapshot(5, 'earlier-token'))
    native.clear.mockResolvedValue(null)
    native.load.mockResolvedValue(snapshot(6, 'newer-token', bootstrap('new@example.com')))
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'newer-token')

    await expect(beginDesktopAuthLogin('earlier-token', expectation)).resolves.toBeNull()

    expect(native.clear).toHaveBeenCalledWith(5, 'earlier-token')
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('newer-token')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
  })

  it('keeps the same token when a higher native generation already completed it', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'old-token')
    useAppStore.setState({ desktopAuthSnapshot: snapshot(6, 'new-token') })
    native.beginLogin.mockResolvedValue(snapshot(5, 'new-token'))
    native.load.mockResolvedValue(snapshot(6, 'new-token', bootstrap('new@example.com')))

    await expect(
      beginDesktopAuthLogin('new-token', {
        generation: 4,
        authorityToken: 'old-token',
        localToken: 'old-token',
      }),
    ).resolves.toBeNull()

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('new-token')
    expect(useAppStore.getState().desktopAuthSnapshot?.generation).toBe(6)
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
  })

  it('keeps a same-token login that wins after the local candidate was accepted', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'old-token')
    const newer = snapshot(6, 'new-token', bootstrap('new@example.com'))
    native.beginLogin.mockResolvedValue(snapshot(5, 'new-token'))
    native.confirm.mockResolvedValue(false)
    native.load.mockResolvedValue(newer)

    await expect(
      beginDesktopAuthLogin('new-token', {
        generation: 4,
        authorityToken: 'old-token',
        localToken: 'old-token',
      }),
    ).resolves.toBeNull()

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('new-token')
    expect(native.clear).not.toHaveBeenCalled()
    expect(useAppStore.getState().desktopAuthSnapshot?.generation).toBe(6)
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
  })

  it('rolls back native authority and fails closed when local token persistence fails', async () => {
    native.load.mockResolvedValue(snapshot(4, null))
    native.beginLogin.mockResolvedValue(snapshot(5, 'verified-token'))
    native.clear.mockResolvedValue(snapshot(6, null))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('browser storage is unavailable')
    })

    await expect(
      beginDesktopAuthLogin('verified-token', {
        generation: 4,
        authorityToken: null,
        localToken: null,
      }),
    ).rejects.toThrow('browser storage is unavailable')

    expect(native.clear).toHaveBeenCalledWith(5, 'verified-token')
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrap: null,
    })
  })

  it('keeps a newer cached response when an older same-token commit is rejected', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const requestSnapshot = snapshot(9, 'session-token', bootstrap('old@example.com'))
    const newer = snapshot(
      10,
      'session-token',
      bootstrap('new@example.com', '2026-07-30T03:00:00.000Z'),
    )
    native.commit.mockResolvedValue(null)
    native.load.mockResolvedValue(newer)

    await expect(
      applyDesktopBootstrapResponse(bootstrap('old@example.com', '2026-07-30T01:00:00.000Z'), {
        token: 'session-token',
        snapshot: requestSnapshot,
      }),
    ).resolves.toEqual({ kind: 'stale', cacheError: null })

    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
  })

  it('re-adopts the native last-known-good cache when commit persistence fails', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const lastKnownGood = snapshot(9, 'session-token', bootstrap('cached@example.com'))
    native.commit.mockRejectedValue(new Error('native envelope write failed'))
    native.load.mockResolvedValue(lastKnownGood)

    const result = await applyDesktopBootstrapResponse(bootstrap('fresh@example.com'), {
      token: 'session-token',
      snapshot: lastKnownGood,
    })

    expect(result.kind).toBe('cache-error')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('cached@example.com')
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
  })

  it('does not let a late unauthorized response clear a newer local identity', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'new-token')
    const newer = snapshot(12, 'new-token', bootstrap('new@example.com'))
    native.load.mockResolvedValue(newer)

    await expect(
      handleDesktopBootstrapFailure(
        new Error(JSON.stringify({ status: 401, code: 'unauthorized' })),
        { token: 'old-token', snapshot: snapshot(10, 'old-token') },
      ),
    ).resolves.toBe(false)

    expect(native.clear).not.toHaveBeenCalled()
    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('new-token')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
  })

  it('drops the authorized view when local storage cannot be read', async () => {
    const confirmed = snapshot(8, 'session-token', bootstrap('user@example.com'))
    useAppStore.setState({
      desktopAuthToken: 'session-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'session-token',
      desktopBootstrap: bootstrap('user@example.com'),
      desktopAuthSnapshot: confirmed,
    })
    native.load.mockResolvedValue(confirmed)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('browser storage read failed')
    })

    await expect(refreshDesktopAuthSnapshot()).rejects.toThrow('browser storage read failed')

    expect(native.load).toHaveBeenCalledTimes(1)
    expect(native.invalidate).toHaveBeenCalledWith(8, 'session-token')
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrap: null,
    })
  })

  it('drops the authorized view when token removal fails after native clear', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const requestSnapshot = snapshot(9, 'session-token', bootstrap('user@example.com'))
    useAppStore.setState({
      desktopAuthToken: 'session-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'session-token',
      desktopBootstrap: requestSnapshot.cache?.bootstrap ?? null,
    })
    native.clear.mockResolvedValue(snapshot(10, null))
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
      throw new Error('browser storage remove failed')
    })

    await expect(
      handleDesktopBootstrapFailure(
        new Error(JSON.stringify({ status: 401, code: 'unauthorized' })),
        { token: 'session-token', snapshot: requestSnapshot },
      ),
    ).resolves.toBe(false)

    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrap: null,
    })
  })

  it('fails closed when the conditional token read fails after native clear', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const requestSnapshot = snapshot(9, 'session-token', bootstrap('user@example.com'))
    useAppStore.setState({
      desktopAuthToken: 'session-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'session-token',
      desktopBootstrap: requestSnapshot.cache?.bootstrap ?? null,
    })
    native.clear.mockResolvedValue(snapshot(10, null))
    const originalGetItem = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem')
      .mockImplementationOnce(function (this: Storage, key) {
        return originalGetItem.call(this, key)
      })
      .mockImplementationOnce(() => {
        throw new Error('browser storage second read failed')
      })

    await expect(
      handleDesktopBootstrapFailure(
        new Error(JSON.stringify({ status: 401, code: 'unauthorized' })),
        { token: 'session-token', snapshot: requestSnapshot },
      ),
    ).resolves.toBe(false)

    expect(native.clear).toHaveBeenCalledWith(9, 'session-token')
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrap: null,
    })
  })

  it('contains a native clear failure and drops the authorized view', async () => {
    localStorage.setItem(DESKTOP_AUTH_TOKEN_KEY, 'session-token')
    const requestSnapshot = snapshot(9, 'session-token', bootstrap('user@example.com'))
    useAppStore.setState({
      desktopAuthToken: 'session-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'session-token',
      desktopBootstrap: requestSnapshot.cache?.bootstrap ?? null,
    })
    native.clear.mockRejectedValue(new Error('native envelope write failed'))

    await expect(
      handleDesktopBootstrapFailure(
        new Error(JSON.stringify({ status: 401, code: 'unauthorized' })),
        { token: 'session-token', snapshot: requestSnapshot },
      ),
    ).resolves.toBe(false)

    expect(localStorage.getItem(DESKTOP_AUTH_TOKEN_KEY)).toBe('session-token')
    expect(useAppStore.getState()).toMatchObject({
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrap: null,
    })
  })
})
