import { ApiError, json } from '../errors.js'
import type { Handler } from '../http.js'
import {
  InvalidAdminInsightCursorError,
  type AdminQuotaOperationStatus,
} from '../services/admin/admin-insights-service.js'
import { utcPeriodKey } from '../services/quota/usage-ledger.js'
import type { QuotaKind } from '../services/quota/quota-service.js'

const DEFAULT_PAGE_LIMIT = 25
const MAX_PAGE_LIMIT = 100

export const adminOperationsOverview: Handler = async (ctx) => {
  const params = new URL(ctx.request.url).searchParams
  const periodKey = periodKeyParam(params.get('periodKey'))
  const { subject, ...overview } = await ctx.services.adminInsights.getOverview({
    periodKey,
    userId: null,
  })
  void subject
  return json({
    generatedAt: new Date().toISOString(),
    overview,
  })
}

export const adminUsageOverview: Handler = async (ctx) => {
  const params = new URL(ctx.request.url).searchParams
  const periodKey = periodKeyParam(params.get('periodKey'))
  const userId = optionalText(params.get('userId'), 180)
  const overview = await ctx.services.adminInsights.getOverview({ periodKey, userId })
  if (userId && !overview.subject) {
    throw new ApiError(404, 'not_found', '账号不存在或已删除')
  }
  return json({
    generatedAt: new Date().toISOString(),
    overview,
  })
}

export const adminAuditEntries: Handler = async (ctx) => {
  const params = new URL(ctx.request.url).searchParams
  try {
    const page = await ctx.services.adminInsights.listAudit({
      cursor: optionalText(params.get('cursor'), 2048),
      limit: pageLimit(params.get('limit')),
      query: optionalText(params.get('q'), 120),
      userId: optionalText(params.get('userId'), 180),
      minimumStatus: optionalInteger(params.get('minimumStatus'), 100, 599),
    })
    return json({ generatedAt: new Date().toISOString(), ...page })
  } catch (error) {
    if (error instanceof InvalidAdminInsightCursorError) throw invalidCursor()
    throw error
  }
}

export const adminQuotaOperations: Handler = async (ctx) => {
  const params = new URL(ctx.request.url).searchParams
  try {
    const page = await ctx.services.adminInsights.listQuotaOperations({
      cursor: optionalText(params.get('cursor'), 2048),
      limit: pageLimit(params.get('limit')),
      userId: optionalText(params.get('userId'), 180),
      periodKey: optionalPeriodKey(params.get('periodKey')),
      kind: quotaKindParam(params.get('kind')),
      status: operationStatusParam(params.get('status')),
    })
    return json({ generatedAt: new Date().toISOString(), ...page })
  } catch (error) {
    if (error instanceof InvalidAdminInsightCursorError) throw invalidCursor()
    throw error
  }
}

export const adminUserSessions: Handler = async (ctx) => {
  const params = new URL(ctx.request.url).searchParams
  const userId = requiredText(params.get('userId'), 'userId', 180)
  const includeExpired = params.get('includeExpired') === 'true'
  const sessions = await ctx.services.adminInsights.listUserSessions({
    userId,
    includeExpired,
    limit: pageLimit(params.get('limit')),
  })
  return json({ generatedAt: new Date().toISOString(), userId, sessions })
}

function pageLimit(value: string | null): number {
  if (value === null || value === '') return DEFAULT_PAGE_LIMIT
  return requiredInteger(value, 'limit', 1, MAX_PAGE_LIMIT)
}

function periodKeyParam(value: string | null): string {
  return optionalPeriodKey(value) ?? utcPeriodKey()
}

function optionalPeriodKey(value: string | null): string | null {
  const normalized = optionalText(value, 7)
  if (normalized === null) return null
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(normalized)) {
    throw new ApiError(422, 'validation_failed', 'periodKey must use YYYY-MM')
  }
  return normalized
}

function quotaKindParam(value: string | null): QuotaKind | null {
  const normalized = optionalText(value, 32)
  if (normalized === null) return null
  if (
    normalized !== 'stt_seconds' &&
    normalized !== 'llm_tokens' &&
    normalized !== 'ocr_images' &&
    normalized !== 'tts_chars'
  ) {
    throw new ApiError(422, 'validation_failed', 'kind is invalid')
  }
  return normalized
}

function operationStatusParam(value: string | null): AdminQuotaOperationStatus | null {
  const normalized = optionalText(value, 32)
  if (normalized === null) return null
  if (normalized !== 'reserved' && normalized !== 'completed' && normalized !== 'released') {
    throw new ApiError(422, 'validation_failed', 'status is invalid')
  }
  return normalized
}

function optionalInteger(value: string | null, min: number, max: number): number | null {
  if (value === null || value === '') return null
  return requiredInteger(value, 'number', min, max)
}

function requiredInteger(value: string, field: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) {
    throw new ApiError(422, 'validation_failed', `${field} is invalid`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(422, 'validation_failed', `${field} is invalid`)
  }
  return parsed
}

function optionalText(value: string | null, maxLength: number): string | null {
  if (value === null) return null
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > maxLength) {
    throw new ApiError(422, 'validation_failed', 'query value is too long')
  }
  return normalized
}

function requiredText(value: string | null, field: string, maxLength: number): string {
  const normalized = optionalText(value, maxLength)
  if (!normalized) throw new ApiError(422, 'validation_failed', `${field} is required`)
  return normalized
}

function invalidCursor(): ApiError {
  return new ApiError(422, 'validation_failed', '列表位置已失效，请刷新后重试')
}
