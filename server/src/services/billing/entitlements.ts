import type {
  AuthenticatedUser,
  Plan,
  PlanLimits,
  SubscriptionStatus,
  UserQuotaLevel,
} from '../../types.js'
import { utcPeriodKey } from '../quota/usage-ledger.js'

export function limitsForPlan(planLimits: Record<Plan, PlanLimits>, plan: Plan): PlanLimits {
  return planLimits[plan]
}

export const USER_QUOTA_LEVEL_MIN = 1
export const USER_QUOTA_LEVEL_MAX = 5

export interface UserQuotaProfile {
  quotaLevel: UserQuotaLevel
}

export interface UserQuotaLevelOption {
  quotaLevel: UserQuotaLevel
  quotaMultiplier: number
  label: string
}

export function normalizeQuotaLevel(value: unknown): UserQuotaLevel {
  const numericValue =
    typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value
  if (!Number.isInteger(numericValue)) return USER_QUOTA_LEVEL_MIN
  const bounded = Math.min(
    USER_QUOTA_LEVEL_MAX,
    Math.max(USER_QUOTA_LEVEL_MIN, numericValue as number),
  )
  return bounded as UserQuotaLevel
}

export function quotaMultiplierForLevel(level: unknown): number {
  return normalizeQuotaLevel(level)
}

export function applyQuotaLevel(limits: PlanLimits, level: number): PlanLimits {
  const multiplier = quotaMultiplierForLevel(level)
  return {
    ...limits,
    sttSecondsLimit: limits.sttSecondsLimit * multiplier,
    llmTokensLimit: limits.llmTokensLimit * multiplier,
    ocrImagesLimit: limits.ocrImagesLimit * multiplier,
    ttsCharsLimit: limits.ttsCharsLimit * multiplier,
  }
}

export function userQuotaLevelOptions(): UserQuotaLevelOption[] {
  const levels: UserQuotaLevel[] = [1, 2, 3, 4, 5]
  return levels.map((quotaLevel) => ({
    quotaLevel,
    quotaMultiplier: quotaMultiplierForLevel(quotaLevel),
    label: `Lv.${quotaLevel}`,
  }))
}

export type SubscriptionStoreStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'

export interface SubscriptionRecord {
  plan: Plan
  status: SubscriptionStoreStatus
  currentPeriodEnd: Date | null
  stripeCustomerId: string | null
}

export interface StripeCustomerInput {
  userId: string
  stripeCustomerId: string
}

export interface StripeSubscriptionInput {
  userId: string
  stripeCustomerId: string
  stripeSubscriptionId: string | null
  plan: Plan
  status: SubscriptionStoreStatus
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
}

export interface StripeSubscriptionWebhookMutation extends Omit<StripeSubscriptionInput, 'userId'> {
  kind: 'subscription_upsert'
  userId: string | null
  stripeSubscriptionId: string
}

export type StripeWebhookMutation =
  | { kind: 'none' }
  | {
      kind: 'customer_upsert'
      userId: string
      stripeCustomerId: string
    }
  | StripeSubscriptionWebhookMutation

export interface StripeWebhookApplyInput {
  id: string
  type: string
  eventCreatedAt: Date
  mutation: StripeWebhookMutation
  resolveSubscription?: () => Promise<StripeSubscriptionWebhookMutation>
}

export interface StripeWebhookApplyResult {
  duplicate: boolean
}

export class StripeWebhookUserMappingMissingError extends Error {
  constructor() {
    super('Stripe subscription customer is not mapped to a user')
    this.name = 'StripeWebhookUserMappingMissingError'
  }
}

export class StripeCustomerMappingConflictError extends Error {
  constructor() {
    super('Stripe customer is already mapped to another user')
    this.name = 'StripeCustomerMappingConflictError'
  }
}

export interface UsageTotals {
  sttSecondsUsed: number
  llmTokensUsed: number
  ocrImagesUsed: number
  ttsCharsUsed: number
}

