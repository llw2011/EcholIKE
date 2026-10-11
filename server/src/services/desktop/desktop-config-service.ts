import type { ServerEnv } from '../../env.js'
import { maskSecret } from '../../routes/desktop-bootstrap.js'
import type { AdminControlContext } from '../admin/admin-service.js'
import {
  providerDisplayName,
  providerPreset,
  providerPresetModel,
  resolvePresetEndpoint,
} from '../proxy/provider-presets.js'
import { sameProviderOrigin } from '../security/provider-egress-policy.js'
import { createProviderNodeTransport } from '../security/provider-node-transport.js'
import {
  otaArtifactBaseUrlFromPublicApiBaseUrl,
  validateOtaArtifact,
  type OtaArtifactValidationResult,
} from './ota-artifact-validator.js'
import { createPeVersionInspector, matchesWindowsArtifactVersion } from './pe-version-inspector.js'

export type ProviderKind = 'llm' | 'stt' | 'tts' | 'ocr'
export type ProviderMode = 'proxy' | 'direct' | 'byok' | 'local' | 'disabled'
export type DesktopPolicyPlan = 'free' | 'pro' | 'all'

export interface ProviderModelRecord {
  id: string
  label?: string
  supportsStreaming?: boolean
  supportsTranslate?: boolean
  maxInputChars?: number
}

export interface ProviderRegistryRecord {
  id: string
  kind: ProviderKind
  providerId: string
  displayName: string
  enabled: boolean
  mode: ProviderMode
  endpoint: string | null
  apiKeyPreview: string | null
  defaultModel: string | null
  models: ProviderModelRecord[]
  capabilities: Record<string, unknown>
  priority: number
  revision: number
  createdAt: string | null
  updatedAt: string | null
}

export interface ProviderRegistryStoredRecord extends ProviderRegistryRecord {
  apiKey: string | null
}

export interface ProviderRegistryInput {
  id?: string
  expectedRevision?: number
  kind: ProviderKind
  providerId: string
  displayName: string
  enabled: boolean
  mode: ProviderMode
  endpoint?: string | null
  apiKey?: string | null | undefined
  defaultModel?: string | null
  models?: ProviderModelRecord[]
  capabilities?: Record<string, unknown>
  priority?: number
}

export type ProviderRegistryStateErrorCode =
  | 'provider_conflict'
  | 'provider_not_found'
  | 'provider_stale'

export class ProviderRegistryStateError extends Error {
  constructor(readonly code: ProviderRegistryStateErrorCode) {
    super(`Provider registry state transition failed: ${code}`)
    this.name = 'ProviderRegistryStateError'
  }
}

