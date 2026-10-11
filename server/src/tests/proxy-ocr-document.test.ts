import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { ApiError } from '../errors.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import type { DocumentOcrService } from '../services/ocr/document-ocr-service.js'
import type { QuotaService } from '../services/quota/quota-service.js'
import { proUser, request, testEnv, testServices } from './helpers.js'

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% test document\n')

describe('PDF document OCR route', () => {
  it('accepts one raw PDF, reserves the exact inspected page count, and returns Pipeline metadata', async () => {
    const authorize = vi.fn(async () => undefined)
    const documentOcr = documentService({
      pageCount: 3,
      text: '## 第 1 页\n\n正文',
      warnings: ['第 2 页未提取到文字，可能是空白页或该页识别不完整。'],
      degraded: true,
      authorize,
    })
    const quota = quotaService()
    const app = documentApp(documentOcr, quota)

    const response = await app.fetch(documentRequest('req-pdf-success'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(quota.assertAvailable).toHaveBeenCalledWith(
      proUser,
      'ocr_images',
      3,
      'req-pdf-success',
      expect.objectContaining({
        idempotencyKey: 'op-req-pdf-success',
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
    expect(quota.reserve).toHaveBeenCalledWith(
      proUser,
      'ocr_images',
      3,
      'proxy_ocr',
      'req-pdf-success',
      expect.objectContaining({ idempotencyKey: 'op-req-pdf-success' }),
    )
    expect(quota.commit).toHaveBeenCalledWith(
      expect.objectContaining({ reservedAmount: 3 }),
      3,
      expect.objectContaining({ status: 200, body: expect.any(Uint8Array) }),
    )
    expect(quota.release).not.toHaveBeenCalled()
    expect(body).toEqual({
      text: '## 第 1 页\n\n正文',
      model: 'glm-ocr:latest',
      route: 'pipeline',
      processingReason: 'server-pdf-pipeline',
      warnings: ['第 2 页未提取到文字，可能是空白页或该页识别不完整。'],
      degraded: true,
      pageCount: 3,
      requestId: 'req-pdf-success',
    })
  })

  it('rejects non-multipart requests before invoking the document service', async () => {
    const documentOcr = documentService()
    const app = documentApp(documentOcr, quotaService())

    const response = await app.fetch(
      request('/echo-api/proxy/ocr/document', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/pdf',
        },
        body: PDF_BYTES,
      }),
    )

    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ code: 'ocr_document_invalid' })
    expect(documentOcr.process).not.toHaveBeenCalled()
  })

  it('rejects a fake PDF before quota or Pipeline work', async () => {
    const documentOcr = documentService()
    const quota = quotaService()
    const form = new FormData()
    form.append('document', new Blob(['not a pdf'], { type: 'application/pdf' }), 'fake.pdf')
    const app = documentApp(documentOcr, quota)

    const response = await app.fetch(
      request('/echo-api/proxy/ocr/document', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: form,
      }),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'ocr_document_invalid' })
    expect(documentOcr.process).not.toHaveBeenCalled()
    expect(quota.reserve).not.toHaveBeenCalled()
  })

  it('releases the exact reservation when Pipeline processing fails', async () => {
    const documentOcr = documentService({ failure: new Error('pipeline failed'), pageCount: 4 })
    const quota = quotaService()
    const app = documentApp(documentOcr, quota)

    const response = await app.fetch(documentRequest('req-pdf-failed'))

    expect(response.status).toBe(500)
    expect(quota.reserve).toHaveBeenCalledWith(
      proUser,
      'ocr_images',
      4,
      'proxy_ocr',
      'req-pdf-failed',
      expect.objectContaining({ idempotencyKey: 'op-req-pdf-failed' }),
    )
    expect(quota.commit).not.toHaveBeenCalled()
    expect(quota.release).toHaveBeenCalledTimes(1)
    expect(quota.release).toHaveBeenCalledWith(expect.objectContaining({ reservedAmount: 4 }))
  })

  it('does not start Pipeline when exact-page quota reservation fails', async () => {
    const unavailable = new ApiError(403, 'ocr_quota_exceeded', 'OCR quota exceeded')
    const quota = quotaService({ reserveError: unavailable })
    let pipelineStarted = false
    const documentOcr = documentService({
      pageCount: 20,
      afterAuthorize: () => {
        pipelineStarted = true
      },
    })
    const app = documentApp(documentOcr, quota)

    const response = await app.fetch(documentRequest('req-pdf-quota'))

    expect(response.status).toBe(403)
    expect(quota.assertAvailable).toHaveBeenCalledWith(
      proUser,
      'ocr_images',
      20,
      'req-pdf-quota',
      expect.objectContaining({ idempotencyKey: 'op-req-pdf-quota' }),
    )
    expect(quota.reserve).toHaveBeenCalledTimes(1)
    expect(pipelineStarted).toBe(false)
    expect(quota.commit).not.toHaveBeenCalled()
    expect(quota.release).not.toHaveBeenCalled()
  })

  it('rejects a 21-page document before quota reservation', async () => {
    const documentOcr: DocumentOcrService = {
      async warmup() {},
      async capability() {
        return { available: true, providerAvailable: true, model: 'glm-ocr:latest' }
      },
      async process() {
        throw new ApiError(
          422,
          'ocr_document_page_limit',
          '这份 PDF 共 21 页，当前一次最多处理 20 页。请拆分后重试。',
        )
      },
      async shutdown() {},
    }
    const quota = quotaService()
    const response = await documentApp(documentOcr, quota).fetch(
      documentRequest('req-pdf-page-limit'),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'ocr_document_page_limit' })
    expect(quota.assertAvailable).not.toHaveBeenCalled()
    expect(quota.reserve).not.toHaveBeenCalled()
  })

  it('enforces the decoded 25 MiB PDF limit independently of multipart overhead', async () => {
    const exactBytes = new Uint8Array(25 * 1024 * 1024)
    exactBytes.set(PDF_BYTES)
    const documentOcr = documentService()
    const exactForm = new FormData()
    exactForm.append(
      'document',
      new Blob([exactBytes], { type: 'application/pdf' }),
      'boundary.pdf',
    )
    const exact = await documentApp(documentOcr, quotaService()).fetch(
      request('/echo-api/proxy/ocr/document', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: exactForm,
      }),
    )
    expect(exact.status).toBe(200)

    const oversizedBytes = new Uint8Array(25 * 1024 * 1024 + 1)
    oversizedBytes.set(PDF_BYTES)
    const oversizedForm = new FormData()
    oversizedForm.append(
      'document',
      new Blob([oversizedBytes], { type: 'application/pdf' }),
      'oversized.pdf',
    )
    const oversized = await documentApp(documentService(), quotaService()).fetch(
      request('/echo-api/proxy/ocr/document', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: oversizedForm,
      }),
    )
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ code: 'payload_too_large' })
  })

  it('asserts exact quota before waiting but reserves only after the execution gate is entered', async () => {
    let inspected: () => void = () => undefined
    let enterGate: () => void = () => undefined
    const inspectedPromise = new Promise<void>((resolve) => {
      inspected = resolve
    })
    const gate = new Promise<void>((resolve) => {
      enterGate = resolve
    })
    const documentOcr: DocumentOcrService = {
      async warmup() {},
      async capability() {
        return { available: true, providerAvailable: true, model: 'glm-ocr:latest' }
      },
      async process(input) {
        await input.assertAvailable(2)
        inspected()
        await gate
        await input.reserve(2)
        return {
          text: 'queued PDF',
          model: 'glm-ocr:latest',
          pageCount: 2,
          warnings: [],
          degraded: false,
        }
      },
      async shutdown() {},
    }
    const quota = quotaService()
    const app = documentApp(documentOcr, quota)

    const responsePromise = app.fetch(documentRequest('req-pdf-queued'))
    await inspectedPromise
    expect(quota.assertAvailable).toHaveBeenCalledWith(
      proUser,
      'ocr_images',
      2,
      'req-pdf-queued',
      expect.objectContaining({ idempotencyKey: 'op-req-pdf-queued' }),
    )
    expect(quota.reserve).not.toHaveBeenCalled()

    enterGate()
    expect((await responsePromise).status).toBe(200)
    expect(quota.reserve).toHaveBeenCalledTimes(1)
  })
})

