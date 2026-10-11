import { describe, expect, it } from 'vitest'
import {
  createMemoryQuotaLedgerStore,
  createQuotaService,
  type AcquiredQuotaReservation,
  type QuotaCachedResponse,
  type QuotaKind,
  type QuotaLedgerStore,
} from '../services/quota/quota-service.js'
import type { EntitlementService } from '../services/billing/entitlements.js'
import type { SubscriptionStatus } from '../types.js'
import { proUser } from './helpers.js'

describe('quota service', () => {
  it('commits usage and replays the cached response without charging twice', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    const reservation = await acquired(
      quota.reserve(
        proUser,
        'llm_tokens',
        100,
        'proxy_llm',
        'req_quota_commit',
        operation('op-quota-commit', 'a'),
      ),
    )
    const response = cachedJson({ text: 'done' })

    await quota.commit(reservation, 40, response)
    await quota.commit(reservation, 40, response)

    const replay = await quota.reserve(
      proUser,
      'llm_tokens',
      100,
      'proxy_llm',
      'req_quota_commit_retry',
      operation('op-quota-commit', 'a', '2026-06-25T00:00:02.000Z'),
    )

    expect(replay).toMatchObject({ outcome: 'replay', actualAmount: 40 })
    expect(replay.outcome === 'replay' ? replay.cachedResponse : null).toEqual(response)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(40)
  })

  it('returns in-progress for an active duplicate without charging twice', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    const first = await quota.reserve(
      proUser,
      'ocr_images',
      1,
      'proxy_ocr',
      'req-active-first',
      operation('op-active', 'b', '2026-06-25T00:00:00.000Z', 10_000),
    )
    const duplicate = await quota.reserve(
      proUser,
      'ocr_images',
      1,
      'proxy_ocr',
      'req-active-duplicate',
      operation('op-active', 'b', '2026-06-25T00:00:01.100Z', 10_000),
    )

    expect(first.outcome).toBe('acquired')
    expect(duplicate).toMatchObject({ outcome: 'in_progress', retryAfterSeconds: 9 })
    await expect(used(ledger, proUser.id, 'ocr_images')).resolves.toBe(1)
  })

  it('serializes a burst of the same operation into one reservation', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        quota.reserve(
          proUser,
          'llm_tokens',
          25,
          'proxy_llm',
          `req-burst-${index}`,
          operation('op-burst', 'b'),
        ),
      ),
    )

    expect(results.filter((result) => result.outcome === 'acquired')).toHaveLength(1)
    expect(results.filter((result) => result.outcome === 'in_progress')).toHaveLength(19)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(25)
  })

  it('scopes the same idempotency key independently per user', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    const secondUser = { ...proUser, id: 'user-second-idempotency-scope' }
    const [first, second] = await Promise.all([
      quota.reserve(
        proUser,
        'ocr_images',
        1,
        'proxy_ocr',
        'req-user-scope-first',
        operation('op-shared-by-users', 'c'),
      ),
      quota.reserve(
        secondUser,
        'ocr_images',
        1,
        'proxy_ocr',
        'req-user-scope-second',
        operation('op-shared-by-users', 'c'),
      ),
    ])

    expect(first.outcome).toBe('acquired')
    expect(second.outcome).toBe('acquired')
    await expect(used(ledger, proUser.id, 'ocr_images')).resolves.toBe(1)
    await expect(used(ledger, secondUser.id, 'ocr_images')).resolves.toBe(1)
  })

  it('fails closed when an idempotency key is reused for a different payload', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    await quota.reserve(
      proUser,
      'tts_chars',
      12,
      'proxy_tts',
      'req-conflict-first',
      operation('op-conflict', 'c'),
    )

    await expect(
      quota.reserve(
        proUser,
        'tts_chars',
        12,
        'proxy_tts',
        'req-conflict-second',
        operation('op-conflict', 'd'),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' })
    await expect(used(ledger, proUser.id, 'tts_chars')).resolves.toBe(12)
  })

  it('makes release idempotent and permits a clean retry of a released operation', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    const first = await acquired(
      quota.reserve(
        proUser,
        'stt_seconds',
        30,
        'proxy_stt',
        'req_quota_release',
        operation('op-release', 'e'),
      ),
    )

    await quota.release(first)
    await quota.release(first)
    const retry = await acquired(
      quota.reserve(
        proUser,
        'stt_seconds',
        30,
        'proxy_stt',
        'req_quota_release_retry',
        operation('op-release', 'e', '2026-06-25T00:00:02.000Z'),
      ),
    )
    await quota.commit(retry, 18, cachedJson({ text: 'retry succeeded' }))
    await expect(quota.commit(first, 30, cachedJson({ text: 'stale' }))).rejects.toMatchObject({
      code: 'operation_stale',
    })
    await quota.release(first)

    await expect(used(ledger, proUser.id, 'stt_seconds')).resolves.toBe(18)
  })

  it('atomically releases and re-reserves an expired operation with a fenced lease', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    const expired = await acquired(
      quota.reserve(
        proUser,
        'llm_tokens',
        100,
        'proxy_llm',
        'req-expired-first',
        operation('op-expired', 'f', '2026-06-25T00:00:00.000Z', 1_000),
      ),
    )
    const reclaimed = await acquired(
      quota.reserve(
        proUser,
        'llm_tokens',
        100,
        'proxy_llm',
        'req-expired-retry',
        operation('op-expired', 'f', '2026-06-25T00:00:02.000Z', 10_000),
      ),
    )

    expect(reclaimed.leaseToken).not.toBe(expired.leaseToken)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(100)
    await expect(
      quota.commit(expired, 50, cachedJson({ text: 'stale completion' })),
    ).rejects.toMatchObject({ code: 'operation_stale' })
    await quota.commit(reclaimed, 50, cachedJson({ text: 'current completion' }))
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(50)
  })

  it('reaps crashed reservations before checking quota for another operation', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements({ ocrImagesLimit: 1 }), ledger)
    await quota.reserve(
      proUser,
      'ocr_images',
      1,
      'proxy_ocr',
      'req-crashed',
      operation('op-crashed', '1', '2026-06-25T00:00:00.000Z', 1_000),
    )

    const next = await quota.reserve(
      proUser,
      'ocr_images',
      1,
      'proxy_ocr',
      'req-after-crash',
      operation('op-after-crash', '2', '2026-06-25T00:00:02.000Z'),
    )

    expect(next.outcome).toBe('acquired')
    await expect(
      ledger.getUsed(proUser.id, 'ocr_images', '2026-06', new Date('2026-06-25T00:00:02.000Z')),
    ).resolves.toBe(1)
  })

  it('keeps a completed tombstone after the response cache expires', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    const reservation = await acquired(
      quota.reserve(proUser, 'tts_chars', 20, 'proxy_tts', 'req-cache-first', {
        ...operation('op-cache-expiry', '7'),
        responseCacheTtlMs: 1_000,
      }),
    )
    await quota.commit(
      reservation,
      12,
      cachedJson({ audio: 'cached' }),
      new Date('2026-06-25T00:00:00.000Z'),
    )

    const expired = await quota.reserve(
      proUser,
      'tts_chars',
      20,
      'proxy_tts',
      'req-cache-retry',
      operation('op-cache-expiry', '7', '2026-06-25T00:00:02.000Z'),
    )
    const stillExpired = await quota.reserve(
      proUser,
      'tts_chars',
      20,
      'proxy_tts',
      'req-cache-retry-again',
      operation('op-cache-expiry', '7', '2026-07-25T00:00:00.000Z'),
    )

    expect(expired).toMatchObject({ outcome: 'result_expired', actualAmount: 12 })
    expect(stillExpired.outcome).toBe('result_expired')
    await expect(used(ledger, proUser.id, 'tts_chars')).resolves.toBe(12)
  })

  it('releases an expired old-period reservation before charging the retry to the new period', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements(), ledger)
    await quota.reserve(
      proUser,
      'ocr_images',
      1,
      'proxy_ocr',
      'req-month-first',
      operation('op-cross-month', '8', '2026-06-30T23:59:59.000Z', 1_000),
    )
    const retry = await quota.reserve(
      proUser,
      'ocr_images',
      1,
      'proxy_ocr',
      'req-month-retry',
      operation('op-cross-month', '8', '2026-07-01T00:00:01.000Z'),
    )

    expect(retry).toMatchObject({ outcome: 'acquired', periodKey: '2026-07' })
    await expect(
      ledger.getUsed(proUser.id, 'ocr_images', '2026-06', new Date('2026-07-01T00:00:01.000Z')),
    ).resolves.toBe(0)
    await expect(
      ledger.getUsed(proUser.id, 'ocr_images', '2026-07', new Date('2026-07-01T00:00:01.000Z')),
    ).resolves.toBe(1)
  })

  it('lets operation-aware preflight pass for a replay while rejecting a new operation', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements({ ocrImagesLimit: 1 }), ledger)
    const options = operation('op-preflight-replay', '9')
    const reservation = await acquired(
      quota.reserve(proUser, 'ocr_images', 1, 'proxy_ocr', 'req-preflight-first', options),
    )
    await quota.commit(reservation, 1, cachedJson({ text: 'done' }))

    await expect(
      quota.assertAvailable(proUser, 'ocr_images', 1, 'req-preflight-replay', options),
    ).resolves.toBeUndefined()
    await expect(
      quota.assertAvailable(
        proUser,
        'ocr_images',
        1,
        'req-preflight-new',
        operation('op-preflight-new', 'a'),
      ),
    ).rejects.toMatchObject({ code: 'ocr_quota_exceeded' })
  })

  it('rejects concurrent reservations that would exceed the limit', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(testEntitlements({ llmTokensLimit: 5 }), ledger)

    const results = await Promise.allSettled([
      quota.reserve(
        proUser,
        'llm_tokens',
        3,
        'proxy_llm',
        'req_quota_race_a',
        operation('op-race-a', '3'),
      ),
      quota.reserve(
        proUser,
        'llm_tokens',
        3,
        'proxy_llm',
        'req_quota_race_b',
        operation('op-race-b', '4'),
      ),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(used(ledger, proUser.id, 'llm_tokens')).resolves.toBe(3)
  })

  it('applies dedicated OCR and TTS limits', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const quota = createQuotaService(
      testEntitlements({ ocrImagesLimit: 1, ttsCharsLimit: 10 }),
      ledger,
    )

    await quota.reserve(
      proUser,
      'ocr_images',
      1,
      'proxy_ocr',
      'req_ocr_quota',
      operation('op-ocr-quota', '5'),
    )

    await expect(
      quota.reserve(
        proUser,
        'tts_chars',
        11,
        'proxy_tts',
        'req_tts_quota',
        operation('op-tts-quota', '6'),
      ),
    ).rejects.toMatchObject({ code: 'tts_quota_exceeded' })
    await expect(used(ledger, proUser.id, 'ocr_images')).resolves.toBe(1)
  })
})

