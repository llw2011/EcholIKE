import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCapsuleFocusable,
  getCapsuleVisibility,
  getCapsuleWindowFrame,
  useCapsuleResize,
} from '../useCapsuleResize'
import { capsuleStyleOptions, getCapsuleSize } from '../../components/Capsule/capsuleSkin'
import { useAppStore } from '../../stores/appStore'

const windowMocks = vi.hoisted(() => ({
  hide: vi.fn().mockResolvedValue(undefined),
  outerPosition: vi.fn().mockResolvedValue({ x: 10, y: 20 }),
  setFocusable: vi.fn().mockResolvedValue(undefined),
  setPosition: vi.fn().mockResolvedValue(undefined),
  setSize: vi.fn().mockResolvedValue(undefined),
  show: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/window', () => ({
  currentMonitor: vi.fn().mockResolvedValue(null),
  getCurrentWindow: () => windowMocks,
  LogicalPosition: class LogicalPosition {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}))

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState())
  vi.clearAllMocks()
})

describe('getCapsuleVisibility', () => {
  it('hides idle capsule when auto-hide is enabled', () => {
    expect(
      getCapsuleVisibility({
        capsuleAutoHide: true,
        contextMenuOpen: false,
        hasError: false,
        pipelineState: 'idle',
      }),
    ).toBe(false)
  })

  it('shows idle capsule when an error appears', () => {
    expect(
      getCapsuleVisibility({
        capsuleAutoHide: true,
        contextMenuOpen: false,
        hasError: true,
        pipelineState: 'idle',
      }),
    ).toBe(true)
  })

  it('shows the idle capsule while a pipeline notice is visible', () => {
    expect(
      getCapsuleVisibility({
        capsuleAutoHide: true,
        contextMenuOpen: false,
        hasError: false,
        hasNotice: true,
        pipelineState: 'idle',
      }),
    ).toBe(true)
  })

  it('shows active capsule while recording', () => {
    expect(
      getCapsuleVisibility({
        capsuleAutoHide: true,
        contextMenuOpen: false,
        hasError: false,
        pipelineState: 'recording',
      }),
    ).toBe(true)
  })

  it('shows idle capsule while the context menu is open', () => {
    expect(
      getCapsuleVisibility({
        capsuleAutoHide: true,
        contextMenuOpen: true,
        hasError: false,
        pipelineState: 'idle',
      }),
    ).toBe(true)
  })

  it('keeps the capsule overlay from stealing keyboard output focus', () => {
    expect(getCapsuleFocusable()).toBe(false)
  })
})

describe('getCapsuleWindowFrame', () => {
  it('keeps the normal capsule window flush with the capsule body', () => {
    expect(getCapsuleWindowFrame('idle', false, false)).toEqual({
      capsule: { width: 36, height: 36 },
      window: { width: 36, height: 36 },
    })
    expect(getCapsuleWindowFrame('recording', false, false).window).toEqual(
      getCapsuleWindowFrame('recording', false, false).capsule,
    )
  })

  it('only expands the transparent window while the context menu is open', () => {
    expect(getCapsuleWindowFrame('idle', false, true)).toEqual({
      capsule: { width: 36, height: 36 },
      window: { width: 220, height: 220 },
    })
  })

  it('derives live capsule dimensions from the selected style', () => {
    for (const style of capsuleStyleOptions) {
      expect(getCapsuleWindowFrame('recording', false, false, style.id).capsule).toEqual(
        getCapsuleSize(style.id, 'recording'),
      )
      expect(getCapsuleWindowFrame('idle', true, false, style.id).capsule).toEqual(
        getCapsuleSize(style.id, 'error'),
      )
    }

    expect(getCapsuleWindowFrame('recording', false, false, 'compact').capsule).not.toEqual(
      getCapsuleWindowFrame('recording', false, false, 'classic').capsule,
    )
  })

  it('uses the completion geometry for an idle pipeline notice', () => {
    expect(getCapsuleWindowFrame('idle', false, false, 'classic', true).capsule).toEqual(
      getCapsuleSize('classic', 'outputting'),
    )
  })
})

describe('useCapsuleResize', () => {
  it('shows and sizes an auto-hidden idle capsule for a recording transition error', async () => {
    act(() => {
      useAppStore.setState((state) => ({
        config: { ...state.config, capsule_auto_hide: true },
        recordingTransition: {
          kind: 'start',
          status: 'error',
          leaseId: 81,
          startedAt: '2026-07-20T00:00:00.000Z',
          error: 'recording rejected',
        },
      }))
    })

    const { result } = renderHook(() => useCapsuleResize())

    expect(result.current).toEqual(getCapsuleSize('classic', 'error'))
    await waitFor(() => expect(windowMocks.show).toHaveBeenCalled())
    expect(windowMocks.hide).not.toHaveBeenCalled()
  })

  it('resizes an authorization error when its selected skin changes', async () => {
    act(() => {
      useAppStore.setState((state) => ({
        pipelineError: '请重新登录授权',
        config: { ...state.config, capsule_style: 'pulse' },
      }))
    })

    const { result } = renderHook(() => useCapsuleResize())

    expect(result.current).toEqual(getCapsuleSize('pulse', 'error'))
    await waitFor(() => expect(windowMocks.show).toHaveBeenCalled())
    windowMocks.setSize.mockClear()

    act(() => {
      useAppStore.getState().updateConfig({ capsule_style: 'orbit' })
    })

    expect(result.current).toEqual(getCapsuleSize('orbit', 'error'))
    await waitFor(() =>
      expect(windowMocks.setSize).toHaveBeenLastCalledWith(
        expect.objectContaining(getCapsuleSize('orbit', 'error')),
      ),
    )
  })
})
