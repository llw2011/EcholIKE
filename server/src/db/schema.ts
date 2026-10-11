import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const planEnum = pgEnum('plan', ['free', 'pro'])
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
])
export const usageLedgerKindEnum = pgEnum('usage_ledger_kind', [
  'stt_seconds',
  'llm_tokens',
  'ocr_images',
  'tts_chars',
])
export const usageLedgerSourceEnum = pgEnum('usage_ledger_source', [
  'proxy_stt',
  'proxy_llm',
  'proxy_ocr',
  'proxy_tts',
  'adjustment',
])
export const quotaOperationStatusEnum = pgEnum('quota_operation_status', [
  'reserved',
  'completed',
  'released',
])
export const quotaOperationEventEnum = pgEnum('quota_operation_event', [
  'reserve',
  'commit',
  'release',
])
export const adminRoleEnum = pgEnum('admin_role', ['owner', 'admin', 'operator', 'viewer'])
export const adminStatusEnum = pgEnum('admin_status', ['active', 'disabled'])
export const providerKindEnum = pgEnum('provider_kind', ['llm', 'stt', 'tts', 'ocr'])
export const providerModeEnum = pgEnum('provider_mode', [
  'proxy',
  'direct',
  'byok',
  'local',
  'disabled',
])
export const desktopPolicyPlanEnum = pgEnum('desktop_policy_plan', ['free', 'pro', 'all'])

const createdAtColumn = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAtColumn = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => Uint8Array.from(value),
})

export const users = pgTable(
  'user',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    image: text('image'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    emailIdx: uniqueIndex('user_email_idx').on(table.email),
  }),
)

export const sessions = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipHash: text('ip_hash'),
    userAgentHash: text('user_agent_hash'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex('session_token_hash_idx').on(table.tokenHash),
    userExpiresIdx: index('session_user_expires_idx').on(table.userId, table.expiresAt),
  }),
)

export const accounts = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    providerAccountIdx: uniqueIndex('account_provider_account_idx').on(
      table.providerId,
      table.providerAccountId,
    ),
    userIdx: index('account_user_idx').on(table.userId),
  }),
)

export const verifications = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    identifierIdx: index('verification_identifier_idx').on(table.identifier),
    expiresAtIdx: index('verification_expires_at_idx').on(table.expiresAt),
  }),
)

export const adminAccounts = pgTable(
  'admin_account',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: adminRoleEnum('role').notNull(),
    status: adminStatusEnum('status').notNull().default('active'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    roleIdx: index('admin_account_role_idx').on(table.role),
    statusIdx: index('admin_account_status_idx').on(table.status),
  }),
)

export const adminOperations = pgTable(
  'admin_operation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    requestId: text('request_id').notNull(),
    resultJson: jsonb('result_json').$type<Record<string, unknown>>(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    actorKeyIdx: uniqueIndex('admin_operation_actor_key_idx').on(
      table.actorUserId,
      table.kind,
      table.idempotencyKey,
    ),
    createdAtIdx: index('admin_operation_created_at_idx').on(table.createdAt),
    kindCheck: check('admin_operation_kind_check', sql`${table.kind} = 'quota_adjustment'`),
    payloadHashCheck: check(
      'admin_operation_payload_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    idempotencyKeyCheck: check(
      'admin_operation_idempotency_key_check',
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9._:-]{16,200}$'`,
    ),
    resultCheck: check(
      'admin_operation_result_check',
      sql`${table.resultJson} is null or jsonb_typeof(${table.resultJson}) = 'object'`,
    ),
  }),
)

export const subscriptions = pgTable(
  'subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id'),
    plan: planEnum('plan').notNull(),
    status: subscriptionStatusEnum('status').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    stripeEventCreatedAt: timestamp('stripe_event_created_at', { withTimezone: true }),
    stripeEventId: text('stripe_event_id'),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    userIdx: index('subscription_user_idx').on(table.userId),
    customerIdx: uniqueIndex('subscription_stripe_customer_idx').on(table.stripeCustomerId),
    stripeSubscriptionIdx: uniqueIndex('subscription_stripe_subscription_idx').on(
      table.stripeSubscriptionId,
    ),
    stripeEventOrderIdx: index('subscription_stripe_event_order_idx').on(
      table.stripeEventCreatedAt,
      table.stripeEventId,
    ),
  }),
)

