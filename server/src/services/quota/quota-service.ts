import { randomUUID } from 'node:crypto'
import { ApiError } from '../../errors.js'
import type { AuthenticatedUser } from '../../types.js'
import type { EntitlementService } from '../billing/entitlements.js'
import { utcPeriodKey } from './usage-ledger.js'

export type QuotaKind = 'stt_seconds' | 'llm_tokens' | 'ocr_images' | 'tts_chars'
export type QuotaSource = 'proxy_stt' | 'proxy_llm' | 'proxy_ocr' | 'proxy_tts' | 'adjustment'
export type QuotaOperationStatus = 'reserved' | 'completed' | 'released'

export const DEFAULT_QUOTA_OPERATION_LEASE_MS = 30 * 60 * 1_000
export const DEFAULT_QUOTA_RESPONSE_CACHE_TTL_MS = 15 * 60 * 1_000

const MAX_OPERATION_LEASE_MS = 24 * 60 * 60 * 1_000
const MAX_RESPONSE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_CACHED_RESPONSE_BYTES = 64 * 1024 * 1024
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/
const PAYLOAD_HASH_RE = /^[a-f0-9]{64}$/
const CACHEABLE_RESPONSE_HEADERS = new Set(['cache-control', 'content-type', 'x-tts-usage-chars'])

export interface QuotaCachedResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

export interface QuotaOperationOptions {
  idempotencyKey: string
  payloadHash: string
  leaseMs?: number
  responseCacheTtlMs?: number
  now?: Date
}

interface QuotaReservationBase {
  operationId: string
  userId: string
  kind: QuotaKind
  source: Exclude<QuotaSource, 'adjustment'>
  periodKey: string
  requestId: string
  idempotencyKey: string
  payloadHash: string
  reservedAmount: number
}

export interface AcquiredQuotaReservation extends QuotaReservationBase {
  outcome: 'acquired'
  leaseToken: string
  leaseExpiresAt: Date
  responseCacheTtlMs: number
}

export interface InProgressQuotaReservation extends QuotaReservationBase {
  outcome: 'in_progress'
  retryAfterSeconds: number
}

export interface ReplayedQuotaReservation extends QuotaReservationBase {
  outcome: 'replay'
  actualAmount: number
  cachedResponse: QuotaCachedResponse
}

export interface ExpiredQuotaReservation extends QuotaReservationBase {
  outcome: 'result_expired'
  actualAmount: number
}

export type QuotaReservation =
  | AcquiredQuotaReservation
  | InProgressQuotaReservation
  | ReplayedQuotaReservation
  | ExpiredQuotaReservation

export type ResolvedQuotaOperation = Exclude<QuotaReservation, AcquiredQuotaReservation>

export interface QuotaReserveInput {
  userId: string
  kind: QuotaKind
  amount: number
  limit: number
  source: Exclude<QuotaSource, 'adjustment'>
  requestId: string
  periodKey: string
  idempotencyKey: string
  payloadHash: string
  leaseMs: number
  responseCacheTtlMs: number
  now: Date
}

export type QuotaAvailabilityInput = Omit<QuotaReserveInput, 'leaseMs' | 'responseCacheTtlMs'>

export interface QuotaResolveInput {
  userId: string
  kind: QuotaKind
  source: Exclude<QuotaSource, 'adjustment'>
  requestId: string
  idempotencyKey: string
  payloadHash: string
  now: Date
}

export interface QuotaAdjustmentInput {
  userId: string
  kind: QuotaKind
  amount: number
  requestId: string
  periodKey: string
}

export interface QuotaCommitInput {
  reservation: AcquiredQuotaReservation
  actualAmount: number
  cachedResponse: QuotaCachedResponse
  now: Date
}

export interface QuotaReleaseInput {
  reservation: AcquiredQuotaReservation
  now: Date
}

export interface QuotaMaintenanceResult {
  releasedReservations: number
  clearedResponses: number
}

