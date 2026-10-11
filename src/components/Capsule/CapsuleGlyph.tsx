import { useReducedMotion } from '../../hooks/useReducedMotion'
import { useAppStore } from '../../stores/appStore'
import type { CapsuleStyle } from '../../stores/appStore'

type Size = 'idle' | 'inline'

export function CapsuleGlyph({
  size = 'idle',
  capsuleStyle: capsuleStyleOverride,
}: {
  size?: Size
  capsuleStyle?: CapsuleStyle
}) {
  const configuredCapsuleStyle = useAppStore((s) => s.config.capsule_style)
  const capsuleStyle = capsuleStyleOverride ?? configuredCapsuleStyle
  const reduced = useReducedMotion()

  return (
    <span
      className={`echo-capsule-glyph echo-capsule-glyph--${capsuleStyle} echo-capsule-glyph--${size} ${
        reduced ? 'is-reduced' : ''
      }`}
      aria-hidden="true"
    >
      <i />
      <b />
      <em />
    </span>
  )
}
