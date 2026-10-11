import { ApiError } from '../errors.js'
import type { Handler } from '../http.js'
import { operationFingerprint } from '../services/quota/operation-fingerprint.js'
import {
  acquiredReservation,
  commitQuotaResponse,
  releaseQuotaReservation,
} from '../services/quota/quota-response.js'

const MAX_TEXT_CHARS = 8_000
const CLIENT_PROVIDER_FIELDS = ['apiKey', 'providerApiKey', 'baseUrl', 'model', 'provider'] as const
const FORMAT_RE = /^(mp3|opus|aac|flac|wav|pcm)$/

export const proxyTts: Handler = async (ctx) => {
  const user = ctx.user
  if (!user) throw new Error('proxyTts must be mounted behind requireAuth')

  const body = await ctx.request.json().catch(() => {
    throw new ApiError(422, 'validation_failed', 'invalid JSON body')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(422, 'validation_failed', 'request body must be an object')
  }

  for (const field of CLIENT_PROVIDER_FIELDS) {
    if (field in body) {
      throw new ApiError(422, 'validation_failed', `${field} is not accepted by cloud proxy`)
    }
  }

  const record = body as Record<string, unknown>
  const text = stringField(record, 'text', MAX_TEXT_CHARS)
  const voice = optionalStringField(record, 'voice', 64)
  const format = optionalFormatField(record, 'format')
  const speed = optionalSpeedField(record, 'speed')
  const reservationResult = await ctx.services.quota.reserve(
    user,
    'tts_chars',
    text.length,
    'proxy_tts',
    ctx.requestId,
    {
      idempotencyKey: ctx.idempotencyKey,
      payloadHash: operationFingerprint(
        'proxy-tts-v1',
        [text, voice ?? '', format ?? '', speed === null ? '' : String(speed)],
        ctx.env.betterAuthSecret,
      ),
    },
  )
  const reservation = acquiredReservation(reservationResult)
  if (reservation instanceof Response) return reservation

  let result: Awaited<ReturnType<typeof ctx.services.proxy.tts.synthesize>>
  try {
    result = await ctx.services.proxy.tts.synthesize({ text, voice, format, speed })
  } catch (error) {
    await releaseQuotaReservation(ctx.services.quota, reservation)
    throw error
  }

  const response = new Response(result.audio, {
    status: 200,
    headers: {
      'content-type': result.contentType,
      'x-tts-usage-chars': String(result.usageChars),
    },
  })
  await commitQuotaResponse(ctx.services.quota, reservation, result.usageChars, response)
  return response
}

function stringField(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = body[key]
  if (typeof value !== 'string') {
    throw new ApiError(422, 'validation_failed', `${key} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return trimmed
}

function optionalStringField(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const value = body[key]
  if (value === undefined || value === null || value === '') return null
  return stringField(body, key, maxLength)
}

function optionalFormatField(body: Record<string, unknown>, key: string): string | null {
  const value = optionalStringField(body, key, 16)
  if (value === null) return null
  if (!FORMAT_RE.test(value)) {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return value
}

function optionalSpeedField(body: Record<string, unknown>, key: string): number | null {
  const value = body[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || value < 0.25 || value > 4) {
    throw new ApiError(422, 'validation_failed', `${key} must be a number between 0.25 and 4`)
  }
  return value
}