export const quotaOperations = pgTable(
  'quota_operation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    kind: usageLedgerKindEnum('kind').notNull(),
    source: usageLedgerSourceEnum('source').notNull(),
    periodKey: text('period_key').notNull(),
    requestId: text('request_id').notNull(),
    reservedAmount: integer('reserved_amount').notNull(),
    actualAmount: integer('actual_amount'),
    status: quotaOperationStatusEnum('status').notNull().default('reserved'),
    leaseToken: text('lease_token'),
    finalizedLeaseToken: text('finalized_lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    responseHeadersJson: jsonb('response_headers_json').$type<Record<string, string>>(),
    responseBody: bytea('response_body'),
    responseExpiresAt: timestamp('response_expires_at', { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    userKeyIdx: uniqueIndex('quota_operation_user_key_idx').on(table.userId, table.idempotencyKey),
    leaseSweepIdx: index('quota_operation_lease_sweep_idx').on(
      table.userId,
      table.kind,
      table.periodKey,
      table.status,
      table.leaseExpiresAt,
    ),
    globalLeaseSweepIdx: index('quota_operation_global_lease_sweep_idx').on(
      table.status,
      table.leaseExpiresAt,
    ),
    createdAtIdx: index('quota_operation_created_at_idx').on(table.createdAt, table.id),
    userCreatedAtIdx: index('quota_operation_user_created_at_idx').on(
      table.userId,
      table.createdAt,
      table.id,
    ),
    periodStatusCreatedAtIdx: index('quota_operation_period_status_created_at_idx').on(
      table.periodKey,
      table.status,
      table.createdAt,
      table.id,
    ),
    responseSweepIdx: index('quota_operation_response_sweep_idx').on(
      table.status,
      table.responseExpiresAt,
    ),
    responseHeadersObjectCheck: check(
      'quota_operation_response_headers_object_check',
      sql`${table.responseHeadersJson} is null or jsonb_typeof(${table.responseHeadersJson}) = 'object'`,
    ),
    sourceCheck: check(
      'quota_operation_source_check',
      sql`${table.source} <> 'adjustment'::usage_ledger_source`,
    ),
    reservedAmountCheck: check(
      'quota_operation_reserved_amount_check',
      sql`${table.reservedAmount} >= 0`,
    ),
    actualAmountCheck: check(
      'quota_operation_actual_amount_check',
      sql`${table.actualAmount} is null or ${table.actualAmount} >= 0`,
    ),
    payloadHashCheck: check(
      'quota_operation_payload_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    idempotencyKeyCheck: check(
      'quota_operation_idempotency_key_check',
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$'`,
    ),
    stateCheck: check(
      'quota_operation_state_check',
      sql`(
        (${table.status} = 'reserved'::quota_operation_status
          and ${table.leaseToken} is not null
          and ${table.leaseExpiresAt} is not null
          and ${table.finalizedLeaseToken} is null
          and ${table.actualAmount} is null
          and ${table.responseStatus} is null
          and ${table.responseHeadersJson} is null
          and ${table.responseBody} is null
          and ${table.responseExpiresAt} is null)
        or
        (${table.status} = 'completed'::quota_operation_status
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.finalizedLeaseToken} is not null
          and ${table.actualAmount} is not null
          and ${table.responseStatus} is not null
          and ${table.responseExpiresAt} is not null
          and (
            (${table.responseHeadersJson} is not null and ${table.responseBody} is not null)
            or (${table.responseHeadersJson} is null and ${table.responseBody} is null)
          ))
        or
        (${table.status} = 'released'::quota_operation_status
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.finalizedLeaseToken} is not null
          and ${table.actualAmount} is null
          and ${table.responseStatus} is null
          and ${table.responseHeadersJson} is null
          and ${table.responseBody} is null
          and ${table.responseExpiresAt} is null)
      )`,
    ),
  }),
)

export const usageLedgers = pgTable(
  'usage_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: usageLedgerKindEnum('kind').notNull(),
    amount: integer('amount').notNull(),
    source: usageLedgerSourceEnum('source').notNull(),
    requestId: text('request_id').notNull(),
    periodKey: text('period_key').notNull(),
    operationId: uuid('operation_id').references(() => quotaOperations.id, {
      onDelete: 'restrict',
    }),
    operationLeaseToken: text('operation_lease_token'),
    operationEvent: quotaOperationEventEnum('operation_event'),
    adminOperationId: uuid('admin_operation_id').references(() => adminOperations.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    quotaLookupIdx: index('usage_ledger_quota_lookup_idx').on(
      table.userId,
      table.kind,
      table.periodKey,
    ),
    periodKindIdx: index('usage_ledger_period_kind_idx').on(
      table.periodKey,
      table.kind,
      table.userId,
    ),
    requestIdx: index('usage_ledger_request_idx').on(table.requestId),
    operationEventIdx: uniqueIndex('usage_ledger_operation_event_idx').on(
      table.operationId,
      table.operationLeaseToken,
      table.operationEvent,
    ),
    adminOperationIdx: uniqueIndex('usage_ledger_admin_operation_idx').on(table.adminOperationId),
    operationMetadataCheck: check(
      'usage_ledger_operation_metadata_check',
      sql`(
        (${table.operationId} is null and ${table.operationLeaseToken} is null and ${table.operationEvent} is null)
        or
        (${table.operationId} is not null and ${table.operationLeaseToken} is not null and ${table.operationEvent} is not null)
      )`,
    ),
    adminOperationMetadataCheck: check(
      'usage_ledger_admin_operation_metadata_check',
      sql`${table.adminOperationId} is null or (
        ${table.source} = 'adjustment'::usage_ledger_source
        and ${table.operationId} is null
        and ${table.operationLeaseToken} is null
        and ${table.operationEvent} is null
      )`,
    ),
  }),
)

