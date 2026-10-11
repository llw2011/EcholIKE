import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  createPostgresAdminStore,
  createPostgresConnection,
  createPostgresDesktopConfigStore,
} from '../db/client.js'
import { AdminAuthorizationChangedError } from '../services/admin/admin-service.js'
import { createDesktopConfigService } from '../services/desktop/desktop-config-service.js'
import { testEnv } from './helpers.js'

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'rolls back every control mutation when authorization or audit persistence fails',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

    const sql = createPostgresConnection(databaseUrl)
    const suffix = randomUUID()
    const identifierSuffix = suffix.replaceAll('-', '')
    const actorId = `control-owner-${suffix}`
    const targetId = `control-target-${suffix}`
    const createdEmail = `control-created-${suffix}@example.invalid`
    const providerId = `control-provider-${identifierSuffix}`
    const providerDisplayName = `Atomic provider ${suffix}`
    const policyChannel = `atomic-policy-${identifierSuffix}`
    const otaVersion = `0.0.0-control-${suffix}`
    const sceneSlug = `control-${identifierSuffix}`
    const requestPrefix = `forced-control-audit-${suffix}`
    const triggerName = `fail_control_audit_${identifierSuffix}`
    const functionName = `fail_control_audit_fn_${identifierSuffix}`
    const adminStore = createPostgresAdminStore(sql)
    const env = testEnv()
    const desktopStore = createPostgresDesktopConfigStore(
      sql,
      `control-encryption-${suffix}`,
      env.providerControlDeadlineMs,
    )
    const desktopConfig = createDesktopConfigService(desktopStore, env, {
      validateOtaReleaseArtifact: async (release) => ({
        valid: true,
        bytes: release.artifactBytes ?? 0,
        sha256: release.sha256 ?? '',
        contentLength: release.artifactBytes,
        redirects: 0,
        network: 'public',
        signaturePresent: true,
        artifactType: 'windows-pe-installer',
        expectedVersion: release.version,
        versionFacts: {},
      }),
    })

    const control = (action: string) => ({
      actorUserId: actorId,
      requestId: `${requestPrefix}-${action}`,
    })
    const baselineControl = (action: string) => ({
      actorUserId: actorId,
      requestId: `baseline-control-${suffix}-${action}`,
    })

    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values
          (${actorId}, ${`${actorId}@example.invalid`}, 'Control owner', true),
          (${targetId}, ${`${targetId}@example.invalid`}, 'Control target', true)
      `
      await sql`
        insert into admin_account (user_id, role, status)
        values
          (${actorId}, 'owner', 'active'),
          (${targetId}, 'viewer', 'active')
      `
      await sql`
        insert into account (id, user_id, provider_id, provider_account_id, password)
        values (${`credential-${suffix}`}, ${targetId}, 'credential', ${targetId}, 'old-password-hash')
      `
      await sql`
        insert into session (id, user_id, token_hash, expires_at)
        values (${`session-${suffix}`}, ${targetId}, ${`token-${suffix}`}, now() + interval '1 day')
      `

      await sql.unsafe(`
        create function "${functionName}"() returns trigger
        language plpgsql as $$
        begin
          if new.request_id like '${requestPrefix}-%' then
            raise exception 'forced control audit failure';
          end if;
          return new;
        end
        $$
      `)
      await sql.unsafe(`
        create trigger "${triggerName}"
        before insert on audit_log
        for each row execute function "${functionName}"()
      `)

      await expect(
        adminStore.createUser({
          email: createdEmail,
          name: 'Must fail closed',
          passwordHash: 'missing-control-password-hash',
          emailVerified: true,
        }),
      ).rejects.toBeInstanceOf(AdminAuthorizationChangedError)

      await expect(
        adminStore.createUser({
          email: createdEmail,
          name: 'Must roll back',
          passwordHash: 'new-user-password-hash',
          emailVerified: true,
          control: control('create-user'),
        }),
      ).rejects.toThrow('forced control audit failure')

      await expect(
        adminStore.resetUserPassword({
          userId: targetId,
          passwordHash: 'must-not-commit',
          control: control('reset-password'),
        }),
      ).rejects.toThrow('forced control audit failure')

      await expect(
        adminStore.setAdminAccount({
          userId: targetId,
          role: 'admin',
          status: 'active',
          actorUserId: actorId,
          requestId: control('admin-role').requestId,
        }),
      ).rejects.toThrow('forced control audit failure')

      await expect(
        adminStore.setUserQuotaLevel({
          userId: targetId,
          quotaLevel: 4,
          actorUserId: actorId,
          requestId: control('quota-level').requestId,
        }),
      ).rejects.toThrow('forced control audit failure')

      await expect(
        adminStore.upsertScenePack({
          slug: sceneSlug,
          name: 'Must roll back',
          description: 'Atomic audit failure fixture',
          category: 'test',
          promptTemplate: 'Do not persist this scene.',
          dictionaryTerms: [],
          isPro: false,
          enabled: true,
          control: control('scene'),
        }),
      ).rejects.toThrow('forced control audit failure')

      await expect(
        desktopConfig.upsertProvider(
          {
            kind: 'llm',
            providerId,
            displayName: providerDisplayName,
            enabled: false,
            mode: 'proxy',
            endpoint: 'https://provider.example/v1',
            apiKey: 'must-not-persist',
            defaultModel: 'test-model',
          },
          { control: control('provider') },
        ),
      ).rejects.toThrow('forced control audit failure')

      await expect(
        desktopConfig.upsertOtaRelease(
          {
            appName: 'EcholIKE',
            version: otaVersion,
            channel: 'test',
            platform: 'windows',
            arch: 'x86_64',
            enabled: false,
            forceUpdate: false,
            artifactBytes: 1024,
            downloadUrl: `https://artifact.example/${otaVersion}.exe`,
            sha256: 'a'.repeat(64),
            signature: 'test-signature',
          },
          { control: control('ota') },
        ),
      ).rejects.toThrow('forced control audit failure')

      const baselineProvider = await desktopConfig.upsertProvider(
        {
          kind: 'llm',
          providerId,
          displayName: `${providerDisplayName} baseline`,
          enabled: false,
          mode: 'proxy',
          endpoint: 'https://old-provider.example/v1',
          apiKey: 'baseline-secret',
          defaultModel: 'test-model',
          models: [{ id: 'test-model', label: 'Test model' }],
          capabilities: { streaming: true },
        },
        { control: baselineControl('provider') },
      )
      const baselinePolicy = await desktopStore.upsertDesktopPolicy({
        channel: policyChannel,
        platform: 'windows',
        plan: 'all',
        features: { managedAuth: true },
        services: { llm: { available: true } },
        policy: { activation: 'next_start' },
        enabled: true,
      })
      const jsonShapes = await sql<
        {
          provider_models: string
          provider_capabilities: string
          policy_features: string
          policy_services: string
          policy_policy: string
        }[]
      >`
        select
          jsonb_typeof(provider.models_json) as provider_models,
          jsonb_typeof(provider.capabilities_json) as provider_capabilities,
          jsonb_typeof(policy.features_json) as policy_features,
          jsonb_typeof(policy.services_json) as policy_services,
          jsonb_typeof(policy.policy_json) as policy_policy
        from provider_registry provider
        cross join desktop_policy policy
        where provider.id = ${baselineProvider.id}
          and policy.id = ${baselinePolicy.id}
      `
      expect(jsonShapes[0]).toEqual({
        provider_models: 'array',
        provider_capabilities: 'object',
        policy_features: 'object',
        policy_services: 'object',
        policy_policy: 'object',
      })
      await expect(
        desktopConfig.upsertProvider(
          {
            id: baselineProvider.id,
            expectedRevision: baselineProvider.revision,
            kind: 'llm',
            providerId,
            displayName: `${providerDisplayName} changed`,
            enabled: false,
            mode: 'proxy',
            endpoint: 'https://new-provider.example/v1',
            apiKey: 'must-not-commit',
            defaultModel: 'changed-model',
          },
          { control: control('provider-update') },
        ),
      ).rejects.toThrow('forced control audit failure')
      expect(await desktopStore.getProviderById(baselineProvider.id)).toMatchObject({
        displayName: `${providerDisplayName} baseline`,
        endpoint: 'https://old-provider.example/v1',
        apiKey: 'baseline-secret',
        revision: baselineProvider.revision,
      })

      const baselineRelease = await desktopConfig.upsertOtaRelease(
        {
          appName: 'EcholIKE',
          version: `${otaVersion}-baseline`,
          channel: 'test',
          platform: 'windows',
          arch: 'x86_64',
          enabled: false,
          forceUpdate: false,
          artifactBytes: 1024,
          downloadUrl: `https://artifact.example/${otaVersion}-baseline.exe`,
          sha256: 'b'.repeat(64),
          signature: 'baseline-signature',
        },
        { control: baselineControl('ota') },
      )
      await expect(
        desktopConfig.validateOtaRelease(
          { id: baselineRelease.id, expectedRevision: baselineRelease.revision },
          { control: control('ota-validate') },
        ),
      ).rejects.toThrow('forced control audit failure')
      await expect(
        desktopConfig.activateOtaRelease(
          {
            id: baselineRelease.id,
            expectedRevision: baselineRelease.revision,
            forceUpdate: false,
          },
          { control: control('ota-activate') },
        ),
      ).rejects.toThrow('forced control audit failure')
      expect(await desktopStore.getOtaReleaseById(baselineRelease.id)).toMatchObject({
        enabled: false,
        revision: baselineRelease.revision,
      })

      const activatedRelease = await desktopConfig.activateOtaRelease(
        {
          id: baselineRelease.id,
          expectedRevision: baselineRelease.revision,
          forceUpdate: false,
        },
        { control: baselineControl('ota-activate') },
      )
      await expect(
        desktopConfig.deactivateOtaRelease(
          {
            id: baselineRelease.id,
            expectedRevision: activatedRelease.release.revision,
          },
          { control: control('ota-deactivate') },
        ),
      ).rejects.toThrow('forced control audit failure')
      expect(await desktopStore.getOtaReleaseById(baselineRelease.id)).toMatchObject({
        enabled: true,
        revision: activatedRelease.release.revision,
      })

      const facts = await sql<
        {
          created_users: number | string
          password: string | null
          sessions: number | string
          target_role: string
          quota_profiles: number | string
          scenes: number | string
          providers: number | string
          releases: number | string
        }[]
      >`
        select
          (select count(*) from "user" where email = ${createdEmail})::int as created_users,
          (select password from account where user_id = ${targetId} and provider_id = 'credential')
            as password,
          (select count(*) from session where user_id = ${targetId})::int as sessions,
          (select role from admin_account where user_id = ${targetId}) as target_role,
          (select count(*) from user_quota_profile where user_id = ${targetId})::int
            as quota_profiles,
          (select count(*) from scene_pack where slug = ${sceneSlug})::int as scenes,
          (select count(*) from provider_registry where display_name = ${providerDisplayName})::int
            as providers,
          (select count(*) from ota_release where version = ${otaVersion})::int as releases
      `
      expect(facts[0]).toEqual({
        created_users: 0,
        password: 'old-password-hash',
        sessions: 1,
        target_role: 'viewer',
        quota_profiles: 0,
        scenes: 0,
        providers: 0,
        releases: 0,
      })

      await sql`
        update admin_account
        set status = 'disabled'
        where user_id = ${actorId}
      `
      await expect(
        desktopConfig.upsertProvider(
          {
            kind: 'llm',
            providerId,
            displayName: providerDisplayName,
            enabled: false,
            mode: 'proxy',
            endpoint: 'https://provider.example/v1',
            defaultModel: 'test-model',
          },
          { control: { actorUserId: actorId, requestId: `disabled-${suffix}` } },
        ),
      ).rejects.toBeInstanceOf(AdminAuthorizationChangedError)
    } finally {
      await sql
        .unsafe(`drop trigger if exists "${triggerName}" on audit_log`)
        .catch(() => undefined)
      await sql.unsafe(`drop function if exists "${functionName}"()`).catch(() => undefined)
      await sql`delete from ota_release where version = ${otaVersion}`.catch(() => undefined)
      await sql`delete from ota_release where version = ${`${otaVersion}-baseline`}`.catch(
        () => undefined,
      )
      await sql`delete from provider_registry where display_name = ${providerDisplayName}`.catch(
        () => undefined,
      )
      await sql`delete from provider_registry where display_name like ${`${providerDisplayName}%`}`.catch(
        () => undefined,
      )
      await sql`delete from desktop_policy where channel = ${policyChannel}`.catch(() => undefined)
      await sql`delete from scene_pack where slug = ${sceneSlug}`.catch(() => undefined)
      await sql`delete from audit_log where request_id like ${`${requestPrefix}-%`}`.catch(
        () => undefined,
      )
      await sql`delete from audit_log where request_id like ${`baseline-control-${suffix}-%`}`.catch(
        () => undefined,
      )
      await sql`delete from "user" where id in (${actorId}, ${targetId}) or email = ${createdEmail}`.catch(
        () => undefined,
      )
      await sql.end()
    }
  },
)
