import type { Middleware } from '../http.js'

export const requestIdMiddleware: Middleware = async (ctx, next) => {
  const response = await next(ctx)
  response.headers.set('x-request-id', ctx.requestId)
  response.headers.set('x-idempotency-key', ctx.idempotencyKey)
  return response
}
