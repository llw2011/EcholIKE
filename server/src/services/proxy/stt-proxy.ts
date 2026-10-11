import { ApiError } from '../../errors.js'
import type { ServerEnv } from '../../env.js'
import type { DesktopConfigService } from '../desktop/desktop-config-service.js'
import { resolveSttProviderConfig } from './provider-config.js'

export interface SttTranscribeInput {
  audio: Blob
  language: string | null
  estimatedSeconds: number
}

export interface SttTranscribeResult {
  text: string
  durationSeconds: number
}

export interface SttProxyService {
  transcribe(input: SttTranscribeInput): Promise<SttTranscribeResult>
}

type FetchLike = typeof fetch

const STT_TIMEOUT_MS = 60_000
export const STT_MAX_PROVIDER_RESPONSE_BYTES = 1 * 1024 * 1024

export function createSttProxyService(
  env: ServerEnv,
  fetchImpl: FetchLike = fetch,
  desktopConfig?: DesktopConfigService,
): SttProxyService {
  return {
    async transcribe(input) {
      const config = await resolveSttProviderConfig(env, desktopConfig)
      const formData = new FormData()
      if (config.protocol === 'sensevoice') {
        formData.append('file', input.audio, 'audio.wav')
        formData.append(
          'language',
          input.language && input.language !== 'multi' ? input.language : 'auto',
        )
      } else {
        formData.append('model', config.model)
        formData.append('file', input.audio, 'audio.wav')
        if (input.language && input.language !== 'multi') {
          formData.append('language', input.language)
        }
        for (const [key, value] of Object.entries(config.extraFields)) {
          formData.append(key, value)
        }
      }

      const response = await fetchMultipart(fetchImpl, config.endpoint, config.apiKey, formData)
      const body = await response.json().catch(() => {
        throw new ApiError(502, 'stt_failed', 'Cloud STT returned invalid JSON')
      })
      const text = extractTranscript(body)
      if (!text.trim()) {
        throw new ApiError(422, 'stt_no_speech_detected', 'No speech detected')
      }

      return {
        text,
        durationSeconds: input.estimatedSeconds,
      }
    },
  }
}

export const disabledSttProxyService: SttProxyService = {
  async transcribe() {
    throw new ApiError(501, 'not_implemented', 'Cloud STT proxy is not configured')
  },
}

async function fetchMultipart(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string | null,
  formData: FormData,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS)

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: formData,
      signal: controller.signal,
    })

    if (!response.ok) {
      throw await upstreamSttError(response)
    }

    return response
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(504, 'stt_timeout', 'Cloud STT timed out')
    }
    throw new ApiError(502, 'stt_failed', 'Cloud STT provider request failed')
  } finally {
    clearTimeout(timer)
  }
}

function authHeaders(apiKey: string | null): HeadersInit {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

async function upstreamSttError(response: Response): Promise<ApiError> {
  void response.body?.cancel().catch(() => undefined)
  if (response.status === 401 || response.status === 403) {
    return new ApiError(502, 'stt_invalid_key', 'Cloud STT provider credentials are invalid')
  }
  return new ApiError(502, 'stt_failed', 'Cloud STT provider request failed')
}

function extractTranscript(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const record = body as Record<string, unknown>
  const text = record.text ?? record.result
  if (typeof text === 'string') return text
  const data = record.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const dataText = (data as Record<string, unknown>).text
  return typeof dataText === 'string' ? dataText : ''
}
