import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStartupUpdateWindow, type StartupUpdateWindowMode } from '../useStartupUpdateWindow'

const windowMocks = vi.hoisted(() => ({
  outerSize: vi.fn(),
  outerPosition: vi.fn(),
  setSize: vi.fn(),
  setPosition: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
  currentMonitor: vi.fn(),
}))

const nativeMocks = vi.hoisted(() => ({
  syncMainWindowShape: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/window')>()
  return {
    ...actual,
    getCurrentWindow: () => windowMocks,
    currentMonitor: windowMocks.currentMonitor,
  }
})

vi.mock('../../lib/tauri', () => ({
  syncMainWindowShape: nativeMocks.syncMainWindowShape,
}))

describe('useStartupUpdateWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    windowMocks.setSize.mockResolvedValue(undefined)
    windowMocks.setPosition.mockResolvedValue(undefined)
    windowMocks.show.mockResolvedValue(undefined)
    windowMocks.setFocus.mockResolvedValue(undefined)
    nativeMocks.syncMainWindowShape.mockResolvedValue(undefined)
    windowMocks.currentMonitor.mockResolvedValue({
      workArea: {
        position: { x: 0, y: 0 },
        size: { width: 1920, height: 1040 },
      },
    })
  })

  it('keeps the checking state hidden without resizing the main window', async () => {
    renderHook(() => useStartupUpdateWindow('checking' as StartupUpdateWindowMode, true))

    await Promise.resolve()
    await Promise.resolve()

    expect(windowMocks.outerSize).not.toHaveBeenCalled()
    expect(windowMocks.outerPosition).not.toHaveBeenCalled()
    expect(windowMocks.setSize).not.toHaveBeenCalled()
    expect(windowMocks.setPosition).not.toHaveBeenCalled()
    expect(windowMocks.show).not.toHaveBeenCalled()
    expect(nativeMocks.syncMainWindowShape).not.toHaveBeenCalled()
  })

  it('uses fixed compact frames without measuring the rendered update content', async () => {
    const originalSize = { width: 1180, height: 820 }
    const originalPosition = { x: 120, y: 80 }
    windowMocks.outerSize
      .mockResolvedValueOnce(originalSize)
      .mockResolvedValueOnce({ width: 520, height: 340 })
      .mockResolvedValueOnce({ width: 520, height: 420 })
      .mockResolvedValueOnce({ width: 520, height: 420 })
    windowMocks.outerPosition.mockResolvedValueOnce(originalPosition)

    const { rerender } = renderHook(
      ({ mode }: { mode: StartupUpdateWindowMode }) => useStartupUpdateWindow(mode, true),
      { initialProps: { mode: 'available' } },
    )

    await waitFor(() => expect(windowMocks.setPosition).toHaveBeenCalledTimes(1))
    expect(windowMocks.setSize.mock.calls[0][0]).toMatchObject({ width: 520, height: 340 })
    expect(windowMocks.setPosition.mock.calls[0][0]).toMatchObject({ x: 700, y: 350 })
    expect(nativeMocks.syncMainWindowShape).toHaveBeenCalledTimes(1)
    expect(windowMocks.show).toHaveBeenCalledTimes(1)
    expect(windowMocks.setSize.mock.invocationCallOrder[0]).toBeLessThan(
      nativeMocks.syncMainWindowShape.mock.invocationCallOrder[0],
    )
    expect(nativeMocks.syncMainWindowShape.mock.invocationCallOrder[0]).toBeLessThan(
      windowMocks.show.mock.invocationCallOrder[0],
    )

    rerender({ mode: 'installing' })
    await waitFor(() => expect(windowMocks.setPosition).toHaveBeenCalledTimes(2))
    expect(windowMocks.setSize.mock.calls[1][0]).toMatchObject({ width: 520, height: 420 })
    expect(windowMocks.setPosition.mock.calls[1][0]).toMatchObject({ x: 700, y: 310 })
    expect(windowMocks.outerPosition).toHaveBeenCalledTimes(1)
    expect(nativeMocks.syncMainWindowShape).toHaveBeenCalledTimes(2)

    rerender({ mode: 'failed' })
    await waitFor(() => expect(windowMocks.setPosition).toHaveBeenCalledTimes(3))
    expect(windowMocks.setSize.mock.calls[2][0]).toMatchObject({ width: 520, height: 420 })
    expect(windowMocks.setPosition.mock.calls[2][0]).toMatchObject({ x: 700, y: 310 })
    expect(nativeMocks.syncMainWindowShape).toHaveBeenCalledTimes(3)

    rerender({ mode: null })
    await waitFor(() => expect(windowMocks.setPosition).toHaveBeenCalledTimes(4))
    expect(windowMocks.setSize.mock.calls[3][0]).toBe(originalSize)
    expect(windowMocks.setPosition.mock.calls[3][0]).toBe(originalPosition)
    expect(nativeMocks.syncMainWindowShape).toHaveBeenCalledTimes(4)
  })

  it('syncs the final responsive window shape before revealing the normal main UI', async () => {
    renderHook(() => useStartupUpdateWindow(null, true))

    await waitFor(() => expect(windowMocks.show).toHaveBeenCalledTimes(1))
    expect(windowMocks.outerSize).not.toHaveBeenCalled()
    expect(windowMocks.setSize).not.toHaveBeenCalled()
    expect(windowMocks.setPosition).not.toHaveBeenCalled()
    expect(nativeMocks.syncMainWindowShape).toHaveBeenCalledTimes(1)
    expect(nativeMocks.syncMainWindowShape.mock.invocationCallOrder[0]).toBeLessThan(
      windowMocks.show.mock.invocationCallOrder[0],
    )
    expect(windowMocks.setFocus).toHaveBeenCalledTimes(1)
  })

  it('keeps a start-minimized main window hidden after synchronizing its shape', async () => {
    renderHook(() => useStartupUpdateWindow(null, false))

    await waitFor(() => expect(nativeMocks.syncMainWindowShape).toHaveBeenCalledTimes(1))
    expect(windowMocks.show).not.toHaveBeenCalled()
    expect(windowMocks.setFocus).not.toHaveBeenCalled()
  })

  it('still reveals the painted UI when native shape synchronization is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    nativeMocks.syncMainWindowShape.mockRejectedValueOnce(new Error('shape unavailable'))

    try {
      renderHook(() => useStartupUpdateWindow(null, true))

      await waitFor(() => expect(windowMocks.show).toHaveBeenCalledTimes(1))
      expect(windowMocks.setFocus).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        'Main window shape synchronization skipped:',
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('does not stay hidden when an invisible WebView pauses animation frames', async () => {
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)

    try {
      renderHook(() => useStartupUpdateWindow(null, true))

      await waitFor(() => expect(windowMocks.show).toHaveBeenCalledTimes(1))
      expect(nativeMocks.syncMainWindowShape).toHaveBeenCalledTimes(1)
    } finally {
      animationFrame.mockRestore()
    }
  })

  it('reveals the update prompt when native sizing fails before the first show', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    windowMocks.outerSize.mockRejectedValueOnce(new Error('size unavailable'))

    try {
      renderHook(() => useStartupUpdateWindow('available', true))

      await waitFor(() => expect(windowMocks.show).toHaveBeenCalledTimes(1))
      expect(warn).toHaveBeenCalledWith('Startup update window resize skipped:', expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })

  it('bounds a stalled native shape command before revealing the main UI', async () => {
    nativeMocks.syncMainWindowShape.mockReturnValueOnce(new Promise<void>(() => undefined))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      renderHook(() => useStartupUpdateWindow(null, true))

      await waitFor(() => expect(windowMocks.show).toHaveBeenCalledTimes(1))
      expect(warn).toHaveBeenCalledWith(
        'Main window shape synchronization skipped:',
        expect.objectContaining({ message: 'Main window shape synchronization timed out' }),
      )
    } finally {
      warn.mockRestore()
    }
  })
})