export const userQuotaProfiles = pgTable(
  'user_quota_profile',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    quotaLevel: integer('quota_level').notNull().default(1),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    levelCheck: check(
      'user_quota_profile_quota_level_check',
      sql`${table.quotaLevel} between 1 and 5`,
    ),
    levelIdx: index('user_quota_profile_level_idx').on(table.quotaLevel),
  }),
)

// Historical backup metadata remains declared so future Drizzle diffs do not
// propose dropping existing production data after the inactive backup API was removed.
export const backupObjects = pgTable(
  'backup_object',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    version: integer('version').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    userVersionIdx: uniqueIndex('backup_object_user_version_idx').on(table.userId, table.version),
    objectKeyIdx: uniqueIndex('backup_object_key_idx').on(table.objectKey),
  }),
)

export const scenePacks = pgTable(
  'scene_pack',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    promptTemplate: text('prompt_template').notNull(),
    isPro: boolean('is_pro').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    slugIdx: uniqueIndex('scene_pack_slug_idx').on(table.slug),
    visibilityIdx: index('scene_pack_visibility_idx').on(table.enabled, table.isPro),
  }),
)

export const sceneDictionaryTerms = pgTable(
  'scene_dictionary_term',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scenePackId: uuid('scene_pack_id')
      .notNull()
      .references(() => scenePacks.id, { onDelete: 'cascade' }),
    word: text('word').notNull(),
    pronunciation: text('pronunciation'),
  },
  (table) => ({
    scenePackIdx: index('scene_dictionary_term_pack_idx').on(table.scenePackId),
    uniqueTermIdx: uniqueIndex('scene_dictionary_term_unique_idx').on(
      table.scenePackId,
      table.word,
    ),
  }),
)

export const providerRegistry = pgTable(
  'provider_registry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: providerKindEnum('kind').notNull(),
    providerId: text('provider_id').notNull(),
    displayName: text('display_name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    mode: providerModeEnum('mode').notNull(),
    endpointEncrypted: text('endpoint_encrypted'),
    apiKeyEncrypted: text('api_key_encrypted'),
    defaultModel: text('default_model'),
    modelsJson: jsonb('models_json')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    capabilitiesJson: jsonb('capabilities_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    priority: integer('priority').notNull().default(0),
    revision: integer('revision').notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    kindProviderIdx: uniqueIndex('provider_registry_kind_provider_idx').on(
      table.kind,
      table.providerId,
    ),
    lookupIdx: index('provider_registry_lookup_idx').on(table.kind, table.enabled, table.priority),
    revisionCheck: check('provider_registry_revision_check', sql`${table.revision} >= 0`),
    modelsArrayCheck: check(
      'provider_registry_models_array_check',
      sql`jsonb_typeof(${table.modelsJson}) = 'array'`,
    ),
    capabilitiesObjectCheck: check(
      'provider_registry_capabilities_object_check',
      sql`jsonb_typeof(${table.capabilitiesJson}) = 'object'`,
    ),
  }),
)

