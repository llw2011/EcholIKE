import { normalizeAudioVolume, useAppStore } from '../../stores/appStore'
import { audioLevelSegmentCount } from './audioLevel'

export function AudioLevelMeter({
  segmentCount,
  className,
  ariaLabel = '实时输入电平',
  simulatedLevel,
}: {
  segmentCount: number
  className: string
  ariaLabel?: string
  simulatedLevel?: number
}) {
  const liveLevel = useAppStore((state) =>
    state.pipelineState === 'recording' ? state.audioVolume : 0,
  )
  const level = normalizeAudioVolume(simulatedLevel ?? liveLevel)
  const count = Number.isFinite(segmentCount) ? Math.max(0, Math.floor(segmentCount)) : 0
  const activeCount = audioLevelSegmentCount(level, count)

  return (
    <div
      className={className}
      role="meter"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={level}
      aria-valuetext={`${activeCount}/${count}`}
    >
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={index < activeCount ? 'is-active' : ''} />
      ))}
    </div>
  )
}
