import { createHmac } from 'node:crypto'
import type postgres from 'postgres'
import type {
  AdminAuditEntry,
  AdminInsightsStore,
  AdminOperationsOverview,
  AdminQuotaOperationEntry,
  AdminUserSessionEntry,
} from '../services/admin/admin-insights-service.js'
import type { QuotaKind } from '../services/quota/quota-service.js'

const QUOTA_KINDS: QuotaKind[] = ['stt_seconds', 'llm_tokens', 'ocr_images', 'tts_chars']

export function createPostgresAdminInsightsStore(
  client: postgres.Sql,
  fingerprintSecret: string,
): AdminInsightsStore {
  return {
    async getOverview(input) {
      const period = utcPeriodBounds(input.periodKey)
      const rows = await client<
        {
          stt_seconds: number | string
          llm_tokens: number | string
          ocr_images: number | string
          tts_chars: number | string
          reserved_count: number | string
          completed_count: number | string
          released_count: number | string
          expired_reservations: number | string
          unreconciled_operations: number | string
          adjustment_count: number | string
          audited_requests: number | string
          failed_requests: number | string
          latest_audit_at: Date | string | null
          subject_id: string | null
          subject_email: string | null
          subject_name: string | null
        }[]
      >`
        with operation_rollup as (
          select
            operation.id,
            operation.status,
            operation.reserved_amount,
            operation.actual_amount,
            operation.lease_expires_at,
            coalesce(sum(ledger.amount), 0)::bigint as ledger_net
          from quota_operation operation
          left join usage_ledger ledger on ledger.operation_id = operation.id
          where operation.period_key = ${input.periodKey}
            and (${input.userId}::text is null or operation.user_id = ${input.userId})
          group by operation.id
        ), audit_period as (
          select metadata_json, created_at
          from audit_log
          where created_at >= ${period.start}::timestamptz
            and created_at < ${period.end}::timestamptz
            and (${input.userId}::text is null or user_id = ${input.userId})
        )
        select
          (select id from "user" where id = ${input.userId}) as subject_id,
          (select email from "user" where id = ${input.userId}) as subject_email,
          (select name from "user" where id = ${input.userId}) as subject_name,
          coalesce((select sum(amount) from usage_ledger where period_key = ${input.periodKey} and kind = 'stt_seconds' and (${input.userId}::text is null or user_id = ${input.userId})), 0)::bigint as stt_seconds,
          coalesce((select sum(amount) from usage_ledger where period_key = ${input.periodKey} and kind = 'llm_tokens' and (${input.userId}::text is null or user_id = ${input.userId})), 0)::bigint as llm_tokens,
          coalesce((select sum(amount) from usage_ledger where period_key = ${input.periodKey} and kind = 'ocr_images' and (${input.userId}::text is null or user_id = ${input.userId})), 0)::bigint as ocr_images,
          coalesce((select sum(amount) from usage_ledger where period_key = ${input.periodKey} and kind = 'tts_chars' and (${input.userId}::text is null or user_id = ${input.userId})), 0)::bigint as tts_chars,
          (select count(*) from operation_rollup where status = 'reserved')::int as reserved_count,
          (select count(*) from operation_rollup where status = 'completed')::int as completed_count,
          (select count(*) from operation_rollup where status = 'released')::int as released_count,
          (select count(*) from operation_rollup where status = 'reserved' and lease_expires_at <= ${input.now.toISOString()}::timestamptz)::int as expired_reservations,
          (
            select count(*) from operation_rollup
            where ledger_net <> case
              when status = 'completed' then coalesce(actual_amount, 0)
              when status = 'released' then 0
              else reserved_amount
            end
          )::int as unreconciled_operations,
          (
            select count(*) from usage_ledger
            where period_key = ${input.periodKey}
              and source = 'adjustment'
              and operation_id is null
              and (${input.userId}::text is null or user_id = ${input.userId})
          )::int as adjustment_count,
          (select count(*) from audit_period)::int as audited_requests,
          (
            select count(*) from audit_period
            where metadata_json->>'status' ~ '^[0-9]{3}$'
              and (metadata_json->>'status')::int >= 400
          )::int as failed_requests,
          (select max(created_at) from audit_period) as latest_audit_at
      `
      const row = rows[0]
      return {
        periodKey: input.periodKey,
        subject:
          row?.subject_id && row.subject_email
            ? { id: row.subject_id, email: row.subject_email, name: row.subject_name }
            : null,
        usage: {
          stt_seconds: toNumber(row?.stt_seconds),
          llm_tokens: toNumber(row?.llm_tokens),
          ocr_images: toNumber(row?.ocr_images),
          tts_chars: toNumber(row?.tts_chars),
        },
        operations: {
          reserved: toNumber(row?.reserved_count),
          completed: toNumber(row?.completed_count),
          released: toNumber(row?.released_count),
        },
        expiredReservations: toNumber(row?.expired_reservations),
        unreconciledOperations: toNumber(row?.unreconciled_operations),
        adjustments: toNumber(row?.adjustment_count),
        auditedRequests: toNumber(row?.audited_requests),
        failedRequests: toNumber(row?.failed_requests),
        latestAuditAt: timestampToIso(row?.latest_audit_at),
      } satisfies AdminOperationsOverview
    },

    async listAudit(input) {
      const cursorCreatedAt = input.cursor?.createdAt ?? null
      const cursorId = input.cursor?.id ?? null
      const rows = await client<
        {
          id: string
          user_id: string | null
          request_id: string
          action: string
          metadata_json: Record<string, unknown>
          status: number | string | null
          duration_ms: number | string | null
          created_at: Date | string
        }[]
      >`
        select
          id,
          user_id,
          request_id,
          action,
          metadata_json,
          case when metadata_json->>'status' ~ '^[0-9]{3}$' then (metadata_json->>'status')::int end as status,
          case when metadata_json->>'durationMs' ~ '^[0-9]+$' then (metadata_json->>'durationMs')::int end as duration_ms,
          to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
        from audit_log
        where (
          ${input.query}::text is null
          or position(lower(${input.query}::text) in lower(action)) > 0
          or position(lower(${input.query}::text) in lower(request_id)) > 0
        )
          and (${input.userId}::text is null or user_id = ${input.userId})
          and (
            ${input.minimumStatus}::int is null
            or (
              metadata_json->>'status' ~ '^[0-9]{3}$'
              and (metadata_json->>'status')::int >= ${input.minimumStatus}
            )
          )
          and (
            ${cursorCreatedAt}::text::timestamptz is null
            or created_at < ${cursorCreatedAt}::text::timestamptz
            or (
              created_at = ${cursorCreatedAt}::text::timestamptz
              and id < ${cursorId}
            )
          )
        order by created_at desc, id desc
        limit ${input.limit + 1}
      `
      return rows.map(
        (row) =>
          ({
            id: row.id,
            userId: row.user_id,
            requestId: row.request_id,
            action: row.action,
            status: nullableNumber(row.status),
            durationMs: nullableNumber(row.duration_ms),
            createdAt: requiredCursorTimestamp(row.created_at),
          }) satisfies AdminAuditEntry,
      )
    },

    async listQuotaOperations(input) {
      const cursorCreatedAt = input.cursor?.createdAt ?? null
      const cursorId = input.cursor?.id ?? null
      const rows = await client<
        {
          id: string
          user_id: string
          user_email: string
          user_name: string | null
          kind: QuotaKind
          source: string
          period_key: string
          request_id: string
          reserved_amount: number | string
          actual_amount: number | string | null
          status: AdminQuotaOperationEntry['status']
          lease_expires_at: Date | string | null
          response_status: number | string | null
          response_cached: boolean
          ledger_net_amount: number | string
          ledger_event_count: number | string
          created_at: Date | string
          updated_at: Date | string
        }[]
      >`
        select
          operation.id,
          operation.user_id,
          account_user.email as user_email,
          account_user.name as user_name,
          operation.kind,
          operation.source,
          operation.period_key,
          operation.request_id,
          operation.reserved_amount,
          operation.actual_amount,
          operation.status,
          operation.lease_expires_at,
          operation.response_status,
          (operation.response_body is not null) as response_cached,
          coalesce(sum(ledger.amount), 0)::bigint as ledger_net_amount,
          count(ledger.id)::int as ledger_event_count,
          to_char(operation.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
          operation.updated_at
        from quota_operation operation
        join "user" account_user on account_user.id = operation.user_id
        left join usage_ledger ledger on ledger.operation_id = operation.id
        where (${input.userId}::text is null or operation.user_id = ${input.userId})
          and (${input.periodKey}::text is null or operation.period_key = ${input.periodKey})
          and (${input.kind}::usage_ledger_kind is null or operation.kind = ${input.kind})
          and (${input.status}::quota_operation_status is null or operation.status = ${input.status})
          and (
            ${cursorCreatedAt}::text::timestamptz is null
            or operation.created_at < ${cursorCreatedAt}::text::timestamptz
            or (
              operation.created_at = ${cursorCreatedAt}::text::timestamptz
              and operation.id < ${cursorId}
            )
          )
        group by operation.id, account_user.email, account_user.name
        order by operation.created_at desc, operation.id desc
        limit ${input.limit + 1}
      `
      return rows.map((row) => {
        const reservedAmount = toNumber(row.reserved_amount)
        const actualAmount = nullableNumber(row.actual_amount)
        const ledgerNetAmount = toNumber(row.ledger_net_amount)
        const expectedAmount =
          row.status === 'completed'
            ? (actualAmount ?? 0)
            : row.status === 'released'
              ? 0
              : reservedAmount
        return {
          id: row.id,
          userId: row.user_id,
          userEmail: row.user_email,
          userName: row.user_name,
          kind: row.kind,
          source: row.source,
          periodKey: row.period_key,
          requestId: row.request_id,
          reservedAmount,
          actualAmount,
          status: row.status,
          leaseExpiresAt: timestampToIso(row.lease_expires_at),
          responseStatus: nullableNumber(row.response_status),
          responseCached: row.response_cached,
          ledgerNetAmount,
          ledgerEventCount: toNumber(row.ledger_event_count),
          reconciled: ledgerNetAmount === expectedAmount,
          createdAt: requiredCursorTimestamp(row.created_at),
          updatedAt: requiredTimestampToIso(row.updated_at),
        } satisfies AdminQuotaOperationEntry
      })
    },

    async listUserSessions(input) {
      const rows = await client<
        {
          id: string
          user_id: string
          expires_at: Date | string
          created_at: Date | string
          updated_at: Date | string
          ip_hash: string | null
          user_agent_hash: string | null
        }[]
      >`
        select id, user_id, expires_at, created_at, updated_at, ip_hash, user_agent_hash
        from session
        where user_id = ${input.userId}
          and (${input.includeExpired}::boolean or expires_at > ${input.now.toISOString()}::timestamptz)
        order by expires_at desc, id desc
        limit ${input.limit}
      `
      return rows.map(
        (row) =>
          ({
            id: row.id,
            userId: row.user_id,
            expiresAt: requiredTimestampToIso(row.expires_at),
            createdAt: requiredTimestampToIso(row.created_at),
            updatedAt: requiredTimestampToIso(row.updated_at),
            active: Date.parse(requiredTimestampToIso(row.expires_at)) > input.now.getTime(),
            ipFingerprint: fingerprint(row.ip_hash, fingerprintSecret),
            userAgentFingerprint: fingerprint(row.user_agent_hash, fingerprintSecret),
          }) satisfies AdminUserSessionEntry,
      )
    },
  }
}

