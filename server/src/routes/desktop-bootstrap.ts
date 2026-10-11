import { json } from '../errors.js'
import type { ServerEnv } from '../env.js'
import type { Handler, RequestContext } from '../http.js'
import { resolveBackendProxyAccess } from '../auth/backend-proxy-access.js'
import type { SubscriptionStatus } from '../types.js'
import type {
  ProviderKind,
  ProviderRegistryStoredRecord,
} from '../services/desktop/desktop-config-service.js'
import {
  OCR_PROXY_CAPABILITIES,
  providerDisplayName,
  providerPreset,
  providerPresetModel,
} from '../services/proxy/provider-presets.js'

const APP_NAME = 'EcholIKE'
const DEFAULT_OCR_BASE_URL = 'http://127.0.0.1:11434'
const DEFAULT_OCR_MODEL = 'glm-ocr:latest'
const OCR_DOCUMENT_CONTRACT = 'ocr-document-v1'
const DESKTOP_SERVICE_KINDS = ['stt', 'llm', 'tts', 'ocr'] as const

export const desktopBootstrap: Handler = async (ctx) => {
  const url = new URL(ctx.request.url)
  const currentVersion = cleanVersion(url.searchParams.get('version')) || '0.0.0'
  const access = await resolveBackendProxyAccess(ctx)
  const subscription = access.subscription
  const canUseProxy = access.authorized

  return json(
    await buildDesktopBootstrapPayload(ctx, {
      currentVersion,
      includeSecretPreview: Boolean(ctx.user && subscription.plan === 'pro'),
      cloudEnabled: canUseProxy,
      plan: subscription.plan,
      subscriptionEnd: subscription.subscriptionEnd,
      quotaLevel: subscription.quotaLevel,
      quotaMultiplier: subscription.quotaMultiplier,
      userEmail: ctx.user?.email ?? null,
      userName: ctx.user?.name ?? null,
      adminRole:
        access.adminAccount?.status === 'active' ? (access.adminAccount.role ?? null) : null,
      quotas: quotaPayload(subscription),
      preferProxy: canUseProxy,
    }),
  )
}

export function buildDesktopBootstrapPayload(
  ctx: RequestContext,
  options: {
    currentVersion: string
    channel?: string
    platform?: string
    arch?: string
    includeSecretPreview: boolean
    cloudEnabled: boolean
    plan: 'free' | 'pro'
    subscriptionEnd: string | null
    quotaLevel?: SubscriptionStatus['quotaLevel']
    quotaMultiplier?: number
    userEmail?: string | null
    userName?: string | null
    adminRole?: string | null
    quotas?: DesktopQuotaPayload
    preferProxy: boolean
  },
) {
  return buildDesktopBootstrapPayloadAsync(ctx, options)
}

