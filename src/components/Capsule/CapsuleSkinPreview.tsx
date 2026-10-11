import type { CapsuleStyle } from '../../stores/appStore'
import { CapsuleFrame, CapsuleStateContent } from './CapsulePresentation'
import { getCapsuleSize } from './capsuleSkin'

type PreviewVariant = 'card' | 'current'

export function CapsuleSkinPreview({
  capsuleStyle,
  variant = 'card',
}: {
  capsuleStyle: CapsuleStyle
  variant?: PreviewVariant
}) {
  const capsuleState = 'recording'

  return (
    <CapsuleFrame
      capsuleStyle={capsuleStyle}
      capsuleState={capsuleState}
      capsuleSize={getCapsuleSize(capsuleStyle, capsuleState)}
      mode="preview"
      previewVariant={variant}
    >
      <CapsuleStateContent
        capsuleStyle={capsuleStyle}
        capsuleState={capsuleState}
        mode="preview"
        previewVariant={variant}
      />
    </CapsuleFrame>
  )
}
