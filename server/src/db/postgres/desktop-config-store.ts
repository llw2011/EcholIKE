import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { ApiError } from '../../errors.js'
import type {
  DesktopConfigStore,
  DesktopPolicyRecord,
  OtaReleaseActivationStoreInput,
  OtaReleaseConvergenceInput,
  OtaReleaseInput,
  OtaReleaseStoredRecord,
  ProviderRegistryInput,
  ProviderRegistryStoredRecord,
} from '../../services/desktop/desktop-config-service.js'
import {
  OtaReleaseStateError,
  ProviderRegistryStateError,
} from '../../services/desktop/desktop-config-service.js'
import { assertPostgresControlActor, insertPostgresControlAudit } from './control-audit.js'
import { jsonArray, jsonObject, timestampToIso, toNumber } from './row-values.js'

export function createPostgresDesktopConfigStore(
  client: postgres.Sql,
  encryptionSecret: string,
  controlTransactionDeadlineMs: number,
): DesktopConfigStore {
  if (!Number.isSafeInteger(controlTransactionDeadlineMs) || controlTransactionDeadlineMs <= 0) {
    throw new Error('control transaction deadline must be a positive integer')
  }
  return {
    async listProviders() {
      const rows = await client<ProviderRow[]>`
        select
          id,
          kind,
          provider_id,
          display_name,
          enabled,
          mode,
          endpoint_encrypted,
          api_key_encrypted,
          default_model,
          models_json,
          capabilities_json,
          priority,
          revision,
          created_at,
          updated_at
        from provider_registry
        order by kind, priority desc, provider_id
        limit 200
      `
      return rows.map((row) => providerFromRow(row, encryptionSecret))
    },

    async getProviderById(id) {
      const rows = await client<ProviderRow[]>`
        select
          id,
          kind,
          provider_id,
          display_name,
          enabled,
          mode,
          endpoint_encrypted,
          api_key_encrypted,
          default_model,
          models_json,
          capabilities_json,
          priority,
          revision,
          created_at,
          updated_at
        from provider_registry
        where id = ${id}
        limit 1
      `
      return rows[0] ? providerFromRow(rows[0], encryptionSecret) : null
    },

    async upsertProvider(input, control, prepare) {
      return await client.begin(async (transaction) => {
        await assertPostgresControlActor(transaction, control, ['owner', 'admin'])
        if (!input.id) {
          await acquireProviderIdentityLock(transaction, input.kind, input.providerId)
        }
        const existingRows = input.id
          ? await transaction<ProviderRow[]>`
              select ${transaction.unsafe(providerReturningColumns())}
              from provider_registry
              where id = ${input.id}
              for update
              limit 1
            `
          : await transaction<ProviderRow[]>`
              select ${transaction.unsafe(providerReturningColumns())}
              from provider_registry
              where kind = ${input.kind}
                and provider_id = ${input.providerId}
              for update
              limit 1
            `
        const existing = existingRows[0] ? providerFromRow(existingRows[0], encryptionSecret) : null
        const prepared = await prepare(existing)
        await acquireProviderIdentityLock(transaction, prepared.kind, prepared.providerId)
        const conflictingRows = await transaction<{ id: string }[]>`
          select id
          from provider_registry
          where kind = ${prepared.kind}
            and provider_id = ${prepared.providerId}
            and id <> ${existing?.id ?? prepared.id ?? '00000000-0000-0000-0000-000000000000'}
          for update
          limit 1
        `
        if (conflictingRows[0]) {
          throw new ProviderRegistryStateError('provider_conflict')
        }
        const rows = prepared.id
          ? await updateProvider(transaction, prepared, encryptionSecret)
          : await insertProvider(transaction, prepared, encryptionSecret)
        const row = rows[0]
        if (!row) {
          throw new ProviderRegistryStateError(prepared.id ? 'provider_stale' : 'provider_conflict')
        }
        const provider = providerFromRow(row, encryptionSecret)
        await insertPostgresControlAudit(
          transaction,
          control,
          'admin.provider.upsert',
          providerControlAuditMetadata(provider),
        )
        return provider
      })
    },

    async listDesktopPolicies() {
      const rows = await client<DesktopPolicyRow[]>`
        select
          id,
          channel,
          platform,
          plan,
          features_json,
          services_json,
          policy_json,
          enabled,
          created_at,
          updated_at
        from desktop_policy
        order by updated_at desc
        limit 200
      `
      return rows.map(desktopPolicyFromRow)
    },

    async upsertDesktopPolicy(input) {
      const rows = input.id
        ? await client<DesktopPolicyRow[]>`
            update desktop_policy
            set
              channel = ${input.channel},
              platform = ${input.platform},
              plan = ${input.plan},
              features_json = ${JSON.stringify(input.features ?? {})}::text::jsonb,
              services_json = ${JSON.stringify(input.services ?? {})}::text::jsonb,
              policy_json = ${JSON.stringify(input.policy ?? {})}::text::jsonb,
              enabled = ${input.enabled},
              updated_at = now()
            where id = ${input.id}
            returning id, channel, platform, plan, features_json, services_json, policy_json, enabled, created_at, updated_at
          `
        : await client<DesktopPolicyRow[]>`
            insert into desktop_policy (
              channel,
              platform,
              plan,
              features_json,
              services_json,
              policy_json,
              enabled,
              updated_at
            )
            values (
              ${input.channel},
              ${input.platform},
              ${input.plan},
              ${JSON.stringify(input.features ?? {})}::text::jsonb,
              ${JSON.stringify(input.services ?? {})}::text::jsonb,
              ${JSON.stringify(input.policy ?? {})}::text::jsonb,
              ${input.enabled},
              now()
            )
            returning id, channel, platform, plan, features_json, services_json, policy_json, enabled, created_at, updated_at
          `
      const row = rows[0]
      if (!row) throw new Error('desktop policy upsert did not return a row')
      return desktopPolicyFromRow(row)
    },

    async listOtaReleases() {
      const rows = await client<OtaReleaseRow[]>`
        select
          id,
          app_name,
          version,
          channel,
          platform,
          arch,
          enabled,
          auto_update,
          force_update,
          min_version,
          artifact_bytes,
          download_url_encrypted,
          sha256,
          signature,
          release_notes,
          revision,
          created_at,
          published_at
        from public.ota_release
        order by published_at desc, version desc
        limit 200
      `
      return rows.map((row) => otaReleaseFromRow(row, encryptionSecret))
    },

    async getOtaReleaseById(id) {
      const rows = await client<OtaReleaseRow[]>`
        select ${client.unsafe(otaReturningColumns())}
        from public.ota_release
        where id = ${id}
        limit 1
      `
      const row = rows[0]
      return row ? otaReleaseFromRow(row, encryptionSecret) : null
    },

    async upsertOtaRelease(input, control) {
      return await client.begin(async (transaction) => {
        await configureOtaControlTransaction(transaction, controlTransactionDeadlineMs)
        await acquireOtaControlLock(transaction)
        await assertPostgresControlActor(transaction, control, ['owner', 'admin'])
        await acquireOtaTargetLock(transaction, input)
        const rows = input.id
          ? await updateOtaRelease(transaction, input, encryptionSecret)
          : await insertOtaRelease(transaction, input, encryptionSecret)
        const row = rows[0]
        if (!row) return null
        const release = otaReleaseFromRow(row, encryptionSecret)
        await insertPostgresControlAudit(
          transaction,
          control,
          'admin.ota.upsert',
          otaControlAuditMetadata(release),
        )
        return release
      })
    },

    async recordOtaValidation(input) {
      return await client.begin(async (transaction) => {
        await configureOtaControlTransaction(transaction, controlTransactionDeadlineMs)
        await acquireOtaControlLock(transaction)
        await assertPostgresControlActor(transaction, input.control, ['owner', 'admin'])
        const rows = await transaction<OtaReleaseRow[]>`
          select ${transaction.unsafe(otaReturningColumns())}
          from public.ota_release
          where id = ${input.id}
            and revision = ${input.expectedRevision}
          for update
          limit 1
        `
        const row = rows[0]
        if (!row) return null
        const release = otaReleaseFromRow(row, encryptionSecret)
        await insertPostgresControlAudit(transaction, input.control, 'admin.ota.validate', {
          ...otaControlAuditMetadata(release),
          artifactBytes: input.validation.bytes,
          artifactSha256: input.validation.sha256,
        })
        return release
      })
    },

    async setOtaReleaseActivation(input) {
      return await client.begin(async (transaction) => {
        await configureOtaControlTransaction(transaction, controlTransactionDeadlineMs)
        await acquireOtaControlLock(transaction)
        await assertPostgresControlActor(
          transaction,
          input.control,
          input.enabled && input.forceUpdate ? ['owner'] : ['owner', 'admin'],
        )
        const rows = await setOtaReleaseActivation(transaction, input)
        const row = rows[0]
        if (!row) return null
        const release = otaReleaseFromRow(row, encryptionSecret)
        await insertPostgresControlAudit(
          transaction,
          input.control,
          input.enabled ? 'admin.ota.activate' : 'admin.ota.deactivate',
          otaControlAuditMetadata(release),
        )
        return release
      })
    },

    async convergeOtaReleases(input, prepare) {
      return await client.begin(async (transaction) => {
        await configureOtaControlTransaction(transaction, controlTransactionDeadlineMs)
        await acquireOtaControlLock(transaction)
        await assertPostgresControlActor(transaction, input.control, ['owner', 'admin'])
        const rows = await transaction<OtaReleaseRow[]>`
          select ${transaction.unsafe(otaReturningColumns())}
          from public.ota_release
          order by id
          for update
        `
        const releases = rows.map((row) => otaReleaseFromRow(row, encryptionSecret))
        const target = releases.find((release) => release.id === input.id)
        if (!target || target.revision !== input.expectedRevision) return null

        const requestedIds = prepare(releases)
        const ids = [...new Set(requestedIds)]
        const expectedRevisions = otaConvergenceExpectedRevisions(input)
        if (
          ids.length !== requestedIds.length ||
          ids.length !== expectedRevisions.size ||
          ids.includes(input.id) ||
          ids.some((id) => !expectedRevisions.has(id))
        ) {
          throw new OtaReleaseStateError('release_stale')
        }
        const selected = releases.filter((release) => ids.includes(release.id))
        if (
          selected.length !== ids.length ||
          selected.some(
            (release) => !release.enabled || expectedRevisions.get(release.id) !== release.revision,
          )
        ) {
          throw new OtaReleaseStateError('release_stale')
        }

        if (ids.length) {
          const updated = await transaction<{ id: string }[]>`
            update public.ota_release
            set
              enabled = false,
              force_update = false,
              revision = revision + 1
            where id in ${transaction(ids)}
              and enabled = true
            returning id
          `
          if (updated.length !== ids.length) throw new OtaReleaseStateError('release_stale')
        }

        const invalid = await transaction<{ count: number | string }[]>`
          select count(*)::integer as count
          from public.ota_release
          where enabled = true and (
            artifact_bytes is null or artifact_bytes <= 0 or
            nullif(btrim(download_url_encrypted), '') is null or
            sha256 is null or sha256 !~* '^[a-f0-9]{64}$' or
            nullif(btrim(signature), '') is null
          )
        `
        if (toNumber(invalid[0]?.count) !== 0) {
          throw new OtaReleaseStateError('release_incomplete')
        }
        await transaction`
          alter table public.ota_release
          validate constraint ota_release_enabled_artifact_check
        `
        const constraints = await transaction<{ convalidated: boolean }[]>`
          select convalidated
          from pg_catalog.pg_constraint
          where conname = 'ota_release_enabled_artifact_check'
            and conrelid = 'public.ota_release'::regclass
          limit 1
        `
        if (constraints[0]?.convalidated !== true) {
          throw new OtaReleaseStateError('release_incomplete')
        }

        await insertPostgresControlAudit(transaction, input.control, 'admin.ota.converge', {
          ...otaControlAuditMetadata(target),
          deactivatedCount: ids.length,
          constraintValidated: true,
        })
        return {
          release: target,
          deactivatedCount: ids.length,
          constraintValidated: true,
        }
      })
    },
  }
}

