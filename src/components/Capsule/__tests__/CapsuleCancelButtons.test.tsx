import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { abortRecording } from '../../../lib/tauri'
import { useAppStore } from '../../../stores/appStore'
import { CapsuleStateContent } from '../CapsulePresentation'

vi.mock('../../../lib/tauri', () => ({
  abortRecording: vi.fn().mockResolvedValue(true),
}))

beforeEach(() => useAppStore.setState(useAppStore.getInitialState()))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Capsule cancel buttons', () => {
  for (const [capsuleState, label] of [
    ['recording', '取消录音'],
    ['transcribing', '取消处理'],
    ['polishing', '取消润色'],
  ] as const) {
    it(`keeps ${capsuleState} cancel pointer events inside the shared state content`, () => {
      const onPointerDown = vi.fn()
      const onPointerUp = vi.fn()

      render(
        <div onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          <CapsuleStateContent capsuleStyle="classic" capsuleState={capsuleState} />
        </div>,
      )

      const button = screen.getByRole('button', { name: label })
      fireEvent.pointerDown(button)
      fireEvent.pointerUp(button)
      fireEvent.click(button)

      expect(onPointerDown).not.toHaveBeenCalled()
      expect(onPointerUp).not.toHaveBeenCalled()
      expect(abortRecording).toHaveBeenCalledTimes(1)
    })
  }

  it('deduplicates a pending cancel and stores a normalized rejection', async () => {
    let reject!: (error: unknown) => void
    vi.mocked(abortRecording).mockReturnValue(
      new Promise((_resolve, rejectPromise) => (reject = rejectPromise)),
    )
    render(<CapsuleStateContent capsuleStyle="classic" capsuleState="recording" />)
    const button = screen.getByRole('button', { name: '取消录音' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(abortRecording).toHaveBeenCalledTimes(1)
    reject(new Error('capsule abort rejected'))
    await waitFor(() =>
      expect(useAppStore.getState().recordingTransition).toMatchObject({
        status: 'error',
        error: '取消录音失败。',
      }),
    )
  })
})
