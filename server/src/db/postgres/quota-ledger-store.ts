import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { ApiError } from '../../errors.js'
import type {
  AcquiredQuotaReservation,
  ExpiredQuotaReservation,
  InProgressQuotaReservation,
  QuotaCachedResponse,
  QuotaLedgerStore,
  QuotaMaintenanceResult,
  QuotaOperationStatus,
  QuotaResolveInput,
  QuotaReserveInput,
  ReplayedQuotaReservation,
} from '../../services/quota/quota-service.js'
import { sanitizeQuotaResponseHeaders } from '../../services/quota/quota-service.js'
import { postgresDateParameter, safeDatabaseInteger } from './row-values.js'

export function createPostgresQuotaLedgerStore(
  client: postgres.Sql,
  encryptionSecret: string,
): QuotaLedgerStore {
  if (!encryptionSecret) throw new Error('quota response encryption secret is required')
  let nextMaintenanceAt = 0
  const maybeRunMaintenance = async (now: Date) => {
    if (now.getTime() < nextMaintenanceAt) return
    nextMaintenanceAt = now.getTime() + 60_000
    try {
      await runBoundedQuotaMaintenanceOnClient(client, now, 32)
    } catch {
      // The request's own transaction remains authoritative. Retry global
      // maintenance soon without making healthy quota operations depend on it.
      nextMaintenanceAt = now.getTime() + 5_000
    }
  }
  return {
    async getUsed(userId, kind, periodKey, now = new Date()) {
      await maybeRunMaintenance(now)
      return client.begin(async (transaction) => {
        await acquireQuotaUserLock(transaction, userId)
        await clearExpiredQuotaResponsesForUser(transaction, userId, now)
        await releaseExpiredQuotaReservationsForUsage(transaction, userId, kind, periodKey, now)
        return readPostgresQuotaUsage(transaction, userId, kind, periodKey)
      })
    },

    async resolve(input) {
      await maybeRunMaintenance(input.now)
      return client.begin(async (transaction) => {
        await acquireQuotaUserLock(transaction, input.userId)
        await clearExpiredQuotaResponsesForUser(transaction, input.userId, input.now)
        const operation = await selectQuotaOperation(
          transaction,
          input.userId,
          input.idempotencyKey,
        )
        if (!operation) return null
        validatePostgresOperationIdentityBase(operation, input)
        if (operation.status === 'completed') {
          const completed = completedPostgresOutcome(operation, encryptionSecret)
          if (
            completed.outcome === 'result_expired' &&
            (operation.response_headers_json !== null || operation.response_body !== null)
          ) {
            await clearQuotaResponsePayload(transaction, operation.id, input.now)
          }
          return completed
        }
        if (operation.status === 'reserved') {
          if (postgresDate(operation.lease_expires_at).getTime() > input.now.getTime()) {
            return inProgressPostgresOutcome(operation, input.now)
          }
          await releaseExpiredQuotaReservationsForUsage(
            transaction,
            input.userId,
            input.kind,
            operation.period_key,
            input.now,
          )
        }
        return null
      })
    },

    async isAvailable(input) {
      await maybeRunMaintenance(input.now)
      return client.begin(async (transaction) => {
        await acquireQuotaUserLock(transaction, input.userId)
        await clearExpiredQuotaResponsesForUser(transaction, input.userId, input.now)
        let operation = await selectQuotaOperation(transaction, input.userId, input.idempotencyKey)
        if (operation) validatePostgresOperationIdentity(operation, input)
        if (operation?.status === 'completed') return true
        if (
          operation?.status === 'reserved' &&
          postgresDate(operation.lease_expires_at).getTime() > input.now.getTime()
        ) {
          return true
        }
        if (operation?.status === 'reserved') {
          await releaseExpiredQuotaReservationsForUsage(
            transaction,
            input.userId,
            input.kind,
            operation.period_key,
            input.now,
          )
          operation = await selectQuotaOperation(transaction, input.userId, input.idempotencyKey)
          if (operation?.status === 'reserved') return true
        }
        await releaseExpiredQuotaReservationsForUsage(
          transaction,
          input.userId,
          input.kind,
          input.periodKey,
          input.now,
        )
        const used = await readPostgresQuotaUsage(
          transaction,
          input.userId,
          input.kind,
          input.periodKey,
        )
        return used + input.amount <= input.limit
      })
    },

    async reserve(input) {
      await maybeRunMaintenance(input.now)
      return client.begin(async (transaction) => {
        await acquireQuotaUserLock(transaction, input.userId)
        await clearExpiredQuotaResponsesForUser(transaction, input.userId, input.now)

        let operation = await selectQuotaOperation(transaction, input.userId, input.idempotencyKey)
        if (operation) validatePostgresOperationIdentity(operation, input)
        if (operation?.status === 'completed') {
          const completed = completedPostgresOutcome(operation, encryptionSecret)
          if (
            completed.outcome === 'result_expired' &&
            (operation.response_headers_json !== null || operation.response_body !== null)
          ) {
            await clearQuotaResponsePayload(transaction, operation.id, input.now)
          }
          return completed
        }
        if (
          operation?.status === 'reserved' &&
          postgresDate(operation.lease_expires_at).getTime() > input.now.getTime()
        ) {
          return inProgressPostgresOutcome(operation, input.now)
        }

        if (operation?.status === 'reserved') {
          await releaseExpiredQuotaReservationsForUsage(
            transaction,
            input.userId,
            input.kind,
            operation.period_key,
            input.now,
          )
          operation = await selectQuotaOperation(transaction, input.userId, input.idempotencyKey)
          if (operation?.status === 'reserved') {
            return inProgressPostgresOutcome(operation, input.now)
          }
        }

        // A retry after release is a new execution. It consumes the current
        // period even when the abandoned reservation was created last month.
        await releaseExpiredQuotaReservationsForUsage(
          transaction,
          input.userId,
          input.kind,
          input.periodKey,
          input.now,
        )
        const used = await readPostgresQuotaUsage(
          transaction,
          input.userId,
          input.kind,
          input.periodKey,
        )
        if (used + input.amount > input.limit) return null

        const operationId = operation?.id ?? randomUUID()
        const leaseToken = randomUUID()
        const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs)
        if (operation) {
          const updated = await transaction<{ id: string }[]>`
            update quota_operation
            set
              period_key = ${input.periodKey},
              request_id = ${input.requestId},
              status = 'reserved',
              lease_token = ${leaseToken},
              finalized_lease_token = null,
              lease_expires_at = ${postgresDateParameter(leaseExpiresAt)},
              actual_amount = null,
              response_status = null,
              response_headers_json = null,
              response_body = null,
              response_expires_at = null,
              updated_at = ${postgresDateParameter(input.now)}
            where id = ${operationId}
              and user_id = ${input.userId}
              and status = 'released'
            returning id
          `
          if (updated.length !== 1) throw stalePostgresQuotaOperation()
        } else {
          await transaction`
            insert into quota_operation (
              id,
              user_id,
              idempotency_key,
              payload_hash,
              kind,
              source,
              period_key,
              request_id,
              reserved_amount,
              status,
              lease_token,
              lease_expires_at,
              created_at,
              updated_at
            )
            values (
              ${operationId},
              ${input.userId},
              ${input.idempotencyKey},
              ${input.payloadHash},
              ${input.kind},
              ${input.source},
              ${input.periodKey},
              ${input.requestId},
              ${input.amount},
              'reserved',
              ${leaseToken},
              ${postgresDateParameter(leaseExpiresAt)},
              ${postgresDateParameter(input.now)},
              ${postgresDateParameter(input.now)}
            )
          `
        }

        await transaction`
          insert into usage_ledger (
            user_id,
            kind,
            amount,
            source,
            request_id,
            period_key,
            operation_id,
            operation_lease_token,
            operation_event
          )
          values (
            ${input.userId},
            ${input.kind},
            ${input.amount},
            ${input.source},
            ${input.requestId},
            ${input.periodKey},
            ${operationId},
            ${leaseToken},
            'reserve'
          )
        `

        return {
          outcome: 'acquired',
          operationId,
          userId: input.userId,
          kind: input.kind,
          source: input.source,
          periodKey: input.periodKey,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          reservedAmount: input.amount,
          leaseToken,
          leaseExpiresAt,
          responseCacheTtlMs: input.responseCacheTtlMs,
        } satisfies AcquiredQuotaReservation
      })
    },

    async commit(input) {
      const responseHeaders = sanitizeQuotaResponseHeaders(input.cachedResponse.headers)
      const responseBody = encryptQuotaResponseBody(
        input.cachedResponse.body,
        encryptionSecret,
        quotaResponseEncryptionContext(
          input.reservation,
          input.cachedResponse.status,
          responseHeaders,
        ),
      )
      return client.begin(async (transaction) => {
        const reservation = input.reservation
        await acquireQuotaUserLock(transaction, reservation.userId)
        const rows = await transaction<QuotaOperationRow[]>`
          select
            id,
            user_id,
            idempotency_key,
            payload_hash,
            kind,
            source,
            period_key,
            request_id,
            reserved_amount,
            actual_amount,
            status,
            lease_token,
            finalized_lease_token,
            lease_expires_at,
            response_status,
            response_headers_json,
            response_body,
            response_expires_at
          from quota_operation
          where id = ${reservation.operationId}
            and user_id = ${reservation.userId}
          for update
        `
        const operation = rows[0]
        if (!operation) throw stalePostgresQuotaOperation()
        if (operation.status === 'completed') {
          if (operation.finalized_lease_token === reservation.leaseToken) return 'noop'
          throw stalePostgresQuotaOperation()
        }
        if (operation.status !== 'reserved' || operation.lease_token !== reservation.leaseToken) {
          throw stalePostgresQuotaOperation()
        }

        const delta = input.actualAmount - operation.reserved_amount
        await transaction`
          insert into usage_ledger (
            user_id,
            kind,
            amount,
            source,
            request_id,
            period_key,
            operation_id,
            operation_lease_token,
            operation_event
          )
          values (
            ${operation.user_id},
            ${operation.kind},
            ${delta},
            'adjustment',
            ${reservation.requestId},
            ${operation.period_key},
            ${operation.id},
            ${reservation.leaseToken},
            'commit'
          )
        `

        const responseExpiresAt = new Date(input.now.getTime() + reservation.responseCacheTtlMs)
        const updated = await transaction<{ id: string }[]>`
          update quota_operation
          set
            status = 'completed',
            actual_amount = ${input.actualAmount},
            finalized_lease_token = ${reservation.leaseToken},
            lease_token = null,
            lease_expires_at = null,
            response_status = ${input.cachedResponse.status},
            response_headers_json = ${JSON.stringify(responseHeaders)}::text::jsonb,
            response_body = ${Buffer.from(responseBody)},
            response_expires_at = ${postgresDateParameter(responseExpiresAt)},
            updated_at = ${postgresDateParameter(input.now)}
          where id = ${operation.id}
            and status = 'reserved'
            and lease_token = ${reservation.leaseToken}
          returning id
        `
        if (updated.length !== 1) throw stalePostgresQuotaOperation()
        return 'completed'
      })
    },

    async release(input) {
      return client.begin(async (transaction) => {
        const reservation = input.reservation
        await acquireQuotaUserLock(transaction, reservation.userId)
        const rows = await transaction<QuotaOperationRow[]>`
          select
            id,
            user_id,
            idempotency_key,
            payload_hash,
            kind,
            source,
            period_key,
            request_id,
            reserved_amount,
            actual_amount,
            status,
            lease_token,
            finalized_lease_token,
            lease_expires_at,
            response_status,
            response_headers_json,
            response_body,
            response_expires_at
          from quota_operation
          where id = ${reservation.operationId}
            and user_id = ${reservation.userId}
          for update
        `
        const operation = rows[0]
        if (
          !operation ||
          operation.status !== 'reserved' ||
          operation.lease_token !== reservation.leaseToken
        ) {
          return 'noop'
        }

        await transaction`
          insert into usage_ledger (
            user_id,
            kind,
            amount,
            source,
            request_id,
            period_key,
            operation_id,
            operation_lease_token,
            operation_event
          )
          values (
            ${operation.user_id},
            ${operation.kind},
            ${-operation.reserved_amount},
            'adjustment',
            ${reservation.requestId},
            ${operation.period_key},
            ${operation.id},
            ${reservation.leaseToken},
            'release'
          )
        `
        const updated = await transaction<{ id: string }[]>`
          update quota_operation
          set
            status = 'released',
            finalized_lease_token = ${reservation.leaseToken},
            lease_token = null,
            lease_expires_at = null,
            updated_at = ${postgresDateParameter(input.now)}
          where id = ${operation.id}
            and status = 'reserved'
            and lease_token = ${reservation.leaseToken}
          returning id
        `
        if (updated.length !== 1) throw stalePostgresQuotaOperation()
        return 'released'
      })
    },

    async adjust(input) {
      await client.begin(async (transaction) => {
        await acquireQuotaUserLock(transaction, input.userId)
        await transaction`
          insert into usage_ledger (user_id, kind, amount, source, request_id, period_key)
          values (
            ${input.userId},
            ${input.kind},
            ${input.amount},
            'adjustment',
            ${input.requestId},
            ${input.periodKey}
          )
        `
      })
    },

    async reapExpired(now = new Date(), limit = 100) {
      validatePostgresMaintenanceLimit(limit)
      return client.begin(async (transaction) => {
        const releasedReservations = await releaseExpiredQuotaReservationsGlobally(
          transaction,
          now,
          limit,
        )
        const clearedResponses = await clearExpiredQuotaResponsesGlobally(transaction, now, limit)
        return { releasedReservations, clearedResponses }
      })
    },
  }
}

