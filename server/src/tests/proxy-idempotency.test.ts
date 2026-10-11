import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { disabledBillingSessionService } from '../services/billing/stripe.js'
import { createStaticEntitlementService } from '../services/billing/entitlements.js'
import type { DocumentOcrService } from '../services/ocr/document-ocr-service.js'
import {
  createMemoryQuotaLedgerStore,
  createQuotaService,
  type QuotaKind,
  type QuotaLedgerStore,
} from '../services/quota/quota-service.js'
import { disabledProxyServices, type ProxyServices } from '../services/proxy/proxy-services.js'
import type { AuthenticatedUser } from '../types.js'
import { utcPeriodKey } from '../services/quota/usage-ledger.js'
import { proUser, request, testEnv, testServices } from './helpers.js'

const PNG_BASE64 = 'iVBORw0KGgo='
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% idempotency test\n')

describe('proxy billing idempotency', () => {
  it('replays a lost LLM response without a second provider call or token charge', async () => {
    const complete = vi.fn(async () => ({ text: 'stable answer', usageTokens: 7 }))
    const { app, ledger } = idempotencyApp({
      llm: { complete, stream: vi.fn(async () => Promise.reject(new Error('not used'))) },
    })

    const first = await app.fetch(llmRequest('llm-lost-response', 'hello'))
    expect(first.status).toBe(200)
    // Deliberately discard the first response body to model a client-side lost response.
    const replay = await app.fetch(llmRequest('llm-lost-response', 'hello'))

    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toEqual({ text: 'stable answer' })
    expect(complete).toHaveBeenCalledTimes(1)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(7)
  })

  it('charges a non-empty LLM completion at least once when provider usage is zero', async () => {
    const complete = vi.fn(async () => ({ text: 'non-empty answer', usageTokens: 0 }))
    const { app, ledger } = idempotencyApp({
      llm: { complete, stream: vi.fn(async () => Promise.reject(new Error('not used'))) },
    })

    expect((await app.fetch(llmRequest('llm-zero-provider-usage', 'hello'))).status).toBe(200)

    expect(complete).toHaveBeenCalledTimes(1)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(1)
  })

  it('rejects the same key with a different semantic payload before provider work', async () => {
    const complete = vi.fn(async () => ({ text: 'answer', usageTokens: 5 }))
    const { app, ledger } = idempotencyApp({
      llm: { complete, stream: vi.fn(async () => Promise.reject(new Error('not used'))) },
    })

    expect((await app.fetch(llmRequest('llm-conflict', 'first'))).status).toBe(200)
    const conflict = await app.fetch(llmRequest('llm-conflict', 'different'))

    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ code: 'idempotency_conflict' })
    expect(complete).toHaveBeenCalledTimes(1)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(5)
  })

  it('fences a 20-request duplicate burst and replays after the first operation completes', async () => {
    let startProvider: () => void = () => undefined
    let finishProvider: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      startProvider = resolve
    })
    const held = new Promise<void>((resolve) => {
      finishProvider = resolve
    })
    const complete = vi.fn(async () => {
      startProvider()
      await held
      return { text: 'eventual answer', usageTokens: 11 }
    })
    const { app, ledger } = idempotencyApp({
      llm: { complete, stream: vi.fn(async () => Promise.reject(new Error('not used'))) },
    })

    const firstPromise = app.fetch(llmRequest('llm-concurrent', 'hello'))
    await started
    const concurrent = await Promise.all(
      Array.from({ length: 19 }, () => app.fetch(llmRequest('llm-concurrent', 'hello'))),
    )
    for (const response of concurrent) {
      expect(response.status).toBe(409)
      expect(response.headers.get('retry-after')).toBe('1')
      await expect(response.json()).resolves.toMatchObject({ code: 'operation_in_progress' })
    }

    finishProvider()
    expect((await firstPromise).status).toBe(200)
    expect((await app.fetch(llmRequest('llm-concurrent', 'hello'))).status).toBe(200)
    expect(complete).toHaveBeenCalledTimes(1)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(11)
  })

  it('allows a released failed attempt to retry once and charge only the success', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider failed'))
      .mockResolvedValueOnce({ text: 'recovered', usageTokens: 9 })
    const { app, ledger } = idempotencyApp({
      llm: { complete, stream: vi.fn(async () => Promise.reject(new Error('not used'))) },
    })

    expect((await app.fetch(llmRequest('llm-retry-after-failure', 'hello'))).status).toBe(500)
    expect((await app.fetch(llmRequest('llm-retry-after-failure', 'hello'))).status).toBe(200)

    expect(complete).toHaveBeenCalledTimes(2)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(9)
  })

  it('buffers a streaming LLM completion before delivery and replays the complete stream', async () => {
    const encoder = new TextEncoder()
    const stream = vi.fn(async () => ({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"text":"complete"}\n\n'))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      ),
      completed: Promise.resolve({ text: 'complete', usageTokens: 13 }),
    }))
    const { app, ledger } = idempotencyApp({
      llm: { complete: vi.fn(async () => Promise.reject(new Error('not used'))), stream },
    })

    const first = await app.fetch(llmStreamRequest('llm-stream-replay'))
    const replay = await app.fetch(llmStreamRequest('llm-stream-replay'))
    const firstBody = await first.text()
    const replayBody = await replay.text()

    expect(first.headers.get('content-type')).toContain('text/event-stream')
    expect(firstBody).toContain('complete')
    expect(replayBody).toBe(firstBody)
    expect(stream).toHaveBeenCalledTimes(1)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(13)
  })

  it('replays an STT response for the same audio without charging duration twice', async () => {
    const transcribe = vi.fn(async () => ({ text: 'heard once', durationSeconds: 3 }))
    const { app, ledger } = idempotencyApp({ stt: { transcribe } })

    expect((await app.fetch(sttRequest('stt-replay'))).status).toBe(200)
    const replay = await app.fetch(sttRequest('stt-replay'))

    await expect(replay.json()).resolves.toEqual({ text: 'heard once' })
    expect(transcribe).toHaveBeenCalledTimes(1)
    await expect(used(ledger, proUser.id, 'stt_seconds')).resolves.toBe(3)
  })

  it('replays exact TTS bytes and OCR JSON without duplicate media charges', async () => {
    const synthesize = vi.fn(async () => ({
      audio: new Uint8Array([82, 73, 70, 70]).buffer,
      contentType: 'audio/wav',
      usageChars: 4,
    }))
    const read = vi.fn(async () => ({ text: 'OCR text', model: 'vision-model', usageTokens: 4 }))
    const { app, ledger } = idempotencyApp({ tts: { synthesize }, ocr: { read } })

    const ttsFirst = await app.fetch(ttsRequest('tts-replay'))
    const ttsReplay = await app.fetch(ttsRequest('tts-replay'))
    expect(new Uint8Array(await ttsFirst.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]))
    expect(new Uint8Array(await ttsReplay.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]))
    expect(ttsReplay.headers.get('content-type')).toBe('audio/wav')
    expect(synthesize).toHaveBeenCalledTimes(1)

    expect((await app.fetch(ocrRequest('ocr-replay'))).status).toBe(200)
    const ocrReplay = await app.fetch(ocrRequest('ocr-replay'))
    await expect(ocrReplay.json()).resolves.toMatchObject({
      text: 'OCR text',
      model: 'vision-model',
    })
    expect(read).toHaveBeenCalledTimes(1)

    await expect(used(ledger, proUser.id, 'tts_chars')).resolves.toBe(4)
    await expect(used(ledger, proUser.id, 'ocr_images')).resolves.toBe(1)
  })

  it('replays a completed PDF result after preflight without a second Pipeline run', async () => {
    let pipelineRuns = 0
    const process = vi.fn(async (input: Parameters<DocumentOcrService['process']>[0]) => {
      await input.assertAvailable(2)
      await input.reserve(2)
      pipelineRuns += 1
      return {
        text: 'two page result',
        model: 'glm-ocr:latest',
        pageCount: 2,
        warnings: [],
        degraded: false,
      }
    })
    const documentOcr: DocumentOcrService = {
      async warmup() {},
      async capability() {
        return { available: true, providerAvailable: true, model: 'glm-ocr:latest' }
      },
      process,
      async shutdown() {},
    }
    const { app, ledger } = idempotencyApp({ documentOcr })

    expect((await app.fetch(pdfRequest('pdf-replay'))).status).toBe(200)
    const replay = await app.fetch(pdfRequest('pdf-replay'))
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ text: 'two page result', pageCount: 2 })
    expect(process).toHaveBeenCalledTimes(1)
    expect(pipelineRuns).toBe(1)
    await expect(used(ledger, proUser.id, 'ocr_images')).resolves.toBe(2)
  })

  it('scopes identical keys to the authenticated user', async () => {
    const secondUser: AuthenticatedUser = {
      ...proUser,
      id: 'user_pro_two',
      email: 'two@example.com',
    }
    const complete = vi.fn(async () => ({ text: 'per-user', usageTokens: 3 }))
    const { app, ledger } = idempotencyApp(
      { llm: { complete, stream: vi.fn(async () => Promise.reject(new Error('not used'))) } },
      secondUser,
    )

    expect((await app.fetch(llmRequest('shared-key', 'hello'))).status).toBe(200)
    expect((await app.fetch(llmRequest('shared-key', 'hello', 'valid-pro-token-two'))).status).toBe(
      200,
    )
    expect(complete).toHaveBeenCalledTimes(2)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(3)
    await expect(used(ledger, secondUser.id, 'llm_tokens')).resolves.toBe(3)
  })
})

