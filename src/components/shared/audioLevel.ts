import { normalizeAudioVolume } from '../../stores/appStore'

export function audioLevelSegmentCount(value: number, segmentCount: number): number {
  const count = Number.isFinite(segmentCount) ? Math.max(0, Math.floor(segmentCount)) : 0
  return Math.round(normalizeAudioVolume(value) * count)
}
