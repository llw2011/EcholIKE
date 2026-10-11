import postgres from 'postgres'
import { postgresDateParameter } from './postgres/row-values.js'

export { createPostgresAdminStore } from './postgres/admin-store.js'
export { createPostgresAuditLogStore } from './postgres/audit-store.js'
export { createPostgresBillingStore } from './postgres/billing-store.js'
export {
  createPostgresDesktopConfigStore,
  OTA_CONTROL_LOCK_KEY,
  postgresTimestampValue,
} from './postgres/desktop-config-store.js'
export {
  createPostgresQuotaLedgerStore,
  decryptQuotaResponseBody,
  encryptQuotaResponseBody,
} from './postgres/quota-ledger-store.js'
export { createPostgresSceneStore } from './postgres/scene-store.js'
export { postgresDateParameter }

export interface DatabaseClient {
  ready(): Promise<boolean>
  close(): Promise<void>
}

export function createPostgresConnection(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, { max: 5, prepare: false })
}

export function createPostgresClient(client: postgres.Sql): DatabaseClient {
  return {
    async ready() {
      await client`select 1`
      return true
    },
    async close() {
      await client.end()
    },
  }
}
