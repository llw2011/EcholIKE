import { describe, expect, it } from 'vitest'
import {
  appendPolishedChunkTransition,
  createIdleRecordingTransition,
  failRecordingTransition,
  finishRecordingTransition,
  normalizeAudioVolume,
  pipelineStateTransition,
  resetRecordingTransition,
  startRecordingTransition,
} from '../appStore.recording'
import { getState, setupAppStoreTestLifecycle } from './appStoreTestHarness'

describe('appStore recording transitions', () => {
  it('normalizes non-finite and out-of-range audio volume', () => {
    expect(normalizeAudioVolume(Number.NaN)).toBe(0)
    expect(normalizeAudioVolume(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizeAudioVolume(-0.5)).toBe(0)
    expect(normalizeAudioVolume(0.5)).toBe(0.5)
    expect(normalizeAudioVolume(1.5)).toBe(1)
  })

  it('resets volume on pipeline boundaries but preserves it within recording', () => {
    expect(pipelineStateTransition('idle', 'recording')).toEqual({
      pipelineState: 'recording',
      audioVolume: 0,
    })
    expect(pipelineStateTransition('recording', 'recording')).toEqual({
      pipelineState: 'recording',
    })
    expect(pipelineStateTransition('recording', 'transcribing')).toEqual({
      pipelineState: 'transcribing',
      audioVolume: 0,
    })
  })

  it('creates running and idle transition objects without sharing identity', () => {
    expect(startRecordingTransition('start', 7, '2026-08-29T00:00:00.000Z')).toEqual({
      recordingTransition: {
        kind: 'start',
        status: 'running',
        leaseId: 7,
        startedAt: '2026-08-29T00:00:00.000Z',
        error: null,
      },
    })

    const first = finishRecordingTransition()
    const second = finishRecordingTransition()
    expect(first.recordingTransition).toEqual(createIdleRecordingTransition())
    expect(first.recordingTransition).not.toBe(second.recordingTransition)
  })

  it('preserves the active transition identity when recording an error', () => {
    const running = startRecordingTransition(
      'abort',
      11,
      '2026-08-29T00:00:00.000Z',
    ).recordingTransition

    expect(failRecordingTransition(running, '停止失败')).toEqual({
      recordingTransition: {
        kind: 'abort',
        status: 'error',
        leaseId: 11,
        startedAt: '2026-08-29T00:00:00.000Z',
        error: '停止失败',
      },
    })
  })

  it('builds immutable transcript append and reset patches', () => {
    expect(appendPolishedChunkTransition('hello', ' world')).toEqual({
      polishedText: 'hello world',
    })
    expect(resetRecordingTransition()).toEqual({
      audioVolume: 0,
      partialTranscript: '',
      finalTranscript: '',
      polishedText: '',
    })
  })
})

describe('appStore', () => {
  setupAppStoreTestLifecycle()

  describe('pipeline state', () => {
    it('defaults to idle', () => {
      expect(getState().pipelineState).toBe('idle')
    })

    it('updates pipeline state', () => {
      getState().setPipelineState('recording')
      expect(getState().pipelineState).toBe('recording')
    })

    it.each(['idle', 'transcribing', 'polishing', 'outputting'] as const)(
      'clears input level atomically when recording transitions to %s',
      (nextState) => {
        getState().setPipelineState('recording')
        getState().setAudioVolume(0.75)
        getState().setPipelineState(nextState)

        expect(getState()).toMatchObject({ pipelineState: nextState, audioVolume: 0 })
      },
    )
  })

  describe('recording transition lease', () => {
    it('starts idle, atomically excludes every transition kind, and never changes pipeline state', () => {
      expect(getState().recordingTransition).toMatchObject({ status: 'idle', leaseId: null })
      const lease = getState().tryStartRecordingTransition('start') ?? -1
      expect(getState().tryStartRecordingTransition('stop')).toBeNull()
      expect(getState().tryStartRecordingTransition('abort')).toBeNull()
      expect(getState().pipelineState).toBe('idle')
      getState().finishRecordingTransition(lease)
      expect(getState().recordingTransition.status).toBe('idle')
      expect(getState().pipelineState).toBe('idle')
    })

    it('rejects stale finish, fail, and clear callbacks after recovery starts a new lease', () => {
      const oldLease = getState().tryStartRecordingTransition('start') ?? -1
      getState().failRecordingTransition(oldLease, 'start failed')
      expect(getState().recordingTransition.error).toBe('start failed')
      const newLease = getState().tryStartRecordingTransition('abort') ?? -1
      getState().finishRecordingTransition(oldLease)
      getState().failRecordingTransition(oldLease, 'late failure')
      getState().clearRecordingTransition(oldLease)
      expect(getState().recordingTransition).toMatchObject({
        status: 'running',
        kind: 'abort',
        leaseId: newLease,
        error: null,
      })
    })
  })

  describe('recording state', () => {
    it('accepts only finite clamped input levels during recording', () => {
      getState().setAudioVolume(0.5)
      expect(getState().audioVolume).toBe(0)

      getState().setPipelineState('recording')
      getState().setAudioVolume(0.5)
      expect(getState().audioVolume).toBe(0.5)

      getState().setAudioVolume(4)
      expect(getState().audioVolume).toBe(1)

      getState().setAudioVolume(-1)
      expect(getState().audioVolume).toBe(0)

      getState().setAudioVolume(Number.NaN)
      expect(getState().audioVolume).toBe(0)

      getState().setAudioVolume(Number.POSITIVE_INFINITY)
      expect(getState().audioVolume).toBe(0)
    })

    it('resetRecording clears all recording fields', () => {
      getState().setPipelineState('recording')
      getState().setAudioVolume(0.8)
      getState().setPartialTranscript('partial')
      getState().setFinalTranscript('final')
      getState().appendPolishedChunk('polished')

      getState().resetRecording()

      expect(getState().audioVolume).toBe(0)
      expect(getState().partialTranscript).toBe('')
      expect(getState().finalTranscript).toBe('')
      expect(getState().polishedText).toBe('')
    })

    it('appendPolishedChunk appends to existing text', () => {
      getState().appendPolishedChunk('Hello')
      getState().appendPolishedChunk(' world')
      expect(getState().polishedText).toBe('Hello world')
    })

    it('keeps each completed voice result separate from the streaming transcript', () => {
      getState().setFinalTranscript('上一段识别')
      getState().setCompletedVoiceText('本次识别')

      expect(getState().completedVoiceText).toBe('本次识别')
      expect(getState().completedVoiceTextVersion).toBe(1)

      getState().setCompletedVoiceText('本次识别')
      expect(getState().completedVoiceTextVersion).toBe(2)
    })
  })
})