async function buildDesktopBootstrapPayloadAsync(
  ctx: RequestContext,
  options: {
    currentVersion: string
    channel?: string
    platform?: string
    arch?: string
    includeSecretPreview: boolean
    cloudEnabled: boolean
    plan: 'free' | 'pro'
    subscriptionEnd: string | null
    quotaLevel?: SubscriptionStatus['quotaLevel']
    quotaMultiplier?: number
    userEmail?: string | null
    userName?: string | null
    adminRole?: string | null
    quotas?: DesktopQuotaPayload
    preferProxy: boolean
  },
) {
  const url = new URL(ctx.request.url)
  const channel = options.channel ?? url.searchParams.get('channel') ?? 'stable'
  const platform = options.platform ?? url.searchParams.get('platform') ?? 'all'
  const arch = options.arch ?? url.searchParams.get('arch') ?? 'all'
  const documentContractRequested = requestedDocumentContracts(url).has(OCR_DOCUMENT_CONTRACT)
  const ocrProviderPromise = ctx.services.desktopConfig.resolveProvider('ocr')
  const documentOcrCapabilityPromise = ocrProviderPromise.then((provider) =>
    options.cloudEnabled && provider?.providerId?.trim().toLowerCase() === 'ollama-ocr-local'
      ? ctx.services.documentOcr.capability()
      : { available: false, providerAvailable: false, model: null },
  )
  const [
    llmProvider,
    sttProvider,
    ttsProvider,
    ocrProvider,
    documentOcrCapability,
    desktopPolicy,
    ota,
    scenes,
  ] = await Promise.all([
    ctx.services.desktopConfig.resolveProvider('llm'),
    ctx.services.desktopConfig.resolveProvider('stt'),
    ctx.services.desktopConfig.resolveProvider('tts'),
    ocrProviderPromise,
    documentOcrCapabilityPromise,
    ctx.services.desktopConfig.resolveDesktopPolicy({
      channel,
      platform,
      plan: options.plan,
    }),
    ctx.services.desktopConfig.resolveOtaPolicy({
      currentVersion: options.currentVersion,
      channel,
      platform,
      arch,
    }),
    ctx.services.scenes.listForPlan(options.plan),
  ])

  const llmConfigured = isProviderConfigured('llm', llmProvider)
  const sttConfigured = isProviderConfigured('stt', sttProvider)
  const ttsConfigured = isProviderConfigured('tts', ttsProvider)
  const ocrConfigured = isProviderConfigured('ocr', ocrProvider)

  const ocrService = ocrServicePolicy(
    ocrProvider,
    options,
    platform,
    documentContractRequested,
    documentOcrCapability,
  )
  const features = mergeDesktopFeatures(
    {
      cloudStt: options.cloudEnabled && sttConfigured,
      cloudLlm: options.cloudEnabled && llmConfigured,
      cloudTts: options.cloudEnabled && ttsConfigured,
      cloudOcr: options.cloudEnabled && ocrConfigured && ocrService.capabilities.imageAvailable,
      translate: true,
      selectedTextEdit: true,
      ota: true,
    },
    desktopPolicy?.features,
  )
  const services = mergeDesktopServices(
    {
      stt: sttServicePolicy(sttProvider, ctx.env, options),
      llm: llmServicePolicy(llmProvider, options),
      tts: ttsServicePolicy(ttsProvider, ctx.env, options),
      ocr: ocrService,
    },
    desktopPolicy?.services,
  )
  services.llm = { ...services.llm, models: publicProviderModels(services.llm.models) }
  services.ocr = {
    ...services.ocr,
    capabilities: publicOcrCapabilities(ocrService.capabilities),
  }
  const policy = mergeDesktopPolicy(
    {
      preferProxy: options.preferProxy,
      allowDirectProviderKeys: false,
      allowByok: true,
      allowLocalModels: true,
      remoteConfigDelivery: 'startup',
      activation: 'next_start',
      backgroundPolling: false,
    },
    desktopPolicy?.policy,
  )

  return {
    schemaVersion: 1,
    appName: APP_NAME,
    generatedAt: new Date().toISOString(),
    apiBaseUrl: ctx.env.publicApiBaseUrl,
    user: {
      email: options.userEmail ?? null,
      name: options.userName ?? null,
      plan: options.plan,
      subscriptionEnd: options.subscriptionEnd,
      quotaLevel: options.quotaLevel ?? 1,
      quotaMultiplier: options.quotaMultiplier ?? 1,
      adminRole: options.adminRole ?? null,
    },
    quotas: options.quotas ?? quotaPayload(null),
    features,
    services,
    scenes,
    ota: otaPolicy(ota),
    policy,
  }
}

type DesktopQuotaPayload = {
  stt: DesktopQuotaSnapshot
  llm: DesktopQuotaSnapshot
  ocr: DesktopQuotaSnapshot
  tts: DesktopQuotaSnapshot
}

type DesktopQuotaUnit = 'seconds' | 'tokens' | 'images' | 'chars'

type DesktopQuotaSnapshot = {
  used: number
  limit: number
  remaining: number
  unit: DesktopQuotaUnit
}

