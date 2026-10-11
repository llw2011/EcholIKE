import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { startRecording as startCommand, stopRecording as stopCommand } from '../lib/tauri'
import { userFacingErrorMessage } from '../lib/userErrors'

export function useRecording() {
  const pipelineState = useAppStore((state) => state.pipelineState)
  const resetRecording = useAppStore((state) => state.resetRecording)
  const transitionStatus = useAppStore((state) => state.recordingTransition.status)
  const transitionError = useAppStore((state) => state.recordingTransition.error)

  const run = useCallback(async (kind: 'start' | 'stop', command: () => Promise<boolean>) => {
    const store = useAppStore.getState()
    const leaseId = store.tryStartRecordingTransition(kind)
    if (leaseId === null) return false
    try {
      const acquired = await command()
      useAppStore.getState().finishRecordingTransition(leaseId)
      return acquired
    } catch (error) {
      useAppStore
        .getState()
        .failRecordingTransition(leaseId, userFacingErrorMessage(error, '录音命令执行失败。'))
      return false
    }
  }, [])

  const startRecording = useCallback(async () => {
    return run('start', async () => {
      const acquired = await startCommand()
      if (acquired) resetRecording()
      return acquired
    })
  }, [resetRecording, run])

  const stopRecording = useCallback(async () => {
    return run('stop', stopCommand)
  }, [run])

  const isRecording = pipelineState === 'recording'
  const isProcessing = pipelineState === 'transcribing' || pipelineState === 'polishing'
  const isIdle = pipelineState === 'idle'

  return {
    startRecording,
    stopRecording,
    isRecording,
    isProcessing,
    isIdle,
    pipelineState,
    transitionBusy: transitionStatus === 'running',
    transitionError,
  }
}