function idempotencyApp(
  overrides: Partial<ProxyServices> & { documentOcr?: DocumentOcrService },
  secondUser?: AuthenticatedUser,
) {
  const env = testEnv()
  const ledger = createMemoryQuotaLedgerStore()
  const entitlements = createStaticEntitlementService(env.planLimits, {
    [proUser.id]: { plan: 'pro', subscriptionEnd: proUser.subscriptionEnd },
    ...(secondUser
      ? { [secondUser.id]: { plan: 'pro' as const, subscriptionEnd: secondUser.subscriptionEnd } }
      : {}),
  })
  const services = testServices(env)
  const documentOcr = overrides.documentOcr ?? services.documentOcr
  const { documentOcr: _ignored, ...proxyOverrides } = overrides
  return {
    ledger,
    app: createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-pro-token': proUser,
        ...(secondUser ? { 'valid-pro-token-two': secondUser } : {}),
      }),
      services: {
        ...services,
        entitlements,
        billing: disabledBillingSessionService,
        quota: createQuotaService(entitlements, ledger),
        proxy: { ...disabledProxyServices, ...proxyOverrides },
        documentOcr,
      },
    }),
  }
}

function llmRequest(key: string, content: string, token = 'valid-pro-token') {
  return request('/echo-api/proxy/llm', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-idempotency-key': key,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  })
}

function llmStreamRequest(key: string) {
  return request('/echo-api/proxy/llm', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-pro-token',
      'content-type': 'application/json',
      'x-idempotency-key': key,
    },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  })
}