function quotaPayload(subscription: SubscriptionStatus | null): DesktopQuotaPayload {
  return {
    stt: quotaSnapshot(subscription?.sttSecondsUsed, subscription?.sttSecondsLimit, 'seconds'),
    llm: quotaSnapshot(subscription?.llmTokensUsed, subscription?.llmTokensLimit, 'tokens'),
    ocr: quotaSnapshot(subscription?.ocrImagesUsed, subscription?.ocrImagesLimit, 'images'),
    tts: quotaSnapshot(subscription?.ttsCharsUsed, subscription?.ttsCharsLimit, 'chars'),
  }
}

function quotaSnapshot(
  usedValue: number | null | undefined,
  limitValue: number | null | undefined,
  unit: DesktopQuotaUnit,
): DesktopQuotaSnapshot {
  const used = Number.isFinite(usedValue ?? NaN) ? Math.max(0, usedValue ?? 0) : 0
  const limit = Number.isFinite(limitValue ?? NaN) ? Math.max(0, limitValue ?? 0) : 0
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    unit,
  }
}

function isProviderConfigured(
  kind: ProviderKind,
  provider: ProviderRegistryStoredRecord | null,
): boolean {
  if (!provider?.enabled) return false
  if (provider.mode !== 'proxy') return false
  if (!provider.providerId) return false
  const preset = providerPreset(kind, provider.providerId)
  if (!preset) return false
  if (preset.capabilities.requiresApiKey && !provider.apiKey) return false
  if (kind === 'llm' || kind === 'tts' || kind === 'ocr') return Boolean(provider.defaultModel)
  return true
}

function llmServicePolicy(
  provider: ProviderRegistryStoredRecord | null,
  options: {
    includeSecretPreview: boolean
    cloudEnabled: boolean
    preferProxy: boolean
  },
) {
  const providerId = provider?.providerId?.trim().toLowerCase() || null
  const preset = providerPreset('llm', providerId)
  const configured = isProviderConfigured('llm', provider)

  return {
    mode:
      options.cloudEnabled && configured
        ? serviceMode(provider?.mode ?? 'proxy', options.preferProxy)
        : 'byok',
    configured,
    providerId,
    displayName:
      provider?.displayName ?? (providerId ? providerDisplayName('llm', providerId) : null),
    defaultModel: provider?.defaultModel ?? null,
    models: provider?.models?.length
      ? provider.models
      : provider?.defaultModel
        ? [providerPresetModel(provider.defaultModel, preset)]
        : [],
    apiKey: null,
    apiKeyPreview: options.includeSecretPreview && configured ? maskSecret(provider?.apiKey) : null,
  }
}

function sttServicePolicy(
  provider: ProviderRegistryStoredRecord | null,
  env: ServerEnv,
  options: {
    includeSecretPreview: boolean
    cloudEnabled: boolean
    preferProxy: boolean
  },
) {
  const providerId = provider?.providerId?.trim().toLowerCase() || null
  const preset = providerPreset('stt', providerId)
  const configured = isProviderConfigured('stt', provider)

  return {
    mode:
      options.cloudEnabled && configured
        ? serviceMode(provider?.mode ?? 'proxy', options.preferProxy)
        : 'byok',
    configured,
    providerId,
    displayName:
      provider?.displayName ?? (providerId ? providerDisplayName('stt', providerId) : null),
    defaultModel: providerId
      ? (provider?.defaultModel ?? env.sttModel ?? preset?.defaultModel ?? null)
      : null,
    defaultLanguage: 'multi',
    streaming: Boolean(
      provider?.capabilities.supportsPartialStt ?? preset?.capabilities.supportsPartialStt ?? false,
    ),
    apiKey: null,
    apiKeyPreview: options.includeSecretPreview && configured ? maskSecret(provider?.apiKey) : null,
  }
}