function documentApp(documentOcr: DocumentOcrService, quota: QuotaService) {
  const env = testEnv()
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({ 'valid-pro-token': proUser }),
    services: { ...testServices(env), documentOcr, quota },
  })
}

function documentRequest(requestId: string) {
  const form = new FormData()
  form.append('document', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'report.pdf')
  return request('/echo-api/proxy/ocr/document', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-pro-token',
      'x-request-id': requestId,
      'x-idempotency-key': `op-${requestId}`,
    },
    body: form,
  })
}

function documentService(
  options: {
    pageCount?: number
    text?: string
    warnings?: string[]
    degraded?: boolean
    failure?: Error
    authorize?: (pageCount: number) => Promise<void>
    afterAuthorize?: () => void
  } = {},
): DocumentOcrService {
  const pageCount = options.pageCount ?? 1
  return {
    warmup: vi.fn(async () => undefined),
    capability: vi.fn(async () => ({
      available: true,
      providerAvailable: true,
      model: 'glm-ocr:latest',
    })),
    process: vi.fn(async (input) => {
      await input.assertAvailable(pageCount)
      await input.reserve(pageCount)
      await options.authorize?.(pageCount)
      options.afterAuthorize?.()
      if (options.failure) throw options.failure
      return {
        text: options.text ?? 'PDF text',
        model: 'glm-ocr:latest',
        pageCount,
        warnings: options.warnings ?? [],
        degraded: options.degraded ?? false,
      }
    }),
    shutdown: vi.fn(async () => undefined),
  }
}

function quotaService(options: { reserveError?: Error } = {}): QuotaService {
  return {
    resolve: vi.fn(async () => null),
    assertAvailable: vi.fn(async () => undefined),
    reserve: vi.fn(async (_user, kind, amount, source, requestId, operation) => {
      if (options.reserveError) throw options.reserveError
      if (!operation || operation instanceof Date) throw new Error('operation options required')
      return {
        outcome: 'acquired' as const,
        operationId: 'operation-pdf',
        userId: proUser.id,
        kind,
        source,
        periodKey: '2026-07',
        requestId,
        idempotencyKey: operation.idempotencyKey,
        payloadHash: operation.payloadHash,
        reservedAmount: amount,
        leaseToken: 'lease-pdf',
        leaseExpiresAt: new Date('2026-07-21T18:00:00.000Z'),
        responseCacheTtlMs: 60_000,
      }
    }),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  }
}
