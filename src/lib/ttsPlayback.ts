export const TTS_CHUNK_MAX_CHARS = 1200

export function splitSpeechText(text: string) {
  const chunks: string[] = []
  let remaining = text.trim()

  while (remaining.length > TTS_CHUNK_MAX_CHARS) {
    const cut = speechChunkEnd(remaining, TTS_CHUNK_MAX_CHARS)
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

import {
  acknowledgeIdempotentOperation,
  acquireTtsPlaybackOwner,
  releaseTtsPlaybackOwner,
  type ProcessLease,
} from './tauri'

export interface FetchedTtsAudio {
  audioUrl: string
  operationId?: string | null
}

export async function playTtsChunkQueue(
  chunks: string[],
  fetchAudioUrl: (text: string, lease: ProcessLease) => Promise<string | FetchedTtsAudio>,
  onStarted: () => void,
): Promise<boolean> {
  const lease = await acquireTtsPlaybackOwner()
  if (!lease) return false
  let started = false
  try {
    for (const chunk of chunks) {
      const fetched = await fetchAudioUrl(chunk, lease)
      const { audioUrl, operationId } =
        typeof fetched === 'string' ? { audioUrl: fetched, operationId: null } : fetched
      try {
        await playAudioUrl(audioUrl, () => {
          if (started) return
          started = true
          onStarted()
        })
        if (operationId) {
          await acknowledgeIdempotentOperation(operationId).catch((error) => {
            console.warn('TTS operation ACK deferred:', error)
          })
        }
      } finally {
        URL.revokeObjectURL(audioUrl)
      }
    }
    return true
  } finally {
    await releaseTtsPlaybackOwner(lease.leaseId)
  }
}

function playAudioUrl(audioUrl: string, onStarted?: () => void) {
  return new Promise<void>((resolve, reject) => {
    const audio = new Audio(audioUrl)
    let settled = false

    function settle(error?: Error) {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    audio.onended = () => settle()
    audio.onerror = () => settle(new Error('朗读播放中断，请重试。'))
    audio
      .play()
      .then(() => onStarted?.())
      .catch(() => settle(new Error('朗读播放被系统拦截，请重试。')))
  })
}

function speechChunkEnd(text: string, maxLength: number) {
  const slice = text.slice(0, maxLength)
  const minUsefulCut = Math.floor(maxLength * 0.45)
  let best = -1

  for (const separator of [
    '\n\n',
    '\n',
    '。',
    '！',
    '？',
    '；',
    '. ',
    '! ',
    '? ',
    '; ',
    '，',
    ', ',
  ]) {
    const index = slice.lastIndexOf(separator)
    const end = index + separator.length
    if (index >= minUsefulCut && end > best) best = end
  }

  return best > 0 ? best : maxLength
}
