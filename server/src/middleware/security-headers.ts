import type { Middleware } from '../http.js'

export const securityHeaders: Middleware = async (ctx, next) => {
  const response = await next(ctx)
  response.headers.set('x-content-type-options', 'nosniff')
  response.headers.set('x-frame-options', 'DENY')
  response.headers.set('referrer-policy', 'no-referrer')
  response.headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  )
  response.headers.set('cache-control', 'no-store')
  return response
}
