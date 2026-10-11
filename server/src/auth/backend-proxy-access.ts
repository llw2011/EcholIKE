import type { RequestContext } from '../http.js'
import type { AdminAccount } from '../services/admin/admin-service.js'
import type { SubscriptionStatus } from '../types.js'

const BACKEND_PROXY_ACCESS_STATE_KEY = 'backendProxyAccess'
const SUBSCRIPTION_STATUS_STATE_KEY = 'subscriptionStatus'
const PROXY_ADMIN_ROLES = new Set(['owner', 'admin', 'operator'])

export interface BackendProxyAccess {
  authorized: boolean
  reason: 'pro' | 'admin' | 'none'
  subscription: SubscriptionStatus
  adminAccount: AdminAccount | null
}

export async function resolveBackendProxyAccess(ctx: RequestContext): Promise<BackendProxyAccess> {
  const cached = ctx.state.get(BACKEND_PROXY_ACCESS_STATE_KEY)
  if (isBackendProxyAccess(cached)) return cached

  const user = ctx.user
  const subscription = user
    ? await ctx.services.entitlements.getStatus(user)
    : anonymousSubscriptionStatus(ctx)
  const adminAccount = user ? await ctx.services.admin.getAccount(user.id) : null
  const adminAuthorized = isBackendProxyAdmin(adminAccount)
  const authorized = Boolean(user && (subscription.plan === 'pro' || adminAuthorized))
  const access: BackendProxyAccess = {
    authorized,
    reason: subscription.plan === 'pro' ? 'pro' : adminAuthorized ? 'admin' : 'none',
    subscription,
    adminAccount,
  }

  ctx.state.set(BACKEND_PROXY_ACCESS_STATE_KEY, access)
  ctx.state.set(SUBSCRIPTION_STATUS_STATE_KEY, subscription)
  return access
}

export function isBackendProxyAdmin(account: AdminAccount | null): boolean {
  return Boolean(
    account && account.status === 'active' && PROXY_ADMIN_ROLES.has(account.role),
  )
}

function anonymousSubscriptionStatus(ctx: RequestContext): SubscriptionStatus {
  const limits = ctx.env.planLimits.free
  return {
    plan: 'free',
    subscriptionEnd: null,
    quotaLevel: 1,
    quotaMultiplier: 1,
    sttSecondsUsed: 0,
    sttSecondsLimit: limits.sttSecondsLimit,
    llmTokensUsed: 0,
    llmTokensLimit: limits.llmTokensLimit,
    ocrImagesUsed: 0,
    ocrImagesLimit: limits.ocrImagesLimit,
    ttsCharsUsed: 0,
    ttsCharsLimit: limits.ttsCharsLimit,
  }
}

function isBackendProxyAccess(value: unknown): value is BackendProxyAccess {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BackendProxyAccess>
  return Boolean(candidate.subscription && typeof candidate.authorized === 'boolean')
}
