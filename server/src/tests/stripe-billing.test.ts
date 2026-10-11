import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import {
  createEntitlementService,
  type BillingStore,
  StripeCustomerMappingConflictError,
  type StripeWebhookApplyInput,
  type StripeWebhookApplyResult,
  type StripeSubscriptionInput,
  StripeWebhookUserMappingMissingError,
  type SubscriptionRecord,
  type UsageTotals,
} from '../services/billing/entitlements.js'
import {
  createStripeBillingSessionService,
  type StripeClientLike,
  type StripeWebhookEvent,
} from '../services/billing/stripe.js'
import {
  createMemoryQuotaLedgerStore,
  createQuotaService,
} from '../services/quota/quota-service.js'
import { proUser, request, testEnv, testServices } from './helpers.js'

describe('stripe billing service', () => {
  it('maps externally completed checkout sessions to the local user', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    const billing = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(checkoutCompletedEvent()),
    )

    const result = await billing.handleWebhook('{"id":"evt_checkout_completed"}', 'valid-signature')

    expect(result).toEqual({ received: true, duplicate: false })
    await expect(store.getUserIdByStripeCustomerId('cus_test_new')).resolves.toBe(proUser.id)
  })

  it('rejects checkout metadata that tries to rebind an existing Stripe customer', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    const first = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(checkoutCompletedEvent()),
    )
    await first.handleWebhook('{"id":"evt_checkout_completed"}', 'valid-signature')

    const conflicting = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(
        checkoutCompletedEvent({
          eventId: 'evt_checkout_conflict',
          userId: 'different-user',
        }),
      ),
    )
    await expect(
      conflicting.handleWebhook('{"id":"evt_checkout_conflict"}', 'valid-signature'),
    ).rejects.toBeInstanceOf(StripeCustomerMappingConflictError)

    await expect(store.getUserIdByStripeCustomerId('cus_test_new')).resolves.toBe(proUser.id)
    expect(store.processedEvents).toEqual(['evt_checkout_completed'])
  })

  it('processes subscription webhook events once and updates server-side entitlement state', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    await store.upsertStripeCustomer({
      userId: proUser.id,
      stripeCustomerId: 'cus_existing',
    })
    let retrieveCount = 0
    const event = subscriptionUpdatedEvent()
    const stripe = fakeStripeClient(event, async () => {
      retrieveCount += 1
      return event.data.object
    })
    const billing = createStripeBillingSessionService(env, store, stripe)

    const first = await billing.handleWebhook('{"id":"evt_sub_updated"}', 'valid-signature')
    const duplicate = await billing.handleWebhook('{"id":"evt_sub_updated"}', 'valid-signature')
    const status = await createEntitlementService(env.planLimits, store).getStatus(
      proUser,
      new Date('2026-06-25T00:00:00.000Z'),
    )

    expect(first).toEqual({ received: true, duplicate: false })
    expect(duplicate).toEqual({ received: true, duplicate: true })
    expect(status).toMatchObject({
      plan: 'pro',
      subscriptionEnd: '2026-12-31T00:00:00.000Z',
    })
    expect(store.processedEvents).toEqual(['evt_sub_updated'])
    expect(retrieveCount).toBe(1)
  })

  it('uses the retrieved Stripe subscription instead of stale webhook fields', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    await store.upsertStripeCustomer({
      userId: proUser.id,
      stripeCustomerId: 'cus_existing',
    })
    const staleEvent = subscriptionUpdatedEvent({ status: 'canceled', pro: false })
    const authoritative = subscriptionUpdatedEvent({ status: 'active', pro: true }).data.object
    const billing = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(staleEvent, async () => authoritative),
    )

    await billing.handleWebhook('{"id":"evt_sub_updated"}', 'valid-signature')
    const status = await createEntitlementService(env.planLimits, store).getStatus(
      proUser,
      new Date('2026-06-25T00:00:00.000Z'),
    )

    expect(status).toMatchObject({
      plan: 'pro',
      subscriptionEnd: '2026-12-31T00:00:00.000Z',
    })
    expect(store.appliedMutations[0]).toMatchObject({
      kind: 'subscription_upsert',
      plan: 'pro',
      status: 'active',
    })
  })

  it('rolls back the event marker when subscription mutation fails so retry can succeed', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    await store.upsertStripeCustomer({
      userId: proUser.id,
      stripeCustomerId: 'cus_existing',
    })
    store.failNextSubscriptionMutation = true
    const billing = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(subscriptionUpdatedEvent()),
    )

    await expect(
      billing.handleWebhook('{"id":"evt_sub_updated"}', 'valid-signature'),
    ).rejects.toThrow('forced subscription mutation failure')
    const retry = await billing.handleWebhook('{"id":"evt_sub_updated"}', 'valid-signature')
    const status = await createEntitlementService(env.planLimits, store).getStatus(
      proUser,
      new Date('2026-06-25T00:00:00.000Z'),
    )

    expect(retry).toEqual({ received: true, duplicate: false })
    expect(store.processedEvents).toEqual(['evt_sub_updated'])
    expect(store.subscriptionMutationCount).toBe(1)
    expect(status).toMatchObject({
      plan: 'pro',
      subscriptionEnd: '2026-12-31T00:00:00.000Z',
    })
  })

  it('applies concurrent deliveries of the same event exactly once', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    await store.upsertStripeCustomer({
      userId: proUser.id,
      stripeCustomerId: 'cus_existing',
    })
    const billing = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(subscriptionUpdatedEvent()),
    )

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        billing.handleWebhook('{"id":"evt_sub_updated"}', 'valid-signature'),
      ),
    )

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1)
    expect(results.filter((result) => result.duplicate)).toHaveLength(11)
    expect(store.subscriptionMutationCount).toBe(1)
    expect(store.processedEvents).toEqual(['evt_sub_updated'])
  })

  it('serializes same-second subscription reconciliation without ordering by event id', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    await store.upsertStripeCustomer({
      userId: proUser.id,
      stripeCustomerId: 'cus_existing',
    })
    const olderStarted = deferred<void>()
    const releaseOlder = deferred<void>()
    const retrieveOrder: string[] = []
    const olderEvent = subscriptionUpdatedEvent({
      eventId: 'evt_z_older',
      created: 1_800_000_100,
      status: 'canceled',
      pro: false,
    })
    const newerEvent = subscriptionUpdatedEvent({
      eventId: 'evt_a_newer',
      created: 1_800_000_100,
      status: 'active',
      pro: true,
    })
    const olderBilling = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(olderEvent, async () => {
        retrieveOrder.push('older:start')
        olderStarted.resolve(undefined)
        await releaseOlder.promise
        retrieveOrder.push('older:end')
        return olderEvent.data.object
      }),
    )
    const newerBilling = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(newerEvent, async () => {
        retrieveOrder.push('newer:start')
        return newerEvent.data.object
      }),
    )

    const older = olderBilling.handleWebhook('{"event":"older"}', 'valid-signature')
    await olderStarted.promise
    const newer = newerBilling.handleWebhook('{"event":"newer"}', 'valid-signature')
    releaseOlder.resolve(undefined)
    await Promise.all([older, newer])

    const status = await createEntitlementService(env.planLimits, store).getStatus(
      proUser,
      new Date('2026-06-25T00:00:00.000Z'),
    )
    expect(retrieveOrder).toEqual(['older:start', 'older:end', 'newer:start'])
    expect(status).toMatchObject({
      plan: 'pro',
      subscriptionEnd: '2026-12-31T00:00:00.000Z',
    })
  })

  it('leaves an unmapped subscription event retryable until its customer is known', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    const billing = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient(subscriptionUpdatedEvent()),
    )

    await expect(
      billing.handleWebhook('{"id":"evt_sub_updated"}', 'valid-signature'),
    ).rejects.toBeInstanceOf(StripeWebhookUserMappingMissingError)
    expect(store.processedEvents).toEqual([])

    await store.upsertStripeCustomer({
      userId: proUser.id,
      stripeCustomerId: 'cus_existing',
    })
    await expect(
      billing.handleWebhook('{"id":"evt_sub_updated"}', 'valid-signature'),
    ).resolves.toEqual({ received: true, duplicate: false })
    expect(store.processedEvents).toEqual(['evt_sub_updated'])
  })

  it('marks unrelated events once without passing their raw object to storage', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    const billing = createStripeBillingSessionService(
      env,
      store,
      fakeStripeClient({
        id: 'evt_unrelated',
        type: 'invoice.created',
        created: 1_800_000_000,
        data: {
          object: {
            customer_email: 'must-not-reach-storage@example.invalid',
            secret: 'must-not-reach-storage',
          },
        },
      }),
    )

    const first = await billing.handleWebhook('{"id":"evt_unrelated"}', 'valid-signature')
    const duplicate = await billing.handleWebhook('{"id":"evt_unrelated"}', 'valid-signature')

    expect(first).toEqual({ received: true, duplicate: false })
    expect(duplicate).toEqual({ received: true, duplicate: true })
    expect(store.processedEvents).toEqual(['evt_unrelated'])
    expect(store.appliedMutations).toEqual([{ kind: 'none' }])
    expect(JSON.stringify(store.appliedMutations)).not.toContain('must-not-reach-storage')
  })

  it('exposes the webhook route without bearer auth but requires a Stripe signature', async () => {
    const env = testEnv(stripeEnv())
    const store = new MemoryBillingStore()
    const entitlements = createEntitlementService(env.planLimits, store)
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services: {
        ...testServices(env),
        entitlements,
        billing: createStripeBillingSessionService(env, store, fakeStripeClient()),
        quota: createQuotaService(entitlements, createMemoryQuotaLedgerStore()),
      },
    })

    const res = await app.fetch(
      request('/echo-api/stripe/webhook', {
        method: 'POST',
        body: '{}',
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.code).toBe('unauthorized')
  })
})