export interface QuotaLedgerStore {
  getUsed(userId: string, kind: QuotaKind, periodKey: string, now?: Date): Promise<number>
  resolve(input: QuotaResolveInput): Promise<ResolvedQuotaOperation | null>
  isAvailable(input: QuotaAvailabilityInput): Promise<boolean>
  reserve(input: QuotaReserveInput): Promise<QuotaReservation | null>
  commit(input: QuotaCommitInput): Promise<'completed' | 'noop'>
  release(input: QuotaReleaseInput): Promise<'released' | 'noop'>
  adjust(input: QuotaAdjustmentInput): Promise<void>
  reapExpired(now?: Date, limit?: number): Promise<QuotaMaintenanceResult>
}

export interface QuotaService {
  resolve(
    user: AuthenticatedUser,
    kind: QuotaKind,
    source: Exclude<QuotaSource, 'adjustment'>,
    requestId: string,
    operation: QuotaOperationOptions,
  ): Promise<ResolvedQuotaOperation | null>
  assertAvailable(
    user: AuthenticatedUser,
    kind: QuotaKind,
    amount: number,
    requestId: string,
    operation: QuotaOperationOptions,
  ): Promise<void>
  reserve(
    user: AuthenticatedUser,
    kind: QuotaKind,
    amount: number,
    source: Exclude<QuotaSource, 'adjustment'>,
    requestId: string,
    operation: QuotaOperationOptions,
  ): Promise<QuotaReservation>
  commit(
    reservation: AcquiredQuotaReservation,
    actualAmount: number,
    cachedResponse: QuotaCachedResponse,
    now?: Date,
  ): Promise<void>
  release(reservation: AcquiredQuotaReservation, now?: Date): Promise<void>
}

export function createQuotaService(
  entitlements: EntitlementService,
  ledger: QuotaLedgerStore,
): QuotaService {
  return {
    async resolve(user, kind, source, requestId, operation) {
      const options = normalizeOperationOptions(operation)
      return ledger.resolve({
        userId: user.id,
        kind,
        source,
        requestId,
        idempotencyKey: options.idempotencyKey,
        payloadHash: options.payloadHash,
        now: options.now,
      })
    },

    async assertAvailable(user, kind, amount, requestId, operation) {
      validateQuotaAmount(amount)
      const source = quotaSourceForKind(kind)
      const options = normalizeOperationOptions(operation)
      const available = await ledger.isAvailable({
        userId: user.id,
        kind,
        amount,
        limit: await quotaLimit(entitlements, user, kind, options.now),
        source,
        requestId,
        periodKey: utcPeriodKey(options.now),
        idempotencyKey: options.idempotencyKey,
        payloadHash: options.payloadHash,
        now: options.now,
      })
      if (!available) {
        throw quotaExceeded(kind, requestId)
      }
    },

    async reserve(user, kind, amount, source, requestId, operation) {
      validateQuotaAmount(amount)
      const options = normalizeOperationOptions(operation)
      const periodKey = utcPeriodKey(options.now)
      const limit = await quotaLimit(entitlements, user, kind, options.now)
      const reservation = await ledger.reserve({
        userId: user.id,
        kind,
        amount,
        limit,
        source,
        requestId,
        periodKey,
        idempotencyKey: options.idempotencyKey,
        payloadHash: options.payloadHash,
        leaseMs: options.leaseMs,
        responseCacheTtlMs: options.responseCacheTtlMs,
        now: options.now,
      })
      if (!reservation) {
        throw quotaExceeded(kind, requestId)
      }
      return reservation
    },

    async commit(reservation, actualAmount, cachedResponse, now = new Date()) {
      validateQuotaAmount(actualAmount)
      validateCachedResponse(cachedResponse)
      await ledger.commit({
        reservation,
        actualAmount,
        cachedResponse: {
          status: cachedResponse.status,
          headers: sanitizeQuotaResponseHeaders(cachedResponse.headers),
          body: cachedResponse.body,
        },
        now,
      })
    },

    async release(reservation, now = new Date()) {
      await ledger.release({ reservation, now })
    },
  }
}

interface MemoryQuotaOperation {
  operationId: string
  userId: string
  kind: QuotaKind
  source: Exclude<QuotaSource, 'adjustment'>
  periodKey: string
  requestId: string
  idempotencyKey: string
  payloadHash: string
  reservedAmount: number
  status: QuotaOperationStatus
  leaseToken: string | null
  finalizedLeaseToken: string | null
  leaseExpiresAt: Date | null
  actualAmount: number | null
  responseStatus: number | null
  responseHeaders: Record<string, string> | null
  responseBody: Uint8Array | null
  responseExpiresAt: Date | null
}

