import { ApiError } from '../../errors.js'

export function safeDatabaseInteger(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(500, 'internal_error', `${label} exceeds the safe integer range`, false)
  }
  return parsed
}

export function postgresDateParameter(value: Date | null): string | null {
  if (value === null) return null
  if (!Number.isFinite(value.getTime())) throw new Error('database timestamp must be valid')
  return value.toISOString()
}

export function toNumber(value: number | string | undefined): number {
  return safeDatabaseInteger(value ?? 0, 'database integer')
}

export function timestampToIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

export function jsonArray<T>(value: unknown): T[] {
  const parsed = parseJsonValue(value)
  return Array.isArray(parsed) ? (parsed as T[]) : []
}

export function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
