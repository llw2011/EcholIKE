import { useRef, useCallback, useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAppStore } from '../../stores/appStore'
import { useRecording } from '../../hooks/useRecording'
import { getCapsuleVisibility, useCapsuleResize } from '../../hooks/useCapsuleResize'
import { CapsuleContextMenu } from './CapsuleContextMenu'
import { CapsuleFrame, CapsuleStateContent } from './CapsulePresentation'
import { getCapsuleVisualState } from './capsuleSkin'

const DRAG_THRESHOLD = 5

export function Capsule() {
  const pipelineState = useAppStore((s) => s.pipelineState)
  const pipelineError = useAppStore((s) => s.pipelineError)
  const pipelineNotice = useAppStore((s) => s.pipelineNotice)
  const recordingTransition = useAppStore((s) => s.recordingTransition)
  const clearRecordingTransition = useAppStore((s) => s.clearRecordingTransition)
  const contextMenuOpen = useAppStore((s) => s.contextMenuOpen)
  const setContextMenuOpen = useAppStore((s) => s.setContextMenuOpen)
  const contextMenuReady = useAppStore((s) => s.contextMenuReady)
  const setContextMenuReady = useAppStore((s) => s.setContextMenuReady)
  const capsuleAutoHide = useAppStore((s) => s.config.capsule_auto_hide)
  const capsuleStyle = useAppStore((s) => s.config.capsule_style)
  const resetRecording = useAppStore((s) => s.resetRecording)
  const setPipelineError = useAppStore((s) => s.setPipelineError)
  const { startRecording, stopRecording, isRecording, isProcessing, transitionBusy } =
    useRecording()

  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const isDragging = useRef(false)

  const capsuleSize = useCapsuleResize()

  const hasError = pipelineError !== null || recordingTransition.error !== null
  const hasNotice = pipelineNotice !== null
  const capsuleState = getCapsuleVisualState(pipelineState, hasError, hasNotice)
  const capsuleShouldShow = getCapsuleVisibility({
    capsuleAutoHide,
    contextMenuOpen,
    hasError,
    hasNotice,
    pipelineState,
  })

  useEffect(() => {
    if (capsuleState !== 'error') return

    const timer = window.setTimeout(() => {
      setPipelineError(null)
      if (recordingTransition.leaseId !== null) {
        clearRecordingTransition(recordingTransition.leaseId)
      }
      // Do not overwrite a recording that began during the error visibility window.
      if (useAppStore.getState().pipelineState === 'idle') {
        resetRecording()
      }
    }, 2500)

    return () => window.clearTimeout(timer)
  }, [
    capsuleState,
    clearRecordingTransition,
    pipelineError,
    recordingTransition.error,
    recordingTransition.leaseId,
    resetRecording,
    setPipelineError,
  ])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    dragStart.current = { x: e.clientX, y: e.clientY }
    isDragging.current = false
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragStart.current || isDragging.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      isDragging.current = true
      dragStart.current = null
      getCurrentWindow()
        .startDragging()
        .catch(() => {})
    }
  }, [])

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      if (isDragging.current) {
        isDragging.current = false
        dragStart.current = null
        return
      }
      dragStart.current = null

      if (transitionBusy) return
      if (isRecording) {
        void stopRecording()
      } else if (!isProcessing && !hasError && pipelineState === 'idle') {
        void startRecording()
      }
    },
    [
      isRecording,
      isProcessing,
      hasError,
      pipelineState,
      startRecording,
      stopRecording,
      transitionBusy,
    ],
  )

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!contextMenuOpen) {
      setContextMenuOpen(true)
    }
  }

  const handleCloseMenu = () => {
    setContextMenuReady(false)
    setContextMenuOpen(false)
  }

  return (
    <>
      <CapsuleFrame
        capsuleStyle={capsuleStyle}
        capsuleState={capsuleState}
        capsuleSize={capsuleSize}
        mode="runtime"
        visible={capsuleShouldShow}
        rootStyle={{ background: 'transparent' }}
        onContextMenu={handleContextMenu}
        onSurfacePointerDown={handlePointerDown}
        onSurfacePointerMove={handlePointerMove}
        onSurfacePointerUp={handlePointerUp}
      >
        <CapsuleStateContent
          key={capsuleState}
          capsuleStyle={capsuleStyle}
          capsuleState={capsuleState}
          pipelineNotice={pipelineNotice}
          errorText={recordingTransition.error ?? pipelineError}
        />
      </CapsuleFrame>
      {contextMenuOpen && contextMenuReady && (
        <div className="echo-capsule-context-menu" style={{ left: capsuleSize.width + 8 }}>
          <CapsuleContextMenu onClose={handleCloseMenu} />
        </div>
      )}
    </>
  )
}
