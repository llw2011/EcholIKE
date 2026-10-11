import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startRecording, stopRecording } from '../../lib/tauri'
import { useAppStore } from '../../stores/appStore'
import { useRecording } from '../useRecording'

vi.mock('../../lib/tauri', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))

describe('useRecording transition lifecycle', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState())
    vi.clearAllMocks()
  })

  it('deduplicates pending start across remount and only resets for a true Rust owner', async () => {
    let resolve!: (acquired: boolean) => void
    vi.mocked(startRecording).mockReturnValue(new Promise((done) => (resolve = done)))
    useAppStore.setState({ partialTranscript: 'existing' })
    const first = renderHook(() => useRecording())
    let firstPromise!: Promise<boolean>
    await act(async () => {
      firstPromise = first.result.current.startRecording()
      expect(await first.result.current.startRecording()).toBe(false)
    })
    expect(startRecording).toHaveBeenCalledTimes(1)
    first.unmount()
    const second = renderHook(() => useRecording())
    expect(second.result.current.transitionBusy).toBe(true)
    await act(async () => {
      resolve(false)
      await firstPromise
    })
    expect(useAppStore.getState().partialTranscript).toBe('existing')
    expect(useAppStore.getState().recordingTransition.status).toBe('idle')
  })

  it('deduplicates stop and stores a normalized rejection', async () => {
    vi.mocked(stopRecording).mockRejectedValue(new Error('capsule stop rejected'))
    const hook = renderHook(() => useRecording())
    await act(async () => {
      await Promise.all([hook.result.current.stopRecording(), hook.result.current.stopRecording()])
    })
    expect(stopRecording).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().recordingTransition).toMatchObject({
      status: 'error',
      error: '录音命令执行失败。',
    })
  })

  it('does not rerender recording controls for high-frequency volume updates', () => {
    const renders = vi.fn()
    renderHook(() => {
      renders()
      return useRecording()
    })

    act(() => useAppStore.getState().setPipelineState('recording'))
    renders.mockClear()
    act(() => useAppStore.getState().setAudioVolume(0.5))

    expect(useAppStore.getState().audioVolume).toBe(0.5)
    expect(renders).not.toHaveBeenCalled()
  })
})