class MemoryBillingStore implements BillingStore {
  readonly processedEvents: string[] = []
  readonly appliedMutations: StripeWebhookApplyInput['mutation'][] = []
  failNextSubscriptionMutation = false
  subscriptionMutationCount = 0
  private readonly userByCustomer = new Map<string, string>()
  private readonly subscriptionByUser = new Map<string, SubscriptionRecord>()
  private readonly events = new Set<string>()
  private readonly inFlightEvents = new Map<string, Promise<StripeWebhookApplyResult>>()
  private readonly customerLocks = new Map<string, Promise<void>>()

  async getCurrentSubscription(userId: string): Promise<SubscriptionRecord | null> {
    return this.subscriptionByUser.get(userId) ?? null
  }

  async getUsageTotals(): Promise<UsageTotals> {
    return {
      sttSecondsUsed: 0,
      llmTokensUsed: 0,
      ocrImagesUsed: 0,
      ttsCharsUsed: 0,
    }
  }

  async getUserQuotaProfile() {
    return null
  }

  async upsertStripeCustomer(input: { userId: string; stripeCustomerId: string }): Promise<void> {
    const existingUserId = this.userByCustomer.get(input.stripeCustomerId)
    if (existingUserId && existingUserId !== input.userId) {
      throw new StripeCustomerMappingConflictError()
    }
    this.userByCustomer.set(input.stripeCustomerId, input.userId)
    if (!this.subscriptionByUser.has(input.userId)) {
      this.subscriptionByUser.set(input.userId, {
        plan: 'free',
        status: 'incomplete',
        currentPeriodEnd: null,
        stripeCustomerId: input.stripeCustomerId,
      })
    }
  }