function sttRequest(key: string) {
  const form = new FormData()
  form.append('audio', new Blob([new Uint8Array(64_000)]), 'audio.wav')
  form.append('language', 'en')
  return request('/echo-api/proxy/stt', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-pro-token',
      'x-idempotency-key': key,
    },
    body: form,
  })
}

function ttsRequest(key: string) {
  return request('/echo-api/proxy/tts', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-pro-token',
      'content-type': 'application/json',
      'x-idempotency-key': key,
    },
    body: JSON.stringify({ text: 'test' }),
  })
}

function ocrRequest(key: string) {
  return request('/echo-api/proxy/ocr', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-pro-token',
      'content-type': 'application/json',
      'x-idempotency-key': key,
    },
    body: JSON.stringify({
      contractVersion: 2,
      imageBase64: PNG_BASE64,
      imageMimeType: 'image/png',
    }),
  })
}

function pdfRequest(key: string) {
  const form = new FormData()
  form.append('document', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'document.pdf')
  return request('/echo-api/proxy/ocr/document', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-pro-token',
      'x-idempotency-key': key,
    },
    body: form,
  })
}

function used(ledger: QuotaLedgerStore, userId: string, kind: QuotaKind) {
  return ledger.getUsed(userId, kind, utcPeriodKey())
}