export interface DesktopPolicyRecord {
  id: string
  channel: string
  platform: string
  plan: DesktopPolicyPlan
  features: Record<string, unknown>
  services: Record<string, unknown>
  policy: Record<string, unknown>
  enabled: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface DesktopPolicyInput {
  id?: string
  channel: string
  platform: string
  plan: DesktopPolicyPlan
  features?: Record<string, unknown>
  services?: Record<string, unknown>
  policy?: Record<string, unknown>
  enabled: boolean
}

export interface OtaReleaseRecord {
  id: string
  appName: string
  version: string
  channel: string
  platform: string
  arch: string
  enabled: boolean
  autoUpdate: boolean
  forceUpdate: boolean
  minVersion: string | null
  artifactBytes: number | null
  downloadUrl?: string | null
  downloadUrlPreview: 'set' | 'missing'
  sha256: string | null
  signature: string | null
  releaseNotes: string | null
  revision: number
  createdAt: string | null
  publishedAt: string | null
}

export interface OtaReleaseStoredRecord extends OtaReleaseRecord {
  downloadUrl: string | null
}

export interface OtaReleaseInput {
  id?: string
  expectedRevision?: number
  appName?: string
  version: string
  channel: string
  platform: string
  arch: string
  enabled: boolean
  autoUpdate?: boolean
  forceUpdate: boolean
  minVersion?: string | null
  artifactBytes?: number | null
  downloadUrl?: string | null | undefined
  sha256?: string | null
  signature?: string | null
  releaseNotes?: string | null
  publishedAt?: string | null
}

export interface DesktopPolicyLookup {
  channel: string
  platform: string
  plan: 'free' | 'pro'
}

export interface OtaReleaseLookup {
  currentVersion: string
  channel: string
  platform: string
  arch: string
}

export type OtaReleaseStateErrorCode =
  | 'release_active'
  | 'release_draft_required'
  | 'release_incomplete'
  | 'release_not_found'
  | 'release_not_current'
  | 'release_stale'
  | 'release_validation_in_progress'

export class OtaReleaseStateError extends Error {
  constructor(readonly code: OtaReleaseStateErrorCode) {
    super(`OTA release state transition failed: ${code}`)
    this.name = 'OtaReleaseStateError'
  }
}

export interface OtaReleaseActivationInput {
  id: string
  expectedRevision: number
  forceUpdate: boolean
}

export interface OtaReleaseActivationStoreInput extends OtaReleaseActivationInput {
  expectedRevision: number
  enabled: boolean
}

export interface OtaReleaseValidation {
  release: OtaReleaseRecord
  validation: OtaArtifactValidationResult
}

export interface OtaReleaseConvergenceInput extends OtaReleaseValidationInput {
  currentVersion: string
  channel: string
  platform: string
  arch: string
  expectedCovered: readonly OtaReleaseRevisionExpectation[]
}

export interface OtaReleaseRevisionExpectation {
  id: string
  revision: number
}

export interface OtaReleaseConvergenceResult {
  release: OtaReleaseRecord
  deactivatedCount: number
  constraintValidated: true
}

interface OtaReleaseConvergenceStoreResult {
  release: OtaReleaseStoredRecord
  deactivatedCount: number
  constraintValidated: true
}

export interface DesktopConfigServiceOptions {
  validateOtaReleaseArtifact?: (
    release: OtaReleaseStoredRecord,
    signal?: AbortSignal,
  ) => Promise<OtaArtifactValidationResult>
  validateProvider?: (input: {
    provider: ProviderRegistryInput
    existing: ProviderRegistryRecord | null
    signal?: AbortSignal
  }) => Promise<void>
}

export interface OtaReleaseValidationOptions {
  signal?: AbortSignal
  control?: AdminControlContext
}

export interface DesktopConfigMutationOptions {
  signal?: AbortSignal
  control?: AdminControlContext
  validateProvider?: DesktopConfigServiceOptions['validateProvider']
}

export interface OtaReleaseValidationInput {
  id: string
  expectedRevision: number
}

export interface OtaPolicyResult {
  appName: string
  currentVersion: string
  latestVersion: string
  minVersion: string | null
  enabled: boolean
  autoUpdate: boolean
  updateAvailable: boolean
  forceUpdate: boolean
  downloadUrl: string | null
  sha256: string | null
  signature: string | null
  releaseNotes: string | null
}

export interface DesktopConfigStore {
  listProviders(): Promise<ProviderRegistryStoredRecord[]>
  getProviderById(id: string): Promise<ProviderRegistryStoredRecord | null>
  upsertProvider(
    input: ProviderRegistryInput,
    control: AdminControlContext | undefined,
    prepare: (existing: ProviderRegistryStoredRecord | null) => Promise<ProviderRegistryInput>,
  ): Promise<ProviderRegistryStoredRecord>
  listDesktopPolicies(): Promise<DesktopPolicyRecord[]>
  upsertDesktopPolicy(input: DesktopPolicyInput): Promise<DesktopPolicyRecord>
  listOtaReleases(): Promise<OtaReleaseStoredRecord[]>
  getOtaReleaseById(id: string): Promise<OtaReleaseStoredRecord | null>
  upsertOtaRelease(
    input: OtaReleaseInput,
    control?: AdminControlContext,
  ): Promise<OtaReleaseStoredRecord | null>
  recordOtaValidation(input: {
    id: string
    expectedRevision: number
    validation: OtaArtifactValidationResult
    control?: AdminControlContext
  }): Promise<OtaReleaseStoredRecord | null>
  setOtaReleaseActivation(
    input: OtaReleaseActivationStoreInput & { control?: AdminControlContext },
  ): Promise<OtaReleaseStoredRecord | null>
  convergeOtaReleases(
    input: OtaReleaseConvergenceInput & { control?: AdminControlContext },
    prepare: (releases: readonly OtaReleaseStoredRecord[]) => readonly string[],
  ): Promise<OtaReleaseConvergenceStoreResult | null>
}

export interface DesktopConfigService {
  listProviders(): Promise<ProviderRegistryRecord[]>
  resolveProvider(kind: ProviderKind): Promise<ProviderRegistryStoredRecord | null>
  upsertProvider(
    input: ProviderRegistryInput,
    options?: DesktopConfigMutationOptions,
  ): Promise<ProviderRegistryRecord>
  listDesktopPolicies(): Promise<DesktopPolicyRecord[]>
  resolveDesktopPolicy(input: DesktopPolicyLookup): Promise<DesktopPolicyRecord | null>
  upsertDesktopPolicy(input: DesktopPolicyInput): Promise<DesktopPolicyRecord>
  listOtaReleases(options?: { includeDownloadUrl?: boolean }): Promise<OtaReleaseRecord[]>
  resolveOtaPolicy(input: OtaReleaseLookup): Promise<OtaPolicyResult>
  upsertOtaRelease(
    input: OtaReleaseInput,
    options?: DesktopConfigMutationOptions,
  ): Promise<OtaReleaseRecord>
  validateOtaRelease(
    input: OtaReleaseValidationInput,
    options?: OtaReleaseValidationOptions,
  ): Promise<OtaReleaseValidation>
  activateOtaRelease(
    input: OtaReleaseActivationInput,
    options?: OtaReleaseValidationOptions,
  ): Promise<OtaReleaseValidation>
  deactivateOtaRelease(
    input: OtaReleaseValidationInput,
    options?: DesktopConfigMutationOptions,
  ): Promise<OtaReleaseRecord>
  convergeOtaReleases(
    input: OtaReleaseConvergenceInput,
    options?: DesktopConfigMutationOptions,
  ): Promise<OtaReleaseConvergenceResult>
}

const APP_NAME = 'EcholIKE'
const DEFAULT_CHANNEL = 'stable'
const DEFAULT_PLATFORM = 'all'
const DEFAULT_ARCH = 'all'

export function createDesktopConfigService(
  store: DesktopConfigStore,
  env: ServerEnv,
  options: DesktopConfigServiceOptions = {},
): DesktopConfigService {
  const validateReleaseArtifact =
    options.validateOtaReleaseArtifact ??
    ((release: OtaReleaseStoredRecord, signal?: AbortSignal) =>
      validateStoredOtaReleaseArtifact(release, env, signal))
  const validateProvider = options.validateProvider
  const validationLease = createOtaValidationLease()

  return {
    async listProviders() {
      return (await providersWithEnvFallback(store, env)).map(redactProvider)
    },

    async resolveProvider(kind) {
      const providers = await providersWithEnvFallback(store, env)
      return (
        providers
          .filter((provider) => provider.kind === kind && backendProviderUsable(provider))
          .sort((left, right) => right.priority - left.priority)[0] ?? null
      )
    },

    async upsertProvider(input, mutationOptions = {}) {
      const saved = await store.upsertProvider(input, mutationOptions.control, async (existing) => {
        if (input.id && !existing) {
          throw new ProviderRegistryStateError('provider_not_found')
        }
        if (!input.id && existing) {
          throw new ProviderRegistryStateError('provider_conflict')
        }
        if (
          input.id &&
          (!Number.isSafeInteger(input.expectedRevision) ||
            input.expectedRevision !== existing?.revision)
        ) {
          throw new ProviderRegistryStateError('provider_stale')
        }
        const previousEndpoint = existing ? effectiveProviderEndpoint(existing) : null
        const nextEndpoint = effectiveProviderEndpoint(input)
        const endpointChanged = Boolean(
          existing &&
          (previousEndpoint === null || nextEndpoint === null
            ? previousEndpoint !== nextEndpoint
            : !sameProviderOrigin(previousEndpoint, nextEndpoint)),
        )
        const normalizedApiKey = normalizeSecretUpdate(input.apiKey, existing?.apiKey ?? null)
        const apiKey = endpointChanged && normalizedApiKey === undefined ? null : normalizedApiKey
        const prepared = { ...input, apiKey }
        const providerValidator = mutationOptions.validateProvider ?? validateProvider
        if (providerValidator) {
          await providerValidator({
            provider: prepared,
            existing: existing ? redactProvider(existing) : null,
            ...(mutationOptions.signal ? { signal: mutationOptions.signal } : {}),
          })
        }
        return prepared
      })
      return redactProvider(saved)
    },

    listDesktopPolicies() {
      return store.listDesktopPolicies()
    },

    async resolveDesktopPolicy(input) {
      const policies = await store.listDesktopPolicies()
      return (
        policies
          .filter((policy) => {
            if (!policy.enabled) return false
            if (!matchesDimension(policy.channel, input.channel)) return false
            if (!matchesDimension(policy.platform, input.platform)) return false
            return policy.plan === 'all' || policy.plan === input.plan
          })
          .sort((left, right) => policyScore(right, input) - policyScore(left, input))[0] ?? null
      )
    },

    upsertDesktopPolicy(input) {
      return store.upsertDesktopPolicy(input)
    },

    async listOtaReleases(options = {}) {
      return (await otaWithEnvFallback(store, env)).map((release) =>
        redactOtaRelease(release, options),
      )
    },

    async resolveOtaPolicy(input) {
      const matchingReleases = (await otaWithEnvFallback(store, env))
        .filter((release) => {
          if (!release.enabled) return false
          if (release.appName !== APP_NAME) return false
          if (!isCanonicalStableVersion(release.version)) return false
          if (!matchesDimension(release.channel, input.channel)) return false
          if (!matchesDimension(release.platform, input.platform)) return false
          if (!matchesDimension(release.arch, input.arch)) return false
          return true
        })
        .sort((left, right) => compareCanonicalStableVersions(right.version, left.version))

      const latestRelease = matchingReleases[0] ?? null
      const release = isCanonicalStableVersion(input.currentVersion)
        ? (matchingReleases.find(
            (item) => compareCanonicalStableVersions(item.version, input.currentVersion) > 0,
          ) ?? null)
        : null
      const latestVersion = latestRelease?.version ?? env.desktopUpdateLatestVersion
      const minVersion =
        release?.minVersion && isCanonicalStableVersion(release.minVersion)
          ? release.minVersion
          : null
      const downloadUrl = release?.downloadUrl ?? null
      const candidateUpdateAvailable =
        release !== null &&
        isCanonicalStableVersion(input.currentVersion) &&
        compareCanonicalStableVersions(release.version, input.currentVersion) > 0
      const updateAvailable = candidateUpdateAvailable && Boolean(downloadUrl)
      const belowMinimum = Boolean(
        minVersion &&
        isCanonicalStableVersion(input.currentVersion) &&
        compareCanonicalStableVersions(input.currentVersion, minVersion) < 0,
      )

      return {
        appName: APP_NAME,
        currentVersion: input.currentVersion,
        latestVersion,
        minVersion,
        enabled: Boolean(latestRelease),
        autoUpdate:
          release?.autoUpdate ?? latestRelease?.autoUpdate ?? env.desktopAutoUpdateEnabled,
        updateAvailable,
        forceUpdate: updateAvailable && (Boolean(release?.forceUpdate) || belowMinimum),
        downloadUrl: updateAvailable ? downloadUrl : null,
        sha256: updateAvailable ? (release?.sha256 ?? null) : null,
        signature: updateAvailable ? (release?.signature ?? null) : null,
        releaseNotes: updateAvailable ? (release?.releaseNotes ?? null) : null,
      }
    },

    async upsertOtaRelease(input, mutationOptions = {}) {
      if (input.enabled || input.forceUpdate) {
        throw new OtaReleaseStateError('release_draft_required')
      }
      if (
        !isCanonicalStableVersion(input.version) ||
        (input.minVersion !== null &&
          input.minVersion !== undefined &&
          !isCanonicalStableVersion(input.minVersion))
      ) {
        throw new OtaReleaseStateError('release_incomplete')
      }
      const saved = await store.upsertOtaRelease(
        {
          ...input,
          appName: input.appName ?? APP_NAME,
          enabled: false,
          forceUpdate: false,
        },
        mutationOptions.control,
      )
      if (!saved) {
        const current = input.id ? await store.getOtaReleaseById(input.id) : null
        if (input.id && !current) throw new OtaReleaseStateError('release_not_found')
        if (current?.enabled) throw new OtaReleaseStateError('release_active')
        throw new OtaReleaseStateError('release_stale')
      }
      return redactOtaRelease(saved)
    },

    async validateOtaRelease(input, validationOptions = {}) {
      return await validationLease.run(async () => {
        const release = await requiredOtaRelease(store, input.id)
        assertOtaExpectedRevision(release, input.expectedRevision)
        const validation = await validateCompleteOtaRelease(
          release,
          validateReleaseArtifact,
          validationOptions.signal,
        )
        const audited = await store.recordOtaValidation({
          id: input.id,
          expectedRevision: input.expectedRevision,
          validation,
          ...(validationOptions.control ? { control: validationOptions.control } : {}),
        })
        if (!audited) throw new OtaReleaseStateError('release_stale')
        return {
          release: redactOtaRelease(audited),
          validation,
        }
      })
    },

    async activateOtaRelease(input, validationOptions = {}) {
      return await validationLease.run(async () => {
        const release = await requiredOtaRelease(store, input.id)
        if (
          release.revision === input.expectedRevision + 1 &&
          release.enabled &&
          release.forceUpdate === input.forceUpdate
        ) {
          const validation = await validateCompleteOtaRelease(
            release,
            validateReleaseArtifact,
            validationOptions.signal,
          )
          return { release: redactOtaRelease(release), validation }
        }
        assertOtaExpectedRevision(release, input.expectedRevision)
        if (release.enabled) {
          throw new OtaReleaseStateError('release_active')
        }
        const validation = await validateCompleteOtaRelease(
          release,
          validateReleaseArtifact,
          validationOptions.signal,
        )
        if (release.enabled) {
          return { release: redactOtaRelease(release), validation }
        }

        const activated = await store.setOtaReleaseActivation({
          ...input,
          enabled: true,
          ...(validationOptions.control ? { control: validationOptions.control } : {}),
        })
        if (!activated) throw new OtaReleaseStateError('release_stale')
        return {
          release: redactOtaRelease(activated),
          validation,
        }
      })
    },

    async deactivateOtaRelease(input, mutationOptions = {}) {
      const release = await requiredOtaRelease(store, input.id)
      if (release.revision === input.expectedRevision + 1 && !release.enabled) {
        return redactOtaRelease(release)
      }
      assertOtaExpectedRevision(release, input.expectedRevision)
      if (!release.enabled) throw new OtaReleaseStateError('release_draft_required')

      const deactivated = await store.setOtaReleaseActivation({
        id: input.id,
        enabled: false,
        forceUpdate: false,
        expectedRevision: input.expectedRevision,
        ...(mutationOptions.control ? { control: mutationOptions.control } : {}),
      })
      if (!deactivated) throw new OtaReleaseStateError('release_stale')
      return redactOtaRelease(deactivated)
    },

    async convergeOtaReleases(input, mutationOptions = {}) {
      const converged = await store.convergeOtaReleases(
        {
          ...input,
          ...(mutationOptions.control ? { control: mutationOptions.control } : {}),
        },
        (releases) => convergenceReleaseIds(releases, input),
      )
      if (!converged) {
        const current = await store.getOtaReleaseById(input.id)
        if (!current) throw new OtaReleaseStateError('release_not_found')
        throw new OtaReleaseStateError('release_stale')
      }
      return {
        release: redactOtaRelease(converged.release),
        deactivatedCount: converged.deactivatedCount,
        constraintValidated: converged.constraintValidated,
      }
    },
  }
}

function convergenceReleaseIds(
  releases: readonly OtaReleaseStoredRecord[],
  input: OtaReleaseConvergenceInput,
): readonly string[] {
  const target = releases.find((release) => release.id === input.id)
  if (!target) throw new OtaReleaseStateError('release_not_found')
  assertOtaExpectedRevision(target, input.expectedRevision)
  if (!target.enabled) throw new OtaReleaseStateError('release_draft_required')
  if (
    !isCanonicalStableVersion(target.version) ||
    !isCanonicalStableVersion(input.currentVersion) ||
    !matchesDimension(target.channel, input.channel) ||
    !matchesDimension(target.platform, input.platform) ||
    !matchesDimension(target.arch, input.arch) ||
    compareCanonicalStableVersions(target.version, input.currentVersion) <= 0
  ) {
    throw new OtaReleaseStateError('release_not_current')
  }

  const invalidMatchingRelease = releases.some(
    (release) =>
      release.enabled &&
      release.appName === target.appName &&
      matchesDimension(release.channel, input.channel) &&
      matchesDimension(release.platform, input.platform) &&
      matchesDimension(release.arch, input.arch) &&
      !isCanonicalStableVersion(release.version),
  )
  if (invalidMatchingRelease) throw new OtaReleaseStateError('release_incomplete')

  const competing = releases.some(
    (release) =>
      release.enabled &&
      release.id !== target.id &&
      release.appName === target.appName &&
      matchesDimension(release.channel, input.channel) &&
      matchesDimension(release.platform, input.platform) &&
      matchesDimension(release.arch, input.arch) &&
      compareCanonicalStableVersions(release.version, target.version) >= 0,
  )
  if (competing) throw new OtaReleaseStateError('release_not_current')

  const covered = releases.filter(
    (release) =>
      release.enabled &&
      release.id !== target.id &&
      release.appName === target.appName &&
      release.channel === target.channel &&
      compareCanonicalStableVersions(release.version, target.version) < 0 &&
      coversDimension(target.platform, release.platform) &&
      coversDimension(target.arch, release.arch),
  )
  const expected = convergenceExpectedRevisions(input)
  if (
    covered.length !== expected.size ||
    covered.some((release) => expected.get(release.id) !== release.revision)
  ) {
    throw new OtaReleaseStateError('release_stale')
  }
  return covered.map((release) => release.id)
}

function convergenceExpectedRevisions(input: OtaReleaseConvergenceInput): Map<string, number> {
  const expected = new Map<string, number>()
  for (const item of input.expectedCovered) {
    if (
      !item.id ||
      item.id === input.id ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 0 ||
      expected.has(item.id)
    ) {
      throw new OtaReleaseStateError('release_stale')
    }
    expected.set(item.id, item.revision)
  }
  return expected
}

function effectiveProviderEndpoint(
  provider: Pick<ProviderRegistryInput, 'kind' | 'providerId' | 'endpoint'>,
): string | null {
  const preset = providerPreset(provider.kind, provider.providerId)
  return (preset && resolvePresetEndpoint(preset, provider.endpoint)) || null
}

export function createMemoryDesktopConfigStore(): DesktopConfigStore & {
  providers: Map<string, ProviderRegistryStoredRecord>
  policies: Map<string, DesktopPolicyRecord>
  otaReleases: Map<string, OtaReleaseStoredRecord>
  controlAudits: Array<{
    action: string
    control: AdminControlContext
    metadata: Record<string, unknown>
  }>
} {
  const providers = new Map<string, ProviderRegistryStoredRecord>()
  const policies = new Map<string, DesktopPolicyRecord>()
  const otaReleases = new Map<string, OtaReleaseStoredRecord>()
  const controlAudits: Array<{
    action: string
    control: AdminControlContext
    metadata: Record<string, unknown>
  }> = []

  return {
    providers,
    policies,
    otaReleases,
    controlAudits,
    async listProviders() {
      return [...providers.values()]
    },
    async getProviderById(id) {
      return providers.get(id) ?? null
    },
    async upsertProvider(input, control, prepare) {
      const existing = input.id
        ? (providers.get(input.id) ?? null)
        : ([...providers.values()].find(
            (provider) => provider.kind === input.kind && provider.providerId === input.providerId,
          ) ?? null)
      const prepared = await prepare(existing)
      const id = existing?.id ?? prepared.id ?? `provider_${providers.size + 1}`
      const conflicting = [...providers.values()].find(
        (provider) =>
          provider.id !== id &&
          provider.kind === prepared.kind &&
          provider.providerId === prepared.providerId,
      )
      if (conflicting) throw new ProviderRegistryStateError('provider_conflict')
      const now = new Date().toISOString()
      const record: ProviderRegistryStoredRecord = {
        id,
        kind: prepared.kind,
        providerId: prepared.providerId,
        displayName: prepared.displayName,
        enabled: prepared.enabled,
        mode: prepared.mode,
        endpoint: normalizeNullable(prepared.endpoint),
        apiKey:
          prepared.apiKey === undefined
            ? (existing?.apiKey ?? null)
            : normalizeNullable(prepared.apiKey),
        apiKeyPreview: maskSecret(
          prepared.apiKey === undefined
            ? (existing?.apiKey ?? null)
            : normalizeNullable(prepared.apiKey),
        ),
        defaultModel: normalizeNullable(prepared.defaultModel),
        models: prepared.models ?? [],
        capabilities: prepared.capabilities ?? {},
        priority: prepared.priority ?? 0,
        revision: existing ? existing.revision + 1 : 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      providers.set(id, record)
      if (control) {
        controlAudits.push({
          action: 'admin.provider.upsert',
          control,
          metadata: providerControlAuditMetadata(record),
        })
      }
      return record
    },
    async listDesktopPolicies() {
      return [...policies.values()]
    },
    async upsertDesktopPolicy(input) {
      const id = input.id ?? `policy_${policies.size + 1}`
      const existing = policies.get(id)
      const now = new Date().toISOString()
      const record: DesktopPolicyRecord = {
        id,
        channel: input.channel,
        platform: input.platform,
        plan: input.plan,
        features: input.features ?? {},
        services: input.services ?? {},
        policy: input.policy ?? {},
        enabled: input.enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      policies.set(id, record)
      return record
    },
    async listOtaReleases() {
      return [...otaReleases.values()]
    },
    async getOtaReleaseById(id) {
      return otaReleases.get(id) ?? null
    },
    async upsertOtaRelease(input, control) {
      const id = input.id ?? `ota_${otaReleases.size + 1}`
      const existing = otaReleases.get(id)
      const conflicting = [...otaReleases.values()].find(
        (release) =>
          release.id !== id &&
          release.appName === (input.appName ?? APP_NAME) &&
          release.version === input.version &&
          release.channel === input.channel &&
          release.platform === input.platform &&
          release.arch === input.arch,
      )
      if ((!input.id && conflicting) || (input.id && !existing)) return null
      if (existing?.enabled) return null
      if (
        input.id &&
        (!Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision !== existing?.revision)
      ) {
        return null
      }
      const now = new Date().toISOString()
      const downloadUrl =
        input.downloadUrl === undefined
          ? (existing?.downloadUrl ?? null)
          : normalizeNullable(input.downloadUrl)
      const record: OtaReleaseStoredRecord = {
        id,
        appName: input.appName ?? APP_NAME,
        version: input.version,
        channel: input.channel,
        platform: input.platform,
        arch: input.arch,
        enabled: false,
        autoUpdate: input.autoUpdate ?? false,
        forceUpdate: false,
        minVersion: normalizeNullable(input.minVersion),
        artifactBytes:
          input.artifactBytes === undefined
            ? (existing?.artifactBytes ?? null)
            : input.artifactBytes,
        downloadUrl,
        downloadUrlPreview: downloadUrl ? 'set' : 'missing',
        sha256: normalizeNullable(input.sha256),
        signature: normalizeNullable(input.signature),
        releaseNotes: normalizeNullable(input.releaseNotes),
        revision: existing ? existing.revision + 1 : 0,
        createdAt: existing?.createdAt ?? now,
        publishedAt: input.publishedAt ?? existing?.publishedAt ?? now,
      }
      otaReleases.set(id, record)
      if (control) {
        controlAudits.push({
          action: 'admin.ota.upsert',
          control,
          metadata: otaControlAuditMetadata(record),
        })
      }
      return record
    },
    async recordOtaValidation(input) {
      const existing = otaReleases.get(input.id)
      if (!existing || existing.revision !== input.expectedRevision) return null
      if (input.control) {
        controlAudits.push({
          action: 'admin.ota.validate',
          control: input.control,
          metadata: {
            ...otaControlAuditMetadata(existing),
            artifactBytes: input.validation.bytes,
            artifactSha256: input.validation.sha256,
          },
        })
      }
      return existing
    },
    async setOtaReleaseActivation(input) {
      const existing = otaReleases.get(input.id)
      if (
        !existing ||
        existing.revision !== input.expectedRevision ||
        existing.enabled === input.enabled ||
        (input.enabled && !hasCompleteOtaReleaseArtifact(existing))
      ) {
        return null
      }
      const record: OtaReleaseStoredRecord = {
        ...existing,
        enabled: input.enabled,
        forceUpdate: input.enabled ? input.forceUpdate : false,
        revision: existing.revision + 1,
        publishedAt: input.enabled ? new Date().toISOString() : existing.publishedAt,
      }
      otaReleases.set(input.id, record)
      if (input.control) {
        controlAudits.push({
          action: input.enabled ? 'admin.ota.activate' : 'admin.ota.deactivate',
          control: input.control,
          metadata: otaControlAuditMetadata(record),
        })
      }
      return record
    },
    async convergeOtaReleases(input, prepare) {
      const releases = [...otaReleases.values()]
      const target = otaReleases.get(input.id)
      if (!target || target.revision !== input.expectedRevision) return null
      const requestedIds = prepare(releases)
      const ids = new Set(requestedIds)
      const expectedRevisions = convergenceExpectedRevisions(input)
      if (
        ids.size !== requestedIds.length ||
        ids.size !== expectedRevisions.size ||
        ids.has(input.id) ||
        [...ids].some((id) => !expectedRevisions.has(id))
      ) {
        throw new OtaReleaseStateError('release_stale')
      }
      const selected = releases.filter((release) => ids.has(release.id))
      if (
        selected.length !== ids.size ||
        selected.some(
          (release) => !release.enabled || expectedRevisions.get(release.id) !== release.revision,
        )
      ) {
        throw new OtaReleaseStateError('release_stale')
      }
      const nextRecords = new Map(otaReleases)
      for (const release of selected) {
        nextRecords.set(release.id, {
          ...release,
          enabled: false,
          forceUpdate: false,
          revision: release.revision + 1,
        })
      }
      if (
        [...nextRecords.values()].some(
          (release) => release.enabled && !hasCompleteOtaReleaseArtifact(release),
        )
      ) {
        throw new OtaReleaseStateError('release_incomplete')
      }
      for (const [id, release] of nextRecords) otaReleases.set(id, release)
      const persistedTarget = otaReleases.get(input.id)
      if (!persistedTarget || !persistedTarget.enabled) {
        throw new OtaReleaseStateError('release_stale')
      }
      if (input.control) {
        controlAudits.push({
          action: 'admin.ota.converge',
          control: input.control,
          metadata: {
            ...otaControlAuditMetadata(persistedTarget),
            deactivatedCount: selected.length,
            constraintValidated: true,
          },
        })
      }
      return {
        release: persistedTarget,
        deactivatedCount: selected.length,
        constraintValidated: true,
      }
    },
  }
}

function normalizeSecretUpdate(
  value: string | null | undefined,
  existing: string | null,
): string | null | undefined {
  if (value === undefined) return undefined
  const normalized = normalizeNullable(value)
  if (!normalized) return null
  if (normalized === 'configured') return undefined
  return normalized
}

function providersWithEnvFallback(
  store: DesktopConfigStore,
  env: ServerEnv,
): Promise<ProviderRegistryStoredRecord[]> {
  return store.listProviders().then((providers) => {
    const envRows = envProviders(env)
    if (!providers.length) return envRows
    const storedUsableKinds = new Set(
      providers.filter(backendProviderUsable).map((provider) => provider.kind),
    )
    return [...providers, ...envRows.filter((provider) => !storedUsableKinds.has(provider.kind))]
  })
}

function otaWithEnvFallback(
  store: DesktopConfigStore,
  env: ServerEnv,
): Promise<OtaReleaseStoredRecord[]> {
  return store.listOtaReleases().then((releases) => (releases.length ? releases : envOta(env)))
}

function envProviders(env: ServerEnv): ProviderRegistryStoredRecord[] {
  const now = new Date().toISOString()
  const providers: ProviderRegistryStoredRecord[] = []
  if (env.llmProvider) {
    const preset = providerPreset('llm', env.llmProvider)
    const model = env.llmModel ?? preset?.defaultModel ?? null
    providers.push({
      id: 'env_llm',
      kind: 'llm',
      providerId: env.llmProvider,
      displayName: providerDisplayName('llm', env.llmProvider),
      enabled: Boolean(preset && model && hasRequiredApiKey(preset, env.llmApiKey)),
      mode: 'proxy',
      endpoint: env.llmBaseUrl,
      apiKey: env.llmApiKey,
      apiKeyPreview: maskSecret(env.llmApiKey),
      defaultModel: model,
      models: model ? [providerPresetModel(model, preset)] : [],
      capabilities: preset?.capabilities ?? {},
      priority: 0,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
  }
  if (env.sttProvider) {
    const preset = providerPreset('stt', env.sttProvider)
    const model = env.sttModel ?? preset?.defaultModel ?? null
    providers.push({
      id: 'env_stt',
      kind: 'stt',
      providerId: env.sttProvider,
      displayName: providerDisplayName('stt', env.sttProvider),
      enabled: Boolean(preset && hasRequiredApiKey(preset, env.sttApiKey)),
      mode: 'proxy',
      endpoint: env.sttBaseUrl,
      apiKey: env.sttApiKey,
      apiKeyPreview: maskSecret(env.sttApiKey),
      defaultModel: model,
      models: model ? [{ id: model, label: model }] : [],
      capabilities: preset?.capabilities ?? {},
      priority: 0,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
  }
  if (env.ttsProvider) {
    const preset = providerPreset('tts', env.ttsProvider)
    const model = env.ttsModel ?? preset?.defaultModel ?? null
    providers.push({
      id: 'env_tts',
      kind: 'tts',
      providerId: env.ttsProvider,
      displayName: providerDisplayName('tts', env.ttsProvider),
      enabled: Boolean(preset && model && hasRequiredApiKey(preset, env.ttsApiKey)),
      mode: 'proxy',
      endpoint: env.ttsBaseUrl,
      apiKey: env.ttsApiKey,
      apiKeyPreview: maskSecret(env.ttsApiKey),
      defaultModel: model,
      models: model ? [{ id: model, label: model }] : [],
      capabilities: {
        ...(preset?.capabilities ?? {}),
        voice: env.ttsVoice ?? stringCapability(preset?.capabilities.voice) ?? 'alloy',
      },
      priority: 0,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
  }
  return providers
}

function hasRequiredApiKey(
  preset: NonNullable<ReturnType<typeof providerPreset>>,
  apiKey: string | null,
): boolean {
  return !preset.capabilities.requiresApiKey || Boolean(apiKey)
}

function backendProviderUsable(provider: ProviderRegistryStoredRecord): boolean {
  if (!provider.enabled || provider.mode !== 'proxy') return false
  const preset = providerPreset(provider.kind, provider.providerId)
  if (!preset) return false
  if (!hasRequiredApiKey(preset, provider.apiKey)) return false
  if (!resolvePresetEndpoint(preset, provider.endpoint)) return false
  if (provider.kind === 'llm' || provider.kind === 'tts' || provider.kind === 'ocr') {
    return Boolean(provider.defaultModel ?? preset.defaultModel)
  }
  return true
}

function stringCapability(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function envOta(env: ServerEnv): OtaReleaseStoredRecord[] {
  if (!env.desktopUpdateEnabled) return []
  const now = new Date().toISOString()
  return [
    {
      id: 'env_ota',
      appName: APP_NAME,
      version: env.desktopUpdateLatestVersion,
      channel: DEFAULT_CHANNEL,
      platform: DEFAULT_PLATFORM,
      arch: DEFAULT_ARCH,
      enabled: env.desktopUpdateEnabled,
      autoUpdate: env.desktopAutoUpdateEnabled,
      forceUpdate: env.desktopUpdateForce,
      minVersion: env.desktopUpdateMinVersion,
      artifactBytes: null,
      downloadUrl: env.desktopUpdateDownloadUrl,
      downloadUrlPreview: env.desktopUpdateDownloadUrl ? 'set' : 'missing',
      sha256: env.desktopUpdateSha256,
      signature: env.desktopUpdateSignature,
      releaseNotes: env.desktopUpdateReleaseNotes,
      revision: 0,
      createdAt: now,
      publishedAt: now,
    },
  ]
}

async function requiredOtaRelease(
  store: DesktopConfigStore,
  id: string,
): Promise<OtaReleaseStoredRecord> {
  const release = await store.getOtaReleaseById(id)
  if (!release) throw new OtaReleaseStateError('release_not_found')
  return release
}

function assertOtaExpectedRevision(
  release: OtaReleaseStoredRecord,
  expectedRevision: number,
): void {
  if (!Number.isSafeInteger(expectedRevision) || release.revision !== expectedRevision) {
    throw new OtaReleaseStateError('release_stale')
  }
}

interface OtaValidationLease {
  run<T>(operation: () => Promise<T>): Promise<T>
}

function createOtaValidationLease(): OtaValidationLease {
  let activeToken: symbol | null = null
  return {
    async run(operation) {
      if (activeToken) throw new OtaReleaseStateError('release_validation_in_progress')
      const token = Symbol('ota-validation')
      activeToken = token
      try {
        return await operation()
      } finally {
        if (activeToken === token) activeToken = null
      }
    },
  }
}

async function validateCompleteOtaRelease(
  release: OtaReleaseStoredRecord,
  validateReleaseArtifact: (
    release: OtaReleaseStoredRecord,
    signal?: AbortSignal,
  ) => Promise<OtaArtifactValidationResult>,
  signal?: AbortSignal,
): Promise<OtaArtifactValidationResult> {
  if (
    !hasCompleteOtaReleaseArtifact(release) ||
    !isCanonicalStableVersion(release.version) ||
    (release.minVersion !== null && !isCanonicalStableVersion(release.minVersion))
  ) {
    throw new OtaReleaseStateError('release_incomplete')
  }
  return signal
    ? await validateReleaseArtifact(release, signal)
    : await validateReleaseArtifact(release)
}

async function validateStoredOtaReleaseArtifact(
  release: OtaReleaseStoredRecord,
  env: ServerEnv,
  signal?: AbortSignal,
): Promise<OtaArtifactValidationResult> {
  if (!hasCompleteOtaReleaseArtifact(release)) {
    throw new OtaReleaseStateError('release_incomplete')
  }
  return await validateOtaArtifact(
    {
      artifactUrl: release.downloadUrl,
      expectedAppName: release.appName,
      expectedPlatform: release.platform,
      expectedArch: release.arch,
      expectedBytes: release.artifactBytes,
      maxBytes: release.artifactBytes,
      expectedSha256: release.sha256,
      signature: release.signature,
      expectedVersion: release.version,
    },
    {
      egress: {
        transport: createProviderNodeTransport({ maxResponseBytes: release.artifactBytes }),
      },
      inspector: createPeVersionInspector(),
      updaterPublicKeyBase64: env.tauriUpdaterPublicKey,
      artifactBaseUrl: otaArtifactBaseUrlFromPublicApiBaseUrl(env.publicApiBaseUrl),
      versionMatches: matchesWindowsArtifactVersion,
      ...(signal ? { signal } : {}),
    },
  )
}

function hasCompleteOtaReleaseArtifact(
  release: OtaReleaseStoredRecord,
): release is OtaReleaseStoredRecord & {
  artifactBytes: number
  downloadUrl: string
  sha256: string
  signature: string
} {
  return Boolean(
    release.downloadUrl?.trim() &&
    release.signature?.trim() &&
    release.sha256 &&
    /^[a-f0-9]{64}$/i.test(release.sha256) &&
    Number.isSafeInteger(release.artifactBytes) &&
    (release.artifactBytes ?? 0) > 0,
  )
}

function isCanonicalStableVersion(version: string): boolean {
  return canonicalStableVersionParts(version) !== null
}

function compareCanonicalStableVersions(left: string, right: string): number {
  const leftParts = canonicalStableVersionParts(left)
  const rightParts = canonicalStableVersionParts(right)
  if (!leftParts || !rightParts) throw new OtaReleaseStateError('release_incomplete')
  for (const index of [0, 1, 2] as const) {
    if (leftParts[index] < rightParts[index]) return -1
    if (leftParts[index] > rightParts[index]) return 1
  }
  return 0
}

function canonicalStableVersionParts(version: string): readonly [bigint, bigint, bigint] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  return match ? [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)] : null
}

function redactProvider(provider: ProviderRegistryStoredRecord): ProviderRegistryRecord {
  const { apiKey: _apiKey, ...safe } = provider
  return {
    ...safe,
    endpoint: safeProviderEndpointPreview(provider.endpoint),
    apiKeyPreview: maskSecret(provider.apiKey),
  }
}

function safeProviderEndpointPreview(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
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

function redactOtaRelease(
  release: OtaReleaseStoredRecord,
  options: { includeDownloadUrl?: boolean } = {},
): OtaReleaseRecord {
  const { downloadUrl: _downloadUrl, ...safe } = release
  return {
    ...safe,
    ...(options.includeDownloadUrl ? { downloadUrl: release.downloadUrl } : {}),
    downloadUrlPreview: release.downloadUrl ? 'set' : 'missing',
  }
}

function matchesDimension(policyValue: string, requestValue: string): boolean {
  const policy = policyValue.trim().toLowerCase()
  const request = requestValue.trim().toLowerCase()
  return (
    policy === 'all' ||
    policy === request ||
    normalizeDimensionAlias(policy) === normalizeDimensionAlias(request)
  )
}

function normalizeDimensionAlias(value: string): string {
  if (value === 'darwin') return 'macos'
  if (value === 'win32') return 'windows'
  if (value === 'x64') return 'x86_64'
  if (value === 'amd64') return 'x86_64'
  if (value === 'arm64') return 'aarch64'
  return value
}

function coversDimension(coveringValue: string, coveredValue: string): boolean {
  const covering = normalizeDimensionAlias(coveringValue.trim().toLowerCase())
  const covered = normalizeDimensionAlias(coveredValue.trim().toLowerCase())
  return covering === 'all' || covering === covered
}

function policyScore(policy: DesktopPolicyRecord, input: DesktopPolicyLookup): number {
  return (
    (policy.plan === input.plan ? 4 : 0) +
    (policy.channel === input.channel ? 2 : 0) +
    (policy.platform === input.platform ? 1 : 0)
  )
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
