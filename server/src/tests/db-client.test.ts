import { describe, expect, it } from 'vitest'
import { postgresDateParameter, postgresTimestampValue } from '../db/client.js'

describe('postgres db client helpers', () => {
  it('serializes OTA publishedAt values as ISO strings for postgres parameters', () => {
    const fallback = new Date('2026-07-08T03:00:00.000Z')

    expect(postgresTimestampValue(undefined, fallback)).toBe('2026-07-08T03:00:00.000Z')
    expect(postgresTimestampValue('2026-07-08T03:37:25.471Z', fallback)).toBe(
      '2026-07-08T03:37:25.471Z',
    )
    expect(() => postgresTimestampValue('not-a-date', fallback)).toThrow(
      'publishedAt must be a valid timestamp',
    )
  })

  it('serializes nullable database timestamps before postgres binding', () => {
    const periodStart = new Date('2026-07-21T01:02:03.456Z')

    expect(postgresDateParameter(periodStart)).toBe(periodStart.toISOString())
    expect(postgresDateParameter(null)).toBeNull()
    expect(() => postgresDateParameter(new Date(Number.NaN))).toThrow(
      'database timestamp must be valid',
    )
  })
})
