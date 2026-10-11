import Stripe from 'stripe'
import { ApiError, notImplemented } from '../../errors.js'
import type { ServerEnv } from '../../env.js'
import type {
  BillingStore,
  StripeSubscriptionWebhookMutation,
  StripeWebhookMutation,
  SubscriptionStoreStatus,
} from './entitlements.js'

export interface BillingSessionService {
  handleWebhook(
    rawBody: string,
    signature: string | null,
  ): Promise<{ received: true; duplicate: boolean }>
}

export interface StripeClientLike {
  webhooks: {
    constructEvent(rawBody: string, signature: string, secret: string): StripeWebhookEvent
  }
  subscriptions: {
    retrieve(subscriptionId: string): Promise<Record<string, unknown>>
  }
}

export interface StripeWebhookEvent {
  id: string
  type: string
  created: number
  data: {
    object: Record<string, unknown>
  }
}

export function createStripeBillingSessionService(
  env: ServerEnv,
  store: BillingStore,
  stripeClient: StripeClientLike = createStripeClient(env),
): BillingSessionService {
  return {
    async handleWebhook(rawBody, signature) {
      if (!env.stripeWebhookSecret) {
        throw notImplemented('Stripe webhook is not configured')
      }
      if (!signature) {
        throw new ApiError(401, 'unauthorized', 'Stripe signature required')
      }

      const event = constructStripeEvent(stripeClient, rawBody, signature, env.stripeWebhookSecret)
      const mutation = stripeWebhookMutation(env, event)
      const applyInput = {
        id: event.id,
        type: event.type,
        eventCreatedAt: stripeEventCreatedAt(event),
        mutation,
      }
      const result =
        mutation.kind === 'subscription_upsert'
          ? await store.applyStripeWebhook({
              ...applyInput,
              resolveSubscription: async () =>
                await retrieveSubscriptionMutation(env, stripeClient, mutation),
            })
          : await store.applyStripeWebhook(applyInput)
      return { received: true, duplicate: result.duplicate }
    },
  }
}

function stripeEventCreatedAt(event: StripeWebhookEvent): Date {
  if (!Number.isSafeInteger(event.created) || event.created < 0) {
    throw new ApiError(422, 'validation_failed', 'Stripe event timestamp is invalid')
  }
  const timestamp = new Date(event.created * 1000)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ApiError(422, 'validation_failed', 'Stripe event timestamp is invalid')
  }
  return timestamp
}

export const disabledBillingSessionService: BillingSessionService = {
  async handleWebhook() {
    throw notImplemented('Stripe webhook is not configured')
  },
}

function createStripeClient(env: ServerEnv): StripeClientLike {
  if (!env.stripeSecretKey) {
    return disabledStripeClient()
  }
  const stripe = new Stripe(env.stripeSecretKey)
  return {
    webhooks: {
      constructEvent: (rawBody, signature, secret) =>
        stripe.webhooks.constructEvent(rawBody, signature, secret) as unknown as StripeWebhookEvent,
    },
    subscriptions: {
      retrieve: async (subscriptionId) =>
        (await stripe.subscriptions.retrieve(subscriptionId)) as unknown as Record<string, unknown>,
    },
  }
}

function disabledStripeClient(): StripeClientLike {
  return {
    webhooks: {
      constructEvent() {
        throw notImplemented('Stripe webhook is not configured')
      },
    },
    subscriptions: {
      async retrieve() {
        throw notImplemented('Stripe webhook is not configured')
      },
    },
  }
}

function constructStripeEvent(
  stripeClient: StripeClientLike,
  rawBody: string,
  signature: string,
  secret: string,
): StripeWebhookEvent {
  try {
    return stripeClient.webhooks.constructEvent(rawBody, signature, secret)
  } catch {
    throw new ApiError(401, 'unauthorized', 'Invalid Stripe signature')
  }
}

function stripeWebhookMutation(env: ServerEnv, event: StripeWebhookEvent): StripeWebhookMutation {
  if (event.type === 'checkout.session.completed') {
    return checkoutCompletedMutation(event.data.object)
  }

  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    return subscriptionMutation(env, event.data.object)
  }

  return { kind: 'none' }
}

function checkoutCompletedMutation(object: Record<string, unknown>): StripeWebhookMutation {
  const userId = metadataUserId(object)
  const customerId = stripeId(object.customer)
  if (!userId || !customerId) return { kind: 'none' }

  return {
    kind: 'customer_upsert',
    userId,
    stripeCustomerId: customerId,
  }
}

function subscriptionMutation(
  env: ServerEnv,
  object: Record<string, unknown>,
): StripeSubscriptionWebhookMutation | { kind: 'none' } {
  const stripeCustomerId = stripeId(object.customer)
  const stripeSubscriptionId = stripeId(object.id)
  if (!stripeCustomerId || !stripeSubscriptionId) return { kind: 'none' }

  return {
    kind: 'subscription_upsert',
    userId: metadataUserId(object),
    stripeCustomerId,
    stripeSubscriptionId,
    plan: hasConfiguredProPrice(object, env.stripeProPriceId) ? 'pro' : 'free',
    status: stripeSubscriptionStatus(object.status),
    currentPeriodStart: stripeTimestamp(object.current_period_start),
    currentPeriodEnd: stripeTimestamp(object.current_period_end),
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
  }
}

async function retrieveSubscriptionMutation(
  env: ServerEnv,
  stripeClient: StripeClientLike,
  expected: StripeSubscriptionWebhookMutation,
): Promise<StripeSubscriptionWebhookMutation> {
  const object = await stripeClient.subscriptions.retrieve(expected.stripeSubscriptionId)
  const authoritative = subscriptionMutation(env, object)
  if (
    authoritative.kind !== 'subscription_upsert' ||
    authoritative.stripeSubscriptionId !== expected.stripeSubscriptionId ||
    authoritative.stripeCustomerId !== expected.stripeCustomerId
  ) {
    throw new ApiError(
      502,
      'internal_error',
      'Stripe subscription snapshot did not match the webhook event',
      false,
    )
  }
  return authoritative
}

function metadataUserId(object: Record<string, unknown>): string | null {
  const metadata = object.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const userId = (metadata as Record<string, unknown>).userId
  return typeof userId === 'string' && userId.trim() ? userId : null
}

function stripeId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.trim() ? id : null
}

function stripeTimestamp(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value * 1000)
}

function stripeSubscriptionStatus(value: unknown): SubscriptionStoreStatus {
  const allowed: SubscriptionStoreStatus[] = [
    'trialing',
    'active',
    'past_due',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'unpaid',
  ]
  return allowed.includes(value as SubscriptionStoreStatus)
    ? (value as SubscriptionStoreStatus)
    : 'incomplete'
}

function hasConfiguredProPrice(
  object: Record<string, unknown>,
  proPriceId: string | null,
): boolean {
  if (!proPriceId) return false
  const items = object.items
  if (!items || typeof items !== 'object' || Array.isArray(items)) return false
  const data = (items as Record<string, unknown>).data
  if (!Array.isArray(data)) return false

  return data.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const price = (item as Record<string, unknown>).price
    return stripeId(price) === proPriceId
  })
}
