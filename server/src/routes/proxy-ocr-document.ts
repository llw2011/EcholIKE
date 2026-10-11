import { ApiError, json } from '../errors.js'
import type { Handler } from '../http.js'
import { operationFingerprint } from '../services/quota/operation-fingerprint.js'
import {
  acquiredReservation,
  commitQuotaResponse,
  QuotaReplaySignal,
  releaseQuotaReservation,
} from '../services/quota/quota-response.js'
import type { AcquiredQuotaReservation } from '../services/quota/quota-service.js'

const MAX_PDF_BYTES = 25 * 1024 * 1024

export const proxyOcrDocument: Handler = async (ctx) => {
  const user = ctx.user
  if (!user) throw new Error('proxyOcrDocument must be mounted behind requireAuth')

  const form = await ctx.request.formData().catch(() => {
    throw invalidDocument('请上传有效的 PDF 文件。')
  })
  const documentEntries = form.getAll('document')
  if (documentEntries.length !== 1) {
    throw invalidDocument('一次只能上传一份 PDF 文件。')
  }
  for (const key of form.keys()) {
    if (key !== 'document') throw invalidDocument('PDF 识别请求包含不支持的字段。')
  }
  const document = documentEntries[0]
  if (!(document instanceof Blob) || document.size <= 0) {
    throw invalidDocument('请选择有效的 PDF 文件。')
  }
  if (document.type.trim().toLowerCase() !== 'application/pdf') {
    throw invalidDocument('请选择 PDF 格式的文件。')
  }
  if (document.size > MAX_PDF_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'PDF 文件不能超过 25 MB。')
  }
  const documentBytes = new Uint8Array(await document.arrayBuffer())
  const signature = documentBytes.subarray(0, 1024)
  if (!containsPdfSignature(signature)) {
    throw invalidDocument('无法读取这份 PDF，请确认文件未损坏。')
  }
  const operation = {
    idempotencyKey: ctx.idempotencyKey,
    payloadHash: operationFingerprint(
      'proxy-ocr-document-v1',
      [documentBytes],
      ctx.env.betterAuthSecret,
    ),
  }
  const existingOperation = await ctx.services.quota.resolve(
    user,
    'ocr_images',
    'proxy_ocr',
    ctx.requestId,
    operation,
  )
  if (existingOperation) {
    const replay = acquiredReservation(existingOperation)
    if (replay instanceof Response) return replay
    throw new ApiError(500, 'internal_error', 'resolved quota operation was not terminal', false)
  }

  let reservation: AcquiredQuotaReservation | null = null
  let completedReservation: AcquiredQuotaReservation | null = null
  let result: Awaited<ReturnType<typeof ctx.services.documentOcr.process>>
  try {
    result = await ctx.services.documentOcr.process({
      document,
      requestId: ctx.requestId,
      signal: ctx.request.signal,
      assertAvailable: async (pageCount) => {
        await ctx.services.quota.assertAvailable(
          user,
          'ocr_images',
          pageCount,
          ctx.requestId,
          operation,
        )
      },
      reserve: async (pageCount) => {
        if (reservation)
          throw new ApiError(500, 'internal_error', 'OCR quota was reserved twice', false)
        const outcome = await ctx.services.quota.reserve(
          user,
          'ocr_images',
          pageCount,
          'proxy_ocr',
          ctx.requestId,
          operation,
        )
        const acquired = acquiredReservation(outcome)
        if (acquired instanceof Response) throw new QuotaReplaySignal(acquired)
        reservation = acquired
      },
    })
    completedReservation = reservation as AcquiredQuotaReservation | null
    if (!completedReservation || result.pageCount !== completedReservation.reservedAmount) {
      throw new ApiError(502, 'ocr_failed', 'PDF 识别结果页数异常，请稍后重试。')
    }
  } catch (error) {
    if (error instanceof QuotaReplaySignal) return error.response
    if (reservation) await releaseQuotaReservation(ctx.services.quota, reservation)
    throw error
  }

  const response = json({
    text: result.text,
    model: result.model,
    route: 'pipeline',
    processingReason: 'server-pdf-pipeline',
    warnings: result.warnings,
    degraded: result.degraded,
    pageCount: result.pageCount,
    requestId: ctx.requestId,
  })
  await commitQuotaResponse(ctx.services.quota, completedReservation, result.pageCount, response)
  return response
}

function containsPdfSignature(bytes: Uint8Array): boolean {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]
  if (bytes.byteLength < signature.length) return false
  for (let offset = 0; offset <= bytes.byteLength - signature.length; offset += 1) {
    if (signature.every((value, index) => bytes[offset + index] === value)) return true
  }
  return false
}

function invalidDocument(message: string) {
  return new ApiError(422, 'ocr_document_invalid', message)
}