export function createMemoryQuotaLedgerStore(
  initialUsage: Record<string, number> = {},
): QuotaLedgerStore {
  const usage = new Map(Object.entries(initialUsage))
  const operationsByKey = new Map<string, MemoryQuotaOperation>()
  const operationsById = new Map<string, MemoryQuotaOperation>()

  return {
    async getUsed(userId, kind, periodKey, now = new Date()) {
      reapExpiredMemory(usage, operationsByKey.values(), now, 32)
      clearExpiredResponses(operationsByKey.values(), userId, now)
      releaseExpiredReservations(usage, operationsByKey.values(), userId, kind, periodKey, now)
      return usage.get(usageKey(userId, kind, periodKey)) ?? 0
    },

    async resolve(input) {
      clearExpiredResponses(operationsByKey.values(), input.userId, input.now)
      const operation = operationsByKey.get(operationKey(input.userId, input.idempotencyKey))
      if (!operation) return null
      validateOperationIdentityBase(operation, input)
      if (
        operation.status === 'reserved' &&
        operation.leaseExpiresAt &&
        operation.leaseExpiresAt.getTime() <= input.now.getTime()
      ) {
        releaseMemoryReservation(usage, operation)
        return null
      }
      if (operation.status === 'completed') return completedMemoryOutcome(operation)
      if (operation.status === 'reserved') return inProgressOutcome(operation, input.now)
      return null
    },

    async isAvailable(input) {
      reapExpiredMemory(usage, operationsByKey.values(), input.now, 32)
      clearExpiredResponses(operationsByKey.values(), input.userId, input.now)
      const operation = operationsByKey.get(operationKey(input.userId, input.idempotencyKey))
      if (operation) validateOperationIdentity(operation, input)
      if (operation?.status === 'completed') return true
      if (
        operation?.status === 'reserved' &&
        operation.leaseExpiresAt &&
        operation.leaseExpiresAt.getTime() > input.now.getTime()
      ) {
        return true
      }
      if (operation?.status === 'reserved') {
        releaseExpiredReservations(
          usage,
          operationsByKey.values(),
          input.userId,
          input.kind,
          operation.periodKey,
          input.now,
        )
      }
      releaseExpiredReservations(
        usage,
        operationsByKey.values(),
        input.userId,
        input.kind,
        input.periodKey,
        input.now,
      )
      const used = usage.get(usageKey(input.userId, input.kind, input.periodKey)) ?? 0
      return used + input.amount <= input.limit
    },

    async reserve(input) {
      reapExpiredMemory(usage, operationsByKey.values(), input.now, 32)
      clearExpiredResponses(operationsByKey.values(), input.userId, input.now)
      const key = operationKey(input.userId, input.idempotencyKey)
      let operation = operationsByKey.get(key)
      if (operation) validateOperationIdentity(operation, input)

      const targetPeriodKey = operation?.periodKey ?? input.periodKey
      releaseExpiredReservations(
        usage,
        operationsByKey.values(),
        input.userId,
        input.kind,
        targetPeriodKey,
        input.now,
      )

      operation = operationsByKey.get(key)
      if (operation?.status === 'completed') {
        return completedMemoryOutcome(operation)
      }
      if (operation?.status === 'reserved') {
        return inProgressOutcome(operation, input.now)
      }

      // A completed operation forever belongs to its original period. A released or
      // expired attempt is a new execution and must consume the caller's current period.
      const acquisitionPeriodKey = operation ? input.periodKey : targetPeriodKey
      const usageKeyValue = usageKey(input.userId, input.kind, acquisitionPeriodKey)
      const used = usage.get(usageKeyValue) ?? 0
      if (used + input.amount > input.limit) return null

      const leaseToken = randomUUID()
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs)
      if (operation) {
        operation.status = 'reserved'
        operation.periodKey = acquisitionPeriodKey
        operation.requestId = input.requestId
        operation.leaseToken = leaseToken
        operation.finalizedLeaseToken = null
        operation.leaseExpiresAt = leaseExpiresAt
        operation.actualAmount = null
        operation.responseStatus = null
        operation.responseHeaders = null
        operation.responseBody = null
        operation.responseExpiresAt = null
      } else {
        operation = {
          operationId: randomUUID(),
          userId: input.userId,
          kind: input.kind,
          source: input.source,
          periodKey: acquisitionPeriodKey,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          reservedAmount: input.amount,
          status: 'reserved',
          leaseToken,
          finalizedLeaseToken: null,
          leaseExpiresAt,
          actualAmount: null,
          responseStatus: null,
          responseHeaders: null,
          responseBody: null,
          responseExpiresAt: null,
        }
        operationsByKey.set(key, operation)
        operationsById.set(operation.operationId, operation)
      }
      usage.set(usageKeyValue, used + input.amount)
      return acquiredOutcome(operation, input.responseCacheTtlMs)
    },

    async commit(input) {
      const operation = operationsById.get(input.reservation.operationId)
      if (!operation || operation.userId !== input.reservation.userId) {
        throw staleOperation()
      }
      if (operation.status === 'completed') {
        if (operation.finalizedLeaseToken === input.reservation.leaseToken) return 'noop'
        throw staleOperation()
      }
      if (
        operation.status !== 'reserved' ||
        operation.leaseToken !== input.reservation.leaseToken
      ) {
        throw staleOperation()
      }

      const key = usageKey(operation.userId, operation.kind, operation.periodKey)
      const delta = input.actualAmount - operation.reservedAmount
      usage.set(key, (usage.get(key) ?? 0) + delta)
      operation.status = 'completed'
      operation.actualAmount = input.actualAmount
      operation.finalizedLeaseToken = input.reservation.leaseToken
      operation.leaseToken = null
      operation.leaseExpiresAt = null
      operation.responseStatus = input.cachedResponse.status
      operation.responseHeaders = cloneHeaders(input.cachedResponse.headers)
      operation.responseBody = Uint8Array.from(input.cachedResponse.body)
      operation.responseExpiresAt = new Date(
        input.now.getTime() + input.reservation.responseCacheTtlMs,
      )
      return 'completed'
    },

    async release(input) {
      const operation = operationsById.get(input.reservation.operationId)
      if (
        !operation ||
        operation.userId !== input.reservation.userId ||
        operation.status !== 'reserved' ||
        operation.leaseToken !== input.reservation.leaseToken
      ) {
        return 'noop'
      }

      releaseMemoryReservation(usage, operation)
      return 'released'
    },

    async adjust(input) {
      const key = usageKey(input.userId, input.kind, input.periodKey)
      usage.set(key, (usage.get(key) ?? 0) + input.amount)
    },

    async reapExpired(now = new Date(), limit = 100) {
      validateMaintenanceLimit(limit)
      return reapExpiredMemory(usage, operationsByKey.values(), now, limit)
    },
  }
}

