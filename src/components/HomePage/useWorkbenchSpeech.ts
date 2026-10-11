import { useEffect, useState } from 'react'
import { proxyTtsOnce, type ProcessLease } from '../../lib/tauri'
import { playTtsChunkQueue, splitSpeechText } from '../../lib/ttsPlayback'
import { userFacingErrorMessage } from '../../lib/userErrors'
import {
  useAppStore,
  type TtsPlaybackTarget,
  type WorkbenchFeedbackSlot,
} from '../../stores/appStore'
import { markdownDraftRevision } from '../MarkdownEditor/markdownAiTask'

type WorkbenchSpeechTarget = Exclude<TtsPlaybackTarget, 'preview'>

type UseWorkbenchSpeechOptions = {
  backendManaged: boolean
  desktopToken: string | null
}

function currentWorkbenchFeedbackResourceId(slot: WorkbenchFeedbackSlot) {
  const state = useAppStore.getState()
  if (slot === 'voice') {
    const text =
      state.completedVoiceText ||
      (state.pipelineState === 'idle' ? state.polishedText || state.finalTranscript : '')
    return text ? `voice:${state.completedVoiceTextVersion}:${markdownDraftRevision(text)}` : ''
  }
  if (state.askTask.status !== 'idle' && state.askTask.runId !== null) {
    return `ask:${state.askTask.runId}`
  }
  return state.ocrTask.result && state.ocrTask.runId !== null ? `ocr:${state.ocrTask.runId}` : ''
}