type ProviderRow = {
  id: string
  kind: ProviderRegistryStoredRecord['kind']
  provider_id: string
  display_name: string
  enabled: boolean
  mode: ProviderRegistryStoredRecord['mode']
  endpoint_encrypted: string | null
  api_key_encrypted: string | null
  default_model: string | null
  models_json: unknown
  capabilities_json: unknown
  priority: number
  revision: number | string
  created_at: Date | null
  updated_at: Date | null
}

type DesktopPolicyRow = {
  id: string
  channel: string
  platform: string
  plan: DesktopPolicyRecord['plan']
  features_json: unknown
  services_json: unknown
  policy_json: unknown
  enabled: boolean
  created_at: Date | null
  updated_at: Date | null
}

type OtaReleaseRow = {
  id: string
  app_name: string
  version: string
  channel: string
  platform: string
  arch: string
  enabled: boolean
  auto_update: boolean
  force_update: boolean
  min_version: string | null
  artifact_bytes: number | string | null
  download_url_encrypted: string | null
  sha256: string | null
  signature: string | null
  release_notes: string | null
  revision: number | string
  created_at: Date | null
  published_at: Date | null
}

function providerFromRow(row: ProviderRow, encryptionSecret: string): ProviderRegistryStoredRecord {
  const endpoint = decryptSecret(row.endpoint_encrypted, encryptionSecret)
  const apiKey = decryptSecret(row.api_key_encrypted, encryptionSecret)
  return {
    id: row.id,
    kind: row.kind,
    providerId: row.provider_id,
    displayName: row.display_name,
    enabled: row.enabled,
    mode: row.mode,
    endpoint,
    apiKey,
    apiKeyPreview: apiKey ? 'set' : null,
    defaultModel: row.default_model,
    models: jsonArray<ProviderRegistryStoredRecord['models'][number]>(row.models_json),
    capabilities: jsonObject(row.capabilities_json),
    priority: Number(row.priority ?? 0),
    revision: nullableInteger(row.revision) ?? 0,
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at),
  }
}

