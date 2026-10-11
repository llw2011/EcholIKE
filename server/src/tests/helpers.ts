import { createApp } from '../app.js'
import { parseEnv, type ServerEnv } from '../env.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import type { AuthenticatedUser } from '../types.js'
import type { AppServices } from '../services/app-services.js'
import { createAdminService, createMemoryAdminStore } from '../services/admin/admin-service.js'
import {
  createAdminInsightsService,
  createMemoryAdminInsightsStore,
} from '../services/admin/admin-insights-service.js'
import { createAuditService, createMemoryAuditLogStore } from '../services/audit/audit-service.js'
import { createStaticEntitlementService } from '../services/billing/entitlements.js'
import { disabledBillingSessionService } from '../services/billing/stripe.js'
import {
  createMemoryQuotaLedgerStore,
  createQuotaService,
} from '../services/quota/quota-service.js'
import { createMemoryRateLimiter } from '../services/rate-limit/rate-limit-service.js'
import { disabledProxyServices } from '../services/proxy/proxy-services.js'
import { disabledDocumentOcrService } from '../services/ocr/document-ocr-service.js'
import { createSceneService, createStaticSceneStore } from '../services/scenes/scene-service.js'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
} from '../services/desktop/desktop-config-service.js'
import type { ProviderControlService } from '../services/security/provider-control-service.js'

const permissiveTestProviderControlService: ProviderControlService = {
  async assertSavable() {},
  async listModels() {
    throw new Error('Test provider model lookup is not configured')
  },
}

export function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): ServerEnv {
  return parseEnv({
    NODE_ENV: 'test',
    PORT: '8787',
    PUBLIC_API_BASE_URL: 'http://localhost:8787/echo-api',
    DATABASE_URL: 'postgres://echo:echo@localhost:5432/echo',
    BETTER_AUTH_SECRET: 'test-secret-with-enough-length',
    BETTER_AUTH_URL: 'http://localhost:8787',
    PROVIDER_CONTROL_DEADLINE_MS: '10000',
    PROVIDER_CONTROL_MAX_IN_FLIGHT: '2',
    ...overrides,
  })
}

export const freeUser: AuthenticatedUser = {
  id: 'user_free',
  email: 'free@example.com',
  name: null,
  plan: 'free',
  subscriptionEnd: null,
}

export const proUser: AuthenticatedUser = {
  id: 'user_pro',
  email: 'pro@example.com',
  name: 'Pro User',
  plan: 'pro',
  subscriptionEnd: '2026-12-31T00:00:00.000Z',
}

export function testServices(env = testEnv()): AppServices {
  const entitlements = createStaticEntitlementService(env.planLimits, {
    [freeUser.id]: {
      plan: 'free',
    },
    [proUser.id]: {
      plan: 'pro',
      subscriptionEnd: '2026-12-31T00:00:00.000Z',
    },
  })

  const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)

  return {
    database: {
      async ready() {
        return true
      },
      async close() {},
    },
    audit: createAuditService(createMemoryAuditLogStore()),
    rateLimit: createMemoryRateLimiter(),
    entitlements,
    billing: disabledBillingSessionService,
    quota: createQuotaService(entitlements, createMemoryQuotaLedgerStore()),
    proxy: disabledProxyServices,
    documentOcr: disabledDocumentOcrService,
    scenes: createSceneService(createStaticSceneStore([])),
    admin: createAdminService(createMemoryAdminStore()),
    adminInsights: createAdminInsightsService(createMemoryAdminInsightsStore()),
    desktopConfig,
    providerControl: permissiveTestProviderControlService,
    async warmup() {},
    async stopWorkers() {},
    async closeDatabase() {},
  }
}

export function testApp() {
  const env = testEnv()
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({
      'valid-free-token': freeUser,
      'valid-pro-token': proUser,
    }),
    services: testServices(env),
  })
}

export function request(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost:8787${path}`, init)
}