function fingerprint(value: string | null, secret: string): string | null {
  if (!value) return null
  const digest = createHmac('sha256', secret).update(value, 'utf8').digest('hex')
  return `${digest.slice(0, 8)}…${digest.slice(-4)}`
}

function utcPeriodBounds(periodKey: string): { start: string; end: string } {
  const [yearText, monthText] = periodKey.split('-')
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1
  const start = new Date(Date.UTC(year, monthIndex, 1))
  const end = new Date(Date.UTC(year, monthIndex + 1, 1))
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || Number.isNaN(start.getTime())) {
    throw new Error('Admin insight period key is invalid')
  }
  return { start: start.toISOString(), end: end.toISOString() }
}

function toNumber(value: number | string | null | undefined): number {
  const number = Number(value ?? 0)
  if (!Number.isSafeInteger(number)) throw new Error('PostgreSQL integer exceeds safe range')
  return number
}

function nullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('PostgreSQL integer exceeds safe range')
  return number
}

function timestampToIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function requiredTimestampToIso(value: Date | string): string {
  const timestamp = timestampToIso(value)
  if (!timestamp) throw new Error('PostgreSQL returned an invalid timestamp')
  return timestamp
}

function requiredCursorTimestamp(value: Date | string): string {
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  ) {
    return value
  }
  return requiredTimestampToIso(value)
}

export function adminInsightQuotaKinds(): QuotaKind[] {
  return [...QUOTA_KINDS]
}