function ttsServicePolicy(
  provider: ProviderRegistryStoredRecord | null,
  env: ServerEnv,
  options: {
    includeSecretPreview: boolean
    cloudEnabled: boolean
    preferProxy: boolean
  },
) {
  const providerId = provider?.providerId?.trim().toLowerCase() || null
  const preset = providerPreset('tts', providerId)
  const configured = isProviderConfigured('tts', provider)

  return {
    mode:
      options.cloudEnabled && configured
        ? serviceMode(provider?.mode ?? 'proxy', options.preferProxy)
        : 'disabled',
    configured,
    providerId,
    displayName:
      provider?.displayName ?? (providerId ? providerDisplayName('tts', providerId) : null),
    defaultModel: provider?.defaultModel ?? null,
    defaultVoice:
      stringCapability(provider?.capabilities.voice) ??
      env.ttsVoice ??
      stringCapability(preset?.capabilities.voice) ??
      'alloy',
    apiKey: null,
    apiKeyPreview: options.includeSecretPreview && configured ? maskSecret(provider?.apiKey) : null,
  }
}

function ocrServicePolicy(
  provider: ProviderRegistryStoredRecord | null,
  options: {
    includeSecretPreview: boolean
    cloudEnabled: boolean
    preferProxy: boolean
  },
  platform: string,
  documentContractRequested: boolean,
  documentCapability: {
    available: boolean
    providerAvailable: boolean
    model: string | null
    documentContract?: string
  },
) {
  const providerId = provider?.providerId?.trim().toLowerCase() || null
  const configured = isProviderConfigured('ocr', provider)
  const available = options.cloudEnabled && configured
  const providerReady =
    providerId !== 'ollama-ocr-local' || documentCapability.providerAvailable === true
  const imageAvailable = available && providerReady
  const windowsClient = isWindowsDesktopPlatform(platform)
  const serverPipelineReady = Boolean(
    documentContractRequested &&
    available &&
    providerReady &&
    providerId === 'ollama-ocr-local' &&
    documentCapability.available &&
    documentCapability.documentContract === OCR_DOCUMENT_CONTRACT,
  )
  const clientRasterizedReady = imageAvailable && windowsClient
  const acceptedMimeTypes =
    serverPipelineReady || clientRasterizedReady
      ? [...OCR_PROXY_CAPABILITIES.acceptedMimeTypes, 'application/pdf']
      : [...OCR_PROXY_CAPABILITIES.acceptedMimeTypes]

  return {
    mode: available ? serviceMode(provider?.mode ?? 'proxy', options.preferProxy) : 'local',
    configured,
    providerId,
    displayName:
      provider?.displayName ?? (providerId ? providerDisplayName('ocr', providerId) : null),
    defaultBaseUrl: DEFAULT_OCR_BASE_URL,
    defaultModel: available ? (provider?.defaultModel ?? null) : DEFAULT_OCR_MODEL,
    localModel: DEFAULT_OCR_MODEL,
    capabilities: {
      ...OCR_PROXY_CAPABILITIES,
      acceptedMimeTypes,
      processingRoutes: serverPipelineReady
        ? [...OCR_PROXY_CAPABILITIES.processingRoutes, 'pipeline']
        : [...OCR_PROXY_CAPABILITIES.processingRoutes],
      imageAvailable: imageAvailable && OCR_PROXY_CAPABILITIES.imageAvailable,
      pdfAvailable: serverPipelineReady || clientRasterizedReady,
      maxPdfPages: serverPipelineReady || clientRasterizedReady ? 20 : 0,
      pdfMode: serverPipelineReady
        ? 'server-pipeline'
        : clientRasterizedReady
          ? 'client-rasterized'
          : 'unsupported',
      ...(serverPipelineReady ? { documentContract: OCR_DOCUMENT_CONTRACT } : {}),
    },
    apiKey: null,
    apiKeyPreview: options.includeSecretPreview && configured ? maskSecret(provider?.apiKey) : null,
  }
}

