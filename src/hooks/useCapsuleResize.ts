import { useEffect, useRef } from 'react'
import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from '@tauri-apps/api/window'
import { useAppStore, type CapsuleStyle, type PipelineState } from '../stores/appStore'
import {
  getCapsuleSize,
  getCapsuleVisualState,
  type CapsuleSize,
} from '../components/Capsule/capsuleSkin'

export interface CapsuleVisibilityInput {
  capsuleAutoHide: boolean
  contextMenuOpen: boolean
  hasError: boolean
  hasNotice?: boolean
  pipelineState: PipelineState
}

export function getCapsuleVisibility({
  capsuleAutoHide,
  contextMenuOpen,
  hasError,
  hasNotice = false,
  pipelineState,
}: CapsuleVisibilityInput): boolean {
  return !capsuleAutoHide || contextMenuOpen || hasError || hasNotice || pipelineState !== 'idle'
}

export function getCapsuleFocusable(): boolean {
  return false
}

export function getCapsuleWindowFrame(
  state: PipelineState,
  hasError: boolean,
  contextMenuOpen: boolean,
  capsuleStyle: CapsuleStyle = 'classic',
  hasNotice = false,
): { capsule: CapsuleSize; window: CapsuleSize } {
  const capsuleState = getCapsuleVisualState(state, hasError, hasNotice)
  const capsule = getCapsuleSize(capsuleStyle, capsuleState)
  if (!contextMenuOpen) return { capsule, window: capsule }

  return {
    capsule,
    window: {
      width: Math.max(220, capsule.width + 156),
      height: 220,
    },
  }
}

export function useCapsuleResize() {
  const pipelineState = useAppStore((s) => s.pipelineState)
  const pipelineError = useAppStore((s) => s.pipelineError)
  const recordingTransitionError = useAppStore((s) => s.recordingTransition.error)
  const pipelineNotice = useAppStore((s) => s.pipelineNotice)
  const contextMenuOpen = useAppStore((s) => s.contextMenuOpen)
  const setContextMenuReady = useAppStore((s) => s.setContextMenuReady)
  const capsuleAutoHide = useAppStore((s) => s.config.capsule_auto_hide)
  const capsuleStyle = useAppStore((s) => s.config.capsule_style)
  const initialized = useRef(false)
  const prevWindowSize = useRef<{ width: number; height: number } | null>(null)

  const hasError = pipelineError !== null || recordingTransitionError !== null
  const hasNotice = pipelineNotice !== null

  useEffect(() => {
    const frame = getCapsuleWindowFrame(
      pipelineState,
      hasError,
      contextMenuOpen,
      capsuleStyle,
      hasNotice,
    )
    const windowWidth = frame.window.width
    const windowHeight = frame.window.height
    const shouldShow = getCapsuleVisibility({
      capsuleAutoHide,
      contextMenuOpen,
      hasError,
      hasNotice,
      pipelineState,
    })

    Promise.resolve()
      .then(async () => {
        const win = getCurrentWindow()
        await win.setFocusable(getCapsuleFocusable()).catch(() => {})

        if (!initialized.current) {
          // First mount: position at bottom-center of screen, then show
          await win.setSize(new LogicalSize(windowWidth, windowHeight)).catch(() => {})
          try {
            const monitor = await currentMonitor()
            if (monitor) {
              const sw = monitor.size.width / monitor.scaleFactor
              const sh = monitor.size.height / monitor.scaleFactor
              const x = Math.round(sw / 2 - windowWidth / 2)
              const y = Math.round(sh - windowHeight - 80)
              await win.setPosition(new LogicalPosition(x, y)).catch(() => {})
            }
          } catch {
            /* ignore - monitor info unavailable */
          }
          if (shouldShow) {
            await win.show().catch(() => {})
          } else {
            await win.hide().catch(() => {})
          }
          initialized.current = true
          prevWindowSize.current = { width: windowWidth, height: windowHeight }
          return
        }

        if (!shouldShow) {
          await win.hide().catch(() => {})
        }

        // Subsequent resizes: left edge + vertical center stay fixed so the
        // capsule does not jump when it grows from idle to active/error states.
        const prev = prevWindowSize.current
        if (prev) {
          const pos = await win.outerPosition().catch(() => null)
          if (pos) {
            const monitor = await currentMonitor()
            const scale = monitor?.scaleFactor ?? 1
            const oldLeftX = pos.x / scale
            const oldCenterY = pos.y / scale + prev.height / 2
            const newX = Math.round(oldLeftX)
            const newY = Math.round(oldCenterY - windowHeight / 2)
            await win.setPosition(new LogicalPosition(newX, newY)).catch(() => {})
            await win.setSize(new LogicalSize(windowWidth, windowHeight)).catch(() => {})
          } else {
            await win.setSize(new LogicalSize(windowWidth, windowHeight)).catch(() => {})
          }
        } else {
          await win.setSize(new LogicalSize(windowWidth, windowHeight)).catch(() => {})
        }

        prevWindowSize.current = { width: windowWidth, height: windowHeight }

        // Signal that the window has finished resizing for context menu
        if (contextMenuOpen) {
          setContextMenuReady(true)
        }

        if (shouldShow) {
          await win.show().catch(() => {})
        }
      })
      .catch(() => {})
  }, [
    pipelineState,
    hasError,
    hasNotice,
    contextMenuOpen,
    capsuleAutoHide,
    capsuleStyle,
    setContextMenuReady,
  ])

  return getCapsuleWindowFrame(pipelineState, hasError, contextMenuOpen, capsuleStyle, hasNotice)
    .capsule
}
