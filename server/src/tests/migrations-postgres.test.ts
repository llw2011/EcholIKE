import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { readMigrationFiles, type MigrationConfig } from 'drizzle-orm/migrator'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { expect, it } from 'vitest'
import { createPostgresConnection } from '../db/client.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'migrates a fresh isolated PostgreSQL database with validated control invariants',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')
    const sql = createPostgresConnection(databaseUrl)
    try {
      const db = drizzle(sql)
      await migrate(db, { migrationsFolder })
      const facts = await sql<
        {
          migrations: number | string
          provider_revision: boolean
          provider_revision_check: boolean
          ota_force_check: boolean
          ota_artifact_check_validated: boolean
          stripe_order_columns: number | string
          usage_period_kind_index: boolean
          audit_metadata_object_check: boolean
          json_shape_constraints_validated: boolean
        }[]
      >`
        select
          (select count(*) from drizzle.__drizzle_migrations)::int as migrations,
          exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'provider_registry'
              and column_name = 'revision'
          ) as provider_revision,
          exists (
            select 1 from pg_constraint where conname = 'provider_registry_revision_check'
          ) as provider_revision_check,
          exists (
            select 1 from pg_constraint where conname = 'ota_release_force_enabled_check'
          ) as ota_force_check,
          coalesce((
            select convalidated from pg_constraint
            where conname = 'ota_release_enabled_artifact_check'
          ), false) as ota_artifact_check_validated,
          (
            select count(*) from information_schema.columns
            where table_schema = 'public'
              and (
                (table_name = 'subscription' and column_name in ('stripe_event_created_at', 'stripe_event_id'))
                or (table_name = 'stripe_webhook_event' and column_name = 'event_created_at')
              )
          )::int as stripe_order_columns,
          exists (
            select 1 from pg_indexes
            where schemaname = 'public' and indexname = 'usage_ledger_period_kind_idx'
          ) as usage_period_kind_index,
          coalesce((
            select convalidated from pg_constraint
            where conname = 'audit_log_metadata_object_check'
          ), false) as audit_metadata_object_check,
          not exists (
            select 1
            from (
              values
                ('audit_log_metadata_object_check'),
                ('stripe_webhook_event_metadata_object_check'),
                ('provider_registry_models_array_check'),
                ('provider_registry_capabilities_object_check'),
                ('desktop_policy_features_object_check'),
                ('desktop_policy_services_object_check'),
                ('desktop_policy_policy_object_check'),
                ('quota_operation_response_headers_object_check')
            ) as expected(name)
            left join pg_constraint constraint_row on constraint_row.conname = expected.name
            where constraint_row.oid is null or not constraint_row.convalidated
          ) as json_shape_constraints_validated
      `
      expect(facts[0]).toEqual({
        migrations: 16,
        provider_revision: true,
        provider_revision_check: true,
        ota_force_check: true,
        ota_artifact_check_validated: true,
        stripe_order_columns: 3,
        usage_period_kind_index: true,
        audit_metadata_object_check: true,
        json_shape_constraints_validated: true,
      })
    } finally {
      await sql.end()
    }
  },
)

