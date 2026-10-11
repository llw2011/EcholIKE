import { ApiError } from '../../errors.js'
import type { ServerEnv } from '../../env.js'
import type { DesktopConfigService } from '../desktop/desktop-config-service.js'
import { resolveTtsProviderConfig } from './provider-config.js'

export interface TtsSynthesizeInput {
  text: string
  voice: string | null
  format: string | null
  speed: number | null
}

export interface TtsSynthesizeResult {
  audio: ArrayBuffer
  contentType: string
  usageChars: number
}

export interface TtsProxyService {
  synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult>
}

type FetchLike = typeof fetch

export const TTS_TIMEOUT_MS = 120_000
export const TTS_MAX_PROVIDER_AUDIO_BYTES = 64 * 1024 * 1024
export const COSYVOICE2_VOICES_TIMEOUT_MS = 4_000
const COSYVOICE2_VOICES_MAX_BYTES = 64 * 1024
const COSYVOICE2_VOICES_CACHE_TTL_MS = 30_000

interface CosyVoice2VoiceCacheEntry {
  expiresAt: number
  voices: Promise<Set<string> | null>
}

export function createTtsProxyService(
  env: ServerEnv,
  fetchImpl: FetchLike = fetch,
  desktopConfig?: DesktopConfigService,
): TtsProxyService {
  const cosyVoice2VoiceCache = new Map<string, CosyVoice2VoiceCacheEntry>()

  return {
    async synthesize(input) {
      const config = await resolveTtsProviderConfig(env, desktopConfig)
      const voice =
        config.protocol === 'cosyvoice2'
          ? await resolveCosyVoice2Voice(
              fetchImpl,
              config.endpoint,
              config.apiKey,
              input.voice ?? config.voice,
              cosyVoice2VoiceCache,
            )
          : (input.voice ?? config.voice)
      const body =
        config.protocol === 'cosyvoice2'
          ? {
              text: input.text,
              voice,
              format: input.format ?? 'wav',
              ...(input.speed ? { speed: input.speed } : {}),
            }
          : {
              model: config.model,
              input: input.text,
              voice,
              response_format: input.format ?? 'mp3',
              ...(input.speed ? { speed: input.speed } : {}),
            }
      const { response, audio } = await fetchTts(fetchImpl, config.endpoint, config.apiKey, body)
      if (audio.byteLength === 0) {
        throw new ApiError(502, 'tts_failed', 'Cloud TTS returned empty audio')
      }

      return {
        audio,
        contentType:
          response.headers.get('content-type') ??
          (config.protocol === 'cosyvoice2' ? 'audio/wav' : 'audio/mpeg'),
        usageChars: input.text.length,
      }
    },
  }
}

export const disabledTtsProxyService: TtsProxyService = {
  async synthesize() {
    throw new ApiError(501, 'not_implemented', 'Cloud TTS proxy is not configured')
  },
}

async function fetchTts(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string | null,
  body: unknown,
): Promise<{ response: Response; audio: ArrayBuffer }> {
  const controller = new AbortController()
  let timeoutFailure: ApiError | null = null
  let rejectDeadline: (error: ApiError) => void = () => undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const waitForDeadline = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, deadline])
  const timer = setTimeout(() => {
    timeoutFailure = new ApiError(504, 'tts_timeout', 'Cloud TTS timed out')
    controller.abort(timeoutFailure)
    rejectDeadline(timeoutFailure)
  }, TTS_TIMEOUT_MS)

  try {
    const response = await waitForDeadline(
      fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          ...authHeaders(apiKey),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    )

    if (!response.ok) {
      throw await upstreamTtsError(response)
    }

    const audio = await readTtsAudio(response, waitForDeadline)
    return { response, audio }
  } catch (error) {
    if (timeoutFailure) throw timeoutFailure
    if (error instanceof ApiError) throw error
    if (isAbortError(error)) {
      throw new ApiError(504, 'tts_timeout', 'Cloud TTS timed out')
    }
    throw new ApiError(502, 'tts_failed', 'Cloud TTS provider request failed')
  } finally {
    clearTimeout(timer)
  }
}