interface QuotaOperationRow {
  id: string
  user_id: string
  idempotency_key: string
  payload_hash: string
  kind: QuotaReserveInput['kind']
  source: QuotaReserveInput['source']
  period_key: string
  request_id: string
  reserved_amount: number
  actual_amount: number | null
  status: QuotaOperationStatus
  lease_token: string | null
  finalized_lease_token: string | null
  lease_expires_at: Date | string | null
  response_status: number | null
  response_headers_json: Record<string, string> | null
  response_body: Buffer | Uint8Array | null
  response_expires_at: Date | string | null
}

const QUOTA_RESPONSE_ENVELOPE_MAGIC = Buffer.from([0x45, 0x51, 0x52, 0x01])
const QUOTA_RESPONSE_NONCE_BYTES = 12
const QUOTA_RESPONSE_AUTH_TAG_BYTES = 16

export function encryptQuotaResponseBody(
  body: Uint8Array,
  secret: string,
  context: string,
): Uint8Array {
  const nonce = randomBytes(QUOTA_RESPONSE_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', quotaResponseEncryptionKey(secret), nonce)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  return Uint8Array.from(
    Buffer.concat([QUOTA_RESPONSE_ENVELOPE_MAGIC, nonce, cipher.getAuthTag(), ciphertext]),
  )
}

