import { Buffer } from 'node:buffer'
import type { QuotaKind } from '../quota/quota-service.js'

export type AdminQuotaOperationStatus = 'reserved' | 'completed' | 'released'

export interface AdminInsightCursor {
  createdAt: string
  id: string
}

export interface AdminAuditEntry {
  id: string
  userId: string | null
  requestId: string
  action: string
  status: number | null
  durationMs: number | null
  createdAt: string
}

export interface AdminQuotaOperationEntry {
  id: string
  userId: string
  userEmail: string
  userName: string | null
  kind: QuotaKind
  source: string
  periodKey: string
  requestId: string
  reservedAmount: number
  actualAmount: number | null
  status: AdminQuotaOperationStatus
  leaseExpiresAt: string | null
  responseStatus: number | null
  responseCached: boolean
  ledgerNetAmount: number
  ledgerEventCount: number
  reconciled: boolean
  createdAt: string
  updatedAt: string
}

export interface AdminUserSessionEntry {
  id: string
  userId: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  active: boolean
  ipFingerprint: string | null
  userAgentFingerprint: string | null
}

export interface AdminOperationsOverview {
  periodKey: string
  subject: { id: string; email: string; name: string | null } | null
  usage: Record<QuotaKind, number>
  operations: Record<AdminQuotaOperationStatus, number>
  expiredReservations: number
  unreconciledOperations: number
  adjustments: number
  auditedRequests: number
  failedRequests: number
  latestAuditAt: string | null
}

export interface AdminAuditFilter {
  cursor: AdminInsightCursor | null
  limit: number
  query: string | null
  userId: string | null
  minimumStatus: number | null
}

export interface AdminQuotaOperationFilter {
  cursor: AdminInsightCursor | null
  limit: number
  userId: string | null
  periodKey: string | null
  kind: QuotaKind | null
  status: AdminQuotaOperationStatus | null
}

export interface AdminInsightsStore {
  getOverview(input: {
    periodKey: string
    userId: string | null
    now: Date
  }): Promise<AdminOperationsOverview>
  listAudit(input: AdminAuditFilter): Promise<AdminAuditEntry[]>
  listQuotaOperations(input: AdminQuotaOperationFilter): Promise<AdminQuotaOperationEntry[]>
  listUserSessions(input: {
    userId: string
    now: Date
    includeExpired: boolean
    limit: number
  }): Promise<AdminUserSessionEntry[]>
}

export interface AdminInsightPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface AdminInsightsService {
  getOverview(input: {
    periodKey: string
    userId?: string | null
    now?: Date
  }): Promise<AdminOperationsOverview>
  listAudit(
    input: Omit<AdminAuditFilter, 'cursor'> & { cursor: string | null },
  ): Promise<AdminInsightPage<AdminAuditEntry>>
  listQuotaOperations(
    input: Omit<AdminQuotaOperationFilter, 'cursor'> & { cursor: string | null },
  ): Promise<AdminInsightPage<AdminQuotaOperationEntry>>
  listUserSessions(input: {
    userId: string
    now?: Date
    includeExpired: boolean
    limit: number
  }): Promise<AdminUserSessionEntry[]>
}

export function createAdminInsightsService(store: AdminInsightsStore): AdminInsightsService {
  return {
    getOverview(input) {
      return store.getOverview({
        periodKey: input.periodKey,
        userId: input.userId ?? null,
        now: input.now ?? new Date(),
      })
    },
    async listAudit(input) {
      return page(
        await store.listAudit({ ...input, cursor: decodeAdminInsightCursor(input.cursor) }),
        input.limit,
      )
    },
    async listQuotaOperations(input) {
      return page(
        await store.listQuotaOperations({
          ...input,
          cursor: decodeAdminInsightCursor(input.cursor),
        }),
        input.limit,
      )
    },
    listUserSessions(input) {
      return store.listUserSessions({ ...input, now: input.now ?? new Date() })
    },
  }
}

export function createMemoryAdminInsightsStore(
  fixture: Partial<{
    overview: AdminOperationsOverview
    subjects: { id: string; email: string; name: string | null }[]
    audit: AdminAuditEntry[]
    operations: AdminQuotaOperationEntry[]
    sessions: AdminUserSessionEntry[]
  }> = {},
): AdminInsightsStore {
  return {
    async getOverview(input) {
      const emptyOverview: AdminOperationsOverview = {
        periodKey: input.periodKey,
        subject: null,
        usage: { stt_seconds: 0, llm_tokens: 0, ocr_images: 0, tts_chars: 0 },
        operations: { reserved: 0, completed: 0, released: 0 },
        expiredReservations: 0,
        unreconciledOperations: 0,
        adjustments: 0,
        auditedRequests: 0,
        failedRequests: 0,
        latestAuditAt: null,
      }
      const overview = fixture.overview ?? emptyOverview
      if (!input.userId) return { ...overview, periodKey: input.periodKey, subject: null }
      const operation = (fixture.operations ?? []).find((item) => item.userId === input.userId)
      const subject =
        (fixture.subjects ?? []).find((item) => item.id === input.userId) ??
        (operation
          ? { id: operation.userId, email: operation.userEmail, name: operation.userName }
          : null)
      return {
        ...(operation ? overview : emptyOverview),
        periodKey: input.periodKey,
        subject,
      }
    },
    async listAudit(input) {
      return filterAfterCursor(fixture.audit ?? [], input.cursor).slice(0, input.limit + 1)
    },
    async listQuotaOperations(input) {
      return filterAfterCursor(
        (fixture.operations ?? []).filter(
          (operation) =>
            (!input.userId || operation.userId === input.userId) &&
            (!input.periodKey || operation.periodKey === input.periodKey) &&
            (!input.kind || operation.kind === input.kind) &&
            (!input.status || operation.status === input.status),
        ),
        input.cursor,
      ).slice(0, input.limit + 1)
    },
    async listUserSessions(input) {
      return (fixture.sessions ?? [])
        .filter(
          (session) => session.userId === input.userId && (input.includeExpired || session.active),
        )
        .slice(0, input.limit)
    },
  }
}

function page<T extends { id: string; createdAt: string }>(
  rows: T[],
  limit: number,
): AdminInsightPage<T> {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeAdminInsightCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  }
}

function filterAfterCursor<T extends { id: string; createdAt: string }>(
  rows: T[],
  cursor: AdminInsightCursor | null,
): T[] {
  if (!cursor) return rows
  return rows.filter(
    (row) =>
      row.createdAt < cursor.createdAt ||
      (row.createdAt === cursor.createdAt && row.id < cursor.id),
  )
}

function encodeAdminInsightCursor(cursor: AdminInsightCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeAdminInsightCursor(value: string | null): AdminInsightCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<AdminInsightCursor>
    if (
      typeof parsed.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string' ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error('invalid cursor')
    }
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    throw new InvalidAdminInsightCursorError()
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class InvalidAdminInsightCursorError extends Error {
  constructor() {
    super('Invalid admin insight cursor')
    this.name = 'InvalidAdminInsightCursorError'
  }
}
