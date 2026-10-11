import type { Middleware } from '../http.js'
import { forbidden } from '../errors.js'
import { resolveBackendProxyAccess } from '../auth/backend-proxy-access.js'

export const requirePro: Middleware = async (ctx, next) => {
  if (!ctx.user) {
    throw forbidden('Authenticated user is required')
  }
  const status = await ctx.services.entitlements.getStatus(ctx.user)
  ctx.state.set('subscriptionStatus', status)

  if (status.plan !== 'pro') {
    throw forbidden('Pro plan required')
  }
  return next(ctx)
}

export const requireProOrBackendOperator: Middleware = async (ctx, next) => {
  if (!ctx.user) {
    throw forbidden('Authenticated user is required')
  }

  const access = await resolveBackendProxyAccess(ctx)
  if (!access.authorized) {
    throw forbidden('Pro plan required')
  }

  return next(ctx)
}
