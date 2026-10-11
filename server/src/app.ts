import { Hono, type Handler as HonoHandler, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { createAuth } from './auth/auth.js'
import {
  createBearerRequestSessionVerifier,
  createBetterAuthRequestSessionVerifier,
  type SessionVerifier,
} from './auth/session.js'
import type { ServerEnv } from './env.js'
import { ApiError, errorResponse, unauthorized } from './errors.js'
import { composeMiddleware, type Handler, type Middleware, type RequestContext } from './http.js'
import { adminPanelDashboard, adminPanelLogin } from './routes/admin-panel.js'
import { appUpdateStatus, appUpdateTauriManifest } from './routes/app-update.js'
import {
  adminAdjustQuota,
  adminActivateOtaRelease,
  adminCheckLlm,
  adminCreateUser,
  adminDeactivateOtaRelease,
  adminDesktopPolicy,
  adminOtaReleases,
  adminProviderModels,
  adminProviders,
  adminProxyStatus,
  adminResetUserPassword,
  adminScenePacks,
  adminSetAdminAccount,
  adminSetUserQuotaLevel,
  adminSummary,
  adminSystem,
  adminUpsertOtaRelease,
  adminUpsertProvider,
  adminUpsertScenePack,
  adminUsers,
  adminValidateOtaRelease,
} from './routes/admin.js'
import {
  adminAuditEntries,
  adminOperationsOverview,
  adminQuotaOperations,
  adminUsageOverview,
  adminUserSessions,
} from './routes/admin-insights.js'
import { desktopBootstrap } from './routes/desktop-bootstrap.js'
import { healthz, readyz } from './routes/health.js'
import { proxyLlm } from './routes/proxy-llm.js'
import { proxyOcr } from './routes/proxy-ocr.js'
import { proxyOcrDocument } from './routes/proxy-ocr-document.js'
import { proxyStt } from './routes/proxy-stt.js'
import { proxyTts } from './routes/proxy-tts.js'
import { subscriptionStatus } from './routes/subscription.js'
import { stripeWebhook } from './routes/stripe-webhook.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { securityHeaders } from './middleware/security-headers.js'
import { requireAuth } from './middleware/require-auth.js'
import {
  requireAdmin,
  requireAdminCapability,
  type AdminCapability,
} from './middleware/require-admin.js'
import {
  ADMIN_ACTOR_HEADER,
  requireAdminActorPrecondition,
  requireAdminWriteOrigin,
  verifyAdminActorPreconditionIfPresent,
} from './middleware/admin-origin.js'
import { requirePro, requireProOrBackendOperator } from './middleware/require-pro.js'
import { requireContentLengthBelow } from './middleware/body-limit.js'
import { requireContentType, type RequiredContentType } from './middleware/content-type.js'
import { requireInFlightLimit, type InFlightLimit } from './middleware/in-flight-limit.js'
import { auditBusinessRoute } from './middleware/audit-log.js'
import { requireRateLimit, type RouteRateLimitPolicy } from './middleware/rate-limit.js'
import { createDefaultServices, type AppServices } from './services/app-services.js'
import { authBasePath, joinApiPath } from './paths.js'

export interface CreateAppOptions {
  env: ServerEnv
  sessionVerifier?: SessionVerifier
  services?: AppServices
}

type EchoHonoEnv = {
  Variables: {
    requestContext: RequestContext
  }
}

export type EchoApp = Hono<EchoHonoEnv>

export interface BusinessRouteSpec {
  method: 'GET' | 'POST'
  path: string
  access: 'auth' | 'pro'
  maxBodyBytes?: number
  inFlightLimit?: InFlightLimit
  inFlightGroup?: string
  requiredContentType?: RequiredContentType
  rateLimits: RouteRateLimitPolicy[]
  handler: Handler
}

export interface AdminRouteSpec {
  method: 'GET' | 'POST'
  path: string
  access: 'admin'
  capability: AdminCapability
  maxBodyBytes?: number
  rateLimits: RouteRateLimitPolicy[]
  handler: Handler
}

const JSON_BODY_LIMIT = 1 * 1024 * 1024
// A 25 MiB decoded image expands to 34,952,536 Base64 bytes. Keep enough
// JSON envelope headroom while the legacy 0.2.3 proxy contract remains Base64.
const OCR_BODY_LIMIT = 36 * 1024 * 1024
const OCR_DOCUMENT_BODY_LIMIT = 25 * 1024 * 1024 + 512 * 1024
const STT_UPLOAD_LIMIT = 25 * 1024 * 1024
const STRIPE_WEBHOOK_BODY_LIMIT = 512 * 1024
const READ_RATE_LIMIT: RouteRateLimitPolicy[] = [
  { identity: 'user', rule: { name: 'business-read:user', limit: 120, windowSeconds: 60 } },
  { identity: 'ip', rule: { name: 'business-read:ip', limit: 240, windowSeconds: 60 } },
]
const ADMIN_READ_RATE_LIMIT: RouteRateLimitPolicy[] = [
  { identity: 'user', rule: { name: 'admin-read:user', limit: 180, windowSeconds: 60 } },
  { identity: 'ip', rule: { name: 'admin-read:ip', limit: 360, windowSeconds: 60 } },
]
const ADMIN_PASSWORD_RATE_LIMIT: RouteRateLimitPolicy[] = [
  { identity: 'user', rule: { name: 'admin-password:user', limit: 10, windowSeconds: 60 } },
  { identity: 'ip', rule: { name: 'admin-password:ip', limit: 30, windowSeconds: 60 } },
]
const PROXY_RATE_LIMIT: RouteRateLimitPolicy[] = [
  { identity: 'user', rule: { name: 'proxy:user', limit: 60, windowSeconds: 60 } },
  { identity: 'ip', rule: { name: 'proxy:ip', limit: 120, windowSeconds: 60 } },
]
const OTA_UPDATE_RATE_LIMIT: RouteRateLimitPolicy[] = [
  { identity: 'ip', rule: { name: 'ota-update:ip', limit: 60, windowSeconds: 60 } },
]
export const businessRouteSpecs: BusinessRouteSpec[] = [
  {
    method: 'GET',
    path: '/subscription/status',
    access: 'auth',
    rateLimits: READ_RATE_LIMIT,
    handler: subscriptionStatus,
  },
  {
    method: 'POST',
    path: '/proxy/stt',
    access: 'pro',
    maxBodyBytes: STT_UPLOAD_LIMIT,
    rateLimits: PROXY_RATE_LIMIT,
    handler: proxyStt,
  },
  {
    method: 'POST',
    path: '/proxy/llm',
    access: 'pro',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: PROXY_RATE_LIMIT,
    handler: proxyLlm,
  },
  {
    method: 'POST',
    path: '/proxy/tts',
    access: 'pro',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: PROXY_RATE_LIMIT,
    handler: proxyTts,
  },
  {
    method: 'POST',
    path: '/proxy/ocr',
    access: 'pro',
    maxBodyBytes: OCR_BODY_LIMIT,
    inFlightLimit: { perUser: 1, total: 4 },
    inFlightGroup: 'ocr',
    rateLimits: PROXY_RATE_LIMIT,
    handler: proxyOcr,
  },
  {
    method: 'POST',
    path: '/proxy/ocr/document',
    access: 'pro',
    maxBodyBytes: OCR_DOCUMENT_BODY_LIMIT,
    inFlightLimit: { perUser: 1, total: 4 },
    inFlightGroup: 'ocr',
    requiredContentType: {
      mimeType: 'multipart/form-data',
      status: 415,
      code: 'ocr_document_invalid',
      message: 'PDF 识别需要使用文件上传格式。',
    },
    rateLimits: PROXY_RATE_LIMIT,
    handler: proxyOcrDocument,
  },
]

export const adminRouteSpecs: AdminRouteSpec[] = [
  {
    method: 'GET',
    path: '/admin/summary',
    access: 'admin',
    capability: 'overview:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminSummary,
  },
  {
    method: 'GET',
    path: '/admin/operations-overview',
    access: 'admin',
    capability: 'overview:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminOperationsOverview,
  },
  {
    method: 'GET',
    path: '/admin/system',
    access: 'admin',
    capability: 'system:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminSystem,
  },
  {
    method: 'GET',
    path: '/admin/proxy-status',
    access: 'admin',
    capability: 'services:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminProxyStatus,
  },
  {
    method: 'GET',
    path: '/admin/desktop-policy',
    access: 'admin',
    capability: 'services:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminDesktopPolicy,
  },
  {
    method: 'GET',
    path: '/admin/providers',
    access: 'admin',
    capability: 'services:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminProviders,
  },
  {
    method: 'POST',
    path: '/admin/providers',
    access: 'admin',
    capability: 'providers:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminUpsertProvider,
  },
  {
    method: 'POST',
    path: '/admin/provider-models',
    access: 'admin',
    capability: 'providers:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminProviderModels,
  },
  {
    method: 'POST',
    path: '/admin/checkup/llm',
    access: 'admin',
    capability: 'diagnostics:run',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminCheckLlm,
  },
  {
    method: 'GET',
    path: '/admin/ota-releases',
    access: 'admin',
    capability: 'releases:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminOtaReleases,
  },
  {
    method: 'POST',
    path: '/admin/ota-releases',
    access: 'admin',
    capability: 'releases:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminUpsertOtaRelease,
  },
  {
    method: 'POST',
    path: '/admin/ota-releases/validate',
    access: 'admin',
    capability: 'releases:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminValidateOtaRelease,
  },
  {
    method: 'POST',
    path: '/admin/ota-releases/activate',
    access: 'admin',
    capability: 'releases:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminActivateOtaRelease,
  },
  {
    method: 'POST',
    path: '/admin/ota-releases/deactivate',
    access: 'admin',
    capability: 'releases:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminDeactivateOtaRelease,
  },
  {
    method: 'GET',
    path: '/admin/users',
    access: 'admin',
    capability: 'users:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminUsers,
  },
  {
    method: 'GET',
    path: '/admin/user-sessions',
    access: 'admin',
    capability: 'users:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminUserSessions,
  },
  {
    method: 'GET',
    path: '/admin/quota-operations',
    access: 'admin',
    capability: 'usage:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminQuotaOperations,
  },
  {
    method: 'GET',
    path: '/admin/usage-overview',
    access: 'admin',
    capability: 'usage:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminUsageOverview,
  },
  {
    method: 'GET',
    path: '/admin/audit',
    access: 'admin',
    capability: 'audit:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminAuditEntries,
  },
  {
    method: 'POST',
    path: '/admin/users',
    access: 'admin',
    capability: 'users:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminCreateUser,
  },
  {
    method: 'POST',
    path: '/admin/admin-accounts',
    access: 'admin',
    capability: 'users:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminSetAdminAccount,
  },
  {
    method: 'POST',
    path: '/admin/user-passwords',
    access: 'admin',
    capability: 'users:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_PASSWORD_RATE_LIMIT,
    handler: adminResetUserPassword,
  },
  {
    method: 'POST',
    path: '/admin/quota-adjustments',
    access: 'admin',
    capability: 'quota:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminAdjustQuota,
  },
  {
    method: 'POST',
    path: '/admin/user-quota-levels',
    access: 'admin',
    capability: 'quota:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminSetUserQuotaLevel,
  },
  {
    method: 'GET',
    path: '/admin/scenes',
    access: 'admin',
    capability: 'scenes:read',
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminScenePacks,
  },
  {
    method: 'POST',
    path: '/admin/scenes',
    access: 'admin',
    capability: 'scenes:write',
    maxBodyBytes: JSON_BODY_LIMIT,
    rateLimits: ADMIN_READ_RATE_LIMIT,
    handler: adminUpsertScenePack,
  },
]

export function createApp(options: CreateAppOptions): EchoApp {
  const authServer = createAuth(options.env)
  const requestSessionVerifier = options.sessionVerifier
    ? createBearerRequestSessionVerifier(options.sessionVerifier)
    : createBetterAuthRequestSessionVerifier(authServer)
  const services = options.services ?? createDefaultServices(options.env)
  const auth = requireAuth(requestSessionVerifier)
  const optionalAuth: Middleware = async (ctx, next) => {
    const explicitAuthorization = ctx.request.headers.get('authorization') !== null
    if (!explicitAuthorization) return next(ctx)

    const user = await requestSessionVerifier(ctx.request)
    if (!user) {
      throw unauthorized()
    }

    ctx.user = user
    return next(ctx)
  }
  const pro = requirePro
  const inFlightGroups = new Map<
    string,
    { limit: InFlightLimit; middleware: ReturnType<typeof requireInFlightLimit> }
  >()

  const app = new Hono<EchoHonoEnv>()

  app.use('*', createContextMiddleware(options.env, services))
  app.use(
    '*',
    cors({
      origin: (origin) => (options.env.corsAllowedOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: [
        'authorization',
        'content-type',
        'x-request-id',
        'x-idempotency-key',
        ADMIN_ACTOR_HEADER,
        'stripe-signature',
      ],
      exposeHeaders: ['x-request-id', 'x-idempotency-key', 'retry-after', 'set-auth-token'],
      credentials: true,
      maxAge: 600,
    }),
  )
  app.onError((error, c) => {
    const ctx = c.get('requestContext')
    return applyResponseMiddleware(errorResponse(error, ctx.requestId), ctx)
  })
  app.notFound((c) => {
    const ctx = c.get('requestContext')
    return applyResponseMiddleware(
      errorResponse(new ApiError(404, 'not_found', 'Not found'), ctx.requestId),
      ctx,
    )
  })

  // Public routes.
  app.get(publicRoute(options.env, '/healthz'), adaptHandler([], healthz))
  app.get(publicRoute(options.env, '/readyz'), adaptHandler([], readyz))
  app.post(
    publicRoute(options.env, '/stripe/webhook'),
    adaptHandler([requireContentLengthBelow(STRIPE_WEBHOOK_BODY_LIMIT)], stripeWebhook),
  )
  app.get(
    publicRoute(options.env, '/app/update'),
    adaptHandler([requireRateLimit(OTA_UPDATE_RATE_LIMIT)], appUpdateStatus),
  )
  app.get(
    publicRoute(options.env, '/app/update/tauri'),
    adaptHandler([requireRateLimit(OTA_UPDATE_RATE_LIMIT)], appUpdateTauriManifest),
  )
  app.get(
    publicRoute(options.env, '/desktop/bootstrap'),
    adaptHandler([optionalAuth, requireRateLimit(READ_RATE_LIMIT)], desktopBootstrap),
  )
  const panelFencedAuthAction = adaptHandler(
    [auth, verifyAdminActorPreconditionIfPresent, requireAdminWriteOrigin],
    (ctx) => authServer.handler(ctx.request),
  )
  for (const action of ['/change-password', '/sign-out']) {
    app.post(joinApiPath(authBasePath(options.env.apiBasePath), action), (c, next) =>
      c.req.raw.headers.has(ADMIN_ACTOR_HEADER)
        ? panelFencedAuthAction(c, next)
        : authServer.handler(c.req.raw),
    )
  }
  app.on(['GET', 'POST'], joinApiPath(authBasePath(options.env.apiBasePath), '/*'), (c) =>
    authServer.handler(c.req.raw),
  )
  app.get('/echo-panel/login', adaptHandler([], adminPanelLogin))
  app.get('/echo-panel', (c) => c.redirect('/echo-panel/', 308))
  app.get('/echo-panel/', adaptPanelHandler([auth, requireAdmin], adminPanelDashboard))

  for (const route of businessRouteSpecs) {
    const middleware: Middleware[] = [
      auth,
      auditBusinessRoute({ ...route, path: publicRoute(options.env, route.path) }),
    ]
    if (route.access === 'pro') {
      middleware.push(route.path.startsWith('/proxy/') ? requireProOrBackendOperator : pro)
    }
    middleware.push(requireRateLimit(route.rateLimits))
    if (route.inFlightLimit) {
      const key = route.inFlightGroup ?? `${route.method}:${route.path}`
      const existing = inFlightGroups.get(key)
      if (existing) {
        if (
          existing.limit.perUser !== route.inFlightLimit.perUser ||
          existing.limit.total !== route.inFlightLimit.total
        ) {
          throw new Error(`In-flight group ${key} has conflicting limits`)
        }
        middleware.push(existing.middleware)
      } else {
        const gate = requireInFlightLimit(route.inFlightLimit)
        inFlightGroups.set(key, { limit: route.inFlightLimit, middleware: gate })
        middleware.push(gate)
      }
    }
    if (route.requiredContentType) middleware.push(requireContentType(route.requiredContentType))
    if (route.maxBodyBytes) middleware.push(requireContentLengthBelow(route.maxBodyBytes))
    mountBusinessRoute(app, options.env, route, middleware)
  }

  for (const route of adminRouteSpecs) {
    const middleware: Middleware[] = [
      auth,
      requireAdminActorPrecondition,
      requireAdmin,
      requireAdminCapability(route.capability),
      auditBusinessRoute({ ...route, path: publicRoute(options.env, route.path) }),
    ]
    if (route.method === 'POST') middleware.push(requireAdminWriteOrigin)
    middleware.push(requireRateLimit(route.rateLimits))
    if (route.maxBodyBytes) middleware.push(requireContentLengthBelow(route.maxBodyBytes))
    mountBusinessRoute(app, options.env, route, middleware)
  }

  return app
}

function createContextMiddleware(
  env: ServerEnv,
  services: AppServices,
): MiddlewareHandler<EchoHonoEnv> {
  return async (c, next) => {
    const requestId = c.req.raw.headers.get('x-request-id')?.trim() || crypto.randomUUID()
    const suppliedIdempotencyKey = c.req.raw.headers.get('x-idempotency-key')
    const idempotencyKey = suppliedIdempotencyKey?.trim() || crypto.randomUUID()
    c.set('requestContext', {
      request: c.req.raw,
      env,
      services,
      requestId,
      idempotencyKey,
      user: null,
      state: new Map(),
    })

    if (
      suppliedIdempotencyKey !== null &&
      !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(suppliedIdempotencyKey.trim())
    ) {
      throw new ApiError(
        422,
        'idempotency_key_invalid',
        'x-idempotency-key must be 1 to 128 URL-safe characters',
      )
    }

    await next()
    c.res = await applyResponseMiddleware(c.res, c.get('requestContext'))
  }
}

function adaptHandler(middleware: Middleware[], handler: Handler): HonoHandler<EchoHonoEnv> {
  return async (c) => composeMiddleware(middleware, handler)(c.get('requestContext'))
}

function adaptPanelHandler(middleware: Middleware[], handler: Handler): HonoHandler<EchoHonoEnv> {
  return async (c) => {
    try {
      return await composeMiddleware(middleware, handler)(c.get('requestContext'))
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return c.redirect('/echo-panel/login', 302)
      }
      if (error instanceof ApiError && error.status === 403) {
        return new Response('Forbidden', {
          status: 403,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      throw error
    }
  }
}

function mountBusinessRoute(
  app: EchoApp,
  env: ServerEnv,
  route: BusinessRouteSpec | AdminRouteSpec,
  middleware: Middleware[],
): void {
  const handler = adaptHandler(middleware, route.handler)
  const path = publicRoute(env, route.path)
  if (route.method === 'GET') {
    app.get(path, handler)
    return
  }
  app.post(path, handler)
}

export function publicRoute(env: ServerEnv, path: string): string {
  return joinApiPath(env.apiBasePath, path)
}

function applyResponseMiddleware(response: Response, ctx: RequestContext): Promise<Response> {
  return Promise.resolve(
    composeMiddleware([requestIdMiddleware, securityHeaders], () => response)(ctx),
  )
}
