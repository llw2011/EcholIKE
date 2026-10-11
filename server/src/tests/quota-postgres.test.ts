import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createPostgresAdminStore,
  createPostgresBillingStore,
  createPostgresConnection,
  createPostgresQuotaLedgerStore,
  decryptQuotaResponseBody,
  encryptQuotaResponseBody,
} from '../db/client.js'

describe('postgres quota operation store', () => {
  it('keeps reserve, adjustment, response cache, and completion in transactions', async () => {
    const fake = scriptedPostgres()
    const store = createPostgresQuotaLedgerStore(fake.sql, 'test-quota-encryption-secret')
    const reservation = await store.reserve({
      userId: 'user-quota-postgres',
      kind: 'llm_tokens',
      amount: 100,
      limit: 1_000,
      source: 'proxy_llm',
      requestId: 'req-postgres-reserve',
      periodKey: '2026-07',
      idempotencyKey: 'op-postgres-reserve',
      payloadHash: 'a'.repeat(64),
      leaseMs: 60_000,
      responseCacheTtlMs: 900_000,
      now: new Date('2026-07-21T00:00:00.000Z'),
    })
    expect(reservation?.outcome).toBe('acquired')
    if (!reservation || reservation.outcome !== 'acquired') throw new Error('expected acquired')

    fake.operationRow = {
      id: reservation.operationId,
      user_id: reservation.userId,
      idempotency_key: reservation.idempotencyKey,
      payload_hash: reservation.payloadHash,
      kind: reservation.kind,
      source: reservation.source,
      period_key: reservation.periodKey,
      request_id: reservation.requestId,
      reserved_amount: reservation.reservedAmount,
      actual_amount: null,
      status: 'reserved',
      lease_token: reservation.leaseToken,
      finalized_lease_token: null,
      lease_expires_at: reservation.leaseExpiresAt,
      response_status: null,
      response_headers_json: null,
      response_body: null,
      response_expires_at: null,
    }
    await store.commit({
      reservation,
      actualAmount: 40,
      cachedResponse: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"text":"done"}'),
      },
      now: new Date('2026-07-21T00:00:01.000Z'),
    })

    const reserveLedger = fake.queries.find((query) => query.text.includes("'reserve'"))
    const commitLedger = fake.queries.find((query) => query.text.includes("'commit'"))
    const completion = fake.queries.find(
      (query) =>
        query.text.includes("status = 'completed'") && query.text.includes('actual_amount ='),
    )
    expect(reserveLedger?.text).toContain('operation_lease_token')
    expect(commitLedger?.text).toContain('operation_event')
    expect(completion?.values.some((value) => Buffer.isBuffer(value))).toBe(true)
    expect(completion?.text).toContain('::text::jsonb')
    expect(
      completion?.values.some(
        (value) =>
          typeof value === 'string' &&
          value === JSON.stringify({ 'content-type': 'application/json' }),
      ),
    ).toBe(true)
    expect(commitLedger?.transaction).toBe(completion?.transaction)
    expect(
      fake.queries.flatMap((query) => query.values).some((value) => value instanceof Date),
    ).toBe(false)
  })

  it('encrypts cached response bodies with nonce uniqueness and authenticated context', () => {
    const body = new TextEncoder().encode('private OCR result')
    const first = encryptQuotaResponseBody(body, 'secret-one', 'operation-context')
    const second = encryptQuotaResponseBody(body, 'secret-one', 'operation-context')

    expect(first).not.toEqual(body)
    expect(first).not.toEqual(second)
    expect(decryptQuotaResponseBody(first, 'secret-one', 'operation-context')).toEqual(body)
    expect(decryptQuotaResponseBody(first, 'wrong-secret', 'operation-context')).toBeNull()
    expect(decryptQuotaResponseBody(first, 'secret-one', 'different-context')).toBeNull()

    const tampered = Uint8Array.from(first)
    const finalByteIndex = tampered.length - 1
    const finalByte = tampered[finalByteIndex]
    if (finalByte === undefined) throw new Error('encrypted envelope was unexpectedly empty')
    tampered[finalByteIndex] = finalByte ^ 1
    expect(decryptQuotaResponseBody(tampered, 'secret-one', 'operation-context')).toBeNull()
  })

  it('serializes resolve, release, and maintenance timestamps before postgres binding', async () => {
    const fake = scriptedPostgres()
    const store = createPostgresQuotaLedgerStore(fake.sql, 'test-quota-encryption-secret')
    const now = new Date('2026-07-21T02:03:04.567Z')
    const identity = {
      userId: 'user-quota-timestamps',
      kind: 'ocr_images' as const,
      source: 'proxy_ocr' as const,
      requestId: 'req-quota-timestamps',
      idempotencyKey: 'op-quota-timestamps',
      payloadHash: 'b'.repeat(64),
    }

    await expect(store.resolve({ ...identity, now })).resolves.toBeNull()
    const reservation = await store.reserve({
      ...identity,
      amount: 1,
      limit: 10,
      periodKey: '2026-07',
      leaseMs: 60_000,
      responseCacheTtlMs: 900_000,
      now,
    })
    expect(reservation?.outcome).toBe('acquired')
    if (!reservation || reservation.outcome !== 'acquired') throw new Error('expected acquired')

    fake.operationRow = {
      id: reservation.operationId,
      user_id: reservation.userId,
      idempotency_key: reservation.idempotencyKey,
      payload_hash: reservation.payloadHash,
      kind: reservation.kind,
      source: reservation.source,
      period_key: reservation.periodKey,
      request_id: reservation.requestId,
      reserved_amount: reservation.reservedAmount,
      actual_amount: null,
      status: 'reserved',
      lease_token: reservation.leaseToken,
      finalized_lease_token: null,
      lease_expires_at: reservation.leaseExpiresAt,
      response_status: null,
      response_headers_json: null,
      response_body: null,
      response_expires_at: null,
    }
    await expect(store.release({ reservation, now })).resolves.toBe('released')
    await expect(store.reapExpired(now, 5)).resolves.toEqual({
      releasedReservations: 1,
      clearedResponses: 1,
    })

    const values = fake.queries.flatMap((query) => query.values)
    expect(values.some((value) => value instanceof Date)).toBe(false)
    expect(values).toContain(now.toISOString())
    expect(values).toContain(reservation.leaseExpiresAt.toISOString())
  })

  it('defines operation uniqueness, fenced ledger events, and durable completed tombstones', () => {
    const quotaProfileMigration = readFileSync(
      new URL('../db/migrations/0006_user_quota_profile.sql', import.meta.url),
      'utf8',
    )
    const migration = readFileSync(
      new URL('../db/migrations/0007_quota_operation_idempotency.sql', import.meta.url),
      'utf8',
    )

    expect(migration).toContain('"quota_operation_user_key_idx"')
    expect(migration).toContain('("user_id", "idempotency_key")')
    expect(migration).toContain('"quota_operation_global_lease_sweep_idx"')
    expect(migration).toContain('("status", "lease_expires_at")')
    expect(migration).toContain('"usage_ledger_operation_event_idx"')
    expect(migration).toContain('"operation_id", "operation_lease_token", "operation_event"')
    expect(migration).toContain('"response_body" bytea')
    expect(migration).toContain("'reserved', 'completed', 'released'")
    expect(migration).not.toMatch(/unique[^;]+request_id/is)
    expect(migration).not.toMatch(/delete\s+from\s+quota_operation/i)
    expect(quotaProfileMigration).toMatch(/create\s+table\s+if\s+not\s+exists/i)
    expect(quotaProfileMigration).toMatch(/create\s+index\s+if\s+not\s+exists/i)

    const journal = JSON.parse(
      readFileSync(new URL('../db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries?: Array<{ idx?: number; tag?: string }> }
    expect(journal.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ idx: 6, tag: '0006_user_quota_profile' }),
        expect.objectContaining({ idx: 7, tag: '0007_quota_operation_idempotency' }),
        expect.objectContaining({ idx: 8, tag: '0008_strengthen_default_scenes' }),
        expect.objectContaining({ idx: 9, tag: '0009_admin_control_atomicity' }),
        expect.objectContaining({ idx: 10, tag: '0010_admin_operational_indexes' }),
        expect.objectContaining({ idx: 11, tag: '0011_stripe_webhook_atomicity' }),
        expect.objectContaining({ idx: 12, tag: '0012_ota_artifact_bytes' }),
        expect.objectContaining({ idx: 13, tag: '0013_control_revisions_and_invariants' }),
        expect.objectContaining({ idx: 14, tag: '0014_stripe_event_ordering' }),
        expect.objectContaining({ idx: 15, tag: '0015_normalize_jsonb_shapes' }),
      ]),
    )
  })

  it('serializes manual quota adjustments with proxy reservations for the same user', async () => {
    const fake = scriptedPostgres()
    const store = createPostgresAdminStore(fake.sql)

    await store.adjustQuota({
      userId: 'user-adjusted',
      kind: 'llm_tokens',
      amount: -5,
      requestId: 'admin-adjustment',
      periodKey: '2026-07',
      actorUserId: 'admin-adjustment-actor',
      idempotencyKey: 'admin-adjustment-operation-0001',
      payloadHash: 'c'.repeat(64),
      reason: 'test serialized adjustment',
    })

    const lock = fake.queries.find((query) => query.text.includes('pg_advisory_xact_lock'))
    const adjustment = fake.queries.find((query) => query.text.includes('insert into usage_ledger'))
    expect(lock).toBeTruthy()
    expect(lock?.values).toContain('quota-user:user-adjusted')
    expect(lock?.transaction).toBe(adjustment?.transaction)
  })
})

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'keeps quota reads and reservations valid after cumulative usage crosses int32',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')
    const sql = createPostgresConnection(databaseUrl)
    const suffix = randomUUID()
    const userId = `quota-bigint-${suffix}`
    const periodKey = '2041-01'
    const billing = createPostgresBillingStore(sql)
    const admin = createPostgresAdminStore(sql)
    const quota = createPostgresQuotaLedgerStore(sql, `quota-bigint-secret-${suffix}`)

    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values (${userId}, ${`${userId}@example.invalid`}, 'Bigint quota', true)
      `
      await sql`
        insert into usage_ledger (user_id, kind, amount, source, request_id, period_key)
        select
          ${userId},
          'llm_tokens'::usage_ledger_kind,
          10000000,
          'adjustment'::usage_ledger_source,
          ${`bigint-${suffix}-`} || series::text,
          ${periodKey}
        from generate_series(1, 216) as series
      `

      await expect(billing.getUsageTotals(userId, periodKey)).resolves.toMatchObject({
        llmTokensUsed: 2_160_000_000,
      })
      const users = await admin.listUsers({
        periodKey,
        query: userId,
        cursor: null,
        limit: 25,
      })
      expect(users.users[0]).toMatchObject({
        id: userId,
        llmTokensUsed: 2_160_000_000,
      })

      const reservation = await quota.reserve({
        userId,
        kind: 'llm_tokens',
        amount: 1,
        limit: 3_000_000_000,
        source: 'proxy_llm',
        requestId: `bigint-reserve-${suffix}`,
        periodKey,
        idempotencyKey: `bigint-reserve-${suffix}`,
        payloadHash: 'd'.repeat(64),
        leaseMs: 60_000,
        responseCacheTtlMs: 60_000,
        now: new Date('2041-01-15T00:00:00.000Z'),
      })
      expect(reservation).toMatchObject({ outcome: 'acquired', reservedAmount: 1 })
    } finally {
      await sql`delete from "user" where id = ${userId}`.catch(() => undefined)
      await sql.end()
    }
  },
)

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'enforces quota operation idempotency on a real isolated PostgreSQL database',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

    const sql = createPostgresConnection(databaseUrl)
    const suffix = randomUUID()
    const userId = `quota-postgres-${suffix}`
    const quotaRaceUserId = `quota-race-${suffix}`
    const now = new Date('2026-07-21T00:00:00.000Z')
    const store = createPostgresQuotaLedgerStore(sql, `test-encryption-${suffix}`)
    const reserveInput = (overrides: Record<string, unknown> = {}) => ({
      userId,
      kind: 'llm_tokens' as const,
      amount: 100,
      limit: 1_000,
      source: 'proxy_llm' as const,
      requestId: `request-${suffix}`,
      periodKey: '2026-07',
      idempotencyKey: `operation-${suffix}`,
      payloadHash: 'a'.repeat(64),
      leaseMs: 60_000,
      responseCacheTtlMs: 900_000,
      now,
      ...overrides,
    })

    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values
          (${userId}, ${`${userId}@example.invalid`}, 'PostgreSQL integration', true),
          (${quotaRaceUserId}, ${`${quotaRaceUserId}@example.invalid`}, 'Quota race', true)
      `

      const concurrent = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.reserve(reserveInput({ requestId: `request-${suffix}-${index}` })),
        ),
      )
      const acquired = concurrent.find((result) => result?.outcome === 'acquired')
      expect(acquired?.outcome).toBe('acquired')
      if (!acquired || acquired.outcome !== 'acquired') throw new Error('expected acquired')
      expect(concurrent.filter((result) => result?.outcome === 'acquired')).toHaveLength(1)
      expect(concurrent.filter((result) => result?.outcome === 'in_progress')).toHaveLength(19)

      await expect(
        store.commit({
          reservation: acquired,
          actualAmount: 40,
          cachedResponse: {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-unsafe-response-header': 'must-not-be-cached',
            },
            body: new TextEncoder().encode('{"text":"postgres-replay"}'),
          },
          now: new Date(now.getTime() + 1_000),
        }),
      ).resolves.toBe('completed')

      const replay = await store.reserve(
        reserveInput({
          requestId: `request-${suffix}-retry`,
          now: new Date(now.getTime() + 2_000),
        }),
      )
      expect(replay?.outcome).toBe('replay')
      if (!replay || replay.outcome !== 'replay') throw new Error('expected replay')
      expect(new TextDecoder().decode(replay.cachedResponse.body)).toBe(
        '{"text":"postgres-replay"}',
      )
      expect(replay.cachedResponse.headers).toEqual({ 'content-type': 'application/json' })

      await expect(
        store.reserve(
          reserveInput({
            requestId: `request-${suffix}-conflict`,
            payloadHash: 'f'.repeat(64),
          }),
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' })

      const releaseReservation = await store.reserve(
        reserveInput({
          idempotencyKey: `release-${suffix}`,
          payloadHash: 'b'.repeat(64),
          amount: 30,
          requestId: `release-request-${suffix}`,
        }),
      )
      expect(releaseReservation?.outcome).toBe('acquired')
      if (!releaseReservation || releaseReservation.outcome !== 'acquired') {
        throw new Error('expected release reservation')
      }
      await expect(
        store.release({
          reservation: releaseReservation,
          now: new Date(now.getTime() + 3_000),
        }),
      ).resolves.toBe('released')
      await expect(
        store.release({
          reservation: releaseReservation,
          now: new Date(now.getTime() + 4_000),
        }),
      ).resolves.toBe('noop')

      const quotaRace = await Promise.all([
        store.reserve(
          reserveInput({
            userId: quotaRaceUserId,
            idempotencyKey: `race-a-${suffix}`,
            payloadHash: 'c'.repeat(64),
            amount: 60,
            limit: 100,
            requestId: `race-a-${suffix}`,
          }),
        ),
        store.reserve(
          reserveInput({
            userId: quotaRaceUserId,
            idempotencyKey: `race-b-${suffix}`,
            payloadHash: 'd'.repeat(64),
            amount: 60,
            limit: 100,
            requestId: `race-b-${suffix}`,
          }),
        ),
      ])
      expect(quotaRace.filter((result) => result?.outcome === 'acquired')).toHaveLength(1)
      expect(quotaRace.filter((result) => result === null)).toHaveLength(1)
      const quotaRaceReservation = quotaRace.find((result) => result?.outcome === 'acquired')
      if (!quotaRaceReservation || quotaRaceReservation.outcome !== 'acquired') {
        throw new Error('expected quota race reservation')
      }
      await store.release({
        reservation: quotaRaceReservation,
        now: new Date(now.getTime() + 5_000),
      })

      const [facts] = await sql`
        select
          coalesce(sum(amount), 0)::int as total,
          count(*) filter (where operation_event = 'reserve')::int as reserves,
          count(*) filter (where operation_event = 'commit')::int as commits,
          count(*) filter (where operation_event = 'release')::int as releases
        from usage_ledger
        where user_id = ${userId}
      `
      expect(facts).toEqual({ total: 40, reserves: 2, commits: 1, releases: 1 })

      await sql`delete from "user" where id in (${userId}, ${quotaRaceUserId})`
      const [remaining] = await sql`
        select
          (select count(*)::int from quota_operation where user_id in (${userId}, ${quotaRaceUserId})) as operations,
          (select count(*)::int from usage_ledger where user_id in (${userId}, ${quotaRaceUserId})) as ledger
      `
      expect(remaining).toEqual({ operations: 0, ledger: 0 })
    } finally {
      try {
        await sql`delete from "user" where id in (${userId}, ${quotaRaceUserId})`
      } finally {
        await sql.end()
      }
    }
  },
)

interface FakeQuery {
  text: string
  values: unknown[]
  transaction: number
}

function scriptedPostgres() {
  const queries: FakeQuery[] = []
  let transaction = 0
  const state: { operationRow: Record<string, unknown> | null } = { operationRow: null }

  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    queries.push({ text, values, transaction })
    if (text.includes('from public.admin_account') && text.includes('where user_id =')) {
      return [{ user_id: values[0], role: 'owner', status: 'active' }]
    }
    if (text.includes('select coalesce(sum(amount)')) return [{ total: 0 }]
    if (text.includes('from quota_operation') && text.includes('where id =')) {
      return state.operationRow ? [state.operationRow] : []
    }
    if (text.includes('from quota_operation') && text.includes('idempotency_key =')) return []
    if (text.includes('returning id') || text.includes('returning operation.id')) {
      return [{ id: String(state.operationRow?.id ?? 'updated') }]
    }
    return []
  }
  tag.begin = async (callback: (transactionSql: typeof tag) => unknown) => {
    transaction += 1
    return callback(tag)
  }
  return {
    sql: tag as never,
    queries,
    get operationRow() {
      return state.operationRow
    },
    set operationRow(value: Record<string, unknown> | null) {
      state.operationRow = value
    },
  }
}