async function readTtsAudio(
  response: Response,
  waitForDeadline: <T>(operation: Promise<T>) => Promise<T>,
): Promise<ArrayBuffer> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && contentLengthExceeds(declaredLength, TTS_MAX_PROVIDER_AUDIO_BYTES)) {
    void response.body?.cancel().catch(() => undefined)
    throw providerAudioTooLargeError()
  }
  if (!response.body) return new ArrayBuffer(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await waitForDeadline(reader.read())
      if (done) break
      if (!value?.byteLength) continue
      if (total + value.byteLength > TTS_MAX_PROVIDER_AUDIO_BYTES) {
        throw providerAudioTooLargeError()
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Cancellation owns the pending provider read after a deadline or size failure.
    }
  }

  const audio = new ArrayBuffer(total)
  const bytes = new Uint8Array(audio)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return audio
}

function contentLengthExceeds(value: string, maxBytes: number): boolean {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return false
  const length = Number(trimmed)
  return Number.isSafeInteger(length) && length > maxBytes
}

function providerAudioTooLargeError(): ApiError {
  return new ApiError(502, 'tts_failed', 'Cloud TTS provider response is too large')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function authHeaders(apiKey: string | null): HeadersInit {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

async function resolveCosyVoice2Voice(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string | null,
  requestedVoice: string | null,
  cache: Map<string, CosyVoice2VoiceCacheEntry>,
): Promise<string> {
  const candidate = requestedVoice?.trim() || 'default'
  if (candidate === 'default') return candidate

  const voices = await cachedCosyVoice2Voices(fetchImpl, endpoint, apiKey, cache)
  if (!voices?.size) return candidate
  if (voices.has(candidate)) return candidate
  if (voices.has('default')) return 'default'
  return voices.values().next().value ?? candidate
}

function cachedCosyVoice2Voices(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string | null,
  cache: Map<string, CosyVoice2VoiceCacheEntry>,
): Promise<Set<string> | null> {
  const key = cosyVoice2VoicesEndpoint(endpoint)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.voices

  const voices = fetchCosyVoice2Voices(fetchImpl, key, apiKey).catch(() => null)
  cache.set(key, {
    expiresAt: Date.now() + COSYVOICE2_VOICES_CACHE_TTL_MS,
    voices,
  })
  return voices
}

async function fetchCosyVoice2Voices(
  fetchImpl: FetchLike,
  voicesEndpoint: string,
  apiKey: string | null,
): Promise<Set<string>> {
  const controller = new AbortController()
  let rejectDeadline: (error: Error) => void = () => undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const waitForDeadline = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, deadline])
  const timer = setTimeout(() => {
    const error = new Error('CosyVoice2 voices probe timed out')
    controller.abort(error)
    rejectDeadline(error)
  }, COSYVOICE2_VOICES_TIMEOUT_MS)

  try {
    const response = await waitForDeadline(
      fetchImpl(voicesEndpoint, {
        method: 'GET',
        headers: authHeaders(apiKey),
        signal: controller.signal,
      }),
    )
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      return new Set()
    }

    const text = await readBoundedText(response, COSYVOICE2_VOICES_MAX_BYTES, waitForDeadline)
    const body = parseJson(text)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return new Set()
    const voices = (body as { voices?: unknown }).voices
    if (Array.isArray(voices)) {
      return new Set(
        voices.map((voice) => (typeof voice === 'string' ? voice.trim() : '')).filter(Boolean),
      )
    }
    if (voices && typeof voices === 'object' && !Array.isArray(voices)) {
      return new Set(
        Object.keys(voices)
          .map((voice) => voice.trim())
          .filter(Boolean),
      )
    }
    return new Set()
  } finally {
    clearTimeout(timer)
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  waitForDeadline: <T>(operation: Promise<T>) => Promise<T>,
): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && contentLengthExceeds(declaredLength, maxBytes)) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('Provider response is too large')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await waitForDeadline(reader.read())
      if (done) break
      if (!value?.byteLength) continue
      if (total + value.byteLength > maxBytes) throw new Error('Provider response is too large')
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Cancellation owns the pending probe read after a deadline or size failure.
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function cosyVoice2VoicesEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  url.search = ''
  url.hash = ''
  url.pathname = /\/tts\/?$/.test(url.pathname)
    ? url.pathname.replace(/\/tts\/?$/, '/voices')
    : `${url.pathname.replace(/\/$/, '')}/voices`
  return url.toString()
}

async function upstreamTtsError(response: Response): Promise<ApiError> {
  void response.body?.cancel().catch(() => undefined)
  if (response.status === 401 || response.status === 403) {
    return new ApiError(502, 'tts_invalid_key', 'Cloud TTS provider credentials are invalid')
  }
  return new ApiError(502, 'tts_failed', 'Cloud TTS provider request failed')
}
