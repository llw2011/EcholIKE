import { ApiError, json } from '../errors.js'
import type { Handler } from '../http.js'
import { operationFingerprint } from '../services/quota/operation-fingerprint.js'
import {
  acquiredReservation,
  commitQuotaResponse,
  releaseQuotaReservation,
} from '../services/quota/quota-response.js'

const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const CLIENT_PROVIDER_FIELDS = [
  'apiKey',
  'providerApiKey',
  'baseUrl',
  'model',
  'provider',
  'prompt',
] as const

type CanonicalImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp'

const IMAGE_MIME_ALIASES: Readonly<Record<string, CanonicalImageMime>> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/bmp': 'image/bmp',
  'image/x-bmp': 'image/bmp',
  'image/x-ms-bmp': 'image/bmp',
}

export const proxyOcr: Handler = async (ctx) => {
  const user = ctx.user
  if (!user) throw new Error('proxyOcr must be mounted behind requireAuth')

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
  const contractVersion = contractVersionField(record)
  const image = validatedImageField(record, contractVersion)
  const documentPage = optionalBooleanField(record, 'documentPage')
  const reservationResult = await ctx.services.quota.reserve(
    user,
    'ocr_images',
    1,
    'proxy_ocr',
    ctx.requestId,
    {
      idempotencyKey: ctx.idempotencyKey,
      payloadHash: operationFingerprint(
        'proxy-ocr-v2',
        [String(contractVersion), image.mimeType, documentPage ? 'document' : 'image', image.bytes],
        ctx.env.betterAuthSecret,
      ),
    },
  )
  const reservation = acquiredReservation(reservationResult)
  if (reservation instanceof Response) return reservation

  let result: Awaited<ReturnType<typeof ctx.services.proxy.ocr.read>>
  try {
    result = await ctx.services.proxy.ocr.read({
      imageBase64: image.base64,
      imageMimeType: image.mimeType,
      documentPage,
      requestId: ctx.requestId,
      signal: ctx.request.signal,
    })
  } catch (error) {
    await releaseQuotaReservation(ctx.services.quota, reservation)
    throw error
  }

  const response = json({
    text: result.text,
    model: result.model,
    route: result.route ?? 'direct',
    processingReason: result.processingReason ?? 'cloud-provider-direct',
    warnings: result.warnings ?? [],
    degraded: result.degraded ?? false,
    pageCount: result.pageCount ?? 1,
  })
  await commitQuotaResponse(ctx.services.quota, reservation, 1, response)
  return response
}

function contractVersionField(body: Record<string, unknown>): 1 | 2 {
  const value = body.contractVersion
  if (value === undefined) return 1
  if (value !== 2) {
    throw new ApiError(422, 'validation_failed', 'contractVersion is unsupported')
  }
  return 2
}

function validatedImageField(
  body: Record<string, unknown>,
  contractVersion: 1 | 2,
): { base64: string; mimeType: CanonicalImageMime; bytes: Uint8Array } {
  const value = body.imageBase64
  if (typeof value !== 'string') {
    throw new ApiError(422, 'validation_failed', 'imageBase64 must be a string')
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new ApiError(422, 'validation_failed', 'imageBase64 is invalid')
  }
  if (trimmed.length > MAX_IMAGE_BASE64_CHARS) {
    throw new ApiError(413, 'payload_too_large', 'OCR image exceeds the 25 MiB limit')
  }
  if (!isStandardBase64(trimmed)) {
    throw new ApiError(422, 'validation_failed', 'imageBase64 is invalid')
  }

  const bytes = Buffer.from(trimmed, 'base64')
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'OCR image exceeds the 25 MiB limit')
  }

  const mimeType = imageMimeFromMagic(bytes)
  const declaredMime = optionalMimeField(body, 'imageMimeType')
  if (contractVersion === 2) {
    if (!declaredMime) {
      throw new ApiError(
        422,
        'validation_failed',
        'imageMimeType is required for contractVersion 2',
      )
    }
    if (declaredMime !== mimeType) {
      throw new ApiError(
        422,
        'validation_failed',
        `imageMimeType does not match image content (${mimeType})`,
      )
    }
  }
  return { base64: trimmed, mimeType, bytes }
}

function optionalMimeField(body: Record<string, unknown>, key: string): CanonicalImageMime | null {
  const value = body[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  const normalized = IMAGE_MIME_ALIASES[value.trim().toLowerCase()]
  if (!normalized) {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return normalized
}

function optionalBooleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') {
    throw new ApiError(422, 'validation_failed', `${key} must be a boolean`)
  }
  return value
}

function imageMimeFromMagic(bytes: Uint8Array): CanonicalImageMime {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }
  if (
    bytes.byteLength >= 12 &&
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp'
  }
  if (startsWithBytes(bytes, [0x42, 0x4d])) {
    return 'image/bmp'
  }
  throw new ApiError(
    422,
    'validation_failed',
    'imageBase64 is not a supported PNG, JPEG, WebP, or BMP image',
  )
}

function startsWithBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  if (bytes.byteLength < expected.length) return false
  return expected.every((value, index) => bytes[index] === value)
}

function isStandardBase64(value: string): boolean {
  if (!value.length || value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const payloadEnd = value.length - padding
  for (let index = 0; index < payloadEnd; index += 1) {
    if (base64Value(value.charCodeAt(index)) < 0) return false
  }
  for (let index = payloadEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false
  }
  const lastValue = base64Value(value.charCodeAt(payloadEnd - 1))
  if (padding === 2 && (lastValue & 0x0f) !== 0) return false
  if (padding === 1 && (lastValue & 0x03) !== 0) return false
  return true
}

function base64Value(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52
  if (code === 0x2b) return 62
  if (code === 0x2f) return 63
  return -1
}