export function decryptQuotaResponseBody(
  envelope: Uint8Array,
  secret: string,
  context: string,
): Uint8Array | null {
  const bytes = Buffer.from(envelope)
  const prefixBytes =
    QUOTA_RESPONSE_ENVELOPE_MAGIC.byteLength +
    QUOTA_RESPONSE_NONCE_BYTES +
    QUOTA_RESPONSE_AUTH_TAG_BYTES
  if (
    bytes.byteLength < prefixBytes ||
    !bytes
      .subarray(0, QUOTA_RESPONSE_ENVELOPE_MAGIC.byteLength)
      .equals(QUOTA_RESPONSE_ENVELOPE_MAGIC)
  ) {
    return null
  }

  const nonceStart = QUOTA_RESPONSE_ENVELOPE_MAGIC.byteLength
  const tagStart = nonceStart + QUOTA_RESPONSE_NONCE_BYTES
  const ciphertextStart = tagStart + QUOTA_RESPONSE_AUTH_TAG_BYTES
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      quotaResponseEncryptionKey(secret),
      bytes.subarray(nonceStart, tagStart),
    )
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart))
    return Uint8Array.from(
      Buffer.concat([decipher.update(bytes.subarray(ciphertextStart)), decipher.final()]),
    )
  } catch {
    return null
  }
}

