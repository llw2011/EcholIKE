import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { createPostgresAdminStore, createPostgresConnection } from '../db/client.js'
import { ADMIN_ACTOR_HEADER } from '../middleware/admin-origin.js'
import {
  AdminAuthorizationChangedError,
  AdminIdempotencyConflictError,
  createAdminService,
  createMemoryAdminStore,
  LastActiveOwnerError,
  type AdminAccount,
} from '../services/admin/admin-service.js'
import type { AuthenticatedUser } from '../types.js'
import { request, testEnv, testServices } from './helpers.js'

const ownerUser: AuthenticatedUser = {
  id: 'admin-owner-a',
  email: 'owner-a@example.com',
  name: 'Owner A',
  plan: 'pro',
  subscriptionEnd: null,
}

const activeOwner = (userId: string): AdminAccount => ({
  userId,
  role: 'owner',
  status: 'active',
  createdBy: null,
  createdAt: null,
  updatedAt: null,
})

describe('admin control operation atomicity', () => {
  it('declares durable admin operation and ledger linkage in migration order', () => {
    const migration = readFileSync(
      new URL('../db/migrations/0009_admin_control_atomicity.sql', import.meta.url),
      'utf8',
    )
    const journal = JSON.parse(
      readFileSync(new URL('../db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries?: Array<{ idx?: number; tag?: string }> }

    expect(migration).toContain('CREATE TABLE "admin_operation"')
    expect(migration).toContain('"admin_operation_actor_key_idx"')
    expect(migration).toContain('("actor_user_id", "kind", "idempotency_key")')
    expect(migration).toContain('"admin_operation_payload_hash_check"')
    expect(migration).toContain('"admin_operation_idempotency_key_check"')
    expect(migration).toContain('"admin_operation_id" uuid')
    expect(migration).toContain('"usage_ledger_admin_operation_metadata_check"')
    expect(migration).toContain('"usage_ledger_admin_operation_idx"')
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 9, tag: '0009_admin_control_atomicity' }),
    )
  })

  it('requires a stable idempotency key for quota adjustments', async () => {
    const { app } = adminAtomicityTestApp()

    const response = await app.fetch(quotaRequest({ amount: 25 }))

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ code: 'validation_failed' })
  })

  it('replays the same quota adjustment without duplicating ledger or audit facts', async () => {
    const { app, store } = adminAtomicityTestApp()
    const idempotencyKey = 'quota-adjustment-ack-loss-0001'

    const first = await app.fetch(quotaRequest({ amount: 25 }, idempotencyKey))
    const replay = await app.fetch(quotaRequest({ amount: 25 }, idempotencyKey))
    const firstBody = await first.json()
    const replayBody = await replay.json()

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(firstBody).toMatchObject({
      ok: true,
      userId: 'quota-target',
      amount: 25,
      usageBefore: 0,
      usageAfter: 25,
      replayed: false,
    })
    expect(replayBody).toMatchObject({
      ...firstBody,
      replayed: true,
    })
    expect(replayBody.operationId).toBe(firstBody.operationId)
    expect(store.quotaAdjustments).toHaveLength(1)
    expect(store.quotaControlAudits).toHaveLength(1)
    expect(store.quotaControlAudits[0]).toMatchObject({
      action: 'admin.quota.adjust',
      actorUserId: ownerUser.id,
      targetUserId: 'quota-target',
      usageBefore: 0,
      usageAfter: 25,
      operationId: firstBody.operationId,
    })
  })

  it('rejects reuse of a quota idempotency key for a different payload', async () => {
    const { app, store } = adminAtomicityTestApp()
    const idempotencyKey = 'quota-adjustment-conflict-0001'

    const first = await app.fetch(quotaRequest({ amount: 25 }, idempotencyKey))
    const conflict = await app.fetch(quotaRequest({ amount: 26 }, idempotencyKey))

    expect(first.status).toBe(200)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ code: 'idempotency_conflict' })
    expect(store.quotaAdjustments).toHaveLength(1)
    expect(store.quotaControlAudits).toHaveLength(1)
  })

  it('rejects a stale page actor before quota or control-audit mutation', async () => {
    const { app, store } = adminAtomicityTestApp()
    const response = await app.fetch(
      quotaRequest({ amount: 25 }, 'quota-adjustment-stale-actor-0001', 'stale-admin-user'),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'admin_actor_changed' })
    expect(store.quotaAdjustments).toHaveLength(0)
    expect(store.quotaControlAudits).toHaveLength(0)
  })

  it('treats the operator reason as part of the idempotent quota operation', async () => {
    const { app, store } = adminAtomicityTestApp()
    const idempotencyKey = 'quota-adjustment-reason-conflict-0001'

    expect(
      (await app.fetch(quotaRequest({ amount: 25, reason: '支持工单 A' }, idempotencyKey))).status,
    ).toBe(200)
    const conflict = await app.fetch(
      quotaRequest({ amount: 25, reason: '支持工单 B' }, idempotencyKey),
    )

    expect(conflict.status).toBe(409)
    expect(store.quotaAdjustments).toHaveLength(1)
    expect(store.quotaControlAudits[0]?.reason).toBe('支持工单 A')
  })

  it('prevents demoting the last active owner', async () => {
    const store = createMemoryAdminStore([activeOwner(ownerUser.id)])

    await expect(
      store.setAdminAccount({
        userId: ownerUser.id,
        role: 'admin',
        status: 'active',
        actorUserId: ownerUser.id,
        requestId: 'last-owner-demote',
      }),
    ).rejects.toBeInstanceOf(LastActiveOwnerError)
    expect(store.accounts.get(ownerUser.id)).toMatchObject({ role: 'owner', status: 'active' })
  })

  it('prevents an active administrator from disabling their own account', async () => {
    const adminUserId = 'admin-self-disable'
    const store = createMemoryAdminStore([
      activeOwner(ownerUser.id),
      {
        ...activeOwner(adminUserId),
        role: 'admin',
      },
    ])

    await expect(
      store.setAdminAccount({
        userId: adminUserId,
        role: 'admin',
        status: 'disabled',
        actorUserId: adminUserId,
        requestId: 'self-disable',
      }),
    ).rejects.toBeInstanceOf(AdminAuthorizationChangedError)
    expect(store.accounts.get(adminUserId)).toMatchObject({ role: 'admin', status: 'active' })
  })

  it('returns a conflict instead of applying a last-owner demotion', async () => {
    const { app, store } = adminAtomicityTestApp()

    const response = await app.fetch(
      request('/echo-api/admin/admin-accounts', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-owner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: ownerUser.id,
          role: 'admin',
          status: 'active',
        }),
      }),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'validation_failed' })
    expect(store.accounts.get(ownerUser.id)).toMatchObject({ role: 'owner', status: 'active' })
  })

  it('serializes concurrent owner demotions so one active owner always remains', async () => {
    const secondOwnerId = 'admin-owner-b'
    const store = createMemoryAdminStore([activeOwner(ownerUser.id), activeOwner(secondOwnerId)])

    const outcomes = await Promise.allSettled([
      store.setAdminAccount({
        userId: ownerUser.id,
        role: 'admin',
        status: 'active',
        actorUserId: secondOwnerId,
        requestId: 'concurrent-demote-owner-a',
      }),
      store.setAdminAccount({
        userId: secondOwnerId,
        role: 'admin',
        status: 'active',
        actorUserId: ownerUser.id,
        requestId: 'concurrent-demote-owner-b',
      }),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(
      [...store.accounts.values()].filter(
        (account) => account.role === 'owner' && account.status === 'active',
      ),
    ).toHaveLength(1)
  })
})

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'enforces admin quota and last-owner atomicity on isolated PostgreSQL',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

    const sql = createPostgresConnection(databaseUrl)
    const suffix = randomUUID()
    const identifierSuffix = suffix.replaceAll('-', '')
    const ownerA = `admin-owner-a-${suffix}`
    const ownerB = `admin-owner-b-${suffix}`
    const quotaTarget = `admin-quota-target-${suffix}`
    const idempotencyKey = `admin-quota-${suffix}`
    const failingKey = `admin-quota-failure-${suffix}`
    const failingRequestId = `admin-quota-audit-failure-${suffix}`
    const triggerName = `fail_admin_audit_${identifierSuffix}`
    const functionName = `fail_admin_audit_fn_${identifierSuffix}`
    const store = createPostgresAdminStore(sql)
    const service = createAdminService(store)

    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values
          (${ownerA}, ${`${ownerA}@example.invalid`}, 'Owner A', true),
          (${ownerB}, ${`${ownerB}@example.invalid`}, 'Owner B', true),
          (${quotaTarget}, ${`${quotaTarget}@example.invalid`}, 'Quota Target', true)
      `
      await sql`
        insert into admin_account (user_id, role, status)
        values
          (${ownerA}, 'owner', 'active'),
          (${ownerB}, 'owner', 'active')
      `

      const demotions = await Promise.allSettled([
        store.setAdminAccount({
          userId: ownerA,
          role: 'admin',
          status: 'active',
          actorUserId: ownerB,
          requestId: `postgres-demote-owner-a-${suffix}`,
        }),
        store.setAdminAccount({
          userId: ownerB,
          role: 'admin',
          status: 'active',
          actorUserId: ownerA,
          requestId: `postgres-demote-owner-b-${suffix}`,
        }),
      ])
      expect(demotions.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(demotions.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
      const ownerRows = await sql<{ count: number | string }[]>`
        select count(*)::int as count
        from admin_account
        where role = 'owner' and status = 'active'
          and user_id in (${ownerA}, ${ownerB})
      `
      expect(Number(ownerRows[0]?.count)).toBe(1)

      const quotaResults = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          service.adjustQuota({
            userId: quotaTarget,
            kind: 'llm_tokens',
            amount: 17,
            periodKey: '2026-07',
            requestId: `admin-quota-request-${suffix}-${index}`,
            actorUserId: ownerA,
            idempotencyKey,
            reason: '并发配额校正',
          }),
        ),
      )
      expect(quotaResults.filter((result) => !result.replayed)).toHaveLength(1)
      expect(quotaResults.filter((result) => result.replayed)).toHaveLength(11)
      expect(new Set(quotaResults.map((result) => result.operationId)).size).toBe(1)
      expect(quotaResults[0]).toMatchObject({ usageBefore: 0, usageAfter: 17 })

      const operationRows = await sql<{ id: string; payload_hash: string; result_json: unknown }[]>`
        select id, payload_hash, result_json
        from admin_operation
        where actor_user_id = ${ownerA}
          and idempotency_key = ${idempotencyKey}
      `
      expect(operationRows).toHaveLength(1)
      const operation = operationRows[0]
      if (!operation) throw new Error('admin quota operation was not persisted')
      expect(operation.payload_hash).toMatch(/^[a-f0-9]{64}$/)
      const ledgerRows = await sql<{ count: number | string; total: number | string }[]>`
        select count(*)::int as count, coalesce(sum(amount), 0)::int as total
        from usage_ledger
        where admin_operation_id = ${operation.id}
      `
      expect(ledgerRows[0]).toMatchObject({ count: 1, total: 17 })
      const auditRows = await sql<
        { count: number | string; before: string | null; after: string | null }[]
      >`
        select
          count(*)::int as count,
          max(metadata_json ->> 'usageBefore') as before,
          max(metadata_json ->> 'usageAfter') as after
        from audit_log
        where action = 'admin.quota.adjust'
          and metadata_json ->> 'operationId' = ${operation.id}
      `
      expect(auditRows[0]).toMatchObject({ count: 1, before: '0', after: '17' })

      await expect(
        service.adjustQuota({
          userId: quotaTarget,
          kind: 'llm_tokens',
          amount: 18,
          periodKey: '2026-07',
          requestId: `admin-quota-conflict-${suffix}`,
          actorUserId: ownerA,
          idempotencyKey,
          reason: '并发配额校正',
        }),
      ).rejects.toBeInstanceOf(AdminIdempotencyConflictError)

      await sql.unsafe(`
        create function "${functionName}"() returns trigger
        language plpgsql as $$
        begin
          if new.request_id = '${failingRequestId}' then
            raise exception 'forced atomic audit failure';
          end if;
          return new;
        end
        $$
      `)
      await sql.unsafe(`
        create trigger "${triggerName}"
        before insert on audit_log
        for each row execute function "${functionName}"()
      `)

      await expect(
        service.adjustQuota({
          userId: quotaTarget,
          kind: 'tts_chars',
          amount: 9,
          periodKey: '2026-07',
          requestId: failingRequestId,
          actorUserId: ownerA,
          idempotencyKey: failingKey,
          reason: '审计失败回滚测试',
        }),
      ).rejects.toThrow('forced atomic audit failure')
      const rollbackRows = await sql<{ operations: number | string; ledger: number | string }[]>`
        select
          (select count(*) from admin_operation where idempotency_key = ${failingKey})::int
            as operations,
          (select count(*) from usage_ledger where request_id = ${failingRequestId})::int
            as ledger
      `
      expect(rollbackRows[0]).toMatchObject({ operations: 0, ledger: 0 })
    } finally {
      await sql
        .unsafe(`drop trigger if exists "${triggerName}" on audit_log`)
        .catch(() => undefined)
      await sql.unsafe(`drop function if exists "${functionName}"()`).catch(() => undefined)
      await sql`
        delete from usage_ledger
        where user_id in (${ownerA}, ${ownerB}, ${quotaTarget})
      `.catch(() => undefined)
      await sql`
        delete from admin_operation
        where actor_user_id in (${ownerA}, ${ownerB})
      `.catch(() => undefined)
      await sql`
        delete from audit_log
        where user_id in (${ownerA}, ${ownerB})
      `.catch(() => undefined)
      await sql`
        delete from admin_account
        where user_id in (${ownerA}, ${ownerB})
      `.catch(() => undefined)
      await sql`
        delete from "user"
        where id in (${ownerA}, ${ownerB}, ${quotaTarget})
      `.catch(() => undefined)
      await sql.end()
    }
  },
)

function adminAtomicityTestApp() {
  const env = testEnv()
  const store = createMemoryAdminStore([activeOwner(ownerUser.id)])
  const services = testServices(env)
  services.admin = createAdminService(store)
  const app = createApp({
    env,
    services,
    sessionVerifier: createStaticSessionVerifier({
      'valid-owner-token': ownerUser,
    }),
  })
  return { app, store }
}

function quotaRequest(
  overrides: Partial<{ amount: number; periodKey: string; reason: string }> = {},
  idempotencyKey?: string,
  actorUserId?: string,
): Request {
  const headers: Record<string, string> = {
    authorization: 'Bearer valid-owner-token',
    'content-type': 'application/json',
  }
  if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey
  if (actorUserId) headers[ADMIN_ACTOR_HEADER] = actorUserId
  return request('/echo-api/admin/quota-adjustments', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      userId: 'quota-target',
      kind: 'llm_tokens',
      mode: 'consume',
      amount: overrides.amount ?? 25,
      periodKey: overrides.periodKey ?? '2026-07',
      reason: overrides.reason ?? '客户支持配额校正',
    }),
  })
}
