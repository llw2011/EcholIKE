import postgres from 'postgres'
import type { AuditLogStore } from '../../services/audit/audit-service.js'

export function createPostgresAuditLogStore(client: postgres.Sql): AuditLogStore {
  return {
    async record(input) {
      await client`
        insert into audit_log (user_id, request_id, action, metadata_json)
        values (
          ${input.userId},
          ${input.requestId},
          ${input.action},
          ${JSON.stringify(input.metadata)}::text::jsonb
        )
      `
    },
  }
}
