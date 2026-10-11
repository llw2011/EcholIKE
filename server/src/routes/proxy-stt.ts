import { ApiError, json } from '../errors.js'
import type { Handler } from '../http.js'
import { operationFingerprint } from '../services/quota/operation-fingerprint.js'
import {
  acquiredReservation,
  commitQuotaResponse,
  releaseQuotaReservation,
} from '../services/quota/quota-response.js'

const APPROX_PCM_BYTES_PER_SECOND = 16_000 * 2
const LANGUAGE_RE = /^(multi|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/

export const proxyStt: Handler = async (ctx) => {
  const user = ctx.user
  if (!user) throw new Error('proxyStt must be mounted behind requireAuth')

  const formData = await ctx.request.formData().catch(() => {
    throw new ApiError(422, 'validation_failed', 'multipart form data is required')
  })
  const audio = formData.get('audio')
  if (!(audio instanceof Blob) || audio.size <= 0) {
    throw new ApiError(422, 'validation_failed', 'audio file is required')
  }

  const language = parseLanguage(formData.get('language'))
  const estimatedSeconds = estimateAudioSeconds(audio.size)
  const audioBytes = new Uint8Array(await audio.arrayBuffer())
  const reservationResult = await ctx.services.quota.reserve(
    user,
    'stt_seconds',
    estimatedSeconds,
    'proxy_stt',
    ctx.requestId,
    {
      idempotencyKey: ctx.idempotencyKey,
      payloadHash: operationFingerprint(
        'proxy-stt-v1',
        [language ?? '', audioBytes],
        ctx.env.betterAuthSecret,
      ),
    },
  )
  const reservation = acquiredReservation(reservationResult)
  if (reservation instanceof Response) return reservation

  let result: Awaited<ReturnType<typeof ctx.services.proxy.stt.transcribe>>
  try {
    result = await ctx.services.proxy.stt.transcribe({
      audio,
      language,
      estimatedSeconds,
    })
  } catch (error) {
    await releaseQuotaReservation(ctx.services.quota, reservation)
    throw error
  }

  const response = json({ text: result.text })
  await commitQuotaResponse(ctx.services.quota, reservation, result.durationSeconds, response)
  return response
}

function parseLanguage(input: FormDataEntryValue | null): string | null {
  if (input === null) return null
  if (typeof input !== 'string') {
    throw new ApiError(422, 'validation_failed', 'language must be a string')
  }
  const language = input.trim()
  if (!language) return null
  if (!LANGUAGE_RE.test(language)) {
    throw new ApiError(422, 'validation_failed', 'language is invalid')
  }
  return language
}

function estimateAudioSeconds(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / APPROX_PCM_BYTES_PER_SECOND))
}
