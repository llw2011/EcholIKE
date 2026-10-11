import { and, desc, eq, sql as drizzleSql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
  normalizeQuotaLevel,
  type BillingStore,
  StripeCustomerMappingConflictError,
  type StripeSubscriptionWebhookMutation,
  type StripeWebhookMutation,
  StripeWebhookUserMappingMissingError,
  type UserQuotaProfile,
  type StripeSubscriptionInput,
  type SubscriptionRecord,
  type UsageTotals,
} from '../../services/billing/entitlements.js'
import * as schema from '../schema.js'
import { postgresDateParameter, safeDatabaseInteger } from './row-values.js'

export function createPostgresBillingStore(client: postgres.Sql): BillingStore {
  const db = drizzle(client, { schema })

  return {
    async getCurrentSubscription(userId) {
      const rows = await db
        .select({
          plan: schema.subscriptions.plan,
          status: schema.subscriptions.status,
          currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
          stripeCustomerId: schema.subscriptions.stripeCustomerId,
        })
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.userId, userId))
        .orderBy(desc(schema.subscriptions.updatedAt))
        .limit(1)

      const row = rows[0]
      if (!row) return null

      return {
        plan: row.plan,
        status: row.status,
        currentPeriodEnd: row.currentPeriodEnd,
        stripeCustomerId: row.stripeCustomerId,
      } satisfies SubscriptionRecord
    },

    async getUserQuotaProfile(userId) {
      const rows = await db
        .select({
          quotaLevel: schema.userQuotaProfiles.quotaLevel,
        })
        .from(schema.userQuotaProfiles)
        .where(eq(schema.userQuotaProfiles.userId, userId))
        .limit(1)

      const row = rows[0]
      if (!row) return null

      return {
        quotaLevel: normalizeQuotaLevel(row.quotaLevel),
      } satisfies UserQuotaProfile
    },

    async getUsageTotals(userId, periodKey) {
      const rows = await db
        .select({
          kind: schema.usageLedgers.kind,
          total: drizzleSql<
            number | string
          >`coalesce(sum(${schema.usageLedgers.amount}), 0)::bigint`,
        })
        .from(schema.usageLedgers)
        .where(
          and(eq(schema.usageLedgers.userId, userId), eq(schema.usageLedgers.periodKey, periodKey)),
        )
        .groupBy(schema.usageLedgers.kind)

      const totals: UsageTotals = {
        sttSecondsUsed: 0,
        llmTokensUsed: 0,
        ocrImagesUsed: 0,
        ttsCharsUsed: 0,
      }

      for (const row of rows) {
        const total = safeDatabaseInteger(row.total, 'usage total')
        if (row.kind === 'stt_seconds') totals.sttSecondsUsed = total
        if (row.kind === 'llm_tokens') totals.llmTokensUsed = total
        if (row.kind === 'ocr_images') totals.ocrImagesUsed = total
        if (row.kind === 'tts_chars') totals.ttsCharsUsed = total
      }

      return totals
    },

    async upsertStripeCustomer(input) {
      await upsertStripeCustomer(client, input)
    },

    async getUserIdByStripeCustomerId(stripeCustomerId) {
      const rows = await db
        .select({
          userId: schema.subscriptions.userId,
        })
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.stripeCustomerId, stripeCustomerId))
        .limit(1)

      return rows[0]?.userId ?? null
    },

    async upsertStripeSubscription(input) {
      await upsertStripeSubscription(client, input)
    },

    async applyStripeWebhook(input) {
      return await client.begin(async (transaction) => {
        const markerRows = await transaction<{ id: string }[]>`
          insert into stripe_webhook_event (
            id,
            type,
            mutation_kind,
            event_created_at,
            metadata_json,
            processed_at
          )
          values (
            ${input.id},
            ${input.type},
            ${input.mutation.kind},
            ${postgresDateParameter(input.eventCreatedAt)},
            ${JSON.stringify(stripeWebhookMutationMetadata(input.mutation))}::text::jsonb,
            now()
          )
          on conflict (id) do nothing
          returning id
        `
        if (!markerRows[0]) return { duplicate: true }

        if (input.mutation.kind === 'customer_upsert') {
          await acquireStripeCustomerLock(transaction, input.mutation.stripeCustomerId)
          await upsertStripeCustomer(transaction, input.mutation)
        } else if (input.mutation.kind === 'subscription_upsert') {
          await acquireStripeCustomerLock(transaction, input.mutation.stripeCustomerId)
          const mappedUserId = await stripeWebhookUserId(
            transaction,
            input.mutation.stripeCustomerId,
          )
          if (!input.resolveSubscription) {
            throw new Error('Stripe subscription reconciler is required')
          }
          const authoritative = await input.resolveSubscription()
          assertStripeSubscriptionSnapshot(input.mutation, authoritative)
          if (mappedUserId && authoritative.userId && mappedUserId !== authoritative.userId) {
            throw new Error('Stripe subscription customer is mapped to another user')
          }
          const userId = mappedUserId ?? authoritative.userId
          if (!userId) throw new StripeWebhookUserMappingMissingError()
          await upsertStripeSubscription(
            transaction,
            {
              ...authoritative,
              userId,
            },
            {
              eventCreatedAt: input.eventCreatedAt,
              eventId: input.id,
            },
          )
        }

        return { duplicate: false }
      })
    },
  }
}

