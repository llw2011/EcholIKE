import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { ApiError } from '../../errors.js'
import {
  normalizeQuotaLevel,
  quotaMultiplierForLevel,
} from '../../services/billing/entitlements.js'
import type {
  AdminAccount,
  AdminControlContext,
  AdminOverview,
  AdminQuotaAdjustmentResult,
  AdminResetUserPasswordResult,
  AdminScenePackRecord,
  AdminStore,
  AdminUserRecord,
} from '../../services/admin/admin-service.js'
import {
  AdminAuthorizationChangedError,
  AdminIdempotencyConflictError,
  LastActiveOwnerError,
} from '../../services/admin/admin-service.js'
import type { LockedAdminAccount } from './control-audit.js'
import { assertPostgresControlActor, insertPostgresControlAudit } from './control-audit.js'
import { acquireQuotaUserLock, readPostgresQuotaUsage } from './quota-ledger-store.js'
import { createDefaultSceneSeeder } from './scene-store.js'
import { jsonObject, timestampToIso, toNumber } from './row-values.js'

export function createPostgresAdminStore(client: postgres.Sql): AdminStore {
  const ensureDefaultScenes = createDefaultSceneSeeder(client)

  return {
    async getAccount(userId) {
      const rows = await client<
        {
          user_id: string
          role: AdminAccount['role']
          status: AdminAccount['status']
          created_by: string | null
          created_at: Date | null
          updated_at: Date | null
        }[]
      >`
        select user_id, role, status, created_by, created_at, updated_at
        from admin_account
        where user_id = ${userId}
        limit 1
      `
      const row = rows[0]
      if (!row) return null

      return {
        userId: row.user_id,
        role: row.role,
        status: row.status,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    },

    async getOverview() {
      await ensureDefaultScenes()
      const rows = await client<
        {
          user_count: number | string
          admin_count: number | string
          active_admin_count: number | string
          subscription_count: number | string
          pro_subscription_count: number | string
          usage_ledger_count: number | string
          scene_pack_count: number | string
          audit_log_count: number | string
          latest_audit_at: Date | null
        }[]
      >`
        select
          (select count(*) from "user")::int as user_count,
          (select count(*) from admin_account)::int as admin_count,
          (select count(*) from admin_account where status = 'active')::int as active_admin_count,
          (select count(*) from subscription)::int as subscription_count,
          (select count(*) from subscription where plan = 'pro')::int as pro_subscription_count,
          (select count(*) from usage_ledger)::int as usage_ledger_count,
          (select count(*) from scene_pack)::int as scene_pack_count,
          (select count(*) from audit_log)::int as audit_log_count,
          (select max(created_at) from audit_log) as latest_audit_at
      `

      const row = rows[0]
      return {
        userCount: toNumber(row?.user_count),
        adminCount: toNumber(row?.admin_count),
        activeAdminCount: toNumber(row?.active_admin_count),
        subscriptionCount: toNumber(row?.subscription_count),
        proSubscriptionCount: toNumber(row?.pro_subscription_count),
        usageLedgerCount: toNumber(row?.usage_ledger_count),
        scenePackCount: toNumber(row?.scene_pack_count),
        auditLogCount: toNumber(row?.audit_log_count),
        latestAuditAt: timestampToIso(row?.latest_audit_at),
      } satisfies AdminOverview
    },

    async listUsers(input) {
      const cursorCreatedAt = input.cursor?.createdAt ?? null
      const cursorId = input.cursor?.id ?? null
      const [rows, countRows] = await Promise.all([
        client<
          {
            id: string
            email: string
            name: string | null
            email_verified: boolean
            created_at: Date | null
            created_at_cursor: string
            updated_at: Date | null
            admin_role: AdminAccount['role'] | null
            admin_status: AdminAccount['status'] | null
            plan: 'free' | 'pro' | null
            subscription_status: string | null
            subscription_end: Date | null
            quota_level: number | string
            stt_seconds_used: number | string
            llm_tokens_used: number | string
            ocr_images_used: number | string
            tts_chars_used: number | string
          }[]
        >`
        with page_users as (
          select id, email, name, email_verified, created_at, updated_at
          from "user"
          where (
            ${input.query}::text is null
            or position(lower(${input.query}::text) in lower(id)) > 0
            or position(lower(${input.query}::text) in lower(email)) > 0
            or position(lower(${input.query}::text) in lower(coalesce(name, ''))) > 0
          )
          and (
            ${cursorCreatedAt}::timestamptz is null
            or created_at < ${cursorCreatedAt}::timestamptz
            or (
              created_at = ${cursorCreatedAt}::timestamptz
              and id < ${cursorId}
            )
          )
          order by created_at desc, id desc
          limit ${input.limit + 1}
        )
        select
          page_users.id,
          page_users.email,
          page_users.name,
          page_users.email_verified,
          page_users.created_at,
          to_char(page_users.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_cursor,
          page_users.updated_at,
          admin_account.role as admin_role,
          admin_account.status as admin_status,
          subscription.plan,
          subscription.status as subscription_status,
          subscription.current_period_end as subscription_end,
          coalesce(user_quota_profile.quota_level, 1)::int as quota_level,
          coalesce(sum(usage_ledger.amount) filter (where usage_ledger.kind = 'stt_seconds'), 0)::bigint as stt_seconds_used,
          coalesce(sum(usage_ledger.amount) filter (where usage_ledger.kind = 'llm_tokens'), 0)::bigint as llm_tokens_used,
          coalesce(sum(usage_ledger.amount) filter (where usage_ledger.kind = 'ocr_images'), 0)::bigint as ocr_images_used,
          coalesce(sum(usage_ledger.amount) filter (where usage_ledger.kind = 'tts_chars'), 0)::bigint as tts_chars_used
        from page_users
        left join admin_account on admin_account.user_id = page_users.id
        left join lateral (
          select plan, status, current_period_end
          from subscription
          where subscription.user_id = page_users.id
          order by updated_at desc
          limit 1
        ) subscription on true
        left join user_quota_profile on user_quota_profile.user_id = page_users.id
        left join usage_ledger on usage_ledger.user_id = page_users.id
          and usage_ledger.period_key = ${input.periodKey}
        group by
          page_users.id,
          page_users.email,
          page_users.name,
          page_users.email_verified,
          page_users.created_at,
          page_users.updated_at,
          admin_account.role,
          admin_account.status,
          user_quota_profile.quota_level,
          subscription.plan,
          subscription.status,
          subscription.current_period_end
        order by page_users.created_at desc, page_users.id desc
      `,
        client<{ total: number | string }[]>`
          select count(*)::int as total
          from "user"
          where (
            ${input.query}::text is null
            or position(lower(${input.query}::text) in lower(id)) > 0
            or position(lower(${input.query}::text) in lower(email)) > 0
            or position(lower(${input.query}::text) in lower(coalesce(name, ''))) > 0
          )
        `,
      ])

      const users = rows.slice(0, input.limit).map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        emailVerified: row.email_verified,
        createdAt: row.created_at_cursor,
        updatedAt: timestampToIso(row.updated_at),
        adminRole: row.admin_role,
        adminStatus: row.admin_status,
        plan: row.plan,
        subscriptionStatus: row.subscription_status,
        subscriptionEnd: timestampToIso(row.subscription_end),
        quotaLevel: normalizeQuotaLevel(row.quota_level),
        quotaMultiplier: quotaMultiplierForLevel(row.quota_level),
        sttSecondsUsed: toNumber(row.stt_seconds_used),
        llmTokensUsed: toNumber(row.llm_tokens_used),
        ocrImagesUsed: toNumber(row.ocr_images_used),
        ttsCharsUsed: toNumber(row.tts_chars_used),
      })) satisfies AdminUserRecord[]
      return {
        users,
        total: toNumber(countRows[0]?.total),
        hasMore: rows.length > input.limit,
      }
    },

    async createUser(input) {
      return await client.begin(async (tx) => {
        await assertPostgresControlActor(tx, input.control, ['owner', 'admin'])
        const userId = randomUUID()
        const rows = await tx<
          {
            id: string
            email: string
            name: string | null
            email_verified: boolean
            created_at: Date | null
            updated_at: Date | null
          }[]
        >`
          insert into "user" (id, email, name, email_verified)
          values (${userId}, ${input.email}, ${input.name}, ${input.emailVerified})
          on conflict (email) do nothing
          returning id, email, name, email_verified, created_at, updated_at
        `
        const row = rows[0]
        if (!row) return null

        await tx`
          insert into account (id, user_id, provider_id, provider_account_id, password)
          values (${randomUUID()}, ${row.id}, 'credential', ${row.id}, ${input.passwordHash})
        `

        await insertPostgresControlAudit(tx, input.control, 'admin.user.create', {
          actorUserId: input.control?.actorUserId ?? null,
          targetUserId: row.id,
          email: row.email,
          emailVerified: row.email_verified,
        })

        return {
          id: row.id,
          email: row.email,
          name: row.name,
          emailVerified: row.email_verified,
          createdAt: timestampToIso(row.created_at),
          updatedAt: timestampToIso(row.updated_at),
          adminRole: null,
          adminStatus: null,
          plan: null,
          subscriptionStatus: null,
          subscriptionEnd: null,
          quotaLevel: 1,
          quotaMultiplier: quotaMultiplierForLevel(1),
          sttSecondsUsed: 0,
          llmTokensUsed: 0,
          ocrImagesUsed: 0,
          ttsCharsUsed: 0,
        } satisfies AdminUserRecord
      })
    },

    async resetUserPassword(input) {
      return await client.begin(async (tx) => {
        const adminAccounts = await lockPostgresAdminAccounts(tx)
        const actor = assertLockedControlActor(input.control, ['owner', 'admin'], adminAccounts)
        const targetAdmin = adminAccounts.find((account) => account.userId === input.userId)
        if (input.control && targetAdmin?.role === 'owner' && actor?.role !== 'owner') {
          throw new AdminAuthorizationChangedError()
        }
        const credentialRows = await tx<{ user_id: string }[]>`
          update account
          set password = ${input.passwordHash}, updated_at = now()
          where user_id = ${input.userId}
            and provider_id = 'credential'
            and password is not null
          returning user_id
        `
        if (!credentialRows[0]) return null

        const revokedSessions = await tx<{ id: string }[]>`
          delete from session
          where user_id = ${input.userId}
          returning id
        `
        const result = {
          userId: input.userId,
          sessionsRevoked: revokedSessions.length,
        } satisfies AdminResetUserPasswordResult
        await insertPostgresControlAudit(tx, input.control, 'admin.user.password_reset', {
          targetUserId: result.userId,
          sessionsRevoked: result.sessionsRevoked,
        })
        return result
      })
    },

    async setAdminAccount(input) {
      return await client.begin(async (transaction) => {
        const adminAccounts = await lockPostgresAdminAccounts(transaction)
        const control = { actorUserId: input.actorUserId, requestId: input.requestId }
        const actor = assertLockedControlActor(control, ['owner', 'admin'], adminAccounts)
        const target = adminAccounts.find((account) => account.userId === input.userId)
        if (
          control &&
          ((target?.role === 'owner' && actor?.role !== 'owner') ||
            (input.role === 'owner' && actor?.role !== 'owner') ||
            (input.userId === input.actorUserId && input.status === 'disabled'))
        ) {
          throw new AdminAuthorizationChangedError()
        }
        const activeOwners = adminAccounts.filter(
          (account) => account.role === 'owner' && account.status === 'active',
        )
        const removesActiveOwner =
          activeOwners.some((owner) => owner.userId === input.userId) &&
          (input.role !== 'owner' || input.status !== 'active')
        if (removesActiveOwner && activeOwners.length <= 1) {
          throw new LastActiveOwnerError()
        }

        const rows = await transaction<
          {
            user_id: string
            role: AdminAccount['role']
            status: AdminAccount['status']
            created_by: string | null
            created_at: Date | null
            updated_at: Date | null
          }[]
        >`
          insert into admin_account (user_id, role, status, created_by, updated_at)
          values (${input.userId}, ${input.role}, ${input.status}, ${input.actorUserId}, now())
          on conflict (user_id)
          do update set
            role = excluded.role,
            status = excluded.status,
            updated_at = now()
          returning user_id, role, status, created_by, created_at, updated_at
        `
        const row = rows[0]
        if (!row) throw new Error('admin account upsert did not return a row')

        const account = {
          userId: row.user_id,
          role: row.role,
          status: row.status,
          createdBy: row.created_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
        await insertPostgresControlAudit(transaction, control, 'admin.account.set', {
          targetUserId: input.userId,
          role: input.role,
          status: input.status,
        })
        return account
      })
    },

    async adjustQuota(input) {
      const actorUserId = input.actorUserId
      const idempotencyKey = input.idempotencyKey
      const payloadHash = input.payloadHash

      return await client.begin(async (transaction) => {
        await assertPostgresControlActor(transaction, { actorUserId, requestId: input.requestId }, [
          'owner',
          'admin',
          'operator',
        ])
        const operationId = randomUUID()
        const inserted = await transaction<{ id: string }[]>`
          insert into admin_operation (
            id,
            actor_user_id,
            kind,
            idempotency_key,
            payload_hash,
            request_id,
            result_json
          )
          values (
            ${operationId},
            ${actorUserId},
            'quota_adjustment',
            ${idempotencyKey},
            ${payloadHash},
            ${input.requestId},
            null
          )
          on conflict (actor_user_id, kind, idempotency_key) do nothing
          returning id
        `

        if (!inserted[0]) {
          const existingRows = await transaction<
            { id: string; payload_hash: string; result_json: unknown }[]
          >`
            select id, payload_hash, result_json
            from admin_operation
            where actor_user_id = ${actorUserId}
              and kind = 'quota_adjustment'
              and idempotency_key = ${idempotencyKey}
            for update
          `
          const existing = existingRows[0]
          if (!existing) {
            throw new ApiError(500, 'internal_error', 'admin operation replay is missing', false)
          }
          if (existing.payload_hash !== payloadHash) {
            throw new AdminIdempotencyConflictError()
          }
          return {
            ...adminQuotaAdjustmentResult(existing.result_json, existing.id),
            replayed: true,
          }
        }

        await acquireQuotaUserLock(transaction, input.userId)
        const usageBefore = await readPostgresQuotaUsage(
          transaction,
          input.userId,
          input.kind,
          input.periodKey,
        )
        const result: AdminQuotaAdjustmentResult = {
          operationId,
          userId: input.userId,
          kind: input.kind,
          amount: input.amount,
          periodKey: input.periodKey,
          usageBefore,
          usageAfter: usageBefore + input.amount,
          replayed: false,
          reason: input.reason,
        }
        await transaction`
          insert into usage_ledger (
            user_id,
            kind,
            amount,
            source,
            request_id,
            period_key,
            admin_operation_id
          )
          values (
            ${input.userId},
            ${input.kind},
            ${input.amount},
            'adjustment',
            ${input.requestId},
            ${input.periodKey},
            ${operationId}
          )
        `
        const auditMetadata = {
          operationId,
          actorUserId,
          targetUserId: input.userId,
          kind: input.kind,
          amount: input.amount,
          periodKey: input.periodKey,
          usageBefore: result.usageBefore,
          usageAfter: result.usageAfter,
          reason: result.reason,
        }
        await transaction`
          insert into audit_log (user_id, request_id, action, metadata_json)
          values (
            ${actorUserId},
            ${input.requestId},
            'admin.quota.adjust',
            ${JSON.stringify(auditMetadata)}::text::jsonb
          )
        `
        await transaction`
          update admin_operation
          set result_json = ${JSON.stringify(result)}::text::jsonb
          where id = ${operationId}
        `
        return result
      })
    },

    async setUserQuotaLevel(input) {
      const quotaLevel = normalizeQuotaLevel(input.quotaLevel)
      return await client.begin(async (transaction) => {
        const control = { actorUserId: input.actorUserId, requestId: input.requestId }
        await assertPostgresControlActor(transaction, control, ['owner', 'admin', 'operator'])
        const rows = await transaction<{ user_id: string; quota_level: number | string }[]>`
          insert into user_quota_profile (user_id, quota_level, updated_by, updated_at)
          values (${input.userId}, ${quotaLevel}, ${input.actorUserId}, now())
          on conflict (user_id)
          do update set
            quota_level = excluded.quota_level,
            updated_by = excluded.updated_by,
            updated_at = now()
          returning user_id, quota_level
        `
        const row = rows[0]
        if (!row) throw new Error('user quota level upsert did not return a row')

        const profile = {
          userId: row.user_id,
          quotaLevel: normalizeQuotaLevel(row.quota_level),
          quotaMultiplier: quotaMultiplierForLevel(row.quota_level),
        }
        await insertPostgresControlAudit(transaction, control, 'admin.user_quota_level.set', {
          actorUserId: input.actorUserId,
          targetUserId: input.userId,
          quotaLevel: profile.quotaLevel,
          quotaMultiplier: profile.quotaMultiplier,
        })
        return profile
      })
    },

    async listScenePacks() {
      await ensureDefaultScenes()
      return listAdminScenePacks(client)
    },

    async upsertScenePack(input) {
      const id = await client.begin(async (transaction) => {
        await assertPostgresControlActor(transaction, input.control, ['owner', 'admin', 'operator'])
        const rows = input.id
          ? await transaction<{ id: string }[]>`
              update scene_pack
              set
                slug = ${input.slug},
                name = ${input.name},
                description = ${input.description},
                category = ${input.category},
                prompt_template = ${input.promptTemplate},
                is_pro = ${input.isPro},
                enabled = ${input.enabled},
                updated_at = now()
              where id = ${input.id}
              returning id
            `
          : await transaction<{ id: string }[]>`
              insert into scene_pack (
                slug,
                name,
                description,
                category,
                prompt_template,
                is_pro,
                enabled
              )
              values (
                ${input.slug},
                ${input.name},
                ${input.description},
                ${input.category},
                ${input.promptTemplate},
                ${input.isPro},
                ${input.enabled}
              )
              returning id
            `
        const sceneId = rows[0]?.id
        if (!sceneId) throw new Error('scene pack upsert did not return an id')

        if (input.dictionaryTerms.length) {
          await transaction`
            delete from scene_dictionary_term
            where scene_pack_id = ${sceneId}
              and word not in ${transaction(input.dictionaryTerms.map((term) => term.word))}
          `
        } else {
          await transaction`
            delete from scene_dictionary_term
            where scene_pack_id = ${sceneId}
          `
        }

        for (const term of input.dictionaryTerms) {
          await transaction`
            insert into scene_dictionary_term (scene_pack_id, word, pronunciation)
            values (${sceneId}, ${term.word}, ${term.pronunciation ?? null})
            on conflict (scene_pack_id, word)
            do update set pronunciation = excluded.pronunciation
          `
        }

        await insertPostgresControlAudit(transaction, input.control, 'admin.scene.upsert', {
          actorUserId: input.control?.actorUserId ?? null,
          sceneId,
          slug: input.slug,
          enabled: input.enabled,
          isPro: input.isPro,
        })

        return sceneId
      })

      const scenes = await listAdminScenePacks(client, id)
      const scene = scenes[0]
      if (!scene) throw new Error('scene pack upsert result not found')
      return scene
    },
  }
}

