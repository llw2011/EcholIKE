import type { Middleware } from '../http.js'
import { unauthorized } from '../errors.js'
import type { RequestSessionVerifier } from '../auth/session.js'

export function requireAuth(verifier: RequestSessionVerifier): Middleware {
  return async (ctx, next) => {
    const user = await verifier(ctx.request)
    if (!user) {
      throw unauthorized()
    }

    ctx.user = user
    return next(ctx)
  }
}