function quotaResponseEncryptionKey(secret: string): Buffer {
  return createHash('sha256')
    .update('EcholIKE quota response cache AES-256-GCM key v1\0', 'utf8')
    .update(secret, 'utf8')
    .digest()
}

function quotaResponseEncryptionContext(
  operation: Pick<
    AcquiredQuotaReservation,
    'operationId' | 'userId' | 'idempotencyKey' | 'payloadHash'
  >,
  status: number,
  headers: Record<string, string>,
): string {
  return JSON.stringify([
    'quota-response-v1',
    operation.operationId,
    operation.userId,
    operation.idempotencyKey,
    operation.payloadHash,
    status,
    Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)),
  ])
}

export async function acquireQuotaUserLock(
  transaction: postgres.TransactionSql,
  userId: string,
): Promise<void> {
  await transaction`
    select pg_advisory_xact_lock(hashtext(${'quota-user:' + userId}))
  `
}

async function selectQuotaOperation(
  transaction: postgres.TransactionSql,
  userId: string,
  idempotencyKey: string,
): Promise<QuotaOperationRow | null> {
  const rows = await transaction<QuotaOperationRow[]>`
    select
      id,
      user_id,
      idempotency_key,
      payload_hash,
      kind,
      source,
      period_key,
      request_id,
      reserved_amount,
      actual_amount,
      status,
      lease_token,
      finalized_lease_token,
      lease_expires_at,
      response_status,
      response_headers_json,
      response_body,
      response_expires_at
    from quota_operation
    where user_id = ${userId}
      and idempotency_key = ${idempotencyKey}
    for update
  `
  return rows[0] ?? null
}

