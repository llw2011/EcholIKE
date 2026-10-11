import { describe, expect, it } from 'vitest'
import { auditLogPruneCutoff, pruneAuditLogsJob } from '../jobs/prune-audit-logs.js'
import { resetMonthlyQuotaJob } from '../jobs/reset-monthly-quota.js'

describe('backend jobs', () => {
  it('keeps monthly quota reset non-mutating because usage is period keyed', async () => {
    const result = await resetMonthlyQuotaJob(new Date('2026-06-25T12:00:00.000Z'))

    expect(result).toEqual({
      currentPeriodKey: '2026-06',
      nextPeriodKey: '2026-07',
      nextResetAt: new Date('2026-07-01T00:00:00.000Z'),
      rowsMutated: 0,
    })
  })

  it('computes and applies audit log retention cutoff through an explicit store', async () => {
    const store = new RecordingPruneStore()

    const result = await pruneAuditLogsJob(store, {
      retentionDays: 30,
      now: new Date('2026-06-25T00:00:00.000Z'),
    })

    expect(result).toEqual({
      cutoff: new Date('2026-05-26T00:00:00.000Z'),
      deletedCount: 3,
    })
    expect(store.cutoff).toEqual(new Date('2026-05-26T00:00:00.000Z'))
  })

  it('rejects invalid audit retention windows', () => {
    expect(() => auditLogPruneCutoff({ retentionDays: 0 })).toThrow(/positive integer/)
  })
})

class RecordingPruneStore {
  cutoff: Date | null = null

  async pruneBefore(cutoff: Date): Promise<number> {
    this.cutoff = cutoff
    return 3
  }
}
