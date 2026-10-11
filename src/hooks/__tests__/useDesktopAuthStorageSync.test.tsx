import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type EventHandler = () => void

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  nativeHandler: null as EventHandler | null,
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}))

vi.mock('../../lib/desktopAuthRuntime', () => ({
  refreshDesktopAuthSnapshot: mocks.refresh,
}))

import { useDesktopAuthStorageSync } from '../useDesktopAuthStorageSync'
import { DESKTOP_AUTH_STATE_CHANGED_EVENT, DESKTOP_AUTH_TOKEN_KEY } from '../../lib/desktopAuth'

describe('useDesktopAuthStorageSync', () => {
  beforeEach(() => {
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.listen.mockReset().mockImplementation(async (_event: string, handler: EventHandler) => {
      mocks.nativeHandler = handler
      return mocks.unlisten
    })
    mocks.nativeHandler = null
    mocks.unlisten.mockReset()
  })

  it('uses read-only refresh for startup, browser storage, and native authority events', async () => {
    const view = renderHook(() => useDesktopAuthStorageSync())
    await act(async () => undefined)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: DESKTOP_AUTH_TOKEN_KEY, newValue: 'next-token' }),
      )
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(2)

    await act(async () => {
      mocks.nativeHandler?.()
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(3)

    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    expect(mocks.refresh).toHaveBeenCalledTimes(3)

    view.unmount()
    expect(mocks.unlisten).toHaveBeenCalledTimes(1)
    expect(mocks.listen).toHaveBeenCalledWith(
      DESKTOP_AUTH_STATE_CHANGED_EVENT,
      expect.any(Function),
    )
  })

  it('reads state after native subscription closes the missed-event gap', async () => {
    let resolveListen!: (unlisten: () => void) => void
    mocks.listen.mockImplementationOnce(
      (_event: string, handler: EventHandler) =>
        new Promise((resolve) => {
          mocks.nativeHandler = handler
          resolveListen = resolve
        }),
    )

    const view = renderHook(() => useDesktopAuthStorageSync())
    expect(mocks.refresh).not.toHaveBeenCalled()

    await act(async () => {
      resolveListen(mocks.unlisten)
    })

    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    view.unmount()
  })
})
