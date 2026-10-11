import { json } from '../errors.js'
import type { Middleware } from '../http.js'

export interface InFlightLimit {
  perUser: number
  total: number
}

export function requireInFlightLimit(limit: InFlightLimit): Middleware {
  if (
    !Number.isInteger(limit.perUser) ||
    limit.perUser < 1 ||
    !Number.isInteger(limit.total) ||
    limit.total < limit.perUser
  ) {
    throw new Error('In-flight limits must be positive integers and total must cover perUser')
  }

  const activeByUser = new Map<string, number>()
  let activeTotal = 0
  return async (ctx, next) => {
    const identity = ctx.user?.id ?? 'anonymous'
    const active = activeByUser.get(identity) ?? 0
    if (active >= limit.perUser || activeTotal >= limit.total) {
      return json(
        {
          error: 'Another OCR request is already running',
          code: 'rate_limited',
          requestId: ctx.requestId,
        },
        { status: 429, headers: { 'retry-after': '1' } },
      )
    }

    activeByUser.set(identity, active + 1)
    activeTotal += 1
    try {
      return await next(ctx)
    } finally {
      activeTotal = Math.max(0, activeTotal - 1)
      const remaining = (activeByUser.get(identity) ?? 1) - 1
      if (remaining > 0) activeByUser.set(identity, remaining)
      else activeByUser.delete(identity)
    }
  }
}