function desktopPolicyFromRow(row: DesktopPolicyRow): DesktopPolicyRecord {
  return {
    id: row.id,
    channel: row.channel,
    platform: row.platform,
    plan: row.plan,
    features: jsonObject(row.features_json),
    services: jsonObject(row.services_json),
    policy: jsonObject(row.policy_json),
    enabled: row.enabled,
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at),
  }
}

function otaReleaseFromRow(row: OtaReleaseRow, encryptionSecret: string): OtaReleaseStoredRecord {
  const downloadUrl = decryptSecret(row.download_url_encrypted, encryptionSecret)
  return {
    id: row.id,
    appName: row.app_name,
    version: row.version,
    channel: row.channel,
    platform: row.platform,
    arch: row.arch,
    enabled: row.enabled,
    autoUpdate: row.auto_update,
    forceUpdate: row.force_update,
    minVersion: row.min_version,
    artifactBytes: nullableInteger(row.artifact_bytes),
    downloadUrl,
    downloadUrlPreview: downloadUrl ? 'set' : 'missing',
    sha256: row.sha256,
    signature: row.signature,
    releaseNotes: row.release_notes,
    revision: nullableInteger(row.revision) ?? 0,
    createdAt: timestampToIso(row.created_at),
    publishedAt: timestampToIso(row.published_at),
  }
}

