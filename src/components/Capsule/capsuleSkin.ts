import { CAPSULE_STYLE_OPTIONS, type CapsuleStyle } from '../../lib/appearanceProfiles'
import type { PipelineState } from '../../stores/appStore'

export type CapsuleVisualState = PipelineState | 'error'

export interface CapsuleSize {
  width: number
  height: number
}

type CapsuleGeometry = Record<CapsuleVisualState, CapsuleSize>

// Single geometry authority for the transparent capsule window and settings preview.
// Classic intentionally retains the dimensions of the prior live capsule.
const capsuleGeometry: Record<CapsuleStyle, CapsuleGeometry> = {
  classic: {
    idle: { width: 36, height: 36 },
    recording: { width: 200, height: 36 },
    transcribing: { width: 220, height: 36 },
    polishing: { width: 220, height: 36 },
    outputting: { width: 120, height: 36 },
    error: { width: 200, height: 36 },
  },
  compact: {
    idle: { width: 32, height: 32 },
    recording: { width: 180, height: 32 },
    transcribing: { width: 198, height: 32 },
    polishing: { width: 198, height: 32 },
    outputting: { width: 108, height: 32 },
    error: { width: 180, height: 32 },
  },
  glass: {
    idle: { width: 38, height: 38 },
    recording: { width: 208, height: 38 },
    transcribing: { width: 228, height: 38 },
    polishing: { width: 228, height: 38 },
    outputting: { width: 126, height: 38 },
    error: { width: 208, height: 38 },
  },
  ink: {
    idle: { width: 36, height: 36 },
    recording: { width: 196, height: 36 },
    transcribing: { width: 216, height: 36 },
    polishing: { width: 216, height: 36 },
    outputting: { width: 118, height: 36 },
    error: { width: 196, height: 36 },
  },
  command: {
    idle: { width: 38, height: 38 },
    recording: { width: 206, height: 38 },
    transcribing: { width: 228, height: 38 },
    polishing: { width: 228, height: 38 },
    outputting: { width: 124, height: 38 },
    error: { width: 206, height: 38 },
  },
  signal: {
    idle: { width: 38, height: 38 },
    recording: { width: 204, height: 38 },
    transcribing: { width: 224, height: 38 },
    polishing: { width: 224, height: 38 },
    outputting: { width: 124, height: 38 },
    error: { width: 204, height: 38 },
  },
  pulse: {
    idle: { width: 38, height: 38 },
    recording: { width: 208, height: 38 },
    transcribing: { width: 228, height: 38 },
    polishing: { width: 228, height: 38 },
    outputting: { width: 126, height: 38 },
    error: { width: 208, height: 38 },
  },
  orbit: {
    idle: { width: 38, height: 38 },
    recording: { width: 212, height: 38 },
    transcribing: { width: 232, height: 38 },
    polishing: { width: 232, height: 38 },
    outputting: { width: 128, height: 38 },
    error: { width: 212, height: 38 },
  },
}

export function getCapsuleVisualState(
  pipelineState: PipelineState,
  hasError: boolean,
  hasNotice = false,
): CapsuleVisualState {
  if (hasError) return 'error'
  return hasNotice ? 'outputting' : pipelineState
}

export function getCapsuleSurfaceState(state: CapsuleVisualState): 'idle' | 'active' | 'error' {
  if (state === 'error') return 'error'
  return state === 'idle' ? 'idle' : 'active'
}

export function getCapsuleSize(
  capsuleStyle: CapsuleStyle,
  capsuleState: CapsuleVisualState,
): CapsuleSize {
  return capsuleGeometry[capsuleStyle][capsuleState]
}

export const capsuleStyleOptions = CAPSULE_STYLE_OPTIONS

export function capsuleStyleOption(style: CapsuleStyle) {
  return capsuleStyleOptions.find((option) => option.id === style) ?? capsuleStyleOptions[0]
}
