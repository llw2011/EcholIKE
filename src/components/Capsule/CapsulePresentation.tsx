import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from 'react'
import { Check, Info, Loader2, X } from 'lucide-react'
import type { CapsuleStyle } from '../../stores/appStore'
import { useAppStore } from '../../stores/appStore'
import { abortRecording } from '../../lib/tauri'
import { userFacingErrorMessage } from '../../lib/userErrors'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { getCapsuleSurfaceState, type CapsuleSize, type CapsuleVisualState } from './capsuleSkin'
import { CapsuleGlyph } from './CapsuleGlyph'
import { DurationTimer } from './DurationTimer'
import { Waveform } from './Waveform'

export type CapsuleRenderMode = 'runtime' | 'preview'

const CAPSULE_PREVIEW_SCALE = {
  card: 0.64,
  current: 0.86,
} as const

interface CapsuleFrameProps {
  capsuleStyle: CapsuleStyle
  capsuleState: CapsuleVisualState
  capsuleSize: CapsuleSize
  mode: CapsuleRenderMode
  previewVariant?: 'card' | 'current'
  visible?: boolean
  rootStyle?: CSSProperties
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void
  onSurfacePointerDown?: (event: PointerEvent<HTMLDivElement>) => void
  onSurfacePointerMove?: (event: PointerEvent<HTMLDivElement>) => void
  onSurfacePointerUp?: (event: PointerEvent<HTMLDivElement>) => void
  children: ReactNode
}

