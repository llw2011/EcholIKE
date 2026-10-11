import { ApiError } from '../../errors.js'

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(422, 'validation_failed', 'Request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

export function stringField(body: Record<string, unknown>, key: string, maxLength = 256): string {
  const value = body[key]
  if (typeof value !== 'string') {
    throw new ApiError(422, 'validation_failed', `${key} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return trimmed
}

export function optionalStringField(
  body: Record<string, unknown>,
  key: string,
  maxLength = 256,
): string | null {
  const value = body[key]
  if (value === undefined || value === null || value === '') return null
  return stringField(body, key, maxLength)
}

export function integerField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const rawValue = body[key]
  const value =
    typeof rawValue === 'string' && /^-?\d+$/.test(rawValue.trim()) ? Number(rawValue) : rawValue
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(
      422,
      'validation_failed',
      `${key} must be an integer between ${min} and ${max}`,
    )
  }
  return value
}

export function assertPeriodKey(value: string): void {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new ApiError(422, 'validation_failed', 'periodKey must use YYYY-MM')
  }
}

export const POSTGRES_INTEGER_MAX = 2 ** 31 - 1

export function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') {
    throw new ApiError(422, 'validation_failed', `${key} must be a boolean`)
  }
  return value
}

export function optionalIntegerField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null {
  if (body[key] === undefined || body[key] === null || body[key] === '') return null
  return integerField(body, key, min, max)
}
