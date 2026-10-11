import { ApiError, json } from '../../errors.js'
import type { Handler } from '../../http.js'
import { AdminIdempotencyConflictError } from '../../services/admin/admin-service.js'
import {
  quotaMultiplierForLevel,
  USER_QUOTA_LEVEL_MAX,
  USER_QUOTA_LEVEL_MIN,
} from '../../services/billing/entitlements.js'
import type { QuotaKind } from '../../services/quota/quota-service.js'
import type { UserQuotaLevel } from '../../types.js'
import { requireControlRole, throwAdminMutationError } from './control.js'
import {
  assertPeriodKey,
  integerField,
  optionalStringField,
  readJsonObject,
  stringField,
} from './http-fields.js'

export const adminAdjustQuota: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin', 'operator'])
  const idempotencyKey = adminIdempotencyKey(ctx.request.headers.get('x-idempotency-key'))
  const body = await readJsonObject(ctx.request)
  const userId = stringField(body, 'userId')
  const kind = quotaKindField(body, 'kind')
  const amount = quotaAdjustmentAmount(body)
  const periodKey = stringField(body, 'periodKey', 7)
  const reason = stringField(body, 'reason', 500)
  assertPeriodKey(periodKey)
  if (amount === 0) {
    throw new ApiError(422, 'validation_failed', 'Quota adjustment amount must not be zero')
  }

  let result
  try {
    result = await ctx.services.admin.adjustQuota({
      userId,
      kind,
      amount,
      periodKey,
      requestId: ctx.requestId,
      actorUserId: actor.userId,
      idempotencyKey,
      reason,
    })
  } catch (error) {
    if (error instanceof AdminIdempotencyConflictError) {
      throw new ApiError(
        409,
        'idempotency_conflict',
        '该幂等键已用于不同的配额调整，请重新发起操作',
      )
    }
    throwAdminMutationError(error)
  }

  return json({ ok: true, ...result })
}

export const adminSetUserQuotaLevel: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin', 'operator'])
  const body = await readJsonObject(ctx.request)
  const userId = stringField(body, 'userId')
  const quotaLevel = integerField(
    body,
    'quotaLevel',
    USER_QUOTA_LEVEL_MIN,
    USER_QUOTA_LEVEL_MAX,
  ) as UserQuotaLevel

  let profile
  try {
    profile = await ctx.services.admin.setUserQuotaLevel({
      userId,
      quotaLevel,
      actorUserId: actor.userId,
      requestId: ctx.requestId,
    })
  } catch (error) {
    throwAdminMutationError(error)
  }

  return json({
    ok: true,
    userId,
    quotaLevel: profile.quotaLevel,
    quotaMultiplier: quotaMultiplierForLevel(profile.quotaLevel),
  })
}

const ADMIN_IDEMPOTENCY_KEY_MIN_LENGTH = 16
const ADMIN_IDEMPOTENCY_KEY_MAX_LENGTH = 200
const ADMIN_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/

function adminIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (
    normalized.length < ADMIN_IDEMPOTENCY_KEY_MIN_LENGTH ||
    normalized.length > ADMIN_IDEMPOTENCY_KEY_MAX_LENGTH ||
    !ADMIN_IDEMPOTENCY_KEY_PATTERN.test(normalized)
  ) {
    throw new ApiError(
      422,
      'validation_failed',
      'x-idempotency-key 必须是 16 到 200 个 URL 安全字符',
    )
  }
  return normalized
}

function quotaKindField(body: Record<string, unknown>, key: string): QuotaKind {
  const value = stringField(body, key)
  if (
    value !== 'stt_seconds' &&
    value !== 'llm_tokens' &&
    value !== 'ocr_images' &&
    value !== 'tts_chars'
  ) {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return value
}

function quotaAdjustmentAmount(body: Record<string, unknown>): number {
  const rawAmount = integerField(body, 'amount', -10_000_000, 10_000_000)
  const mode = optionalStringField(body, 'mode') ?? 'raw'

  if (mode === 'grant') return -Math.abs(rawAmount)
  if (mode === 'consume') return Math.abs(rawAmount)
  if (mode === 'raw') return rawAmount

  throw new ApiError(422, 'validation_failed', 'mode is invalid')
}