function reapExpiredMemory(
  usage: Map<string, number>,
  operations: Iterable<MemoryQuotaOperation>,
  now: Date,
  limit: number,
): QuotaMaintenanceResult {
  let releasedReservations = 0
  let clearedResponses = 0
  for (const operation of operations) {
    if (
      releasedReservations < limit &&
      operation.status === 'reserved' &&
      operation.leaseExpiresAt &&
      operation.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      releaseMemoryReservation(usage, operation)
      releasedReservations += 1
    }
    if (
      clearedResponses < limit &&
      operation.status === 'completed' &&
      operation.responseExpiresAt &&
      operation.responseExpiresAt.getTime() <= now.getTime() &&
      (operation.responseHeaders !== null || operation.responseBody !== null)
    ) {
      operation.responseHeaders = null
      operation.responseBody = null
      clearedResponses += 1
    }
  }
  return { releasedReservations, clearedResponses }
}

function clearExpiredResponses(
  operations: Iterable<MemoryQuotaOperation>,
  userId: string,
  now: Date,
): void {
  for (const operation of operations) {
    if (
      operation.userId === userId &&
      operation.status === 'completed' &&
      operation.responseExpiresAt &&
      operation.responseExpiresAt.getTime() <= now.getTime()
    ) {
      operation.responseHeaders = null
      operation.responseBody = null
    }
  }
}

