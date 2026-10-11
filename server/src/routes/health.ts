import { json } from '../errors.js'
import type { Handler } from '../http.js'

export const healthz: Handler = () =>
  json({
    ok: true,
    service: 'echo-api',
  })

export const readyz: Handler = async (ctx) => {
  const databaseReady = await ctx.services.database.ready().catch(() => false)

  return json(
    {
      ok: databaseReady,
      service: 'echo-api',
      dependencies: {
        databaseReady,
        authConfigured: Boolean(ctx.env.betterAuthSecret && ctx.env.betterAuthUrl),
      },
    },
    { status: databaseReady ? 200 : 503 },
  )
}