function testEntitlements(
  limits: Partial<
    Pick<
      SubscriptionStatus,
      'sttSecondsLimit' | 'llmTokensLimit' | 'ocrImagesLimit' | 'ttsCharsLimit'
    >
  > = {},
): EntitlementService {
  return {
    async getStatus() {
      return {
        plan: 'pro',
        subscriptionEnd: '2026-12-31T00:00:00.000Z',
        quotaLevel: 1,
        quotaMultiplier: 1,
        sttSecondsUsed: 0,
        sttSecondsLimit: limits.sttSecondsLimit ?? 36_000,
        llmTokensUsed: 0,
        llmTokensLimit: limits.llmTokensLimit ?? 5_000_000,
        ocrImagesUsed: 0,
        ocrImagesLimit: limits.ocrImagesLimit ?? 5_000,
        ttsCharsUsed: 0,
        ttsCharsLimit: limits.ttsCharsLimit ?? 2_000_000,
      }
    },
  }
}

function used(ledger: QuotaLedgerStore, userId: string, kind: QuotaKind) {
  return ledger.getUsed(userId, kind, '2026-06', new Date('2026-06-25T00:00:00.000Z'))
}

function operation(
  idempotencyKey: string,
  hashSeed: string,
  now = '2026-06-25T00:00:00.000Z',
  leaseMs = 30_000,
) {
  return {
    idempotencyKey,
    payloadHash: hashSeed.repeat(64).slice(0, 64),
    leaseMs,
    now: new Date(now),
  }
}

function cachedJson(value: unknown): QuotaCachedResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  }
}

async function acquired(
  reservation: Promise<Awaited<ReturnType<ReturnType<typeof createQuotaService>['reserve']>>>,
): Promise<AcquiredQuotaReservation> {
  const value = await reservation
  if (value.outcome !== 'acquired') throw new Error(`expected acquired, got ${value.outcome}`)
  return value
}
