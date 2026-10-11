import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acquireTtsPlaybackOwner,
  getMarkdownSpeechState,
  openMarkdownSpeechDirectory,
  readMarkdownSpeechAudio,
  releaseTtsPlaybackOwner,
  revealMarkdownSpeechAsset,
  startMarkdownSpeechGeneration,
  type MarkdownSpeechAsset,
  type MarkdownSpeechKey,
  type MarkdownSpeechStateSnapshot,
  type MarkdownSpeechTaskSnapshot,
} from '../../lib/tauri'
import { splitSpeechText } from '../../lib/ttsPlayback'
import { userFacingErrorMessage } from '../../lib/userErrors'
import type { MarkdownDraft } from './markdownDraft'
import { markdownDraftRevision } from './markdownAiTask'

export interface MarkdownSpeechConfig {
  available: boolean
  apiBaseUrl?: string | null
  token?: string | null
  voiceKey?: string | null
  speedMilli?: number
  unavailableMessage?: string
}

interface PlaybackSession {
  assetId: number
  audio: HTMLAudioElement
  audioUrl: string
  leaseId: number
}

const DEFAULT_SPEED_MILLI = 1_000

export function markdownSpeechKey(
  draft: Pick<MarkdownDraft, 'id' | 'text'>,
  config: MarkdownSpeechConfig,
): MarkdownSpeechKey {
  return {
    draftId: draft.id,
    contentRevision: markdownDraftRevision(draft.text),
    voiceKey: config.voiceKey?.trim() || '',
    speedMilli: config.speedMilli ?? DEFAULT_SPEED_MILLI,
  }
}

export function markdownSpeechButtonLabel(
  state: MarkdownSpeechStateSnapshot | null,
  starting: boolean,
  playing: boolean,
) {
  if (playing) return '朗读中…'
  if (starting) return '生成中…'
  if (state?.task?.outcome.status === 'running') {
    const { completedChunks, totalChunks } = state.task.outcome
    return `生成中 ${completedChunks}/${totalChunks}…`
  }
  if (state?.currentAsset) return '生成完毕'
  if (state?.latestAsset) return '重新生成'
  return '生成朗读'
}