export interface BillingStore {
  getCurrentSubscription(userId: string): Promise<SubscriptionRecord | null>
  getUserQuotaProfile(userId: string): Promise<UserQuotaProfile | null>
  getUsageTotals(userId: string, periodKey: string): Promise<UsageTotals>
  upsertStripeCustomer(input: StripeCustomerInput): Promise<void>
  getUserIdByStripeCustomerId(stripeCustomerId: string): Promise<string | null>
  upsertStripeSubscription(input: StripeSubscriptionInput): Promise<void>
  applyStripeWebhook(input: StripeWebhookApplyInput): Promise<StripeWebhookApplyResult>
}

export interface EntitlementService {
  getStatus(user: AuthenticatedUser, now?: Date): Promise<SubscriptionStatus>
}

export const emptyBillingStore: BillingStore = {
  async getCurrentSubscription() {
    return null
  },
  async getUserQuotaProfile() {
    return null
  },
  async getUsageTotals() {
    return {
      sttSecondsUsed: 0,
      llmTokensUsed: 0,
      ocrImagesUsed: 0,
      ttsCharsUsed: 0,
    }
  },
  async upsertStripeCustomer() {},
  async getUserIdByStripeCustomerId() {
    return null
  },
  async upsertStripeSubscription() {},
  async applyStripeWebhook() {
    return { duplicate: false }
  },
}

export function createEntitlementService(
  planLimits: Record<Plan, PlanLimits>,
  store: BillingStore,
): EntitlementService {
  return {
    async getStatus(user, now = new Date()) {
      const periodKey = utcPeriodKey(now)
      const [subscription, usage, profile] = await Promise.all([
        store.getCurrentSubscription(user.id),
        store.getUsageTotals(user.id, periodKey),
        store.getUserQuotaProfile(user.id),
      ])

      const plan = activePlan(subscription, now)
      const quotaLevel = profile?.quotaLevel ?? USER_QUOTA_LEVEL_MIN
      const quotaMultiplier = quotaMultiplierForLevel(quotaLevel)
      const limits = applyQuotaLevel(limitsForPlan(planLimits, plan), quotaLevel)

      return {
        plan,
        subscriptionEnd:
          plan === 'pro' ? (subscription?.currentPeriodEnd?.toISOString() ?? null) : null,
        quotaLevel,
        quotaMultiplier,
        sttSecondsUsed: usage.sttSecondsUsed,
        sttSecondsLimit: limits.sttSecondsLimit,
        llmTokensUsed: usage.llmTokensUsed,
        llmTokensLimit: limits.llmTokensLimit,
        ocrImagesUsed: usage.ocrImagesUsed,
        ocrImagesLimit: limits.ocrImagesLimit,
        ttsCharsUsed: usage.ttsCharsUsed,
        ttsCharsLimit: limits.ttsCharsLimit,
      }
    },
  }
}

export function createStaticEntitlementService(
  planLimits: Record<Plan, PlanLimits>,
  recordsByUserId: Record<string, Partial<SubscriptionStatus>>,
): EntitlementService {
  return {
    async getStatus(user) {
      const record = recordsByUserId[user.id]
      const plan = record?.plan ?? 'free'
      const quotaLevel = normalizeQuotaLevel(record?.quotaLevel)
      const quotaMultiplier = quotaMultiplierForLevel(quotaLevel)
      const limits = applyQuotaLevel(limitsForPlan(planLimits, plan), quotaLevel)
      return {
        plan,
        subscriptionEnd: record?.subscriptionEnd ?? null,
        quotaLevel,
        quotaMultiplier,
        sttSecondsUsed: record?.sttSecondsUsed ?? 0,
        sttSecondsLimit: record?.sttSecondsLimit ?? limits.sttSecondsLimit,
        llmTokensUsed: record?.llmTokensUsed ?? 0,
        llmTokensLimit: record?.llmTokensLimit ?? limits.llmTokensLimit,
        ocrImagesUsed: record?.ocrImagesUsed ?? 0,
        ocrImagesLimit: record?.ocrImagesLimit ?? limits.ocrImagesLimit,
        ttsCharsUsed: record?.ttsCharsUsed ?? 0,
        ttsCharsLimit: record?.ttsCharsLimit ?? limits.ttsCharsLimit,
      }
    },
  }
}

function activePlan(subscription: SubscriptionRecord | null, now: Date): Plan {
  if (!subscription) return 'free'
  if (subscription.plan !== 'pro') return 'free'
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return 'free'
  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() <= now.getTime()) {
    return 'free'
  }
  return 'pro'
}