  async getUserIdByStripeCustomerId(stripeCustomerId: string): Promise<string | null> {
    return this.userByCustomer.get(stripeCustomerId) ?? null
  }

  async upsertStripeSubscription(input: StripeSubscriptionInput): Promise<void> {
    if (this.failNextSubscriptionMutation) {
      this.failNextSubscriptionMutation = false
      throw new Error('forced subscription mutation failure')
    }
    this.subscriptionMutationCount += 1
    this.userByCustomer.set(input.stripeCustomerId, input.userId)
    this.subscriptionByUser.set(input.userId, {
      plan: input.plan,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd,
      stripeCustomerId: input.stripeCustomerId,
    })
  }

  async applyStripeWebhook(input: StripeWebhookApplyInput): Promise<StripeWebhookApplyResult> {
    if (this.events.has(input.id)) return { duplicate: true }
    const inFlight = this.inFlightEvents.get(input.id)
    if (inFlight) {
      await inFlight
      return { duplicate: true }
    }

    const operation = this.applyStripeWebhookOnce(input)
    this.inFlightEvents.set(input.id, operation)
    try {
      return await operation
    } finally {
      this.inFlightEvents.delete(input.id)
    }
  }

  private async applyStripeWebhookOnce(
    input: StripeWebhookApplyInput,
  ): Promise<StripeWebhookApplyResult> {
    const mutation = input.mutation
    let appliedMutation = mutation
    if (mutation.kind !== 'none') {
      await this.withCustomerLock(mutation.stripeCustomerId, async () => {
        if (mutation.kind === 'customer_upsert') {
          await this.upsertStripeCustomer(mutation)
          return
        }
        if (!input.resolveSubscription) {
          throw new Error('Stripe subscription reconciler is required')
        }
        const authoritative = await input.resolveSubscription()
        if (
          authoritative.stripeCustomerId !== mutation.stripeCustomerId ||
          authoritative.stripeSubscriptionId !== mutation.stripeSubscriptionId
        ) {
          throw new Error('Stripe subscription snapshot does not match the webhook event')
        }
        const mappedUserId = await this.getUserIdByStripeCustomerId(mutation.stripeCustomerId)
        if (mappedUserId && authoritative.userId && mappedUserId !== authoritative.userId) {
          throw new Error('Stripe subscription customer is mapped to another user')
        }
        const userId = mappedUserId ?? authoritative.userId
        if (!userId) throw new StripeWebhookUserMappingMissingError()
        await this.upsertStripeSubscription({ ...authoritative, userId })
        appliedMutation = authoritative
      })
    }
    this.events.add(input.id)
    this.processedEvents.push(input.id)
    this.appliedMutations.push(appliedMutation)
    return { duplicate: false }
  }