export async function readPostgresQuotaUsage(
  transaction: postgres.TransactionSql,
  userId: string,
  kind: QuotaReserveInput['kind'],
  periodKey: string,
): Promise<number> {
  const rows = await transaction<{ total: number | string }[]>`
    select coalesce(sum(amount), 0)::bigint as total
    from usage_ledger
    where user_id = ${userId}
      and kind = ${kind}
      and period_key = ${periodKey}
  `
  return safeDatabaseInteger(rows[0]?.total ?? 0, 'quota usage total')
}

async function clearExpiredQuotaResponsesForUser(
  transaction: postgres.TransactionSql,
  userId: string,
  now: Date,
): Promise<void> {
  const timestamp = postgresDateParameter(now)
  await transaction`
    update quota_operation
    set
      response_headers_json = null,
      response_body = null,
      updated_at = ${timestamp}
    where user_id = ${userId}
      and status = 'completed'
      and response_expires_at <= ${timestamp}
      and (response_headers_json is not null or response_body is not null)
  `
}

async function clearQuotaResponsePayload(
  transaction: postgres.TransactionSql,
  operationId: string,
  now: Date,
): Promise<void> {
  const timestamp = postgresDateParameter(now)
  await transaction`
    update quota_operation
    set
      response_headers_json = null,
      response_body = null,
      updated_at = ${timestamp}
    where id = ${operationId}
      and status = 'completed'
  `
}

