import type { ServerEnv } from './env.js'
import type { AppServices } from './services/app-services.js'
import type { AuthenticatedUser } from './types.js'

export interface RequestContext {
  request: Request
  env: ServerEnv
  services: AppServices
  requestId: string
  idempotencyKey: string
  user: AuthenticatedUser | null
  state: Map<string, unknown>
}

export type Handler = (ctx: RequestContext) => Response | Promise<Response>
export type Middleware = (ctx: RequestContext, next: Handler) => Response | Promise<Response>

export function composeMiddleware(middleware: Middleware[], handler: Handler): Handler {
  return middleware.reduceRight<Handler>((next, current) => {
    return (ctx) => current(ctx, next)
  }, handler)
}