type StripeTransactionalClient = postgres.Sql | postgres.TransactionSql

interface StripeEventOrder {
  eventCreatedAt: Date
  eventId: string
}

async function upsertStripeCustomer(
  client: StripeTransactionalClient,
  input: { userId: string; stripeCustomerId: string },
): Promise<void> {
  const rows = await client<{ user_id: string }[]>`
    insert into subscription (
      user_id,
      stripe_customer_id,
      stripe_subscription_id,
      plan,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      stripe_event_created_at,
      stripe_event_id,
      updated_at
    )
    values (
      ${input.userId},
      ${input.stripeCustomerId},
      null,
      'free',
      'incomplete',
      null,
      null,
      false,
      null,
      null,
      now()
    )
    on conflict (stripe_customer_id)
    do update set
      updated_at = now()
    where subscription.user_id = excluded.user_id
    returning user_id
  `
  if (!rows[0]) throw new StripeCustomerMappingConflictError()
}

async function acquireStripeCustomerLock(
  client: postgres.TransactionSql,
  stripeCustomerId: string,
): Promise<void> {
  await client`
    select pg_advisory_xact_lock(
      hashtextextended(${'stripe_webhook_customer:' + stripeCustomerId}, 0)
    )
  `
}

async function stripeWebhookUserId(
  client: StripeTransactionalClient,
  stripeCustomerId: string,
): Promise<string | null> {
  const rows = await client<{ user_id: string }[]>`
    select user_id
    from subscription
    where stripe_customer_id = ${stripeCustomerId}
    order by updated_at desc
    limit 1
    for update
  `
  return rows[0]?.user_id ?? null
}

function stripeWebhookMutationMetadata(mutation: StripeWebhookMutation): Record<string, unknown> {
  if (mutation.kind === 'customer_upsert') {
    return {
      mutationKind: mutation.kind,
      stripeCustomerId: mutation.stripeCustomerId,
    }
  }
  if (mutation.kind === 'subscription_upsert') {
    return {
      mutationKind: mutation.kind,
      stripeCustomerId: mutation.stripeCustomerId,
      stripeSubscriptionId: mutation.stripeSubscriptionId,
    }
  }
  return { mutationKind: mutation.kind }
}

function assertStripeSubscriptionSnapshot(
  expected: StripeSubscriptionWebhookMutation,
  authoritative: StripeSubscriptionWebhookMutation,
): void {
  if (
    authoritative.stripeCustomerId !== expected.stripeCustomerId ||
    authoritative.stripeSubscriptionId !== expected.stripeSubscriptionId
  ) {
    throw new Error('Stripe subscription snapshot does not match the webhook event')
  }
}

async function upsertStripeSubscription(
  client: StripeTransactionalClient,
  input: StripeSubscriptionInput,
  eventOrder: StripeEventOrder | null = null,
): Promise<void> {
  await client`
    insert into subscription (
      user_id,
      stripe_customer_id,
      stripe_subscription_id,
      plan,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      stripe_event_created_at,
      stripe_event_id,
      updated_at
    )
    values (
      ${input.userId},
      ${input.stripeCustomerId},
      ${input.stripeSubscriptionId},
      ${input.plan},
      ${input.status},
      ${postgresDateParameter(input.currentPeriodStart)},
      ${postgresDateParameter(input.currentPeriodEnd)},
      ${input.cancelAtPeriodEnd},
      ${postgresDateParameter(eventOrder?.eventCreatedAt ?? null)},
      ${eventOrder?.eventId ?? null},
      now()
    )
    on conflict (stripe_customer_id)
    do update set
      user_id = excluded.user_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan = excluded.plan,
      status = excluded.status,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      stripe_event_created_at = case
        when subscription.stripe_event_created_at is null
          or excluded.stripe_event_created_at > subscription.stripe_event_created_at
        then excluded.stripe_event_created_at
        else subscription.stripe_event_created_at
      end,
      stripe_event_id = case
        when subscription.stripe_event_created_at is null
          or excluded.stripe_event_created_at > subscription.stripe_event_created_at
        then excluded.stripe_event_id
        else subscription.stripe_event_id
      end,
      updated_at = now()
  `
}
