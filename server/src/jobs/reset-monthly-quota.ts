import { utcPeriodKey } from '../services/quota/usage-ledger.js'

export interface MonthlyQuotaResetResult {
  currentPeriodKey: string
  nextPeriodKey: string
  nextResetAt: Date
  rowsMutated: 0
}

export async function resetMonthlyQuotaJob(now = new Date()): Promise<MonthlyQuotaResetResult> {
  const nextResetAt = nextUtcMonthStart(now)
  return {
    currentPeriodKey: utcPeriodKey(now),
    nextPeriodKey: utcPeriodKey(nextResetAt),
    nextResetAt,
    rowsMutated: 0,
  }
}

function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}
