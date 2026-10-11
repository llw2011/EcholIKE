import { useEffect, useRef } from 'react'
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  type PhysicalSize,
} from '@tauri-apps/api/window'
import { syncMainWindowShape } from '../lib/tauri'

export type StartupUpdateWindowMode = 'checking' | 'available' | 'installing' | 'failed' | null

interface SavedWindowFrame {
  size: PhysicalSize
  position: PhysicalPosition
}

const PROMPT_WINDOW_WIDTH = 520
const PROMPT_WINDOW_HEIGHT = 340
const PROMPT_WINDOW_BUSY_HEIGHT = 420
const HIDDEN_FRAME_FALLBACK_MS = 80
const SHAPE_SYNC_TIMEOUT_MS = 200

function promptWindowHeight(mode: Exclude<StartupUpdateWindowMode, 'checking' | null>) {
  return mode === 'available' ? PROMPT_WINDOW_HEIGHT : PROMPT_WINDOW_BUSY_HEIGHT
}

function nextRenderedFrame() {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(fallback)
      resolve()
    }
    const fallback = window.setTimeout(finish, HIDDEN_FRAME_FALLBACK_MS)

    if (typeof window.requestAnimationFrame !== 'function') {
      finish()
      return
    }
    window.requestAnimationFrame(() => window.setTimeout(finish, 0))
  })
}

export function useStartupUpdateWindow(mode: StartupUpdateWindowMode, revealWhenReady: boolean) {
  const savedFrame = useRef<SavedWindowFrame | null>(null)
  const transitionId = useRef(0)
  const revealed = useRef(false)

  useEffect(() => {
    const currentTransition = ++transitionId.current
    const appWindow = getCurrentWindow()

    function isCurrentTransition() {
      return transitionId.current === currentTransition
    }

    async function setWindowSize(size: LogicalSize | PhysicalSize) {
      await appWindow.setSize(size)
      await syncWindowShape()
    }

    async function syncWindowShape() {
      let timeout: number | undefined
      await Promise.race([
        syncMainWindowShape(),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error('Main window shape synchronization timed out')),
            SHAPE_SYNC_TIMEOUT_MS,
          )
        }),
      ]).catch((error) => {
        console.warn('Main window shape synchronization skipped:', error)
      })
      if (timeout !== undefined) window.clearTimeout(timeout)
    }

    async function revealWindow() {
      if (!revealWhenReady || revealed.current || !isCurrentTransition()) return

      revealed.current = true
      try {
        await appWindow.show()
      } catch (error) {
        revealed.current = false
        throw error
      }
      await appWindow.setFocus().catch((error) => {
        console.warn('Main window focus skipped:', error)
      })
    }

    async function centerPrompt(height: number) {
      if (!savedFrame.current) {
        const [size, position] = await Promise.all([
          appWindow.outerSize(),
          appWindow.outerPosition(),
        ])
        if (!isCurrentTransition()) return
        savedFrame.current = { size, position }
      }

      const originalFrame = savedFrame.current
      if (!originalFrame || !isCurrentTransition()) return

      await setWindowSize(new LogicalSize(PROMPT_WINDOW_WIDTH, height))
      if (!isCurrentTransition()) return

      const [monitor, promptSize] = await Promise.all([
        currentMonitor().catch(() => null),
        appWindow.outerSize(),
      ])
      if (!isCurrentTransition()) return

      const workArea = monitor?.workArea
      const centerX = workArea
        ? workArea.position.x + (workArea.size.width - promptSize.width) / 2
        : originalFrame.position.x + (originalFrame.size.width - promptSize.width) / 2
      const centerY = workArea
        ? workArea.position.y + (workArea.size.height - promptSize.height) / 2
        : originalFrame.position.y + (originalFrame.size.height - promptSize.height) / 2

      await appWindow.setPosition(new PhysicalPosition(Math.round(centerX), Math.round(centerY)))
      if (!isCurrentTransition() || !revealWhenReady || revealed.current) return

      await nextRenderedFrame()
      await revealWindow()
    }

    async function restoreMainWindow() {
      const originalFrame = savedFrame.current
      if (!originalFrame) {
        await nextRenderedFrame()
        if (!isCurrentTransition()) return
        await syncWindowShape()
      } else {
        await setWindowSize(originalFrame.size)
        if (!isCurrentTransition()) return
        await appWindow.setPosition(originalFrame.position)
        if (!isCurrentTransition()) return
        savedFrame.current = null
        await nextRenderedFrame()
        if (!isCurrentTransition()) return
      }

      await revealWindow()
    }

    const transition =
      mode === 'checking'
        ? Promise.resolve()
        : mode
          ? centerPrompt(promptWindowHeight(mode))
          : restoreMainWindow()
    void transition.catch(async (error) => {
      console.warn('Startup update window resize skipped:', error)
      if (mode === 'checking' || !revealWhenReady || revealed.current || !isCurrentTransition()) {
        return
      }

      await syncWindowShape()
      if (!isCurrentTransition()) return
      await revealWindow().catch((revealError) => {
        console.warn('Startup window fallback reveal skipped:', revealError)
      })
    })

    return () => {
      if (isCurrentTransition()) transitionId.current += 1
    }
  }, [mode, revealWhenReady])
}