async function lockPostgresAdminAccounts(
  transaction: postgres.TransactionSql,
): Promise<LockedAdminAccount[]> {
  const rows = await transaction<
    { user_id: string; role: AdminAccount['role']; status: AdminAccount['status'] }[]
  >`
    select user_id, role, status
    from public.admin_account
    order by user_id
    for update
  `
  return rows.map((row) => ({ userId: row.user_id, role: row.role, status: row.status }))
}

function assertLockedControlActor(
  control: AdminControlContext | undefined,
  allowedRoles: readonly AdminAccount['role'][],
  accounts: readonly LockedAdminAccount[],
): LockedAdminAccount | null {
  if (!control) throw new AdminAuthorizationChangedError()
  const actor = accounts.find((account) => account.userId === control.actorUserId)
  if (!actor || actor.status !== 'active' || !allowedRoles.includes(actor.role)) {
    throw new AdminAuthorizationChangedError()
  }
  return actor
}

function adminQuotaAdjustmentResult(
  value: unknown,
  operationId: string,
): AdminQuotaAdjustmentResult {
  const result = jsonObject(value)
  const kind = result.kind
  const amount = result.amount
  const usageBefore = result.usageBefore
  const usageAfter = result.usageAfter
  const reason = result.reason
  if (
    result.operationId !== operationId ||
    typeof result.userId !== 'string' ||
    (kind !== 'stt_seconds' &&
      kind !== 'llm_tokens' &&
      kind !== 'ocr_images' &&
      kind !== 'tts_chars') ||
    !Number.isSafeInteger(amount) ||
    typeof result.periodKey !== 'string' ||
    !Number.isSafeInteger(usageBefore) ||
    !Number.isSafeInteger(usageAfter) ||
    typeof reason !== 'string'
  ) {
    throw new ApiError(500, 'internal_error', 'admin operation replay is invalid', false)
  }
  return {
    operationId,
    userId: result.userId,
    kind,
    amount: amount as number,
    periodKey: result.periodKey,
    usageBefore: usageBefore as number,
    usageAfter: usageAfter as number,
    replayed: false,
    reason,
  }
}