function providerControlAuditMetadata(
  provider: ProviderRegistryStoredRecord,
): Record<string, unknown> {
  return {
    providerRecordId: provider.id,
    providerId: provider.providerId,
    kind: provider.kind,
    mode: provider.mode,
    enabled: provider.enabled,
    revision: provider.revision,
    apiKey: provider.apiKey ? 'set' : 'missing',
  }
}

function otaControlAuditMetadata(release: OtaReleaseStoredRecord): Record<string, unknown> {
  return {
    releaseId: release.id,
    version: release.version,
    channel: release.channel,
    platform: release.platform,
    arch: release.arch,
    enabled: release.enabled,
    forceUpdate: release.forceUpdate,
    revision: release.revision,
    downloadUrl: release.downloadUrl ? 'set' : 'missing',
  }
}

const ENCRYPTED_VALUE_PREFIX = 'enc:v1:'

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

function encryptSecret(value: string | null | undefined, secret: string): string | null {
  const normalized = value?.trim()
  if (!normalized) return null
  if (normalized.startsWith(ENCRYPTED_VALUE_PREFIX)) return normalized

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv)
  const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${ENCRYPTED_VALUE_PREFIX}${iv.toString('base64')}:${authTag.toString(
    'base64',
  )}:${encrypted.toString('base64')}`
}

function decryptSecret(value: string | null, secret: string): string | null {
  if (!value) return null
  if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) return value

  const [ivText, authTagText, encryptedText] = value.slice(ENCRYPTED_VALUE_PREFIX.length).split(':')
  if (!ivText || !authTagText || !encryptedText) return null

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret),
      Buffer.from(ivText, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(authTagText, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

function providerReturningColumns(): string {
  return `
    id,
    kind,
    provider_id,
    display_name,
    enabled,
    mode,
    endpoint_encrypted,
    api_key_encrypted,
    default_model,
    models_json,
    capabilities_json,
    priority,
    revision,
    created_at,
    updated_at
  `
}

type DesktopConfigTransactionalClient = postgres.Sql | postgres.TransactionSql

export const OTA_CONTROL_LOCK_KEY = 'ota_release:control:v1'

async function acquireProviderIdentityLock(
  client: DesktopConfigTransactionalClient,
  kind: ProviderRegistryInput['kind'],
  providerId: string,
): Promise<void> {
  await client`
    select pg_advisory_xact_lock(
      hashtextextended(${'provider_registry:' + kind + ':' + providerId}, 0)
    )
  `
}

async function acquireOtaTargetLock(
  client: DesktopConfigTransactionalClient,
  input: OtaReleaseInput,
): Promise<void> {
  const target = [
    input.appName ?? 'EcholIKE',
    input.version,
    input.channel,
    input.platform,
    input.arch,
  ]
    .map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`)
    .join('|')
  await client`
    select pg_advisory_xact_lock(hashtextextended(${'ota_release:' + target}, 0))
  `
}

