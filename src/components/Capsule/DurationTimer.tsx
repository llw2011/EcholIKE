import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { stopRecording } from '../../lib/tauri'
import { userFacingErrorMessage } from '../../lib/userErrors'

export function DurationTimer({ preview = false }: { preview?: boolean }) {
  const pipelineState = useAppStore((s) => s.pipelineState)
  const maxSeconds = useAppStore((s) => s.config.max_recording_seconds)
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (preview || pipelineState !== 'recording') {
      setSeconds(0)
      return
    }
    const interval = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(interval)
  }, [preview, pipelineState])

  useEffect(() => {
    if (!preview && pipelineState === 'recording' && seconds >= maxSeconds) {
      const store = useAppStore.getState()
      const leaseId = store.tryStartRecordingTransition('stop')
      if (leaseId === null) return
      void stopRecording()
        .then(() => useAppStore.getState().finishRecordingTransition(leaseId))
        .catch((e: unknown) =>
          useAppStore
            .getState()
            .failRecordingTransition(leaseId, userFacingErrorMessage(e, '自动停止录音失败。')),
        )
    }
  }, [preview, seconds, pipelineState, maxSeconds])

  const displaySeconds = preview ? 8 : seconds
  const mm = String(Math.floor(displaySeconds / 60)).padStart(2, '0')
  const ss = String(displaySeconds % 60).padStart(2, '0')

  return (
    <span className="echo-capsule-duration">
      {mm}:{ss}
    </span>
  )
}