async function listAdminScenePacks(
  client: postgres.Sql,
  id?: string,
): Promise<AdminScenePackRecord[]> {
  const packs = id
    ? await client<
        {
          id: string
          slug: string
          name: string
          description: string
          category: string
          prompt_template: string
          is_pro: boolean
          enabled: boolean
          created_at: Date | null
          updated_at: Date | null
        }[]
      >`
        select id, slug, name, description, category, prompt_template, is_pro, enabled, created_at, updated_at
        from scene_pack
        where id = ${id}
        order by category, name
      `
    : await client<
        {
          id: string
          slug: string
          name: string
          description: string
          category: string
          prompt_template: string
          is_pro: boolean
          enabled: boolean
          created_at: Date | null
          updated_at: Date | null
        }[]
      >`
        select id, slug, name, description, category, prompt_template, is_pro, enabled, created_at, updated_at
        from scene_pack
        order by category, name
        limit 200
      `

  const terms = packs.length
    ? await client<{ scene_pack_id: string; word: string; pronunciation: string | null }[]>`
        select scene_pack_id, word, pronunciation
        from scene_dictionary_term
        where scene_pack_id in ${client(packs.map((pack) => pack.id))}
        order by word
      `
    : []

  const termsByPack = new Map<string, AdminScenePackRecord['dictionaryTerms']>()
  for (const term of terms) {
    const values = termsByPack.get(term.scene_pack_id) ?? []
    values.push({
      word: term.word,
      ...(term.pronunciation ? { pronunciation: term.pronunciation } : {}),
    })
    termsByPack.set(term.scene_pack_id, values)
  }

  return packs.map((pack) => ({
    id: pack.id,
    slug: pack.slug,
    name: pack.name,
    description: pack.description,
    category: pack.category,
    promptTemplate: pack.prompt_template,
    dictionaryTerms: termsByPack.get(pack.id) ?? [],
    isPro: pack.is_pro,
    enabled: pack.enabled,
    createdAt: timestampToIso(pack.created_at),
    updatedAt: timestampToIso(pack.updated_at),
  }))
}
