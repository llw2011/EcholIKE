import { ApiError } from '../errors.js'
import type { Middleware } from '../http.js'

export interface AuditRouteInfo {
  method: string
  path: string
  access: string
}

export function auditBusinessRoute(route: AuditRouteInfo): Middleware {
  return async (ctx, next) => {
    const startedAt = Date.now()
    try {
      const response = await next(ctx)
      await recordAudit(ctx, route, response.status, Date.now() - startedAt)
      return response
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500
      await recordAudit(ctx, route, status, Date.now() - startedAt)
      throw error
    }
  }
}

async function recordAudit(
  ctx: Parameters<Middleware>[0],
  route: AuditRouteInfo,
  status: number,
  durationMs: number,
): Promise<void> {
  await ctx.services.audit
    .record({
      userId: ctx.user?.id ?? null,
      requestId: ctx.requestId,
      action: `${route.method} ${route.path}`,
      metadata: {
        method: route.method,
        path: route.path,
        access: route.access,
        status,
        durationMs,
      },
    })
    .catch(() => undefined)
}
