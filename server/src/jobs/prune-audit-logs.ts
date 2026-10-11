export interface AuditLogPruneStore {
  pruneBefore(cutoff: Date): Promise<number>
}

export interface AuditLogPruneOptions {
  retentionDays?: number
  now?: Date
}

export interface AuditLogPruneResult {
  cutoff: Date
  deletedCount: number
}

export async function pruneAuditLogsJob(
  store: AuditLogPruneStore,
  options: AuditLogPruneOptions = {},
): Promise<AuditLogPruneResult> {
  const cutoff = auditLogPruneCutoff(options)
  return {
    cutoff,
    deletedCount: await store.pruneBefore(cutoff),
  }
}

export function auditLogPruneCutoff({
  retentionDays = 90,
  now = new Date(),
}: AuditLogPruneOptions = {}): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('retentionDays must be a positive integer')
  }
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
}