function requestedDocumentContracts(url: URL): Set<string> {
  return new Set(
    url.searchParams
      .getAll('docContracts')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

function isWindowsDesktopPlatform(platform: string) {
  return /(^|-)(windows|win32)(-|$)/i.test(platform.trim())
}

function otaPolicy(ota: {
  enabled: boolean
  autoUpdate: boolean
  forceUpdate: boolean
  currentVersion: string
  latestVersion: string
  minVersion: string | null
  updateAvailable: boolean
  releaseNotes: string | null
  downloadUrl: string | null
  sha256: string | null
}) {
  return {
    enabled: ota.enabled,
    autoUpdate: ota.autoUpdate,
    forceUpdate: ota.forceUpdate,
    currentVersion: ota.currentVersion,
    latestVersion: cleanVersion(ota.latestVersion) || '0.1.0',
    minVersion: cleanVersion(ota.minVersion) || null,
    updateAvailable: ota.updateAvailable,
    status: ota.updateAvailable ? (ota.forceUpdate ? 'required' : 'available') : 'current',
    releaseNotes: ota.updateAvailable ? ota.releaseNotes : null,
    downloadAvailable: Boolean(ota.updateAvailable && ota.downloadUrl),
    sha256: ota.updateAvailable ? ota.sha256 : null,
    checkedAt: new Date().toISOString(),
  }
}

function serviceMode(mode: string, _preferProxy: boolean): string {
  return mode
}

function mergeDesktopFeatures(
  base: {
    cloudStt: boolean
    cloudLlm: boolean
    cloudTts: boolean
    cloudOcr: boolean
    translate: boolean
    selectedTextEdit: boolean
    ota: boolean
  },
  override: Record<string, unknown> | null | undefined,
): typeof base {
  const safe = publicDesktopFeatureOverride(override)
  return {
    cloudStt: base.cloudStt && safe.cloudStt !== false,
    cloudLlm: base.cloudLlm && safe.cloudLlm !== false,
    cloudTts: base.cloudTts && safe.cloudTts !== false,
    cloudOcr: base.cloudOcr && safe.cloudOcr !== false,
    translate: base.translate && safe.translate !== false,
    selectedTextEdit: base.selectedTextEdit && safe.selectedTextEdit !== false,
    ota: base.ota && safe.ota !== false,
  }
}

function mergeDesktopPolicy(
  base: {
    preferProxy: boolean
    allowDirectProviderKeys: boolean
    allowByok: boolean
    allowLocalModels: boolean
    remoteConfigDelivery: 'startup'
    activation: 'next_start'
    backgroundPolling: false
  },
  override: Record<string, unknown> | null | undefined,
): typeof base {
  const safe = publicDesktopPolicyOverride(override)
  return {
    preferProxy: base.preferProxy && safe.preferProxy !== false,
    allowDirectProviderKeys: false,
    allowByok: base.allowByok && safe.allowByok !== false,
    allowLocalModels: base.allowLocalModels && safe.allowLocalModels !== false,
    remoteConfigDelivery: 'startup',
    activation: 'next_start',
    backgroundPolling: false,
  }
}

function mergeDesktopServices<T extends Record<string, Record<string, unknown>>>(
  base: T,
  override: Record<string, unknown> | null | undefined,
): T {
  const merged: Record<string, Record<string, unknown>> = {}
  for (const [kind, baseService] of Object.entries(base)) {
    const publicOverride = publicDesktopServiceOverride(override?.[kind])
    const service: Record<string, unknown> = { ...baseService, ...publicOverride, apiKey: null }
    delete service.baseUrl
    delete service.endpoint
    merged[kind] = service
  }
  return merged as T
}

export function redactDesktopPolicyServices(
  services: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const kind of DESKTOP_SERVICE_KINDS) {
    if (!Object.hasOwn(services, kind)) continue
    result[kind] = publicDesktopServiceOverride(services[kind])
  }
  return result
}

export function redactDesktopPolicyFeatures(
  features: Record<string, unknown>,
): Record<string, unknown> {
  return publicDesktopFeatureOverride(features)
}

export function redactDesktopPolicySettings(
  policy: Record<string, unknown>,
): Record<string, unknown> {
  return publicDesktopPolicyOverride(policy)
}

function publicDesktopServiceOverride(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  const source = candidate as Record<string, unknown>
  const result: Record<string, unknown> = {}
  if (source.mode === 'disabled') result.mode = 'disabled'
  if (source.configured === false) result.configured = false
  if (source.streaming === false) result.streaming = false
  return result
}

function publicDesktopFeatureOverride(
  candidate: Record<string, unknown> | null | undefined,
): Partial<{
  cloudStt: boolean
  cloudLlm: boolean
  cloudTts: boolean
  cloudOcr: boolean
  translate: boolean
  selectedTextEdit: boolean
  ota: boolean
}> {
  if (!candidate) return {}
  return {
    ...(typeof candidate.cloudStt === 'boolean' ? { cloudStt: candidate.cloudStt } : {}),
    ...(typeof candidate.cloudLlm === 'boolean' ? { cloudLlm: candidate.cloudLlm } : {}),
    ...(typeof candidate.cloudTts === 'boolean' ? { cloudTts: candidate.cloudTts } : {}),
    ...(typeof candidate.cloudOcr === 'boolean' ? { cloudOcr: candidate.cloudOcr } : {}),
    ...(typeof candidate.translate === 'boolean' ? { translate: candidate.translate } : {}),
    ...(typeof candidate.selectedTextEdit === 'boolean'
      ? { selectedTextEdit: candidate.selectedTextEdit }
      : {}),
    ...(typeof candidate.ota === 'boolean' ? { ota: candidate.ota } : {}),
  }
}

function publicDesktopPolicyOverride(
  candidate: Record<string, unknown> | null | undefined,
): Partial<{
  preferProxy: boolean
  allowByok: boolean
  allowLocalModels: boolean
}> {
  if (!candidate) return {}
  return {
    ...(typeof candidate.preferProxy === 'boolean' ? { preferProxy: candidate.preferProxy } : {}),
    ...(typeof candidate.allowByok === 'boolean' ? { allowByok: candidate.allowByok } : {}),
    ...(typeof candidate.allowLocalModels === 'boolean'
      ? { allowLocalModels: candidate.allowLocalModels }
      : {}),
  }
}

function publicProviderModels(candidate: unknown): Array<{ id: string; label?: string }> {
  if (!Array.isArray(candidate)) return []
  return candidate.flatMap((model) => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return []
    const id = Reflect.get(model, 'id')
    const label = Reflect.get(model, 'label')
    if (typeof id !== 'string' || !id.trim()) return []
    return [
      {
        id: id.trim(),
        ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      },
    ]
  })
}

