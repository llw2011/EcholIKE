export interface AuditLogInput {
  userId: string | null
  requestId: string
  action: string
  metadata: Record<string, unknown>
}

export interface AuditLogStore {
  record(input: AuditLogInput): Promise<void>
}

export interface AuditService {
  record(input: AuditLogInput): Promise<void>
}

export function createAuditService(store: AuditLogStore): AuditService {
  return {
    record(input) {
      return store.record({
        ...input,
        metadata: sanitizeMetadata(input.metadata),
      })
    },
  }
}

export const disabledAuditService: AuditService = {
  async record() {},
}

export function createMemoryAuditLogStore(): AuditLogStore & { entries: AuditLogInput[] } {
  const entries: AuditLogInput[] = []
  return {
    entries,
    async record(input) {
      entries.push({
        ...input,
        metadata: sanitizeMetadata(input.metadata),
      })
    },
  }
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (/authorization|cookie|token|secret|password|api[_-]?key/i.test(key)) continue
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      sanitized[key] = value
    }
  }
  return sanitized
}