function releaseExpiredReservations(
  usage: Map<string, number>,
  operations: Iterable<MemoryQuotaOperation>,
  userId: string,
  kind: QuotaKind,
  periodKey: string,
  now: Date,
): void {
  for (const operation of operations) {
    if (
      operation.userId === userId &&
      operation.kind === kind &&
      operation.periodKey === periodKey &&
      operation.status === 'reserved' &&
      operation.leaseExpiresAt &&
      operation.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      releaseMemoryReservation(usage, operation)
    }
  }
}

function releaseMemoryReservation(
  usage: Map<string, number>,
  operation: MemoryQuotaOperation,
): void {
  const key = usageKey(operation.userId, operation.kind, operation.periodKey)
  usage.set(key, (usage.get(key) ?? 0) - operation.reservedAmount)
  operation.status = 'released'
  operation.finalizedLeaseToken = operation.leaseToken
  operation.leaseToken = null
  operation.leaseExpiresAt = null
}

function acquiredOutcome(
  operation: MemoryQuotaOperation,
  responseCacheTtlMs: number,
): AcquiredQuotaReservation {
  if (!operation.leaseToken || !operation.leaseExpiresAt) {
    throw new Error('reserved quota operation is missing its lease')
  }
  return {
    ...reservationBase(operation),
    outcome: 'acquired',
    leaseToken: operation.leaseToken,
    leaseExpiresAt: new Date(operation.leaseExpiresAt),
    responseCacheTtlMs,
  }
}

function inProgressOutcome(operation: MemoryQuotaOperation, now: Date): InProgressQuotaReservation {
  if (!operation.leaseExpiresAt) {
    throw new Error('reserved quota operation is missing its expiry')
  }
  return {
    ...reservationBase(operation),
    outcome: 'in_progress',
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((operation.leaseExpiresAt.getTime() - now.getTime()) / 1_000),
    ),
  }
}

function completedMemoryOutcome(
  operation: MemoryQuotaOperation,
): ReplayedQuotaReservation | ExpiredQuotaReservation {
  if (operation.actualAmount === null) {
    throw new Error('completed quota operation is missing actual usage')
  }
  const base = {
    ...reservationBase(operation),
    actualAmount: operation.actualAmount,
  }
  if (
    operation.responseStatus === null ||
    operation.responseHeaders === null ||
    operation.responseBody === null
  ) {
    return { ...base, outcome: 'result_expired' }
  }
  return {
    ...base,
    outcome: 'replay',
    cachedResponse: {
      status: operation.responseStatus,
      headers: cloneHeaders(operation.responseHeaders),
      body: Uint8Array.from(operation.responseBody),
    },
  }
}

function reservationBase(operation: MemoryQuotaOperation): QuotaReservationBase {
  return {
    operationId: operation.operationId,
    userId: operation.userId,
    kind: operation.kind,
    source: operation.source,
    periodKey: operation.periodKey,
    requestId: operation.requestId,
    idempotencyKey: operation.idempotencyKey,
    payloadHash: operation.payloadHash,
    reservedAmount: operation.reservedAmount,
  }
}

function validateOperationIdentity(
  operation: Pick<
    MemoryQuotaOperation,
    'payloadHash' | 'kind' | 'source' | 'reservedAmount' | 'requestId'
  >,
  input: Pick<QuotaReserveInput, 'payloadHash' | 'kind' | 'source' | 'amount' | 'requestId'>,
): void {
  validateOperationIdentityBase(operation, input)
  if (operation.reservedAmount !== input.amount) {
    throw idempotencyConflict(input.requestId)
  }
}

function validateOperationIdentityBase(
  operation: Pick<MemoryQuotaOperation, 'payloadHash' | 'kind' | 'source' | 'requestId'>,
  input: Pick<QuotaResolveInput, 'payloadHash' | 'kind' | 'source' | 'requestId'>,
): void {
  if (
    operation.payloadHash !== input.payloadHash ||
    operation.kind !== input.kind ||
    operation.source !== input.source
  ) {
    throw idempotencyConflict(input.requestId)
  }
}

