import { describe, expect, it, vi } from 'vitest'
import {
  acquiredReservation,
  cacheResponse,
  commitQuotaResponse,
  releaseQuotaReservation,
} from '../services/quota/quota-response.js'
import type {
  AcquiredQuotaReservation,
  QuotaCachedResponse,
  QuotaLedgerStore,
  QuotaReservation,
} from '../services/quota/quota-service.js'
import { createMemoryQuotaLedgerStore } from '../services/quota/quota-service.js'

const base = {
  operationId: 'operation-1',
  userId: 'user-1',
  kind: 'llm_tokens' as const,
  source: 'proxy_llm' as const,
  periodKey: '2026-07',
  requestId: 'trace-1',
  idempotencyKey: 'operation-key-1',
  payloadHash: 'a'.repeat(64),
  reservedAmount: 10,
}

const acquired: AcquiredQuotaReservation = {
  ...base,
  outcome: 'acquired',
  leaseToken: 'lease-1',
  leaseExpiresAt: new Date('2026-07-21T18:00:00.000Z'),
  responseCacheTtlMs: 60_000,
}

describe('quota response replay', () => {
  it('rebuilds the exact status, headers, and body from a completed operation', async () => {
    const original = new Response(new Uint8Array([1, 2, 3]), {
      status: 201,
      headers: { 'content-type': 'application/octet-stream', 'x-usage': '3' },
    })
    const cached = await cacheResponse(original)
    const replay = acquiredReservation({
      ...base,
      outcome: 'replay',
      actualAmount: 3,
      cachedResponse: cached,
    }) as Response

    expect(replay.status).toBe(201)
    expect(replay.headers.get('content-type')).toBe('application/octet-stream')
    expect(replay.headers.get('x-usage')).toBe('3')
    expect(new Uint8Array(await replay.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it.each([
    [
      'in_progress',
      { ...base, outcome: 'in_progress', retryAfterSeconds: 1 } satisfies QuotaReservation,
      'operation_in_progress',
    ],
    [
      'result_expired',
      { ...base, outcome: 'result_expired', actualAmount: 3 } satisfies QuotaReservation,
      'operation_result_expired',
    ],
  ])('fails closed for %s instead of running the provider again', (_name, reservation, code) => {
    expect(() => acquiredReservation(reservation)).toThrowError(
      expect.objectContaining({ status: _name === 'result_expired' ? 410 : 409, code }),
    )
  })

  it('retries a commit whose transaction succeeded before its acknowledgement was lost', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const reservation = await realReservation(ledger, 'commit-ack-lost')
    let loseFirstAcknowledgement = true
    const commit = vi.fn(
      async (
        current: AcquiredQuotaReservation,
        actualAmount: number,
        cachedResponse: QuotaCachedResponse,
      ) => {
        await quotaCommitAdapter(ledger, current, actualAmount, cachedResponse)
        if (loseFirstAcknowledgement) {
          loseFirstAcknowledgement = false
          throw new Error('ack lost after commit')
        }
      },
    )

    await commitQuotaResponse({ commit }, reservation, 3, new Response('ok'))

    expect(commit).toHaveBeenCalledTimes(2)
    expect(commit.mock.calls[0]).toEqual(commit.mock.calls[1])
    await expect(
      ledger.getUsed(reservation.userId, reservation.kind, reservation.periodKey),
    ).resolves.toBe(3)
  })

  it('returns a retryable pending result when commit state stays ambiguous', async () => {
    const commit = vi.fn().mockRejectedValue(new Error('database unavailable'))

    await expect(
      commitQuotaResponse({ commit }, acquired, 3, new Response('ok')),
    ).rejects.toMatchObject({
      status: 503,
      code: 'operation_in_progress',
      headers: { 'retry-after': '1' },
    })
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('retries a release whose transaction succeeded before its acknowledgement was lost', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const reservation = await realReservation(ledger, 'release-ack-lost')
    let loseFirstAcknowledgement = true
    const release = vi.fn(async (current: AcquiredQuotaReservation) => {
      await ledger.release({ reservation: current, now: new Date('2026-07-21T17:00:01.000Z') })
      if (loseFirstAcknowledgement) {
        loseFirstAcknowledgement = false
        throw new Error('ack lost after release')
      }
    })

    await releaseQuotaReservation({ release }, reservation)

    expect(release).toHaveBeenCalledTimes(2)
    expect(release.mock.calls[0]).toEqual(release.mock.calls[1])
    await expect(
      ledger.getUsed(reservation.userId, reservation.kind, reservation.periodKey),
    ).resolves.toBe(0)
  })
})

async function realReservation(
  ledger: QuotaLedgerStore,
  idempotencyKey: string,
): Promise<AcquiredQuotaReservation> {
  const reservation = await ledger.reserve({
    userId: 'user-ack-loss',
    kind: 'llm_tokens',
    amount: 10,
    limit: 100,
    source: 'proxy_llm',
    requestId: `request-${idempotencyKey}`,
    periodKey: '2026-07',
    idempotencyKey,
    payloadHash: 'b'.repeat(64),
    leaseMs: 60_000,
    responseCacheTtlMs: 60_000,
    now: new Date('2026-07-21T17:00:00.000Z'),
  })
  if (!reservation || reservation.outcome !== 'acquired') {
    throw new Error('expected an acquired reservation')
  }
  return reservation
}

async function quotaCommitAdapter(
  ledger: QuotaLedgerStore,
  reservation: AcquiredQuotaReservation,
  actualAmount: number,
  cachedResponse: Parameters<QuotaLedgerStore['commit']>[0]['cachedResponse'],
): Promise<void> {
  await ledger.commit({
    reservation,
    actualAmount,
    cachedResponse,
    now: new Date('2026-07-21T17:00:01.000Z'),
  })
}