async function releaseExpiredQuotaReservationsForUsage(
  transaction: postgres.TransactionSql,
  userId: string,
  kind: QuotaReserveInput['kind'],
  periodKey: string,
  now: Date,
): Promise<number> {
  const timestamp = postgresDateParameter(now)
  const rows = await transaction<{ id: string }[]>`
    with expired as (
      select
        id,
        user_id,
        kind,
        reserved_amount,
        request_id,
        period_key,
        lease_token
      from quota_operation
      where user_id = ${userId}
        and kind = ${kind}
        and period_key = ${periodKey}
        and status = 'reserved'
        and lease_expires_at <= ${timestamp}
      order by lease_expires_at, id
      for update
    ), ledger_events as (
      insert into usage_ledger (
        user_id,
        kind,
        amount,
        source,
        request_id,
        period_key,
        operation_id,
        operation_lease_token,
        operation_event
      )
      select
        user_id,
        kind,
        -reserved_amount,
        'adjustment',
        request_id,
        period_key,
        id,
        lease_token,
        'release'
      from expired
      on conflict (operation_id, operation_lease_token, operation_event) do nothing
    )
    update quota_operation as operation
    set
      status = 'released',
      finalized_lease_token = operation.lease_token,
      lease_token = null,
      lease_expires_at = null,
      updated_at = ${timestamp}
    from expired
    where operation.id = expired.id
      and operation.status = 'reserved'
      and operation.lease_token = expired.lease_token
    returning operation.id
  `
  return rows.length
}

async function releaseExpiredQuotaReservationsGlobally(
  transaction: postgres.TransactionSql,
  now: Date,
  limit: number,
): Promise<number> {
  const timestamp = postgresDateParameter(now)
  const rows = await transaction<{ id: string }[]>`
    with expired as (
      select
        id,
        user_id,
        kind,
        reserved_amount,
        request_id,
        period_key,
        lease_token
      from quota_operation
      where status = 'reserved'
        and lease_expires_at <= ${timestamp}
      order by lease_expires_at, id
      for update skip locked
      limit ${limit}
    ), ledger_events as (
      insert into usage_ledger (
        user_id,
        kind,
        amount,
        source,
        request_id,
        period_key,
        operation_id,
        operation_lease_token,
        operation_event
      )
      select
        user_id,
        kind,
        -reserved_amount,
        'adjustment',
        request_id,
        period_key,
        id,
        lease_token,
        'release'
      from expired
      on conflict (operation_id, operation_lease_token, operation_event) do nothing
    )
    update quota_operation as operation
    set
      status = 'released',
      finalized_lease_token = operation.lease_token,
      lease_token = null,
      lease_expires_at = null,
      updated_at = ${timestamp}
    from expired
    where operation.id = expired.id
      and operation.status = 'reserved'
      and operation.lease_token = expired.lease_token
    returning operation.id
  `
  return rows.length
}

async function clearExpiredQuotaResponsesGlobally(
  transaction: postgres.TransactionSql,
  now: Date,
  limit: number,
): Promise<number> {
  const timestamp = postgresDateParameter(now)
  const rows = await transaction<{ id: string }[]>`
    with expired as (
      select id
      from quota_operation
      where status = 'completed'
        and response_expires_at <= ${timestamp}
        and (response_headers_json is not null or response_body is not null)
      order by response_expires_at, id
      for update skip locked
      limit ${limit}
    )
    update quota_operation as operation
    set
      response_headers_json = null,
      response_body = null,
      updated_at = ${timestamp}
    from expired
    where operation.id = expired.id
    returning operation.id
  `
  return rows.length
}

async function runBoundedQuotaMaintenance(
  transaction: postgres.TransactionSql,
  now: Date,
  limit: number,
): Promise<QuotaMaintenanceResult> {
  const releasedReservations = await releaseExpiredQuotaReservationsGlobally(
    transaction,
    now,
    limit,
  )
  const clearedResponses = await clearExpiredQuotaResponsesGlobally(transaction, now, limit)
  return { releasedReservations, clearedResponses }
}

