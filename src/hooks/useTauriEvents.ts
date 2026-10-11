import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useAppStore } from '../stores/appStore'
import type { AppConfig, PipelineState } from '../stores/appStore'
import { getHistory } from '../lib/tauri'
import {
  capsuleErrorKeyFromPayload,
  capsuleErrorText,
  type PipelineErrorPayload,
} from '../lib/capsuleError'

let trayUpdateCheckRequestId = 0

function nextTrayUpdateCheckHash() {
  trayUpdateCheckRequestId += 1
  return `#/settings/about?check-update=1&request=${Date.now()}-${trayUpdateCheckRequestId}`
}

export function useTauriEvents() {
  useEffect(() => {
    const {
      setPartialTranscript,
      setFinalTranscript,
      appendPolishedChunk,
      resetRecording,
      setCompletedVoiceText,
      setPipelineState,
      setTargetApp,
      setPipelineError,
      setPipelineNotice,
      clearRecordingTransition,
      setAccessibilityTrusted,
      setHistory,
      applyPersistedConfigPatch,
      triggerScreenOcrShortcut,
    } = useAppStore.getState()
    let cancelled = false
    let pipelineNoticeTimer: number | null = null
    let pipelineNoticeSequence = 0
    const unlisteners: Array<() => void> = []

    const cancelPipelineNoticeTimer = () => {
      if (pipelineNoticeTimer === null) return
      window.clearTimeout(pipelineNoticeTimer)
      pipelineNoticeTimer = null
    }

    function addListener<T>(event: string, handler: (payload: T) => void) {
      listen<T>(event, (e) => handler(e.payload))
        .then((unlisten) => {
          if (cancelled) {
            unlisten()
          } else {
            unlisteners.push(unlisten)
          }
        })
        .catch((err) => {
          console.error(`Failed to register listener for "${event}":`, err)
        })
    }

    addListener<number>('audio:volume', (volume) => {
      const store = useAppStore.getState()
      if (store.pipelineState !== 'recording') return
      store.setAudioVolume(volume)
    })
    addListener<string>('stt:partial', setPartialTranscript)
    addListener<string>('stt:final', setFinalTranscript)
    addListener<string>('llm:chunk', appendPolishedChunk)
    addListener<PipelineState>('pipeline:state', (state) => {
      if (state === 'recording') {
        resetRecording()
        setCompletedVoiceText('')
        // Clear any previous error when starting a new pipeline run
        setPipelineError(null)
        pipelineNoticeSequence += 1
        cancelPipelineNoticeTimer()
        setPipelineNotice(null)
        const transition = useAppStore.getState().recordingTransition
        if (transition.status === 'error' && transition.leaseId !== null) {
          clearRecordingTransition(transition.leaseId)
        }
      }
      setPipelineState(state)
      if (state === 'idle') {
        const { polishedText, finalTranscript } = useAppStore.getState()
        const completedText = (polishedText || finalTranscript).trim()
        if (completedText) setCompletedVoiceText(completedText)
        // Don't clear pipelineError here - CapsuleError auto-resets after 2.5s.
        // Clearing here would swallow errors from failed start() calls that
        // transition Recording -> Idle in rapid succession.
        getHistory(200, 0)
          .then(setHistory)
          .catch((err) => {
            console.error('Failed to refresh history:', err)
          })
      }
    })
    addListener<string>('pipeline:target_app', setTargetApp)
    addListener<PipelineErrorPayload>('pipeline:error', (payload) => {
      const capsuleErrorKey = capsuleErrorKeyFromPayload(payload)
      setPipelineError(capsuleErrorText(capsuleErrorKey))
      if (capsuleErrorKey === 'accessibility_required') {
        setAccessibilityTrusted(false)
      }
    })
    addListener<{ code: string; details?: string }>('pipeline:warning', (payload) => {
      const notice = capsuleErrorText(capsuleErrorKeyFromPayload(payload))
      const noticeSequence = ++pipelineNoticeSequence
      cancelPipelineNoticeTimer()
      setPipelineNotice(notice)
      pipelineNoticeTimer = window.setTimeout(() => {
        pipelineNoticeTimer = null
        if (
          noticeSequence === pipelineNoticeSequence &&
          useAppStore.getState().pipelineNotice === notice
        ) {
          setPipelineNotice(null)
        }
      }, 2500)
    })
    addListener<Partial<AppConfig>>('config:patch', (patch) => {
      applyPersistedConfigPatch(patch)
    })

    addListener<void>('tray:settings', () => {
      window.location.hash = '#/settings'
    })
    addListener<string>('navigate', (hash) => {
      window.location.hash = hash === '#/settings' || hash === '#/settings/about' ? hash : '#/'
    })
    addListener<void>('tray:about', () => {
      window.location.hash = '#/settings/about'
    })
    addListener<void>('tray:check-update', () => {
      // Keep the one-shot action addressable even when About is already open.
      // A unique request value guarantees a real hash transition for every
      // tray click; the Settings page consumes it after starting the check.
      window.location.hash = nextTrayUpdateCheckHash()
    })
    addListener<void>('shortcut:screen_ocr', () => {
      window.location.hash = '#/'
      triggerScreenOcrShortcut()
    })
    addListener<string>('onboarding:shortcut', (shortcut) => {
      window.dispatchEvent(
        new CustomEvent('echolike:onboarding-shortcut', {
          detail: shortcut,
        }),
      )
    })
    return () => {
      cancelled = true
      pipelineNoticeSequence += 1
      cancelPipelineNoticeTimer()
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [])
}