export function CapsuleFrame({
  capsuleStyle,
  capsuleState,
  capsuleSize,
  mode,
  previewVariant = 'card',
  visible = true,
  rootStyle,
  onContextMenu,
  onSurfacePointerDown,
  onSurfacePointerMove,
  onSurfacePointerUp,
  children,
}: CapsuleFrameProps) {
  const surfaceState = getCapsuleSurfaceState(capsuleState)
  const previewScale = CAPSULE_PREVIEW_SCALE[previewVariant]
  const surfaceStyle: CSSProperties = {
    width: capsuleSize.width,
    height: capsuleSize.height,
    ...(mode === 'runtime'
      ? {
          opacity: visible ? 1 : 0,
          visibility: visible ? 'visible' : 'hidden',
          pointerEvents: visible ? 'auto' : 'none',
        }
      : {}),
  }

  const surface = (
    <div
      className={`echo-capsule-frame echo-capsule-surface echo-capsule-surface--${surfaceState}`}
      data-capsule-surface-state={surfaceState}
      data-capsule-state={capsuleState}
      style={surfaceStyle}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onSurfacePointerMove}
      onPointerUp={onSurfacePointerUp}
    >
      <div className="echo-capsule-state" data-capsule-content-state={capsuleState}>
        {children}
      </div>
    </div>
  )

  const previewSurface = (
    <div
      className="echo-capsule-preview-viewport"
      data-capsule-preview-variant={previewVariant}
      style={
        {
          '--echo-capsule-preview-scale': previewScale,
          width: capsuleSize.width * previewScale,
          height: capsuleSize.height * previewScale,
        } as CSSProperties
      }
    >
      <div
        className="echo-capsule-preview-scale"
        style={{ width: capsuleSize.width, height: capsuleSize.height }}
      >
        {surface}
      </div>
    </div>
  )

  return (
    <div
      className={[
        'echo-capsule-skin',
        `echo-capsule-skin--${mode}`,
        mode === 'preview' ? `echo-capsule-skin--preview-${previewVariant}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-capsule-style={capsuleStyle}
      data-capsule-state={capsuleState}
      style={rootStyle}
      aria-hidden={mode === 'preview' || undefined}
      onContextMenu={onContextMenu}
    >
      {mode === 'preview' ? previewSurface : surface}
    </div>
  )
}

interface CapsuleStateContentProps {
  capsuleStyle: CapsuleStyle
  capsuleState: CapsuleVisualState
  mode?: CapsuleRenderMode
  previewVariant?: 'card' | 'current'
  pipelineNotice?: string | null
  errorText?: string | null
}

export function CapsuleStateContent({
  capsuleStyle,
  capsuleState,
  mode = 'runtime',
  previewVariant = 'card',
  pipelineNotice = null,
  errorText,
}: CapsuleStateContentProps) {
  const partialTranscript = useAppStore((state) => state.partialTranscript)
  const pipelineError = useAppStore((state) => state.pipelineError)
  const reduced = useReducedMotion()
  const isPreview = mode === 'preview'
  const animatedPreview = isPreview && previewVariant === 'current' && !reduced

  const stopPointerPropagation = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
  }

  const handleCancel = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (isPreview) return

    const store = useAppStore.getState()
    const leaseId = store.tryStartRecordingTransition('abort')
    if (leaseId === null) return
    void abortRecording()
      .then(() => useAppStore.getState().finishRecordingTransition(leaseId))
      .catch((error: unknown) =>
        useAppStore
          .getState()
          .failRecordingTransition(leaseId, userFacingErrorMessage(error, '取消录音失败。')),
      )
  }

  const cancelLabel =
    capsuleState === 'recording'
      ? '取消录音'
      : capsuleState === 'transcribing'
        ? '取消处理'
        : '取消润色'

  const cancelControl =
    capsuleState === 'recording' ||
    capsuleState === 'transcribing' ||
    capsuleState === 'polishing' ? (
      isPreview ? (
        <span
          className="echo-capsule-cancel echo-capsule-cancel--preview"
          data-capsule-preview-cancel={capsuleState}
          aria-hidden="true"
        >
          <X size={12} />
        </span>
      ) : (
        <button
          type="button"
          className="echo-capsule-cancel"
          aria-label={cancelLabel}
          data-capsule-cancel={capsuleState}
          onPointerDown={stopPointerPropagation}
          onPointerMove={stopPointerPropagation}
          onPointerUp={stopPointerPropagation}
          onClick={handleCancel}
        >
          <X size={12} />
        </button>
      )
    ) : null

  if (capsuleState === 'idle') {
    return (
      <div className="echo-capsule-content echo-capsule-content--idle">
        <div className={reduced ? '' : 'echo-capsule-breathe'}>
          <CapsuleGlyph capsuleStyle={capsuleStyle} />
        </div>
      </div>
    )
  }

  if (capsuleState === 'recording') {
    return (
      <div className="echo-capsule-content echo-capsule-content--recording">
        <span
          className={
            reduced || (isPreview && !animatedPreview)
              ? 'echo-capsule-status-dot'
              : 'echo-capsule-status-dot is-animated'
          }
          data-capsule-indicator-style={capsuleStyle}
        />
        <Waveform
          capsuleStyle={capsuleStyle}
          preview={isPreview}
          animatePreview={animatedPreview}
        />
        <span className="echo-capsule-content-spacer" />
        <DurationTimer preview={isPreview} />
        {cancelControl}
      </div>
    )
  }

  if (capsuleState === 'transcribing') {
    return (
      <div className="echo-capsule-content echo-capsule-content--processing">
        <Loader2
          className={reduced ? 'echo-capsule-loader' : 'echo-capsule-loader is-animated'}
          size={12}
        />
        <p className="echo-capsule-copy">
          {partialTranscript || '转录中…'}
          <span className={reduced ? 'echo-capsule-caret' : 'echo-capsule-caret is-animated'} />
        </p>
        {cancelControl}
      </div>
    )
  }

  if (capsuleState === 'polishing') {
    return (
      <div className="echo-capsule-content echo-capsule-content--polishing">
        <span className="echo-capsule-thinking-dots" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <i
              key={index}
              className={reduced ? '' : 'is-animated'}
              style={reduced ? undefined : { animationDelay: `${index * 0.2}s` }}
            />
          ))}
        </span>
        <p className="echo-capsule-copy">正在润色…</p>
        {cancelControl}
        <span className={reduced ? 'echo-capsule-progress' : 'echo-capsule-progress is-animated'} />
      </div>
    )
  }

  if (capsuleState === 'outputting') {
    const isInformationalNotice = Boolean(pipelineNotice && pipelineNotice !== '已复制')

    return (
      <div
        className={`echo-capsule-content ${
          isInformationalNotice ? 'echo-capsule-content--notice' : 'echo-capsule-content--complete'
        }`}
        data-capsule-notice-tone={isInformationalNotice ? 'notice' : 'success'}
      >
        {isInformationalNotice ? <Info size={14} /> : <Check size={14} />}
        <span>{pipelineNotice || '完成'}</span>
      </div>
    )
  }

  return (
    <div
      className="echo-capsule-content echo-capsule-content--error"
      data-capsule-error-style={capsuleStyle}
    >
      <CapsuleGlyph capsuleStyle={capsuleStyle} size="inline" />
      <p className="echo-capsule-copy">{errorText || pipelineError || '发生错误'}</p>
    </div>
  )
}
