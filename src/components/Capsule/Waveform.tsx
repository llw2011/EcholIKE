import { useReducedMotion } from '../../hooks/useReducedMotion'
import { useAppStore } from '../../stores/appStore'
import type { CapsuleStyle } from '../../stores/appStore'

type WaveformProfile = {
  shape: readonly number[]
  previewHeights: readonly number[]
  minHeight: number
  maxHeight: number
}

const RUNTIME_OPACITY_FLOOR = 0.5
const RUNTIME_RESPONSE_MS = 75

const WAVEFORM_PROFILES = {
  classic: {
    shape: [0.42, 0.68, 0.88, 1, 0.88, 0.68, 0.42],
    previewHeights: [6, 12, 8, 15, 9, 13, 7],
    minHeight: 3,
    maxHeight: 16,
  },
  compact: {
    shape: [0.38, 0.76, 1, 0.64, 0.42],
    previewHeights: [5, 11, 14, 9, 6],
    minHeight: 2,
    maxHeight: 14,
  },
  glass: {
    shape: [0.28, 0.52, 0.78, 1, 0.78, 0.52, 0.28],
    previewHeights: [5, 9, 13, 16, 13, 9, 5],
    minHeight: 3,
    maxHeight: 16,
  },
  ink: {
    shape: [1, 0.42, 0.72, 0.3],
    previewHeights: [12, 6, 10, 4],
    minHeight: 2,
    maxHeight: 13,
  },
  command: {
    shape: [0.28, 0.58, 1, 0.58, 0.28],
    previewHeights: [4, 8, 14, 8, 4],
    minHeight: 3,
    maxHeight: 14,
  },
  signal: {
    shape: [0.18, 0.34, 0.56, 0.78, 1, 0.78, 0.56, 0.34, 0.18],
    previewHeights: [3, 6, 10, 14, 16, 14, 10, 6, 3],
    minHeight: 2,
    maxHeight: 16,
  },
  pulse: {
    shape: [0.24, 0.5, 0.78, 1, 0.78, 0.5, 0.24],
    previewHeights: [4, 8, 13, 16, 13, 8, 4],
    minHeight: 3,
    maxHeight: 16,
  },
  orbit: {
    shape: [0.32, 0.72, 1, 0.44, 0.86, 0.56],
    previewHeights: [5, 11, 15, 7, 13, 6],
    minHeight: 2,
    maxHeight: 15,
  },
} satisfies Record<CapsuleStyle, WaveformProfile>

function clampAudioLevel(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function roundStyleValue(value: number) {
  return Math.round(value * 100) / 100
}

export function Waveform({
  capsuleStyle,
  preview = false,
  animatePreview = false,
}: {
  capsuleStyle: CapsuleStyle
  preview?: boolean
  animatePreview?: boolean
}) {
  const reduced = useReducedMotion()
  const audioLevel = useAppStore((state) => (preview ? 0 : state.audioVolume))
  const synthetic = preview && animatePreview && !reduced
  const normalizedLevel = preview ? 0 : clampAudioLevel(audioLevel)
  const profile = WAVEFORM_PROFILES[capsuleStyle]

  return (
    <div
      className={`echo-capsule-waveform${synthetic ? ' is-synthetic' : ''}`}
      data-capsule-waveform-style={capsuleStyle}
      data-capsule-waveform={
        preview ? (synthetic ? 'preview-animated' : 'preview-static') : 'runtime'
      }
    >
      {profile.shape.map((shape, index) => {
        const amplitude = normalizedLevel * shape
        const height = preview
          ? (profile.previewHeights[index] ?? profile.minHeight)
          : roundStyleValue(profile.minHeight + (profile.maxHeight - profile.minHeight) * amplitude)
        const opacity = preview
          ? 0.82
          : roundStyleValue(RUNTIME_OPACITY_FLOOR + amplitude * (1 - RUNTIME_OPACITY_FLOOR))

        return (
          <span
            key={index}
            className="echo-capsule-waveform-bar"
            style={{
              height: `${height}px`,
              opacity,
              transition:
                !preview && !reduced && normalizedLevel > 0
                  ? `height ${RUNTIME_RESPONSE_MS}ms ease-out, opacity ${RUNTIME_RESPONSE_MS}ms ease-out`
                  : undefined,
            }}
          />
        )
      })}
    </div>
  )
}