export function useMarkdownSpeech(draft: MarkdownDraft, config?: MarkdownSpeechConfig) {
  const enabled = Boolean(config)
  const voiceKey = config?.voiceKey?.trim() || ''
  const speedMilli = config?.speedMilli ?? DEFAULT_SPEED_MILLI
  const key = useMemo(
    () =>
      enabled
        ? {
            draftId: draft.id,
            contentRevision: markdownDraftRevision(draft.text),
            voiceKey,
            speedMilli,
          }
        : null,
    [draft.id, draft.text, enabled, speedMilli, voiceKey],
  )
  const keyRef = useRef(key)
  const [state, setState] = useState<MarkdownSpeechStateSnapshot | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [dialogAsset, setDialogAsset] = useState<MarkdownSpeechAsset | null>(null)
  const [playingAssetId, setPlayingAssetId] = useState<number | null>(null)
  const playbackRef = useRef<PlaybackSession | null>(null)
  const playbackStartingRef = useRef(false)
  const mountedRef = useRef(true)
  const eventVersionRef = useRef(0)
  const ownerWindowLabel = enabled ? getCurrentWindow().label : ''
  keyRef.current = key

  const refresh = useCallback(async () => {
    const requestedKey = keyRef.current
    if (!requestedKey) return null
    const eventVersion = eventVersionRef.current
    const snapshot = await getMarkdownSpeechState(requestedKey)
    if (sameSpeechKey(keyRef.current, requestedKey)) {
      const racedWithEvent = eventVersionRef.current !== eventVersion
      setState((current) => mergeSpeechState(current, snapshot, racedWithEvent))
    }
    return snapshot
  }, [])

  useEffect(() => {
    if (!enabled) return

    let active = true
    let unlisten: (() => void) | undefined
    setError('')

    void listen<MarkdownSpeechTaskSnapshot>('markdown-speech:updated', (event) => {
      if (!active || event.payload.key.draftId !== keyRef.current?.draftId) return
      eventVersionRef.current += 1
      setState((current) => mergeSpeechTask(current, keyRef.current!, event.payload))
      if (event.payload.outcome.status === 'success') {
        if (
          event.payload.ownerWindow === ownerWindowLabel &&
          sameSpeechKey(event.payload.key, keyRef.current)
        ) {
          setDialogAsset(event.payload.outcome.asset)
        }
        void refresh().catch(() => undefined)
      } else if (event.payload.outcome.status === 'error') {
        if (event.payload.ownerWindow === ownerWindowLabel) {
          setError(
            userFacingErrorMessage(
              event.payload.outcome.error,
              '生成朗读未完成，请稍后重试。',
              'tts',
            ),
          )
        }
        void refresh().catch(() => undefined)
      }
    })
      .then((stopListening) => {
        if (!active) {
          stopListening()
          return
        }
        unlisten = stopListening
      })
      .catch((cause) => {
        if (!active) return
        setError(userFacingErrorMessage(cause, '无法监听朗读任务状态，请稍后重试。', 'tts'))
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [draft.id, enabled, ownerWindowLabel, refresh])

  useEffect(() => {
    if (!enabled || !key) {
      setLoading(false)
      setState(null)
      return
    }

    let active = true
    setState((current) => {
      if (!current || sameSpeechKey(current.key, key)) return current
      if (current.key.draftId !== key.draftId) {
        return {
          key,
          task: null,
          currentAsset: null,
          latestAsset: null,
          directoryPath: '',
        }
      }
      return { ...current, key, currentAsset: null }
    })
    setLoading(true)
    const timer = window.setTimeout(() => {
      void refresh()
        .catch((cause) => {
          if (!active) return
          setError(userFacingErrorMessage(cause, '无法读取朗读成品，请稍后重试。', 'tts'))
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 180)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [enabled, key, refresh])

  const generate = useCallback(async () => {
    if (!config || !key || starting || state?.task?.outcome.status === 'running') return
    if (!config.available || !config.apiBaseUrl?.trim() || !config.token?.trim()) {
      setError(config.unavailableMessage || '后台托管 TTS 暂不可用，请先同步后台配置。')
      return
    }
    const chunks = splitSpeechText(draft.text)
    if (chunks.length === 0) {
      setError('没有可生成朗读的 Markdown 内容。')
      return
    }

    setStarting(true)
    setError('')
    try {
      await flushPendingPlaybackReleases()
      const task = await startMarkdownSpeechGeneration({
        key,
        title: draft.title,
        chunks,
        apiBaseUrl: config.apiBaseUrl,
        token: config.token,
      })
      if (sameSpeechKey(keyRef.current, key)) {
        setState((current) => mergeSpeechTask(current, key, task))
      }
      if (task.outcome.status === 'success') {
        if (task.ownerWindow === ownerWindowLabel && sameSpeechKey(keyRef.current, task.key)) {
          setDialogAsset(task.outcome.asset)
        }
        await refresh()
      } else if (task.outcome.status === 'error') {
        setError(userFacingErrorMessage(task.outcome.error, '生成朗读未完成，请稍后重试。', 'tts'))
      }
    } catch (cause) {
      setError(userFacingErrorMessage(cause, '生成朗读未完成，请稍后重试。', 'tts'))
    } finally {
      setStarting(false)
    }
  }, [
    config,
    draft.text,
    draft.title,
    key,
    ownerWindowLabel,
    refresh,
    starting,
    state?.task?.outcome.status,
  ])

  const finishPlayback = useCallback(async (session: PlaybackSession, message?: string) => {
    if (playbackRef.current !== session) return
    playbackRef.current = null
    session.audio.onended = null
    session.audio.onerror = null
    session.audio.pause()
    URL.revokeObjectURL(session.audioUrl)
    setPlayingAssetId(null)
    await releasePlaybackLease(session.leaseId)
    if (message && mountedRef.current) setError(message)
  }, [])

  const stopPlayback = useCallback(async () => {
    const session = playbackRef.current
    if (!session) return
    await finishPlayback(session)
  }, [finishPlayback])

  const play = useCallback(
    async (asset: MarkdownSpeechAsset) => {
      if (playbackRef.current?.assetId === asset.id) {
        await stopPlayback()
        return
      }
      if (playbackStartingRef.current) return
      if (playbackRef.current) await stopPlayback()

      playbackStartingRef.current = true
      setError('')
      await flushPendingPlaybackReleases()
      const lease = await acquireTtsPlaybackOwner().catch(() => null)
      if (!lease) {
        playbackStartingRef.current = false
        setError('已有朗读或音频生成任务正在进行，请稍后再试。')
        return
      }

      let audioUrl = ''
      try {
        const raw = await readMarkdownSpeechAudio(asset.id)
        if (!mountedRef.current) {
          await releasePlaybackLease(lease.leaseId)
          return
        }
        const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw)
        audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
        const audio = new Audio(audioUrl)
        const session: PlaybackSession = {
          assetId: asset.id,
          audio,
          audioUrl,
          leaseId: lease.leaseId,
        }
        playbackRef.current = session
        audio.onended = () => void finishPlayback(session)
        audio.onerror = () =>
          void finishPlayback(
            session,
            '音频已经生成，但系统播放器未能朗读。你仍可打开所在文件夹播放。',
          )
        await audio.play()
        if (playbackRef.current === session) setPlayingAssetId(asset.id)
      } catch (cause) {
        if (audioUrl) URL.revokeObjectURL(audioUrl)
        if (playbackRef.current?.assetId === asset.id) playbackRef.current = null
        await releasePlaybackLease(lease.leaseId)
        setPlayingAssetId(null)
        setError(
          userFacingErrorMessage(
            cause,
            '音频已经生成，但暂时无法朗读。你仍可打开所在文件夹播放。',
            'tts',
          ),
        )
      } finally {
        playbackStartingRef.current = false
      }
    },
    [finishPlayback, stopPlayback],
  )

  const previousDraftIdRef = useRef(draft.id)
  useEffect(() => {
    if (previousDraftIdRef.current === draft.id) return
    previousDraftIdRef.current = draft.id
    setDialogAsset(null)
    void stopPlayback()
  }, [draft.id, stopPlayback])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const session = playbackRef.current
      if (!session) return
      playbackRef.current = null
      session.audio.onended = null
      session.audio.onerror = null
      session.audio.pause()
      URL.revokeObjectURL(session.audioUrl)
      void releasePlaybackLease(session.leaseId)
    }
  }, [])

  const reveal = useCallback(
    async (asset: MarkdownSpeechAsset) => {
      try {
        await revealMarkdownSpeechAsset(asset.id)
      } catch (cause) {
        setError(userFacingErrorMessage(cause, '无法打开朗读音频所在位置。'))
        await refresh().catch(() => null)
      }
    },
    [refresh],
  )

  const openDirectory = useCallback(async () => {
    try {
      await openMarkdownSpeechDirectory()
    } catch (cause) {
      setError(userFacingErrorMessage(cause, '无法打开朗读音频文件夹。'))
    }
  }, [])

  return {
    state,
    loading,
    starting,
    error,
    clearError: () => setError(''),
    dialogAsset,
    setDialogAsset,
    playingAssetId,
    generate,
    play,
    stopPlayback,
    reveal,
    openDirectory,
  }
}

function mergeSpeechTask(
  current: MarkdownSpeechStateSnapshot | null,
  key: MarkdownSpeechKey,
  task: MarkdownSpeechTaskSnapshot,
): MarkdownSpeechStateSnapshot {
  const nextTask = newerSpeechTask(current?.task ?? null, task) ?? task
  const successAsset = nextTask.outcome.status === 'success' ? nextTask.outcome.asset : null
  return {
    key,
    task: nextTask,
    currentAsset:
      successAsset && sameSpeechKey(successAsset.key, key)
        ? successAsset
        : sameSpeechKey(current?.key, key)
          ? (current?.currentAsset ?? null)
          : null,
    latestAsset: successAsset ?? current?.latestAsset ?? null,
    directoryPath: successAsset?.directoryPath ?? current?.directoryPath ?? '',
  }
}

function mergeSpeechState(
  current: MarkdownSpeechStateSnapshot | null,
  incoming: MarkdownSpeechStateSnapshot,
  racedWithEvent: boolean,
): MarkdownSpeechStateSnapshot {
  if (!current || current.key.draftId !== incoming.key.draftId) return incoming
  const task = newerSpeechTask(current.task ?? null, incoming.task ?? null)
  if (!racedWithEvent) return { ...incoming, task }
  let currentAsset = newerSpeechAsset(current.currentAsset ?? null, incoming.currentAsset ?? null)
  let latestAsset = newerSpeechAsset(current.latestAsset ?? null, incoming.latestAsset ?? null)
  if (task?.outcome.status === 'success') {
    latestAsset = newerSpeechAsset(latestAsset, task.outcome.asset)
    if (sameSpeechKey(task.outcome.asset.key, incoming.key)) {
      currentAsset = newerSpeechAsset(currentAsset, task.outcome.asset)
    }
  }
  return {
    ...incoming,
    task,
    currentAsset,
    latestAsset,
  }
}

function newerSpeechAsset(
  current: MarkdownSpeechAsset | null,
  incoming: MarkdownSpeechAsset | null,
) {
  if (!current) return incoming
  if (!incoming) return current
  return incoming.id > current.id ? incoming : current
}

function newerSpeechTask(
  current: MarkdownSpeechTaskSnapshot | null,
  incoming: MarkdownSpeechTaskSnapshot | null,
) {
  if (!current) return incoming
  if (!incoming) return current
  if (incoming.outcome.leaseId !== current.outcome.leaseId) {
    return incoming.outcome.leaseId > current.outcome.leaseId ? incoming : current
  }
  if (current.outcome.status !== 'running') return current
  if (incoming.outcome.status !== 'running') return incoming
  return incoming.outcome.completedChunks > current.outcome.completedChunks ? incoming : current
}

function sameSpeechKey(
  left: MarkdownSpeechKey | null | undefined,
  right: MarkdownSpeechKey | null,
) {
  return Boolean(
    left &&
    right &&
    left.draftId === right.draftId &&
    left.contentRevision === right.contentRevision &&
    left.voiceKey === right.voiceKey &&
    left.speedMilli === right.speedMilli,
  )
}

const pendingPlaybackReleases = new Set<number>()

async function releasePlaybackLease(leaseId: number) {
  pendingPlaybackReleases.add(leaseId)
  for (const delayMs of [0, 80, 240]) {
    if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs))
    try {
      await releaseTtsPlaybackOwner(leaseId)
      pendingPlaybackReleases.delete(leaseId)
      return
    } catch {
      // A transient IPC teardown race gets two bounded retries. The lease stays
      // queued so the next playback attempt can make one more cleanup pass.
    }
  }
}

async function flushPendingPlaybackReleases() {
  await Promise.all([...pendingPlaybackReleases].map((leaseId) => releasePlaybackLease(leaseId)))
}
