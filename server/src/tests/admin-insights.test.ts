import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import {
  createAdminInsightsService,
  createMemoryAdminInsightsStore,
  type AdminAuditEntry,
  type AdminInsightsStore,
  type AdminQuotaOperationEntry,
} from '../services/admin/admin-insights-service.js'
import {
  createAdminService,
  createMemoryAdminStore,
  type AdminRole,
} from '../services/admin/admin-service.js'
import type { AuthenticatedUser } from '../types.js'
import { testEnv, testServices } from './helpers.js'

const operator: AuthenticatedUser = {
  id: 'admin-insights-operator',
  email: 'operator@example.com',
  name: 'Operator',
  plan: 'pro',
  subscriptionEnd: null,
}

const auditNewId = '11111111-1111-4111-8111-111111111111'
const auditOldId = '22222222-2222-4222-8222-222222222222'
const operationNewId = '33333333-3333-4333-8333-333333333333'

describe('admin operational insight routes', () => {
  it('returns a redacted operational overview to viewers', async () => {
    const overviewInputs: Parameters<AdminInsightsStore['getOverview']>[0][] = []
    const app = insightApp('viewer', overviewInputs)
    const response = await app.fetch(adminRequest('/echo-api/admin/operations-overview'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.overview).toMatchObject({
      periodKey: expect.stringMatching(/^\d{4}-\d{2}$/),
      expiredReservations: 2,
      unreconciledOperations: 1,
      failedRequests: 3,
    })
    expect(overviewInputs).toHaveLength(1)
    expect(overviewInputs[0]).toMatchObject({ userId: null })
    expect(JSON.stringify(body)).not.toContain('metadata')
    expect(body.overview).not.toHaveProperty('subject')
  })

  it('keeps account usage behind usage:read and forwards one account snapshot', async () => {
    const overviewInputs: Parameters<AdminInsightsStore['getOverview']>[0][] = []
    const app = insightApp('operator', overviewInputs)
    const response = await app.fetch(
      adminRequest('/echo-api/admin/usage-overview?periodKey=2026-07&userId=target-user'),
    )

    expect(response.status).toBe(200)
    expect(overviewInputs).toHaveLength(1)
    expect(overviewInputs[0]).toMatchObject({ periodKey: '2026-07', userId: 'target-user' })
  })

  it('distinguishes an existing zero-usage account from a deleted account', async () => {
    const app = insightApp('operator')
    const existing = await app.fetch(
      adminRequest('/echo-api/admin/usage-overview?periodKey=2026-07&userId=zero-user'),
    )
    const missing = await app.fetch(
      adminRequest('/echo-api/admin/usage-overview?periodKey=2026-07&userId=missing-user'),
    )

    expect(existing.status).toBe(200)
    expect((await existing.json()).overview).toMatchObject({
      subject: { id: 'zero-user', email: 'zero@example.com', name: 'Zero User' },
      usage: { stt_seconds: 0, llm_tokens: 0, ocr_images: 0, tts_chars: 0 },
      operations: { reserved: 0, completed: 0, released: 0 },
    })
    expect(missing.status).toBe(404)
  })

  it('cursor-paginates audit entries and rejects malformed cursors', async () => {
    const app = insightApp('operator')
    const first = await app.fetch(adminRequest('/echo-api/admin/audit?limit=1'))
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    expect(firstBody.items).toHaveLength(1)
    expect(firstBody.items[0].requestId).toBe('request-new')
    expect(firstBody.nextCursor).toEqual(expect.any(String))

    const second = await app.fetch(
      adminRequest(`/echo-api/admin/audit?limit=1&cursor=${firstBody.nextCursor}`),
    )
    expect(second.status).toBe(200)
    const secondBody = await second.json()
    expect(secondBody.items[0].requestId).toBe('request-old')
    expect(secondBody.nextCursor).toBeNull()

    expect(
      (await app.fetch(adminRequest('/echo-api/admin/audit?cursor=not-a-cursor'))).status,
    ).toBe(422)
  })

  it('shows quota reconciliation facts without response bodies or idempotency secrets', async () => {
    const app = insightApp('operator')
    const response = await app.fetch(adminRequest('/echo-api/admin/quota-operations'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items[0]).toMatchObject({
      id: operationNewId,
      userEmail: 'target@example.com',
      userName: 'Target User',
      status: 'completed',
      ledgerNetAmount: 4,
      reconciled: true,
      responseCached: true,
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('idempotencyKey')
    expect(serialized).not.toContain('responseBody')
    expect(serialized).not.toContain('payloadHash')
    expect(serialized).not.toContain('metadata')

    const otherAccount = await app.fetch(
      adminRequest('/echo-api/admin/quota-operations?userId=other-user&periodKey=2026-07'),
    )
    expect(otherAccount.status).toBe(200)
    expect((await otherAccount.json()).items).toEqual([])
  })

  it('lists only the selected user sessions and shortens stored fingerprints', async () => {
    const app = insightApp('operator')
    const response = await app.fetch(
      adminRequest('/echo-api/admin/user-sessions?userId=target-user'),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]).toMatchObject({
      userId: 'target-user',
      active: true,
      ipFingerprint: '12345678…cdef',
    })
    expect(JSON.stringify(body)).not.toContain('1234567890abcdef')
  })
})

function insightApp(
  role: AdminRole,
  overviewInputs: Parameters<AdminInsightsStore['getOverview']>[0][] = [],
) {
  const env = testEnv()
  const adminStore = createMemoryAdminStore([
    {
      userId: operator.id,
      role,
      status: 'active',
      createdBy: null,
      createdAt: null,
      updatedAt: null,
    },
  ])
  const audit: AdminAuditEntry[] = [
    {
      id: auditNewId,
      userId: operator.id,
      requestId: 'request-new',
      action: 'POST /admin/quota-adjustments',
      status: 200,
      durationMs: 12,
      createdAt: '2026-07-30T12:00:00.000Z',
    },
    {
      id: auditOldId,
      userId: operator.id,
      requestId: 'request-old',
      action: 'GET /admin/users',
      status: 500,
      durationMs: 30,
      createdAt: '2026-07-30T11:00:00.000Z',
    },
  ]
  const operations: AdminQuotaOperationEntry[] = [
    {
      id: operationNewId,
      userId: 'target-user',
      userEmail: 'target@example.com',
      userName: 'Target User',
      kind: 'ocr_images',
      source: 'proxy_ocr',
      periodKey: '2026-07',
      requestId: 'quota-request',
      reservedAmount: 10,
      actualAmount: 4,
      status: 'completed',
      leaseExpiresAt: null,
      responseStatus: 200,
      responseCached: true,
      ledgerNetAmount: 4,
      ledgerEventCount: 2,
      reconciled: true,
      createdAt: '2026-07-30T12:00:00.000Z',
      updatedAt: '2026-07-30T12:00:01.000Z',
    },
  ]
  const memoryInsights = createMemoryAdminInsightsStore({
    subjects: [
      { id: 'target-user', email: 'target@example.com', name: 'Target User' },
      { id: 'zero-user', email: 'zero@example.com', name: 'Zero User' },
    ],
    overview: {
      periodKey: '2026-07',
      subject: null,
      usage: { stt_seconds: 1, llm_tokens: 2, ocr_images: 3, tts_chars: 4 },
      operations: { reserved: 1, completed: 3, released: 1 },
      expiredReservations: 2,
      unreconciledOperations: 1,
      adjustments: 1,
      auditedRequests: 10,
      failedRequests: 3,
      latestAuditAt: '2026-07-30T12:00:00.000Z',
    },
    audit,
    operations,
    sessions: [
      {
        id: 'session-target',
        userId: 'target-user',
        expiresAt: '2099-01-01T00:00:00.000Z',
        createdAt: '2026-07-30T10:00:00.000Z',
        updatedAt: '2026-07-30T11:00:00.000Z',
        active: true,
        ipFingerprint: '12345678…cdef',
        userAgentFingerprint: 'abcdef01…6789',
      },
      {
        id: 'session-other',
        userId: 'other-user',
        expiresAt: '2099-01-01T00:00:00.000Z',
        createdAt: '2026-07-30T10:00:00.000Z',
        updatedAt: '2026-07-30T11:00:00.000Z',
        active: true,
        ipFingerprint: null,
        userAgentFingerprint: null,
      },
    ],
  })
  const services = {
    ...testServices(env),
    admin: createAdminService(adminStore),
    adminInsights: createAdminInsightsService({
      ...memoryInsights,
      getOverview(input) {
        overviewInputs.push(input)
        return memoryInsights.getOverview(input)
      },
    }),
  }
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({ 'admin-insights-token': operator }),
    services,
  })
}

function adminRequest(path: string): Request {
  return new Request(`http://localhost:8787${path}`, {
    headers: { authorization: 'Bearer admin-insights-token' },
  })
}