export function useWorkbenchSpeech({ backendManaged, desktopToken }: UseWorkbenchSpeechOptions) {
  const desktopBootstrap = useAppStore((state) => state.desktopBootstrap)
  const pipelineState = useAppStore((state) => state.pipelineState)
  const finalTranscript = useAppStore((state) => state.finalTranscript)
  const polishedText = useAppStore((state) => state.polishedText)
  const completedVoiceText = useAppStore((state) => state.completedVoiceText)
  const completedVoiceTextVersion = useAppStore((state) => state.completedVoiceTextVersion)
  const askTask = useAppStore((state) => state.askTask)
  const ocrTask = useAppStore((state) => state.ocrTask)
  const ttsBusy = useAppStore((state) => state.ttsPlaybackBusy)
  const tryStartTtsPlayback = useAppStore((state) => state.tryStartTtsPlayback)
  const finishTtsPlayback = useAppStore((state) => state.finishTtsPlayback)
  const workbenchFeedback = useAppStore((state) => state.workbenchFeedback)
  const setWorkbenchFeedback = useAppStore((state) => state.setWorkbenchFeedback)
  const [lastReadVoiceResult, setLastReadVoiceResult] = useState('')

  const cloudTts = desktopBootstrap?.services?.tts
  const ttsAvailable = Boolean(
    backendManaged &&
    cloudTts?.mode === 'proxy' &&
    cloudTts.configured !== false &&
    desktopBootstrap?.apiBaseUrl &&
    desktopToken,
  )
  const unavailableMessage = backendManaged
    ? '后台托管 TTS 不可用，请先同步后台配置或切换到本机配置。'
    : '本机配置暂未启用 TTS 朗读。'
  const resultSpeechText =
    completedVoiceText || (pipelineState === 'idle' ? polishedText || finalTranscript : '')
  const voiceFeedbackResourceId = resultSpeechText
    ? `voice:${completedVoiceTextVersion}:${markdownDraftRevision(resultSpeechText)}`
    : ''
  const hasAskAnswer = Boolean(
    askTask.question && (askTask.answer !== null || askTask.error !== null),
  )
  const workspaceFeedbackResourceId = hasAskAnswer
    ? `ask:${askTask.runId ?? 'current'}`
    : ocrTask.result
      ? `ocr:${ocrTask.runId ?? 'current'}`
      : ''
  const visibleVoiceFeedback =
    workbenchFeedback.voice?.resourceId === voiceFeedbackResourceId ? workbenchFeedback.voice : null
  const visibleWorkspaceFeedback =
    workbenchFeedback.workspace?.resourceId === workspaceFeedbackResourceId
      ? workbenchFeedback.workspace
      : null

  useEffect(() => {
    const visibleFeedback = [
      ['voice', visibleVoiceFeedback],
      ['workspace', visibleWorkspaceFeedback],
    ] as const
    const timers = visibleFeedback
      .filter((entry) => entry[1]?.type === 'success')
      .map(([slot, feedback]) =>
        window.setTimeout(() => {
          if (useAppStore.getState().workbenchFeedback[slot] === feedback) {
            setWorkbenchFeedback(slot, null)
          }
        }, 4500),
      )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [setWorkbenchFeedback, visibleVoiceFeedback, visibleWorkspaceFeedback])

  function setFeedbackIfCurrent(
    slot: WorkbenchFeedbackSlot,
    resourceId: string,
    type: 'success' | 'error',
    message: string,
  ) {
    if (!resourceId || currentWorkbenchFeedbackResourceId(slot) !== resourceId) return
    setWorkbenchFeedback(slot, { resourceId, type, message })
  }

  async function fetchTtsAudioUrl(text: string, lease: ProcessLease) {
    if (!desktopBootstrap?.apiBaseUrl || !desktopToken) {
      throw new Error('后台托管 TTS 不可用，请先同步后台配置或切换到本机配置。')
    }

    const result = await proxyTtsOnce(
      desktopBootstrap.apiBaseUrl,
      desktopToken,
      text,
      cloudTts?.defaultVoice ?? undefined,
      lease.leaseId,
    )

    return {
      audioUrl: URL.createObjectURL(
        new Blob([new Uint8Array(result.audioBytes)], { type: result.mimeType || 'audio/mpeg' }),
      ),
      operationId: result.operationId,
    }
  }

  async function speakText(text: string, target: WorkbenchSpeechTarget, resourceId: string) {
    const speechText = text.trim()
    if (!speechText) return
    const slot: WorkbenchFeedbackSlot = target === 'result' ? 'voice' : 'workspace'
    setWorkbenchFeedback(slot, null)

    const publishFailure = (message: string) => {
      setFeedbackIfCurrent(slot, resourceId, 'error', message)
    }

    if (!backendManaged) {
      publishFailure('本机配置暂未启用 TTS 朗读。')
      return
    }
    if (!ttsAvailable || !desktopBootstrap?.apiBaseUrl || !desktopToken) {
      publishFailure('后台托管 TTS 不可用，请先同步后台配置或切换到本机配置。')
      return
    }

    const playbackId = tryStartTtsPlayback(target)
    if (playbackId === null) return

    try {
      const chunks = splitSpeechText(speechText)
      const played = await playTtsChunkQueue(chunks, fetchTtsAudioUrl, () => undefined)
      if (!played) throw new Error('已有朗读任务正在进行，请稍后再试。')
    } catch (error) {
      const message = userFacingErrorMessage(error, '朗读未完成，请稍后重试。', 'tts')
      publishFailure(message)
    } finally {
      finishTtsPlayback(playbackId)
    }
  }

  function speakVoiceResult() {
    setLastReadVoiceResult(resultSpeechText)
    return speakText(resultSpeechText, 'result', voiceFeedbackResourceId)
  }

  return {
    clearFeedback: (slot: WorkbenchFeedbackSlot) => setWorkbenchFeedback(slot, null),
    lastReadVoiceResult,
    resultSpeechText,
    setFeedbackIfCurrent,
    speakText,
    speakVoiceResult,
    speechConfig: {
      available: ttsAvailable,
      apiBaseUrl: desktopBootstrap?.apiBaseUrl,
      token: desktopToken,
      voiceKey: cloudTts?.defaultVoice,
      unavailableMessage,
    },
    ttsAvailable,
    ttsBusy,
    visibleVoiceFeedback,
    visibleWorkspaceFeedback,
    voiceFeedbackResourceId,
    workspaceFeedbackResourceId,
  }
}
