import { json } from '../errors.js'
import type { Handler } from '../http.js'
import type { SubscriptionStatus } from '../types.js'

export const subscriptionStatus: Handler = async (ctx) => {
  const user = ctx.user
  if (!user) throw new Error('subscriptionStatus must be mounted behind requireAuth')

  const cachedStatus = ctx.state.get('subscriptionStatus')
  const status = isSubscriptionStatus(cachedStatus)
    ? cachedStatus
    : await ctx.services.entitlements.getStatus(user)

  return json(status)
}

function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SubscriptionStatus>
  return candidate.plan === 'free' || candidate.plan === 'pro'
}
