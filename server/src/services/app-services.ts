import type { ServerEnv } from '../env.js'
import { createPostgresAdminInsightsStore } from '../db/admin-insights.js'
import {
  createPostgresConnection,
  createPostgresClient,
  createPostgresAuditLogStore,
  createPostgresAdminStore,
  createPostgresBillingStore,
  createPostgresDesktopConfigStore,
  createPostgresQuotaLedgerStore,
  createPostgresSceneStore,
  type DatabaseClient,
} from '../db/client.js'
import { createAdminService, type AdminService } from './admin/admin-service.js'
import {
  createAdminInsightsService,
  type AdminInsightsService,
} from './admin/admin-insights-service.js'
import { createAuditService, type AuditService } from './audit/audit-service.js'
import { createEntitlementService, type EntitlementService } from './billing/entitlements.js'
import { createStripeBillingSessionService, type BillingSessionService } from './billing/stripe.js'
import { createQuotaService, type QuotaService } from './quota/quota-service.js'
import { createMemoryRateLimiter, type RateLimiter } from './rate-limit/rate-limit-service.js'
import {
  createOcrProviderFetch,
  createProxyServices,
  type ProxyServices,
} from './proxy/proxy-services.js'
import {
  createDocumentOcrService,
  createLocalOcrExecutionGate,
  type DocumentOcrService,
  writeDocumentOcrFailureDiagnostic,
} from './ocr/document-ocr-service.js'
import { createLocalOcrRuntime } from './ocr/local-ocr-runtime.js'
import { createSceneService, type SceneService } from './scenes/scene-service.js'
import {
  createDesktopConfigService,
  type DesktopConfigService,
} from './desktop/desktop-config-service.js'
import {
  createProviderControlService,
  type ProviderControlService,
} from './security/provider-control-service.js'

export interface AppServices {
  database: DatabaseClient
  audit: AuditService
  rateLimit: RateLimiter
  entitlements: EntitlementService
  billing: BillingSessionService
  quota: QuotaService
  proxy: ProxyServices
  documentOcr: DocumentOcrService
  scenes: SceneService
  admin: AdminService
  adminInsights: AdminInsightsService
  desktopConfig: DesktopConfigService
  providerControl: ProviderControlService
  warmup(): Promise<void>
  stopWorkers(): Promise<void>
  closeDatabase(): Promise<void>
}

export function createDefaultServices(env: ServerEnv): AppServices {
  const postgresClient = createPostgresConnection(env.databaseUrl)
  const billingStore = createPostgresBillingStore(postgresClient)
  const entitlements = createEntitlementService(env.planLimits, billingStore)
  const providerControl = createProviderControlService({
    deadlineMs: env.providerControlDeadlineMs,
    maxInFlight: env.providerControlMaxInFlight,
  })
  const desktopConfig = createDesktopConfigService(
    createPostgresDesktopConfigStore(
      postgresClient,
      env.betterAuthSecret,
      env.providerControlDeadlineMs,
    ),
    env,
    { validateProvider: (input) => providerControl.assertSavable(input) },
  )
  const database = createPostgresClient(postgresClient)
  const localOcrExecutionGate = createLocalOcrExecutionGate()
  const localOcrRuntime = createLocalOcrRuntime(env, desktopConfig)
  const ocrFetch = createOcrProviderFetch(desktopConfig)
  const documentOcr = createDocumentOcrService(env, localOcrExecutionGate, {
    diagnosticSink: writeDocumentOcrFailureDiagnostic,
    localOcrRuntime,
  })
  return {
    database,
    audit: createAuditService(createPostgresAuditLogStore(postgresClient)),
    rateLimit: createMemoryRateLimiter(),
    entitlements,
    billing: createStripeBillingSessionService(env, billingStore),
    quota: createQuotaService(
      entitlements,
      createPostgresQuotaLedgerStore(postgresClient, env.betterAuthSecret),
    ),
    proxy: createProxyServices(env, desktopConfig, localOcrExecutionGate, {
      ocrFetch,
      localOcrRuntime,
    }),
    documentOcr,
    scenes: createSceneService(createPostgresSceneStore(postgresClient)),
    admin: createAdminService(createPostgresAdminStore(postgresClient)),
    adminInsights: createAdminInsightsService(
      createPostgresAdminInsightsStore(postgresClient, env.betterAuthSecret),
    ),
    desktopConfig,
    providerControl,
    async warmup() {
      await documentOcr.warmup()
    },
    async stopWorkers() {
      await documentOcr.shutdown()
    },
    async closeDatabase() {
      await database.close()
    },
  }
}