it.skipIf(!process.env.TEST_UPGRADE_DATABASE_URL)(
  'upgrades a production-shaped 0008 database without overwriting legacy facts',
  async () => {
    const databaseUrl = process.env.TEST_UPGRADE_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_UPGRADE_DATABASE_URL is required')
    const sql = createPostgresConnection(databaseUrl)
    try {
      const db = drizzle(sql)
      const config = { migrationsFolder } satisfies MigrationConfig
      const migrations = readMigrationFiles(config)
      const internal = db as unknown as {
        dialect: {
          migrate(
            migrations: ReturnType<typeof readMigrationFiles>,
            session: unknown,
            config: MigrationConfig,
          ): Promise<void>
        }
        session: unknown
      }
      await internal.dialect.migrate(migrations.slice(0, 9), internal.session, config)

      const userId = 'legacy-upgrade-user'
      await sql`
        insert into "user" (id, email, name, email_verified)
        values (${userId}, 'legacy-upgrade@example.invalid', 'Legacy upgrade', true)
      `
      await sql`
        insert into provider_registry (
          kind, provider_id, display_name, enabled, mode, endpoint_encrypted,
          api_key_encrypted, default_model, models_json, capabilities_json, priority
        )
        values (
          'llm', 'openai-compatible', 'Legacy provider', false, 'proxy',
          'https://legacy-provider.example/v1', 'legacy-key', 'legacy-model',
          to_jsonb(${JSON.stringify([{ id: 'legacy-model' }])}::text),
          to_jsonb(${JSON.stringify({ streaming: true })}::text),
          7
        )
      `
      await sql`
        insert into desktop_policy (
          channel, platform, plan, features_json, services_json, policy_json, enabled
        )
        values (
          'legacy-upgrade',
          'windows',
          'all',
          to_jsonb(${JSON.stringify({ featureFlag: true })}::text),
          to_jsonb(${JSON.stringify({ llm: { available: true } })}::text),
          to_jsonb(${JSON.stringify({ activation: 'next_start' })}::text),
          true
        )
      `
      await sql`
        insert into ota_release (
          app_name, version, channel, platform, arch, enabled, auto_update,
          force_update, download_url_encrypted, sha256, signature, release_notes
        )
        values (
          'EcholIKE', '0.0.0-legacy', 'stable', 'all', 'all', true, false,
          false, 'https://artifact.example/legacy.exe', ${'a'.repeat(64)},
          'legacy-signature', 'Legacy enabled release'
        )
      `
      await sql`
        insert into subscription (
          user_id, stripe_customer_id, stripe_subscription_id, plan, status,
          cancel_at_period_end
        )
        values (${userId}, 'cus_legacy_upgrade', 'sub_legacy_upgrade', 'pro', 'active', false)
      `
      await sql`
        insert into stripe_webhook_event (id, type, metadata_json)
        values (
          'evt_legacy_upgrade',
          'customer.subscription.updated',
          to_jsonb(${JSON.stringify({ legacy: true })}::text)
        )
      `
      await sql`
        insert into audit_log (user_id, request_id, action, metadata_json)
        values (
          ${userId},
          'req_legacy_audit',
          'legacy.audit',
          to_jsonb(${JSON.stringify({ status: 503, durationMs: 17 })}::text)
        )
      `
      await sql`
        insert into quota_operation (
          user_id, idempotency_key, payload_hash, kind, source, period_key, request_id,
          reserved_amount, actual_amount, status, finalized_lease_token, response_status,
          response_headers_json, response_body, response_expires_at
        )
        values (
          ${userId}, 'legacy:quota:upgrade', ${'b'.repeat(64)}, 'llm_tokens', 'proxy_llm',
          '2040-01', 'req_legacy_quota', 1, 1, 'completed', 'legacy-finalized-lease', 200,
          to_jsonb(${JSON.stringify({ 'content-type': 'application/json' })}::text),
          ${Buffer.from('{}')}, '2040-02-01T00:00:00.000Z'::timestamptz
        )
      `

      await sql`
        insert into audit_log (user_id, request_id, action, metadata_json)
        values (${userId}, 'req_invalid_inner_json', 'legacy.invalid', to_jsonb('not-json'::text))
      `

      await expect(internal.dialect.migrate(migrations, internal.session, config)).rejects.toThrow(
        /not valid JSON/,
      )
      const rollbackFacts = await sql<
        {
          migrations: number | string
          admin_operation: string | null
          audit_type: string
          provider_models_type: string
        }[]
      >`
        select
          (select count(*) from drizzle.__drizzle_migrations)::int as migrations,
          to_regclass('public.admin_operation')::text as admin_operation,
          jsonb_typeof(audit.metadata_json) as audit_type,
          jsonb_typeof(provider.models_json) as provider_models_type
        from audit_log audit
        cross join provider_registry provider
        where audit.request_id = 'req_legacy_audit'
          and provider.display_name = 'Legacy provider'
      `
      expect(rollbackFacts[0]).toEqual({
        migrations: 9,
        admin_operation: null,
        audit_type: 'string',
        provider_models_type: 'string',
      })
      await sql`delete from audit_log where request_id = 'req_invalid_inner_json'`

      await internal.dialect.migrate(migrations, internal.session, config)

      const facts = await sql<
        {
          migrations: number | string
          provider_revision: number | string
          provider_name: string
          ota_enabled: boolean
          ota_revision: number | string
          ota_artifact_bytes: number | null
          ota_artifact_check_validated: boolean
          subscription_plan: string
          stripe_event_created_at: Date | null
          stripe_marker_kind: string
          audit_metadata: Record<string, unknown>
          audit_metadata_type: string
          audit_metadata_object_check: boolean
          provider_models: Array<Record<string, unknown>>
          provider_models_type: string
          provider_capabilities: Record<string, unknown>
          provider_capabilities_type: string
          policy_features_type: string
          policy_services_type: string
          policy_policy_type: string
          stripe_metadata_type: string
          quota_headers_type: string
          json_shape_constraints_validated: boolean
        }[]
      >`
        select
          (select count(*) from drizzle.__drizzle_migrations)::int as migrations,
          provider.revision::int as provider_revision,
          provider.display_name as provider_name,
          release.enabled as ota_enabled,
          release.revision::int as ota_revision,
          release.artifact_bytes as ota_artifact_bytes,
          (
            select convalidated from pg_constraint
            where conname = 'ota_release_enabled_artifact_check'
          ) as ota_artifact_check_validated,
          subscription.plan as subscription_plan,
          subscription.stripe_event_created_at,
          event.mutation_kind as stripe_marker_kind,
          audit.metadata_json as audit_metadata,
          jsonb_typeof(audit.metadata_json) as audit_metadata_type,
          provider.models_json as provider_models,
          jsonb_typeof(provider.models_json) as provider_models_type,
          provider.capabilities_json as provider_capabilities,
          jsonb_typeof(provider.capabilities_json) as provider_capabilities_type,
          jsonb_typeof(policy.features_json) as policy_features_type,
          jsonb_typeof(policy.services_json) as policy_services_type,
          jsonb_typeof(policy.policy_json) as policy_policy_type,
          jsonb_typeof(event.metadata_json) as stripe_metadata_type,
          jsonb_typeof(operation.response_headers_json) as quota_headers_type,
          (
            select convalidated from pg_constraint
            where conname = 'audit_log_metadata_object_check'
          ) as audit_metadata_object_check,
          not exists (
            select 1
            from (
              values
                ('audit_log_metadata_object_check'),
                ('stripe_webhook_event_metadata_object_check'),
                ('provider_registry_models_array_check'),
                ('provider_registry_capabilities_object_check'),
                ('desktop_policy_features_object_check'),
                ('desktop_policy_services_object_check'),
                ('desktop_policy_policy_object_check'),
                ('quota_operation_response_headers_object_check')
            ) as expected(name)
            left join pg_constraint constraint_row on constraint_row.conname = expected.name
            where constraint_row.oid is null or not constraint_row.convalidated
          ) as json_shape_constraints_validated
        from provider_registry provider
        cross join ota_release release
        cross join subscription
        cross join stripe_webhook_event event
        cross join audit_log audit
        cross join desktop_policy policy
        cross join quota_operation operation
        where provider.display_name = 'Legacy provider'
          and release.version = '0.0.0-legacy'
          and subscription.stripe_customer_id = 'cus_legacy_upgrade'
          and event.id = 'evt_legacy_upgrade'
          and audit.request_id = 'req_legacy_audit'
          and policy.channel = 'legacy-upgrade'
          and operation.request_id = 'req_legacy_quota'
      `
      expect(facts[0]).toEqual({
        migrations: 16,
        provider_revision: 0,
        provider_name: 'Legacy provider',
        ota_enabled: true,
        ota_revision: 0,
        ota_artifact_bytes: null,
        ota_artifact_check_validated: false,
        subscription_plan: 'pro',
        stripe_event_created_at: null,
        stripe_marker_kind: 'none',
        audit_metadata: { status: 503, durationMs: 17 },
        audit_metadata_type: 'object',
        audit_metadata_object_check: true,
        provider_models: [{ id: 'legacy-model' }],
        provider_models_type: 'array',
        provider_capabilities: { streaming: true },
        provider_capabilities_type: 'object',
        policy_features_type: 'object',
        policy_services_type: 'object',
        policy_policy_type: 'object',
        stripe_metadata_type: 'object',
        quota_headers_type: 'object',
        json_shape_constraints_validated: true,
      })

      await expect(
        sql`
          insert into ota_release (
            app_name, version, channel, platform, arch, enabled, auto_update, force_update
          )
          values ('EcholIKE', '0.0.0-invalid-new', 'test', 'all', 'all', true, false, false)
        `,
      ).rejects.toThrow()
    } finally {
      await sql.end()
    }
  },
)