async function acquireOtaControlLock(client: DesktopConfigTransactionalClient): Promise<void> {
  await client`
    select pg_advisory_xact_lock(hashtextextended(${OTA_CONTROL_LOCK_KEY}, 0))
  `
}

async function configureOtaControlTransaction(
  client: DesktopConfigTransactionalClient,
  deadlineMs: number,
): Promise<void> {
  const timeout = `${deadlineMs}ms`
  await client`
    select
      set_config('lock_timeout', ${timeout}, true),
      set_config('statement_timeout', ${timeout}, true)
  `
}

function otaConvergenceExpectedRevisions(input: OtaReleaseConvergenceInput): Map<string, number> {
  const expected = new Map<string, number>()
  for (const release of input.expectedCovered) {
    if (
      !release.id ||
      release.id === input.id ||
      !Number.isSafeInteger(release.revision) ||
      release.revision < 0 ||
      expected.has(release.id)
    ) {
      throw new OtaReleaseStateError('release_stale')
    }
    expected.set(release.id, release.revision)
  }
  return expected
}

async function insertProvider(
  client: DesktopConfigTransactionalClient,
  input: ProviderRegistryInput,
  encryptionSecret: string,
): Promise<ProviderRow[]> {
  return await client<ProviderRow[]>`
    insert into provider_registry (
      kind,
      provider_id,
      display_name,
      enabled,
      mode,
      endpoint_encrypted,
      api_key_encrypted,
      default_model,
      models_json,
      capabilities_json,
      priority,
      updated_at
    )
    values (
      ${input.kind},
      ${input.providerId},
      ${input.displayName},
      ${input.enabled},
      ${input.mode},
      ${encryptSecret(input.endpoint ?? null, encryptionSecret)},
      ${encryptSecret(input.apiKey ?? null, encryptionSecret)},
      ${input.defaultModel ?? null},
      ${JSON.stringify(input.models ?? [])}::text::jsonb,
      ${JSON.stringify(input.capabilities ?? {})}::text::jsonb,
      ${input.priority ?? 0},
      now()
    )
    on conflict (kind, provider_id) do nothing
    returning ${client.unsafe(providerReturningColumns())}
  `
}

async function updateProvider(
  client: DesktopConfigTransactionalClient,
  input: ProviderRegistryInput,
  encryptionSecret: string,
): Promise<ProviderRow[]> {
  if (!input.id) return []
  return await client<ProviderRow[]>`
    update provider_registry
    set
      kind = ${input.kind},
      provider_id = ${input.providerId},
      display_name = ${input.displayName},
      enabled = ${input.enabled},
      mode = ${input.mode},
      endpoint_encrypted = ${encryptSecret(input.endpoint ?? null, encryptionSecret)},
      api_key_encrypted = case
        when ${input.apiKey === undefined} then api_key_encrypted
        else ${encryptSecret(input.apiKey ?? null, encryptionSecret)}
      end,
      default_model = ${input.defaultModel ?? null},
      models_json = ${JSON.stringify(input.models ?? [])}::text::jsonb,
      capabilities_json = ${JSON.stringify(input.capabilities ?? {})}::text::jsonb,
      priority = ${input.priority ?? 0},
      revision = revision + 1,
      updated_at = now()
    where id = ${input.id}
      and revision = ${input.expectedRevision ?? -1}
    returning ${client.unsafe(providerReturningColumns())}
  `
}