function normalizeOperationOptions(
  operation: QuotaOperationOptions,
): Required<QuotaOperationOptions> {
  const options = operation
  if (!IDEMPOTENCY_KEY_RE.test(options.idempotencyKey)) {
    throw new ApiError(422, 'idempotency_key_invalid', 'idempotency key is invalid')
  }
  if (!PAYLOAD_HASH_RE.test(options.payloadHash)) {
    throw new ApiError(422, 'validation_failed', 'payload hash is invalid')
  }
  const now = options.now ?? new Date()
  if (Number.isNaN(now.getTime())) {
    throw new ApiError(422, 'validation_failed', 'operation time is invalid')
  }
  const leaseMs = options.leaseMs ?? DEFAULT_QUOTA_OPERATION_LEASE_MS
  validateDuration(leaseMs, MAX_OPERATION_LEASE_MS, 'operation lease')
  const responseCacheTtlMs = options.responseCacheTtlMs ?? DEFAULT_QUOTA_RESPONSE_CACHE_TTL_MS
  validateDuration(responseCacheTtlMs, MAX_RESPONSE_CACHE_TTL_MS, 'response cache TTL')

  return {
    idempotencyKey: options.idempotencyKey,
    payloadHash: options.payloadHash,
    leaseMs,
    responseCacheTtlMs,
    now,
  }
}

function validateDuration(value: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < 1_000 || value > maximum) {
    throw new ApiError(422, 'validation_failed', `${label} is invalid`)
  }
}

function validateMaintenanceLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new ApiError(422, 'validation_failed', 'quota maintenance limit is invalid')
  }
}

function validateCachedResponse(response: QuotaCachedResponse): void {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    throw new ApiError(500, 'internal_error', 'cached response status is invalid', false)
  }
  if (
    !(response.body instanceof Uint8Array) ||
    response.body.byteLength > MAX_CACHED_RESPONSE_BYTES
  ) {
    throw new ApiError(500, 'internal_error', 'cached response body is invalid', false)
  }
  for (const [name, value] of Object.entries(response.headers)) {
    if (!name || typeof value !== 'string' || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new ApiError(500, 'internal_error', 'cached response headers are invalid', false)
    }
  }
}

function cloneHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers))
}

export function sanitizeQuotaResponseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => CACHEABLE_RESPONSE_HEADERS.has(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function operationKey(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`
}

function usageKey(userId: string, kind: QuotaKind, periodKey: string): string {
  return `${userId}:${kind}:${periodKey}`
}

function quotaSourceForKind(kind: QuotaKind): Exclude<QuotaSource, 'adjustment'> {
  switch (kind) {
    case 'stt_seconds':
      return 'proxy_stt'
    case 'llm_tokens':
      return 'proxy_llm'
    case 'ocr_images':
      return 'proxy_ocr'
    case 'tts_chars':
      return 'proxy_tts'
  }
}

async function quotaLimit(
  entitlements: EntitlementService,
  user: AuthenticatedUser,
  kind: QuotaKind,
  now: Date,
): Promise<number> {
  const status = await entitlements.getStatus(user, now)
  switch (kind) {
    case 'stt_seconds':
      return status.sttSecondsLimit
    case 'llm_tokens':
      return status.llmTokensLimit
    case 'ocr_images':
      return status.ocrImagesLimit
    case 'tts_chars':
      return status.ttsCharsLimit
  }
}

function validateQuotaAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new ApiError(422, 'validation_failed', 'quota amount must be a non-negative integer')
  }
}

function idempotencyConflict(requestId: string): ApiError {
  void requestId
  return new ApiError(
    409,
    'idempotency_conflict',
    'idempotency key was already used for a different operation',
  )
}

function staleOperation(): ApiError {
  return new ApiError(409, 'operation_stale', 'quota operation lease is no longer current', false)
}

function quotaExceeded(kind: QuotaKind, requestId: string): ApiError {
  void requestId
  if (kind === 'stt_seconds') {
    return new ApiError(403, 'stt_quota_exceeded', 'STT quota exceeded')
  }
  if (kind === 'ocr_images') {
    return new ApiError(403, 'ocr_quota_exceeded', 'OCR quota exceeded')
  }
  if (kind === 'tts_chars') {
    return new ApiError(403, 'tts_quota_exceeded', 'TTS quota exceeded')
  }
  return new ApiError(403, 'llm_quota_exceeded', 'LLM quota exceeded')
}