export const desktopPolicies = pgTable(
  'desktop_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull().default('stable'),
    platform: text('platform').notNull().default('all'),
    plan: desktopPolicyPlanEnum('plan').notNull().default('all'),
    featuresJson: jsonb('features_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    servicesJson: jsonb('services_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    policyJson: jsonb('policy_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    lookupIdx: index('desktop_policy_lookup_idx').on(
      table.channel,
      table.platform,
      table.plan,
      table.enabled,
    ),
    featuresObjectCheck: check(
      'desktop_policy_features_object_check',
      sql`jsonb_typeof(${table.featuresJson}) = 'object'`,
    ),
    servicesObjectCheck: check(
      'desktop_policy_services_object_check',
      sql`jsonb_typeof(${table.servicesJson}) = 'object'`,
    ),
    policyObjectCheck: check(
      'desktop_policy_policy_object_check',
      sql`jsonb_typeof(${table.policyJson}) = 'object'`,
    ),
  }),
)

export const otaReleases = pgTable(
  'ota_release',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appName: text('app_name').notNull().default('EcholIKE'),
    version: text('version').notNull(),
    channel: text('channel').notNull().default('stable'),
    platform: text('platform').notNull().default('all'),
    arch: text('arch').notNull().default('all'),
    enabled: boolean('enabled').notNull().default(false),
    autoUpdate: boolean('auto_update').notNull().default(false),
    forceUpdate: boolean('force_update').notNull().default(false),
    minVersion: text('min_version'),
    artifactBytes: integer('artifact_bytes'),
    downloadUrlEncrypted: text('download_url_encrypted'),
    sha256: text('sha256'),
    signature: text('signature'),
    releaseNotes: text('release_notes'),
    revision: integer('revision').notNull().default(0),
    createdAt: createdAtColumn(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionTargetIdx: uniqueIndex('ota_release_version_target_idx').on(
      table.appName,
      table.version,
      table.channel,
      table.platform,
      table.arch,
    ),
    lookupIdx: index('ota_release_lookup_idx').on(
      table.enabled,
      table.channel,
      table.platform,
      table.arch,
    ),
    artifactBytesCheck: check(
      'ota_release_artifact_bytes_check',
      sql`${table.artifactBytes} is null or ${table.artifactBytes} > 0`,
    ),
    revisionCheck: check('ota_release_revision_check', sql`${table.revision} >= 0`),
    forceEnabledCheck: check(
      'ota_release_force_enabled_check',
      sql`not ${table.forceUpdate} or ${table.enabled}`,
    ),
    enabledArtifactCheck: check(
      'ota_release_enabled_artifact_check',
      sql`not ${table.enabled} or (
        ${table.artifactBytes} is not null
        and ${table.artifactBytes} > 0
        and nullif(btrim(${table.downloadUrlEncrypted}), '') is not null
        and ${table.sha256} is not null
        and ${table.sha256} ~* '^[a-f0-9]{64}$'
        and nullif(btrim(${table.signature}), '') is not null
      )`,
    ),
  }),
)

export const auditLogs = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    requestId: text('request_id').notNull(),
    action: text('action').notNull(),
    metadataJson: jsonb('metadata_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAtColumn(),
  },
  (table) => ({
    userCreatedIdx: index('audit_log_user_created_idx').on(table.userId, table.createdAt),
    createdIdx: index('audit_log_created_idx').on(table.createdAt, table.id),
    requestIdx: index('audit_log_request_idx').on(table.requestId),
    metadataObjectCheck: check(
      'audit_log_metadata_object_check',
      sql`jsonb_typeof(${table.metadataJson}) = 'object'`,
    ),
  }),
)

export const stripeWebhookEvents = pgTable(
  'stripe_webhook_event',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    mutationKind: text('mutation_kind').notNull().default('none'),
    eventCreatedAt: timestamp('event_created_at', { withTimezone: true }),
    metadataJson: jsonb('metadata_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    processedAtIdx: index('stripe_webhook_event_processed_at_idx').on(table.processedAt),
    mutationKindCheck: check(
      'stripe_webhook_event_mutation_kind_check',
      sql`${table.mutationKind} in ('none', 'customer_upsert', 'subscription_upsert')`,
    ),
    metadataObjectCheck: check(
      'stripe_webhook_event_metadata_object_check',
      sql`jsonb_typeof(${table.metadataJson}) = 'object'`,
    ),
  }),
)
