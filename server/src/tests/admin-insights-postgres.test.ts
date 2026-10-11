import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createPostgresAdminInsightsStore } from '../db/admin-insights.js'
import { createPostgresAuditLogStore, createPostgresConnection } from '../db/client.js'
import { createAdminInsightsService } from '../services/admin/admin-insights-service.js'

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'paginates PostgreSQL microseconds exactly and keeps UTC/expiry boundaries consistent',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')
    const sql = createPostgresConnection(databaseUrl)
    const suffix = randomUUID()
    const userId = `insight-user-${suffix}`
    const otherUserId = `insight-other-${suffix}`
    const requestPrefix = `insight-${suffix}`
    const auditNewId = randomUUID()
    const auditOldId = randomUUID()
    const auditEndId = randomUUID()
    const operationNewId = randomUUID()
    const operationOldId = randomUUID()
    const expiringOperationId = randomUUID()
    const boundAuditRequestId = `${requestPrefix}-bound-json`
    const service = createAdminInsightsService(
      createPostgresAdminInsightsStore(sql, `insight-fingerprint-${suffix}`),
    )
    const boundary = new Date('2040-01-15T00:00:00.000Z')

    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values
          (${userId}, ${`${userId}@example.invalid`}, 'Insight fixture', true),
          (${otherUserId}, ${`${otherUserId}@example.invalid`}, 'Other insight fixture', true)
      `
      await sql`
        insert into usage_ledger (user_id, kind, amount, source, request_id, period_key)
        values
          (${userId}, 'llm_tokens', 5, 'adjustment', ${`${requestPrefix}-positive`}, '2040-01'),
          (${userId}, 'llm_tokens', -2, 'adjustment', ${`${requestPrefix}-negative`}, '2040-01'),
          (${otherUserId}, 'llm_tokens', 100, 'adjustment', ${`${requestPrefix}-other`}, '2040-01')
      `
      await createPostgresAuditLogStore(sql).record({
        userId,
        requestId: boundAuditRequestId,
        action: 'test.audit.bound_json',
        metadata: { status: 503, durationMs: 17 },
      })
      const boundAudit = await sql<
        { metadata_type: string; status: string | null; duration_ms: string | null }[]
      >`
        select
          jsonb_typeof(metadata_json) as metadata_type,
          metadata_json->>'status' as status,
          metadata_json->>'durationMs' as duration_ms
        from audit_log
        where request_id = ${boundAuditRequestId}
      `
      expect(boundAudit).toEqual([{ metadata_type: 'object', status: '503', duration_ms: '17' }])
      await sql`
        insert into audit_log (id, user_id, request_id, action, metadata_json, created_at)
        values
          (
            ${auditNewId}, ${userId}, ${`${requestPrefix}-new`}, 'test.audit.new',
            '{"status":200}'::jsonb, '2040-01-01T00:00:00.000999Z'::timestamptz
          ),
          (
            ${auditOldId}, ${userId}, ${`${requestPrefix}-old`}, 'test.audit.old',
            '{"status":200}'::jsonb, '2040-01-01T00:00:00.000111Z'::timestamptz
          ),
          (
            ${auditEndId}, ${userId}, ${`boundary-end-${suffix}`}, 'test.boundary.end',
            '{"status":500}'::jsonb, '2040-02-01T00:00:00.000000Z'::timestamptz
          )
      `
      await sql`
        insert into quota_operation (
          id, user_id, idempotency_key, payload_hash, kind, source, period_key,
          request_id, reserved_amount, status, lease_token, finalized_lease_token,
          lease_expires_at, created_at, updated_at
        )
        values
          (
            ${operationNewId}, ${userId}, ${`op-new-${suffix}`}, ${'a'.repeat(64)},
            'llm_tokens', 'proxy_llm', '2040-01', ${`${requestPrefix}-op-new`}, 1,
            'released', null, 'released-new', null,
            '2040-01-02T00:00:00.000999Z'::timestamptz,
            '2040-01-02T00:00:00.000999Z'::timestamptz
          ),
          (
            ${operationOldId}, ${userId}, ${`op-old-${suffix}`}, ${'b'.repeat(64)},
            'llm_tokens', 'proxy_llm', '2040-01', ${`${requestPrefix}-op-old`}, 1,
            'released', null, 'released-old', null,
            '2040-01-02T00:00:00.000111Z'::timestamptz,
            '2040-01-02T00:00:00.000111Z'::timestamptz
          ),
          (
            ${expiringOperationId}, ${userId}, ${`op-expiry-${suffix}`}, ${'c'.repeat(64)},
            'ocr_images', 'proxy_ocr', '2040-01', ${`${requestPrefix}-expiry`}, 1,
            'reserved', 'active-lease', null, ${boundary.toISOString()},
            '2040-01-03T00:00:00.000000Z'::timestamptz,
            '2040-01-03T00:00:00.000000Z'::timestamptz
          )
      `

      const firstAudit = await service.listAudit({
        cursor: null,
        limit: 1,
        query: requestPrefix,
        userId,
        minimumStatus: null,
      })
      if (!firstAudit.nextCursor) throw new Error('expected an audit cursor')
      const decodedAuditCursor = JSON.parse(
        Buffer.from(firstAudit.nextCursor, 'base64url').toString('utf8'),
      ) as { createdAt: string; id: string }
      expect(decodedAuditCursor).toEqual({
        createdAt: '2040-01-01T00:00:00.000999Z',
        id: auditNewId,
      })
      const rawAfterCursor = await sql<{ id: string }[]>`
        select id
        from audit_log
        where user_id = ${userId}
          and id in (${auditNewId}, ${auditOldId})
          and (
            created_at < ${decodedAuditCursor.createdAt}::text::timestamptz
            or (
              created_at = ${decodedAuditCursor.createdAt}::text::timestamptz
              and id < ${decodedAuditCursor.id}
            )
          )
        order by created_at desc, id desc
      `
      expect(rawAfterCursor.map((row) => row.id)).toEqual([auditOldId])
      const secondAudit = await service.listAudit({
        cursor: firstAudit.nextCursor,
        limit: 1,
        query: requestPrefix,
        userId,
        minimumStatus: null,
      })
      expect(firstAudit.items[0]).toMatchObject({
        id: auditNewId,
        createdAt: '2040-01-01T00:00:00.000999Z',
      })
      expect(secondAudit.items[0]).toMatchObject({
        id: auditOldId,
        createdAt: '2040-01-01T00:00:00.000111Z',
      })

      const firstOperation = await service.listQuotaOperations({
        cursor: null,
        limit: 1,
        userId,
        periodKey: '2040-01',
        kind: 'llm_tokens',
        status: 'released',
      })
      const secondOperation = await service.listQuotaOperations({
        cursor: firstOperation.nextCursor,
        limit: 1,
        userId,
        periodKey: '2040-01',
        kind: 'llm_tokens',
        status: 'released',
      })
      expect(firstOperation.items[0]).toMatchObject({
        id: operationNewId,
        userEmail: `${userId}@example.invalid`,
        userName: 'Insight fixture',
        createdAt: '2040-01-02T00:00:00.000999Z',
      })
      expect(secondOperation.items[0]).toMatchObject({
        id: operationOldId,
        createdAt: '2040-01-02T00:00:00.000111Z',
      })
      expect(
        new Set([...firstOperation.items, ...secondOperation.items].map((row) => row.id)),
      ).toEqual(new Set([operationNewId, operationOldId]))

      const overview = await service.getOverview({
        periodKey: '2040-01',
        userId,
        now: boundary,
      })
      expect(overview).toMatchObject({
        auditedRequests: 2,
        failedRequests: 0,
        expiredReservations: 1,
        operations: { reserved: 1, completed: 0, released: 2 },
        usage: { llm_tokens: 3 },
        adjustments: 2,
      })
      const boundAuditPage = await service.listAudit({
        cursor: null,
        limit: 1,
        query: boundAuditRequestId,
        userId,
        minimumStatus: 500,
      })
      expect(boundAuditPage.items[0]).toMatchObject({
        requestId: boundAuditRequestId,
        status: 503,
        durationMs: 17,
      })
    } finally {
      await sql`
        delete from audit_log
        where id in (${auditNewId}, ${auditOldId}, ${auditEndId})
          or request_id = ${boundAuditRequestId}
      `.catch(() => undefined)
      await sql`delete from "user" where id in (${userId}, ${otherUserId})`.catch(() => undefined)
      await sql.end()
    }
  },
)