function otaReturningColumns(): string {
  return `
    id,
    app_name,
    version,
    channel,
    platform,
    arch,
    enabled,
    auto_update,
    force_update,
    min_version,
    artifact_bytes,
    download_url_encrypted,
    sha256,
    signature,
    release_notes,
    revision,
    created_at,
    published_at
  `
}

async function insertOtaRelease(
  client: DesktopConfigTransactionalClient,
  input: OtaReleaseInput,
  encryptionSecret: string,
): Promise<OtaReleaseRow[]> {
  return await client<OtaReleaseRow[]>`
    insert into public.ota_release (
      app_name,
      version,
      channel,
      platform,
      arch,
      enabled,
      auto_update,
      force_update,
      min_version,
      artifact_bytes,
      download_url_encrypted,
      sha256,
      signature,
      release_notes,
      published_at
    )
    values (
      ${input.appName ?? 'EcholIKE'},
      ${input.version},
      ${input.channel},
      ${input.platform},
      ${input.arch},
      false,
      ${input.autoUpdate ?? false},
      false,
      ${input.minVersion ?? null},
      ${input.artifactBytes ?? null},
      ${encryptSecret(input.downloadUrl ?? null, encryptionSecret)},
      ${input.sha256 ?? null},
      ${input.signature ?? null},
      ${input.releaseNotes ?? null},
      ${postgresTimestampValue(input.publishedAt)}
    )
    on conflict (app_name, version, channel, platform, arch) do nothing
    returning ${client.unsafe(otaReturningColumns())}
  `
}

async function updateOtaRelease(
  client: DesktopConfigTransactionalClient,
  input: OtaReleaseInput,
  encryptionSecret: string,
): Promise<OtaReleaseRow[]> {
  if (!input.id) return []
  return await client<OtaReleaseRow[]>`
    update public.ota_release
    set
      app_name = ${input.appName ?? 'EcholIKE'},
      version = ${input.version},
      channel = ${input.channel},
      platform = ${input.platform},
      arch = ${input.arch},
      enabled = false,
      auto_update = ${input.autoUpdate ?? false},
      force_update = false,
      min_version = ${input.minVersion ?? null},
      artifact_bytes = case
        when ${input.artifactBytes === undefined} then artifact_bytes
        else ${input.artifactBytes ?? null}
      end,
      download_url_encrypted = case
        when ${input.downloadUrl === undefined} then download_url_encrypted
        else ${encryptSecret(input.downloadUrl ?? null, encryptionSecret)}
      end,
      sha256 = ${input.sha256 ?? null},
      signature = ${input.signature ?? null},
      release_notes = ${input.releaseNotes ?? null},
      published_at = ${postgresTimestampValue(input.publishedAt)},
      revision = revision + 1
    where id = ${input.id}
      and enabled = false
      and revision = ${input.expectedRevision ?? -1}
    returning ${client.unsafe(otaReturningColumns())}
  `
}

async function setOtaReleaseActivation(
  client: DesktopConfigTransactionalClient,
  input: OtaReleaseActivationStoreInput,
): Promise<OtaReleaseRow[]> {
  return await client<OtaReleaseRow[]>`
    update public.ota_release
    set
      enabled = ${input.enabled},
      force_update = ${input.enabled ? input.forceUpdate : false},
      revision = revision + 1,
      published_at = case when ${input.enabled} then now() else published_at end
    where id = ${input.id}
      and revision = ${input.expectedRevision}
      and enabled = ${!input.enabled}
      and (
        ${!input.enabled}
        or (
          artifact_bytes > 0
          and nullif(btrim(download_url_encrypted), '') is not null
          and sha256 ~* '^[a-f0-9]{64}$'
          and nullif(btrim(signature), '') is not null
        )
      )
    returning ${client.unsafe(otaReturningColumns())}
  `
}

function nullableInteger(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(500, 'internal_error', 'database integer value is invalid', false)
  }
  return parsed
}

export function postgresTimestampValue(
  value: string | null | undefined,
  fallback = new Date(),
): string {
  const date = value ? new Date(value) : fallback
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) {
    throw new Error('publishedAt must be a valid timestamp')
  }
  return date.toISOString()
}
