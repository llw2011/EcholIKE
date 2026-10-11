import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPostgresBillingStore, createPostgresConnection } from '../db/client.js'
import { parseEnv } from '../env.js'
import { StripeCustomerMappingConflictError } from '../services/billing/entitlements.js'
import {
  createStripeBillingSessionService,
  type StripeClientLike,
  type StripeWebhookEvent,
} from '../services/billing/stripe.js'

describe('Stripe webhook transaction contract', () => {
  it('adds an explicit mutation marker after the existing admin migrations', () => {
    const migration = readFileSync(
      new URL('../db/migrations/0011_stripe_webhook_atomicity.sql', import.meta.url),
      'utf8',
    )
    const journal = JSON.parse(
      readFileSync(new URL('../db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries?: Array<{ idx?: number; tag?: string }> }

    expect(migration).toContain('ADD COLUMN "mutation_kind"')
    expect(migration).toContain('"stripe_webhook_event_mutation_kind_check"')
    expect(migration).toContain("'customer_upsert'")
    expect(migration).toContain("'subscription_upsert'")
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 11, tag: '0011_stripe_webhook_atomicity' }),
    )
    const orderingMigration = readFileSync(
      new URL('../db/migrations/0014_stripe_event_ordering.sql', import.meta.url),
      'utf8',
    )
    expect(orderingMigration).toContain('"stripe_event_created_at"')
    expect(orderingMigration).toContain('"event_created_at"')
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 14, tag: '0014_stripe_event_ordering' }),
    )
  })
})

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'atomically applies, rolls back, retries, and deduplicates Stripe events on PostgreSQL',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

    const sql = createPostgresConnection(databaseUrl)
    const suffix = randomUUID()
    const identifierSuffix = suffix.replaceAll('-', '')
    const userId = `stripe-user-${suffix}`
    const conflictingUserId = `stripe-conflicting-user-${suffix}`
    const concurrentCustomerId = `cus_concurrent_${suffix}`
    const failingCustomerId = `cus_failure_${suffix}`
    const checkoutCustomerId = `cus_checkout_${suffix}`
    const orderedCustomerId = `cus_ordered_${suffix}`
    const racedCustomerId = `cus_raced_${suffix}`
    const concurrentEventId = `evt_concurrent_${suffix}`
    const failingEventId = `evt_failure_${suffix}`
    const unknownEventId = `evt_unknown_${suffix}`
    const checkoutEventId = `evt_z_checkout_${suffix}`
    const checkoutSubscriptionEventId = `evt_a_checkout_subscription_${suffix}`
    const lateCheckoutEventId = `evt_late_checkout_${suffix}`
    const conflictingCheckoutEventId = `evt_conflicting_checkout_${suffix}`
    const newerEventId = `evt_newer_${suffix}`
    const olderEventId = `evt_older_${suffix}`
    const racedNewerEventId = `evt_a_raced_newer_${suffix}`
    const racedOlderEventId = `evt_z_raced_older_${suffix}`
    const triggerName = `fail_stripe_subscription_${identifierSuffix}`
    const functionName = `fail_stripe_subscription_fn_${identifierSuffix}`
    const env = stripeTestEnv(databaseUrl)
    const store = createPostgresBillingStore(sql)

    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values
          (${userId}, ${`${userId}@example.invalid`}, 'Stripe atomicity', true),
          (
            ${conflictingUserId},
            ${`${conflictingUserId}@example.invalid`},
            'Stripe mapping conflict',
            true
          )
      `

      const concurrentBilling = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(checkoutEvent(concurrentEventId, concurrentCustomerId, userId)),
      )
      const concurrentResults = await Promise.all(
        Array.from({ length: 16 }, () =>
          concurrentBilling.handleWebhook('{"event":"concurrent"}', 'valid-signature'),
        ),
      )
      expect(concurrentResults.filter((result) => !result.duplicate)).toHaveLength(1)
      expect(concurrentResults.filter((result) => result.duplicate)).toHaveLength(15)
      const concurrentRows = await sql<
        { events: number | string; subscriptions: number | string }[]
      >`
        select
          (select count(*) from stripe_webhook_event where id = ${concurrentEventId})::int
            as events,
          (select count(*) from subscription where stripe_customer_id = ${concurrentCustomerId})::int
            as subscriptions
      `
      expect(concurrentRows[0]).toMatchObject({ events: 1, subscriptions: 1 })

      await store.upsertStripeCustomer({ userId, stripeCustomerId: failingCustomerId })
      await sql.unsafe(`
        create function "${functionName}"() returns trigger
        language plpgsql as $$
        begin
          if new.stripe_customer_id = '${failingCustomerId}' then
            raise exception 'forced Stripe subscription failure';
          end if;
          return new;
        end
        $$
      `)
      await sql.unsafe(`
        create trigger "${triggerName}"
        before insert or update on subscription
        for each row execute function "${functionName}"()
      `)

      let failingRetrieveCount = 0
      const failingEvent = subscriptionEvent(failingEventId, failingCustomerId)
      const failingBilling = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(failingEvent, async () => {
          failingRetrieveCount += 1
          return failingEvent.data.object
        }),
      )
      await expect(
        failingBilling.handleWebhook('{"event":"failure"}', 'valid-signature'),
      ).rejects.toThrow('forced Stripe subscription failure')
      const rolledBack = await sql<{ events: number | string; plan: string; status: string }[]>`
        select
          (select count(*) from stripe_webhook_event where id = ${failingEventId})::int
            as events,
          plan,
          status
        from subscription
        where stripe_customer_id = ${failingCustomerId}
      `
      expect(rolledBack[0]).toMatchObject({ events: 0, plan: 'free', status: 'incomplete' })

      await sql.unsafe(`drop trigger "${triggerName}" on subscription`)
      await sql.unsafe(`drop function "${functionName}"()`)
      const retry = await failingBilling.handleWebhook('{"event":"failure"}', 'valid-signature')
      const duplicate = await failingBilling.handleWebhook('{"event":"failure"}', 'valid-signature')
      expect(retry).toEqual({ received: true, duplicate: false })
      expect(duplicate).toEqual({ received: true, duplicate: true })
      expect(failingRetrieveCount).toBe(2)
      const applied = await sql<
        { events: number | string; mutation_kind: string; plan: string; status: string }[]
      >`
        select
          (select count(*) from stripe_webhook_event where id = ${failingEventId})::int
            as events,
          event.mutation_kind,
          subscription.plan,
          subscription.status
        from stripe_webhook_event as event
        join subscription on subscription.stripe_customer_id = ${failingCustomerId}
        where event.id = ${failingEventId}
      `
      expect(applied[0]).toMatchObject({
        events: 1,
        mutation_kind: 'subscription_upsert',
        plan: 'pro',
        status: 'active',
      })

      const unknownBilling = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient({
          id: unknownEventId,
          type: 'invoice.created',
          created: 1_800_000_000,
          data: {
            object: {
              customer_email: 'must-not-be-persisted@example.invalid',
              secret: 'must-not-be-persisted',
            },
          },
        }),
      )
      const unknownFirst = await unknownBilling.handleWebhook(
        '{"event":"unknown"}',
        'valid-signature',
      )
      const unknownDuplicate = await unknownBilling.handleWebhook(
        '{"event":"unknown"}',
        'valid-signature',
      )
      expect(unknownFirst).toEqual({ received: true, duplicate: false })
      expect(unknownDuplicate).toEqual({ received: true, duplicate: true })
      const unknownRows = await sql<
        { mutation_kind: string; metadata_json: Record<string, unknown> }[]
      >`
        select mutation_kind, metadata_json
        from stripe_webhook_event
        where id = ${unknownEventId}
      `
      expect(unknownRows[0]).toEqual({
        mutation_kind: 'none',
        metadata_json: { mutationKind: 'none' },
      })
      expect(JSON.stringify(unknownRows[0])).not.toContain('must-not-be-persisted')

      const checkoutCreated = 1_800_000_050
      const checkoutBilling = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(
          checkoutEvent(checkoutEventId, checkoutCustomerId, userId, checkoutCreated),
        ),
      )
      await checkoutBilling.handleWebhook('{"event":"checkout"}', 'valid-signature')
      const checkoutMapping = await sql<
        { plan: string; stripe_event_created_at: Date | null; stripe_event_id: string | null }[]
      >`
        select plan, stripe_event_created_at, stripe_event_id
        from subscription
        where stripe_customer_id = ${checkoutCustomerId}
      `
      expect(checkoutMapping[0]).toEqual({
        plan: 'free',
        stripe_event_created_at: null,
        stripe_event_id: null,
      })

      const checkoutSubscription = subscriptionEvent(
        checkoutSubscriptionEventId,
        checkoutCustomerId,
        {
          created: checkoutCreated,
          subscriptionId: `sub_checkout_${suffix}`,
          status: 'active',
          pro: true,
        },
      )
      await createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(checkoutSubscription),
      ).handleWebhook('{"event":"checkout-subscription"}', 'valid-signature')
      const checkoutReconciled = await sql<
        { plan: string; status: string; stripe_event_id: string | null }[]
      >`
        select plan, status, stripe_event_id
        from subscription
        where stripe_customer_id = ${checkoutCustomerId}
      `
      expect(checkoutReconciled[0]).toEqual({
        plan: 'pro',
        status: 'active',
        stripe_event_id: checkoutSubscriptionEventId,
      })
      await createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(
          checkoutEvent(lateCheckoutEventId, checkoutCustomerId, userId, checkoutCreated + 1),
        ),
      ).handleWebhook('{"event":"late-checkout"}', 'valid-signature')
      const afterLateCheckout = await sql<
        { plan: string; status: string; stripe_event_id: string | null }[]
      >`
        select plan, status, stripe_event_id
        from subscription
        where stripe_customer_id = ${checkoutCustomerId}
      `
      expect(afterLateCheckout[0]).toEqual({
        plan: 'pro',
        status: 'active',
        stripe_event_id: checkoutSubscriptionEventId,
      })
      const conflictingCheckout = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(
          checkoutEvent(
            conflictingCheckoutEventId,
            checkoutCustomerId,
            conflictingUserId,
            checkoutCreated + 2,
          ),
        ),
      )
      await expect(
        conflictingCheckout.handleWebhook('{"event":"conflicting-checkout"}', 'valid-signature'),
      ).rejects.toBeInstanceOf(StripeCustomerMappingConflictError)
      const afterConflictingCheckout = await sql<
        {
          user_id: string
          plan: string
          status: string
          stripe_event_id: string | null
          conflict_event_count: number
        }[]
      >`
        select
          user_id,
          plan,
          status,
          stripe_event_id,
          (
            select count(*)::int
            from stripe_webhook_event
            where id = ${conflictingCheckoutEventId}
          ) as conflict_event_count
        from subscription
        where stripe_customer_id = ${checkoutCustomerId}
      `
      expect(afterConflictingCheckout[0]).toEqual({
        user_id: userId,
        plan: 'pro',
        status: 'active',
        stripe_event_id: checkoutSubscriptionEventId,
        conflict_event_count: 0,
      })

      await store.upsertStripeCustomer({ userId, stripeCustomerId: orderedCustomerId })
      const orderedSubscriptionId = `sub_ordered_${suffix}`
      const newerBilling = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(
          subscriptionEvent(newerEventId, orderedCustomerId, {
            created: 1_800_000_200,
            subscriptionId: orderedSubscriptionId,
            status: 'active',
            pro: true,
          }),
        ),
      )
      const olderBilling = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(
          subscriptionEvent(olderEventId, orderedCustomerId, {
            created: 1_800_000_100,
            subscriptionId: orderedSubscriptionId,
            status: 'canceled',
            pro: false,
          }),
          async () =>
            subscriptionEvent(newerEventId, orderedCustomerId, {
              created: 1_800_000_200,
              subscriptionId: orderedSubscriptionId,
              status: 'active',
              pro: true,
            }).data.object,
        ),
      )
      await newerBilling.handleWebhook('{"event":"newer"}', 'valid-signature')
      await olderBilling.handleWebhook('{"event":"older"}', 'valid-signature')
      const orderedRows = await sql<
        { plan: string; status: string; stripe_event_id: string | null }[]
      >`
        select plan, status, stripe_event_id
        from subscription
        where stripe_customer_id = ${orderedCustomerId}
      `
      expect(orderedRows[0]).toEqual({
        plan: 'pro',
        status: 'active',
        stripe_event_id: newerEventId,
      })

      await store.upsertStripeCustomer({ userId, stripeCustomerId: racedCustomerId })
      const racedSubscriptionId = `sub_raced_${suffix}`
      const sameSecond = 1_800_000_300
      const olderRetrieveStarted = deferred<void>()
      const releaseOlderRetrieve = deferred<void>()
      const retrieveOrder: string[] = []
      const racedOlderEvent = subscriptionEvent(racedOlderEventId, racedCustomerId, {
        created: sameSecond,
        subscriptionId: racedSubscriptionId,
        status: 'canceled',
        pro: false,
      })
      const racedNewerEvent = subscriptionEvent(racedNewerEventId, racedCustomerId, {
        created: sameSecond,
        subscriptionId: racedSubscriptionId,
        status: 'active',
        pro: true,
      })
      const racedNewer = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(racedNewerEvent, async () => {
          retrieveOrder.push('newer:start')
          return racedNewerEvent.data.object
        }),
      )
      const racedOlder = createStripeBillingSessionService(
        env,
        store,
        fakeStripeClient(racedOlderEvent, async () => {
          retrieveOrder.push('older:start')
          olderRetrieveStarted.resolve(undefined)
          await releaseOlderRetrieve.promise
          retrieveOrder.push('older:end')
          return racedOlderEvent.data.object
        }),
      )
      const racedOlderRequest = racedOlder.handleWebhook(
        '{"event":"raced-older"}',
        'valid-signature',
      )
      await olderRetrieveStarted.promise
      const racedNewerRequest = racedNewer.handleWebhook(
        '{"event":"raced-newer"}',
        'valid-signature',
      )
      releaseOlderRetrieve.resolve(undefined)
      await Promise.all([racedOlderRequest, racedNewerRequest])
      const racedRows = await sql<{ plan: string; status: string; event_count: number }[]>`
        select
          plan,
          status,
          (
            select count(*)::int
            from stripe_webhook_event
            where id in (${racedOlderEventId}, ${racedNewerEventId})
          ) as event_count
        from subscription
        where stripe_customer_id = ${racedCustomerId}
      `
      expect(retrieveOrder).toEqual(['older:start', 'older:end', 'newer:start'])
      expect(racedRows[0]).toEqual({
        plan: 'pro',
        status: 'active',
        event_count: 2,
      })
    } finally {
      await sql
        .unsafe(`drop trigger if exists "${triggerName}" on subscription`)
        .catch(() => undefined)
      await sql.unsafe(`drop function if exists "${functionName}"()`).catch(() => undefined)
      await sql`
        delete from stripe_webhook_event
        where id in (
          ${concurrentEventId},
          ${failingEventId},
          ${unknownEventId},
          ${checkoutEventId},
          ${checkoutSubscriptionEventId},
          ${lateCheckoutEventId},
          ${conflictingCheckoutEventId},
          ${newerEventId},
          ${olderEventId},
          ${racedNewerEventId},
          ${racedOlderEventId}
        )
      `.catch(() => undefined)
      await sql`
        delete from subscription
        where stripe_customer_id in (
          ${concurrentCustomerId},
          ${failingCustomerId},
          ${checkoutCustomerId},
          ${orderedCustomerId},
          ${racedCustomerId}
        )
      `.catch(() => undefined)
      await sql`
        delete from "user"
        where id in (${userId}, ${conflictingUserId})
      `.catch(() => undefined)
      await sql.end()
    }
  },
)

function stripeTestEnv(databaseUrl: string) {
  return parseEnv({
    NODE_ENV: 'test',
    PORT: '8787',
    PUBLIC_API_BASE_URL: 'http://localhost:8787/echo-api',
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: 'stripe-atomicity-test-secret-with-enough-length',
    BETTER_AUTH_URL: 'http://localhost:8787',
    PROVIDER_CONTROL_DEADLINE_MS: '10000',
    PROVIDER_CONTROL_MAX_IN_FLIGHT: '2',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    STRIPE_PRO_PRICE_ID: 'price_test_pro',
  })
}

function fakeStripeClient(
  event: StripeWebhookEvent,
  retrieveSubscription: (subscriptionId: string) => Promise<Record<string, unknown>> = async () =>
    event.data.object,
): StripeClientLike {
  return {
    webhooks: {
      constructEvent(_rawBody, signature) {
        if (signature !== 'valid-signature') throw new Error('invalid signature')
        return event
      },
    },
    subscriptions: {
      retrieve: retrieveSubscription,
    },
  }
}

function checkoutEvent(
  eventId: string,
  stripeCustomerId: string,
  userId: string,
  created = 1_800_000_000,
): StripeWebhookEvent {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    created,
    data: {
      object: {
        customer: stripeCustomerId,
        metadata: { userId },
      },
    },
  }
}

function subscriptionEvent(
  eventId: string,
  stripeCustomerId: string,
  options: {
    created?: number
    subscriptionId?: string
    status?: 'active' | 'canceled'
    pro?: boolean
  } = {},
): StripeWebhookEvent {
  return {
    id: eventId,
    type: 'customer.subscription.updated',
    created: options.created ?? 1_800_000_001,
    data: {
      object: {
        id: options.subscriptionId ?? `sub_${eventId}`,
        customer: stripeCustomerId,
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
