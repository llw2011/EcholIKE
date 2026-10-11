import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import {
  createEntitlementService,
  emptyBillingStore,
  type BillingStore,
} from '../services/billing/entitlements.js'
import { disabledBillingSessionService } from '../services/billing/stripe.js'
import {
  createMemoryQuotaLedgerStore,
  createQuotaService,
} from '../services/quota/quota-service.js'
import type { AuthenticatedUser } from '../types.js'
import { freeUser, request, testEnv, testServices } from './helpers.js'

describe('subscription entitlements', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-06-25T00:00:00.000Z') })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('derives pro status from server-side entitlement data, not the session plan field', async () => {
    const env = testEnv()
    const sessionUser: AuthenticatedUser = {
      ...freeUser,
      id: 'user_with_paid_record',
      plan: 'free',
    }
    const entitlements = createEntitlementService(env.planLimits, {
      ...emptyBillingStore,
      async getCurrentSubscription() {
        return {
          plan: 'pro',
          status: 'active',
          currentPeriodEnd: new Date('2026-12-31T00:00:00.000Z'),
          stripeCustomerId: 'cus_test',
        }
      },
      async getUsageTotals(_userId, periodKey) {
        expect(periodKey).toBe('2026-06')
        return {
          sttSecondsUsed: 42,
          llmTokensUsed: 4096,
          ocrImagesUsed: 3,
          ttsCharsUsed: 1200,
        }
      },
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-paid-token': sessionUser,
      }),
      services: {
        ...testServices(env),
        entitlements,
        billing: disabledBillingSessionService,
        quota: createQuotaService(entitlements, createMemoryQuotaLedgerStore()),
      },
    })

    const res = await app.fetch(
      request('/echo-api/subscription/status', {
        headers: { authorization: 'Bearer valid-paid-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      plan: 'pro',
      subscriptionEnd: '2026-12-31T00:00:00.000Z',
      sttSecondsUsed: 42,
      llmTokensUsed: 4096,
      ocrImagesUsed: 3,
      ttsCharsUsed: 1200,
      sttSecondsLimit: 36000,
      llmTokensLimit: 5000000,
      ocrImagesLimit: 5000,
      ttsCharsLimit: 2000000,
    })
  })

  it('downgrades expired or non-active paid records to free', async () => {
    const env = testEnv()
    const store = expiredStore(new Date('2026-01-01T00:00:00.000Z'))
    const entitlements = createEntitlementService(env.planLimits, store)

    const status = await entitlements.getStatus(freeUser, new Date('2026-06-25T00:00:00.000Z'))

    expect(status).toMatchObject({
      plan: 'free',
      subscriptionEnd: null,
      sttSecondsLimit: 900,
      llmTokensLimit: 100000,
      ocrImagesLimit: 50,
      ttsCharsLimit: 50000,
    })
  })

  it('applies per-user quota levels as a monthly limit multiplier', async () => {
    const env = testEnv()
    const entitlements = createEntitlementService(env.planLimits, {
      ...emptyBillingStore,
      async getUserQuotaProfile() {
        return { quotaLevel: 3 }
      },
    })

    const status = await entitlements.getStatus(freeUser, new Date('2026-06-25T00:00:00.000Z'))

    expect(status).toMatchObject({
      plan: 'free',
      quotaLevel: 3,
      quotaMultiplier: 3,
      sttSecondsLimit: 2700,
      llmTokensLimit: 300000,
      ocrImagesLimit: 150,
      ttsCharsLimit: 150000,
    })
  })
})

function expiredStore(currentPeriodEnd: Date): BillingStore {
  return {
    ...emptyBillingStore,
    async getCurrentSubscription() {
      return {
        plan: 'pro',
        status: 'active',
        currentPeriodEnd,
        stripeCustomerId: 'cus_expired',
      }
    },
    async getUsageTotals() {
      return {
        sttSecondsUsed: 0,
        llmTokensUsed: 0,
        ocrImagesUsed: 0,
        ttsCharsUsed: 0,
      }
    },
  }
}