async function runBoundedQuotaMaintenanceOnClient(
  client: postgres.Sql,
  now: Date,
  limit: number,
): Promise<QuotaMaintenanceResult> {
  return client.begin((transaction) => runBoundedQuotaMaintenance(transaction, now, limit))
}

function validatePostgresOperationIdentity(
  operation: QuotaOperationRow,
  input: Pick<QuotaReserveInput, 'payloadHash' | 'kind' | 'source' | 'amount' | 'requestId'>,
): void {
  validatePostgresOperationIdentityBase(operation, input)
  if (operation.reserved_amount !== input.amount) {
    throw new ApiError(
      409,
      'idempotency_conflict',
      'idempotency key was already used for a different operation',
    )
  }
}

function validatePostgresOperationIdentityBase(
  operation: QuotaOperationRow,
  input: Pick<QuotaResolveInput, 'payloadHash' | 'kind' | 'source' | 'requestId'>,
): void {
  if (
    operation.payload_hash !== input.payloadHash ||
    operation.kind !== input.kind ||
    operation.source !== input.source
  ) {
    throw new ApiError(
      409,
      'idempotency_conflict',
      'idempotency key was already used for a different operation',
    )
  }
}

function completedPostgresOutcome(
  operation: QuotaOperationRow,
  encryptionSecret: string,
): ReplayedQuotaReservation | ExpiredQuotaReservation {
  if (operation.actual_amount === null || operation.response_status === null) {
    throw new ApiError(500, 'internal_error', 'completed quota operation is invalid', false)
  }
  const base = {
    operationId: operation.id,
    userId: operation.user_id,
    kind: operation.kind,
    source: operation.source,
    periodKey: operation.period_key,
    requestId: operation.request_id,
    idempotencyKey: operation.idempotency_key,
    payloadHash: operation.payload_hash,
    reservedAmount: operation.reserved_amount,
    actualAmount: operation.actual_amount,
  }
  if (operation.response_headers_json === null || operation.response_body === null) {
    return { ...base, outcome: 'result_expired' }
  }
  const headers = sanitizeQuotaResponseHeaders(operation.response_headers_json)
  const body = decryptQuotaResponseBody(
    operation.response_body,
    encryptionSecret,
    quotaResponseEncryptionContext(base, operation.response_status, headers),
  )
  if (body === null) return { ...base, outcome: 'result_expired' }
  return {
    ...base,
    outcome: 'replay',
    cachedResponse: {
      status: operation.response_status,
      headers,
      body,
    } satisfies QuotaCachedResponse,
  }
}

function inProgressPostgresOutcome(
  operation: QuotaOperationRow,
  now: Date,
): InProgressQuotaReservation {
  const leaseExpiresAt = postgresDate(operation.lease_expires_at)
  return {
    operationId: operation.id,
    userId: operation.user_id,
    kind: operation.kind,
    source: operation.source,
    periodKey: operation.period_key,
    requestId: operation.request_id,
    idempotencyKey: operation.idempotency_key,
    payloadHash: operation.payload_hash,
    reservedAmount: operation.reserved_amount,
    outcome: 'in_progress',
    retryAfterSeconds: Math.max(1, Math.ceil((leaseExpiresAt.getTime() - now.getTime()) / 1_000)),
  }
}

function postgresDate(value: Date | string | null): Date {
  const date = value instanceof Date ? value : new Date(value ?? Number.NaN)
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(500, 'internal_error', 'quota operation timestamp is invalid', false)
  }
  return date
}

function stalePostgresQuotaOperation(): ApiError {
  return new ApiError(409, 'operation_stale', 'quota operation lease is no longer current', false)
}

function validatePostgresMaintenanceLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new ApiError(422, 'validation_failed', 'quota maintenance limit is invalid')
  }
}
