import { json } from '../errors.js'
import type { Middleware, RequestContext } from '../http.js'
import type { RateLimitRule } from '../services/rate-limit/rate-limit-service.js'

export type RateLimitIdentity = 'ip' | 'user'

export interface RouteRateLimitPolicy {
  identity: RateLimitIdentity
  rule: RateLimitRule
}

export function requireRateLimit(policies: RouteRateLimitPolicy[]): Middleware {
  return async (ctx, next) => {
    for (const policy of policies) {
      const identity = resolveIdentity(ctx, policy.identity)
      const decision = await ctx.services.rateLimit.check({
        identity,
        rule: policy.rule,
      })

      if (!decision.allowed) {
        return json(
          {
            error: 'Rate limit exceeded',
            code: 'rate_limited',
            requestId: ctx.requestId,
          },
          {
            status: 429,
            headers: {
              'retry-after': String(decision.retryAfterSeconds),
            },
          },
        )
      }
    }

    return next(ctx)
  }
}

function resolveIdentity(ctx: RequestContext, identity: RateLimitIdentity): string {
  if (identity === 'user') {
    return ctx.user ? `user:${ctx.user.id}` : `ip:${clientIp(ctx.request)}`
  }
  return `ip:${clientIp(ctx.request)}`
}

function clientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const realIp = request.headers.get('x-real-ip')?.trim()
  const cfIp = request.headers.get('cf-connecting-ip')?.trim()
  // The deployment proxy overwrites X-Real-IP with its direct peer address,
  // while X-Forwarded-For may retain a client-supplied first hop.
  return realIp || cfIp || forwardedFor || 'unknown'
}