function publicOcrCapabilities(candidate: unknown): {
  imageAvailable: boolean
  pdfAvailable: boolean
  acceptedMimeTypes: string[]
  maxInputBytes: number
  maxPdfPages: number
  processingRoutes: Array<'direct' | 'tile' | 'pipeline'>
  documentContract?: typeof OCR_DOCUMENT_CONTRACT
  pdfMode: 'client-rasterized' | 'server-pipeline' | 'unsupported'
} {
  const source =
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : {}
  const acceptedMimeTypes = stringArray(source.acceptedMimeTypes)
  const processingRoutes = stringArray(source.processingRoutes).filter(
    (route): route is 'direct' | 'tile' | 'pipeline' =>
      route === 'direct' || route === 'tile' || route === 'pipeline',
  )
  const pdfMode =
    source.pdfMode === 'client-rasterized' ||
    source.pdfMode === 'server-pipeline' ||
    source.pdfMode === 'unsupported'
      ? source.pdfMode
      : 'unsupported'
  return {
    imageAvailable: source.imageAvailable === true,
    pdfAvailable: source.pdfAvailable === true,
    acceptedMimeTypes,
    maxInputBytes: isNonNegativeSafeInteger(source.maxInputBytes) ? source.maxInputBytes : 0,
    maxPdfPages: isNonNegativeSafeInteger(source.maxPdfPages) ? source.maxPdfPages : 0,
    processingRoutes,
    ...(source.documentContract === OCR_DOCUMENT_CONTRACT
      ? { documentContract: OCR_DOCUMENT_CONTRACT }
      : {}),
    pdfMode,
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function stringCapability(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function maskSecret(value: string | null | undefined): string | null {
  const secret = value?.trim()
  if (!secret) return null
  return 'configured'
}

function cleanVersion(value: string | null): string {
  return value?.trim().replace(/^v/i, '') ?? ''
}
