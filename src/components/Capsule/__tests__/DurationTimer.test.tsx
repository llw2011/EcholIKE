import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stopRecording } from '../../../lib/tauri'
import { useAppStore } from '../../../stores/appStore'
import { DurationTimer } from '../DurationTimer'

vi.mock('../../../lib/tauri', () => ({ stopRecording: vi.fn() }))

describe('DurationTimer recording transition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(useAppStore.getInitialState())
    useAppStore.setState((state) => ({
      pipelineState: 'recording',
      config: { ...state.config, max_recording_seconds: 1 },
    }))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('issues one IPC while auto-stop is pending and releases a boolean no-op', async () => {
    let resolve!: (acquired: boolean) => void
    vi.mocked(stopRecording).mockReturnValue(new Promise((done) => (resolve = done)))
    render(<DurationTimer />)
    act(() => vi.advanceTimersByTime(3000))
    expect(stopRecording).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve(false)
      await Promise.resolve()
    })
    expect(useAppStore.getState().recordingTransition.status).toBe('idle')
    expect(useAppStore.getState().pipelineState).toBe('recording')
  })

  it('captures rejection in the typed task without an unhandled promise', async () => {
    vi.mocked(stopRecording).mockRejectedValue(new Error('timer stop rejected'))
    render(<DurationTimer />)
    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })
    expect(useAppStore.getState().recordingTransition).toMatchObject({
      status: 'error',
      error: '自动停止录音失败。',
    })
  })
})