  private async withCustomerLock<T>(
    stripeCustomerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.customerLocks.get(stripeCustomerId) ?? Promise.resolve()
    const turn = deferred<void>()
    const tail = previous.then(() => turn.promise)
    this.customerLocks.set(stripeCustomerId, tail)
    await previous
    try {
      return await operation()
    } finally {
      turn.resolve(undefined)
      if (this.customerLocks.get(stripeCustomerId) === tail) {
        this.customerLocks.delete(stripeCustomerId)
      }
    }
  }
}

function stripeEnv() {
  return {
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    STRIPE_PRO_PRICE_ID: 'price_test_pro',
  }
}

function fakeStripeClient(
  event: StripeWebhookEvent = checkoutCompletedEvent(),
  retrieveSubscription: (subscriptionId: string) => Promise<Record<string, unknown>> = async () =>
    event.data.object,
): StripeClientLike {
  return {
    webhooks: {
      constructEvent(_rawBody: string, signature: string) {
        if (signature !== 'valid-signature') throw new Error('invalid signature')
        return event
      },
    },
    subscriptions: {
      retrieve: retrieveSubscription,
    },
  }
}

function checkoutCompletedEvent(
  options: { eventId?: string; userId?: string } = {},
): StripeWebhookEvent {
  return {
    id: options.eventId ?? 'evt_checkout_completed',
    type: 'checkout.session.completed',
    created: 1_800_000_000,
    data: {
      object: {
        customer: 'cus_test_new',
        metadata: { userId: options.userId ?? proUser.id },
      },
    },
  }
}

function subscriptionUpdatedEvent(
  options: {
    eventId?: string
    created?: number
    status?: 'active' | 'canceled'
    pro?: boolean
  } = {},
): StripeWebhookEvent {
  return {
    id: options.eventId ?? 'evt_sub_updated',
    type: 'customer.subscription.updated',
    created: options.created ?? 1_800_000_001,
    data: {
      object: {
        id: 'sub_test',
        customer: 'cus_existing',
        status: options.status ?? 'active',
        current_period_start: 1_782_302_400,
        current_period_end: 1_798_675_200,
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: options.pro === false ? 'price_free' : 'price_test_pro' } }],
        },
      },
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}
