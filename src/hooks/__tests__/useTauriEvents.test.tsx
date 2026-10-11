import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../stores/appStore'

type EventHandler = (event: { payload: unknown }) => void

const eventMocks = vi.hoisted(() => ({
  handlers: new Map<string, EventHandler>(),
  unlisten: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: EventHandler) => {
    eventMocks.handlers.set(event, handler)
    return Promise.resolve(eventMocks.unlisten)
  }),
}))

vi.mock('../../lib/tauri', () => ({
  getHistory: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../lib/toast', () => ({
  toast: eventMocks.toast,
}))

import { useTauriEvents } from '../useTauriEvents'

describe('useTauriEvents', () => {
  beforeEach(() => {
    eventMocks.handlers.clear()
    eventMocks.unlisten.mockClear()
    window.location.hash = '#/'
    useAppStore.setState(useAppStore.getInitialState())
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('applies a capsule-style config patch in every listening renderer', async () => {
    renderHook(() => useTauriEvents())

    await waitFor(() => expect(eventMocks.handlers.has('config:patch')).toBe(true))

    act(() => {
      eventMocks.handlers.get('config:patch')?.({ payload: { capsule_style: 'orbit' } })
    })

    expect(useAppStore.getState().config.capsule_style).toBe('orbit')
  })

  it('clears a prior transcript on recording and snapshots one completed result at idle', async () => {
    renderHook(() => useTauriEvents())

    await waitFor(() => expect(eventMocks.handlers.has('pipeline:state')).toBe(true))

    useAppStore.getState().setPartialTranscript('上一段实时文本')
    useAppStore.getState().setFinalTranscript('上一段最终文本')
    useAppStore.getState().appendPolishedChunk('上一段润色文本')
    useAppStore.getState().setCompletedVoiceText('上一段结果')
    useAppStore.setState({
      recordingTransition: {
        kind: 'start',
        status: 'error',
        leaseId: 99,
        startedAt: '2026-07-20T00:00:00.000Z',
        error: '上一次启动失败',
      },
    })

    act(() => {
      eventMocks.handlers.get('pipeline:state')?.({ payload: 'recording' })
    })

    expect(useAppStore.getState()).toMatchObject({
      pipelineState: 'recording',
      partialTranscript: '',
      finalTranscript: '',
      polishedText: '',
      completedVoiceText: '',
      recordingTransition: expect.objectContaining({ status: 'idle', error: null }),
    })

    act(() => {
      useAppStore.getState().setFinalTranscript('本次识别结果')
      eventMocks.handlers.get('pipeline:state')?.({ payload: 'idle' })
    })

    expect(useAppStore.getState()).toMatchObject({
      pipelineState: 'idle',
      completedVoiceText: '本次识别结果',
    })
  })

  it('accepts volume only while recording and rejects a late event after stop', async () => {
    renderHook(() => useTauriEvents())

    await waitFor(() => expect(eventMocks.handlers.has('audio:volume')).toBe(true))

    act(() => {
      eventMocks.handlers.get('audio:volume')?.({ payload: 0.5 })
    })
    expect(useAppStore.getState().audioVolume).toBe(0)

    act(() => {
      eventMocks.handlers.get('pipeline:state')?.({ payload: 'recording' })
      eventMocks.handlers.get('audio:volume')?.({ payload: 0.5 })
    })
    expect(useAppStore.getState().audioVolume).toBe(0.5)

    act(() => {
      eventMocks.handlers.get('pipeline:state')?.({ payload: 'transcribing' })
      eventMocks.handlers.get('audio:volume')?.({ payload: 0.9 })
    })
    expect(useAppStore.getState()).toMatchObject({
      pipelineState: 'transcribing',
      audioVolume: 0,
    })
  })

  it('does not subscribe its host component to high-frequency store updates', async () => {
    const hostRender = vi.fn()

    function EventHost() {
      hostRender()
      useTauriEvents()
      return null
    }

    render(<EventHost />)
    await waitFor(() => expect(eventMocks.handlers.has('audio:volume')).toBe(true))

    act(() => {
      eventMocks.handlers.get('pipeline:state')?.({ payload: 'recording' })
      eventMocks.handlers.get('audio:volume')?.({ payload: 0.25 })
      eventMocks.handlers.get('audio:volume')?.({ payload: 0.5 })
    })

    expect(useAppStore.getState().audioVolume).toBe(0.5)
    expect(hostRender).toHaveBeenCalledTimes(1)
  })

  it('opens the About page with an explicit one-shot update check from the tray menu', async () => {
    renderHook(() => useTauriEvents())

    await waitFor(() => expect(eventMocks.handlers.has('tray:check-update')).toBe(true))

    act(() => {
      eventMocks.handlers.get('tray:check-update')?.({ payload: undefined })
    })

    const firstRequest = window.location.hash
    expect(firstRequest).toMatch(/^#\/settings\/about\?check-update=1&request=\d+-\d+$/)

    act(() => {
      eventMocks.handlers.get('tray:check-update')?.({ payload: undefined })
    })

    expect(window.location.hash).toMatch(/^#\/settings\/about\?check-update=1&request=\d+-\d+$/)
    expect(window.location.hash).not.toBe(firstRequest)
  })

  it('does not subscribe to presentation-only OCR progress events', async () => {
    renderHook(() => useTauriEvents())

    await waitFor(() => expect(eventMocks.handlers.has('config:patch')).toBe(true))

    expect(eventMocks.handlers.has('ocr:processing')).toBe(false)
  })

  it.each([
    ['backend_auth_required', '请先登录授权'],
    ['backend_auth_expired', '请重新登录授权'],
    ['backend_auth_changed', '授权已更新，请重新开始'],
    ['backend_policy_stale', '请刷新网络服务状态'],
    ['backend_stt_unavailable', '后台语音识别暂不可用'],
  ] as const)('preserves the backend STT preflight meaning for %s', async (code, message) => {
    renderHook(() => useTauriEvents())

    await waitFor(() => expect(eventMocks.handlers.has('pipeline:error')).toBe(true))

    act(() => {
      eventMocks.handlers.get('pipeline:error')?.({
        payload: { code, retry_count: 0 },
      })
    })

    expect(useAppStore.getState().pipelineError).toBe(message)
  })

  it('stores pipeline fallback feedback for the capsule instead of broadcasting toast', async () => {
    renderHook(() => useTauriEvents())

    await waitFor(() => expect(eventMocks.handlers.has('pipeline:warning')).toBe(true))
    vi.useFakeTimers()

    act(() => {
      eventMocks.handlers.get('pipeline:warning')?.({
        payload: {
          code: 'output_fallback_clipboard',
          details: 'keyboard unavailable',
        },
      })
    })

    expect(useAppStore.getState()).toMatchObject({ pipelineNotice: '已复制' })
    expect(eventMocks.toast).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(2499)
    })
    expect(useAppStore.getState().pipelineNotice).toBe('已复制')

    act(() => {
      eventMocks.handlers.get('pipeline:warning')?.({
        payload: { code: 'output_fallback_clipboard' },
      })
      vi.advanceTimersByTime(1)
    })
    expect(useAppStore.getState().pipelineNotice).toBe('已复制')

    act(() => {
      vi.advanceTimersByTime(2499)
    })
    expect(useAppStore.getState().pipelineNotice).toBeNull()

    act(() => {
      eventMocks.handlers.get('pipeline:warning')?.({
        payload: { code: 'output_wayland_unsupported' },
      })
      eventMocks.handlers.get('pipeline:state')?.({ payload: 'recording' })
    })
    expect(useAppStore.getState().pipelineNotice).toBeNull()
  })
})
