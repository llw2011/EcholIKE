import { json } from '../../errors.js'
import type { Handler } from '../../http.js'
import { capabilitiesForAdminRole, currentAdminAccount } from '../../middleware/require-admin.js'
import type { ProviderKind, ProviderMode } from '../../services/desktop/desktop-config-service.js'
import { providerPreset } from '../../services/proxy/provider-presets.js'
import {
  buildDesktopBootstrapPayload,
  redactDesktopPolicyFeatures,
  redactDesktopPolicyServices,
  redactDesktopPolicySettings,
} from '../desktop-bootstrap.js'

export const adminSummary: Handler = async (ctx) => {
  const admin = currentAdminAccount(ctx)
  if (!admin) throw new Error('adminSummary must be mounted behind requireAdmin')

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    admin: {
      userId: admin.userId,
      role: admin.role,
      capabilities: capabilitiesForAdminRole(admin.role),
    },
    overview: await ctx.services.admin.getOverview(),
  })
}

export const adminSystem: Handler = async (ctx) => {
  const databaseReady = await ctx.services.database.ready().catch(() => false)

  return json({
    ok: databaseReady,
    generatedAt: new Date().toISOString(),
    runtime: {
      nodeEnv: ctx.env.nodeEnv,
      apiBasePath: ctx.env.apiBasePath,
      publicApiOrigin: new URL(ctx.env.publicApiBaseUrl).origin,
      betterAuthOrigin: new URL(ctx.env.betterAuthUrl).origin,
      corsAllowedOrigins: ctx.env.corsAllowedOrigins,
    },
    dependencies: {
      databaseReady,
      authSecret: configured(ctx.env.betterAuthSecret),
      redis: configured(ctx.env.redisUrl),
      googleOAuth: configuredPair(ctx.env.googleClientId, ctx.env.googleClientSecret),
      githubOAuth: configuredPair(ctx.env.githubClientId, ctx.env.githubClientSecret),
      stripe: configuredAll(
        ctx.env.stripeSecretKey,
        ctx.env.stripeWebhookSecret,
        ctx.env.stripeProPriceId,
      ),
      sttProxy: configuredEnvProvider('stt', ctx.env.sttProvider, ctx.env.sttApiKey),
      llmProxy: configuredEnvProvider(
        'llm',
        ctx.env.llmProvider,
        ctx.env.llmApiKey,
        ctx.env.llmModel,
      ),
      ttsProxy: configuredEnvProvider(
        'tts',
        ctx.env.ttsProvider,
        ctx.env.ttsApiKey,
        ctx.env.ttsModel,
      ),
    },
  })
}

export const adminProxyStatus: Handler = async (ctx) => {
  const [stt, llm, tts, ocr] = await Promise.all(
    (['stt', 'llm', 'tts', 'ocr'] as const).map((kind) =>
      ctx.services.desktopConfig.resolveProvider(kind),
    ),
  )

  return json({
    generatedAt: new Date().toISOString(),
    stt: {
      configured: providerConfigured('stt', stt),
      provider: stt?.providerId ?? null,
      apiKey: stt?.apiKeyPreview ? 'set' : 'missing',
    },
    llm: {
      configured: providerConfigured('llm', llm),
      provider: llm?.providerId ?? null,
      model: llm?.defaultModel ?? null,
      apiKey: llm?.apiKeyPreview ? 'set' : 'missing',
    },
    tts: {
      configured: providerConfigured('tts', tts),
      provider: tts?.providerId ?? null,
      model: tts?.defaultModel ?? null,
      apiKey: tts?.apiKeyPreview ? 'set' : 'missing',
    },
    ocr: {
      configured: providerConfigured('ocr', ocr),
      provider: ocr?.providerId ?? null,
      model: ocr?.defaultModel ?? null,
      apiKey: ocr?.apiKeyPreview ? 'set' : 'missing',
    },
  })
}

export const adminDesktopPolicy: Handler = async (ctx) => {
  const url = new URL(ctx.request.url)
  const currentVersion = url.searchParams.get('version')?.trim().replace(/^v/i, '') || '0.0.0'
  const [preview, providerRows, ota] = await Promise.all([
    buildDesktopBootstrapPayload(ctx, {
      currentVersion,
      channel: 'stable',
      platform: 'windows',
      arch: 'x86_64',
      includeSecretPreview: true,
      cloudEnabled: true,
      plan: 'pro',
      subscriptionEnd: null,
      preferProxy: true,
    }),
    Promise.all(
      (['stt', 'llm', 'tts', 'ocr'] as const).map((kind) =>
        ctx.services.desktopConfig.resolveProvider(kind),
      ),
    ),
    ctx.services.desktopConfig.resolveOtaPolicy({
      currentVersion,
      channel: 'stable',
      platform: 'windows',
      arch: 'x86_64',
    }),
  ])
  const [stt, llm, tts, ocr] = providerRows

  return json({
    generatedAt: new Date().toISOString(),
    providerStatus: {
      stt: {
        configured: providerConfigured('stt', stt),
        provider: stt?.providerId ?? null,
        apiKeyPreview: preview.services.stt.apiKeyPreview,
      },
      llm: {
        configured: providerConfigured('llm', llm),
        provider: llm?.providerId ?? null,
        model: llm?.defaultModel ?? null,
        apiKeyPreview: preview.services.llm.apiKeyPreview,
      },
      tts: {
        configured: providerConfigured('tts', tts),
        provider: tts?.providerId ?? null,
        model: tts?.defaultModel ?? null,
        apiKeyPreview: preview.services.tts.apiKeyPreview,
      },
      ocr: {
        configured: providerConfigured('ocr', ocr),
        provider: ocr?.providerId ?? null,
        model: ocr?.defaultModel ?? null,
        apiKeyPreview: preview.services.ocr.apiKeyPreview,
      },
    },
    ota: {
      enabled: ota.enabled,
      autoUpdate: ota.autoUpdate,
      latestVersion: ota.latestVersion,
      minVersion: ota.minVersion,
      updateAvailable: ota.updateAvailable,
      force: ota.forceUpdate,
      downloadUrl: configured(ota.downloadUrl),
      sha256: configured(ota.sha256),
      signature: configured(ota.signature),
    },
    policies: (await ctx.services.desktopConfig.listDesktopPolicies()).map((policy) => ({
      ...policy,
      features: redactDesktopPolicyFeatures(policy.features),
      services: redactDesktopPolicyServices(policy.services),
      policy: redactDesktopPolicySettings(policy.policy),
    })),
    bootstrapPreview: preview,
  })
}

function configured(value: string | null): 'set' | 'missing' {
  return value ? 'set' : 'missing'
}

function configuredPair(left: string | null, right: string | null): 'set' | 'partial' | 'missing' {
  if (left && right) return 'set'
  if (left || right) return 'partial'
  return 'missing'
}

function configuredAll(...values: Array<string | null>): 'set' | 'partial' | 'missing' {
  const configuredCount = values.filter(Boolean).length
  if (configuredCount === values.length) return 'set'
  if (configuredCount > 0) return 'partial'
  return 'missing'
}

function configuredEnvProvider(
  kind: ProviderKind,
  providerId: string | null,
  apiKey: string | null,
  model?: string | null,
): 'set' | 'partial' | 'missing' {
  if (!providerId) return 'missing'
  const preset = providerPreset(kind, providerId)
  if (!preset) return 'partial'
  const hasKey = !preset.capabilities.requiresApiKey || Boolean(apiKey)
  const hasModel = kind === 'stt' || Boolean(model || preset.defaultModel)
  return hasKey && hasModel ? 'set' : 'partial'
}

function providerConfigured(
  kind: ProviderKind,
  provider:
    | {
        enabled: boolean
        mode: ProviderMode
        providerId: string
        apiKeyPreview: string | null
        defaultModel: string | null
      }
    | null
    | undefined,
): boolean {
  if (!provider?.enabled || provider.mode !== 'proxy') return false
  const preset = providerPreset(kind, provider.providerId)
  if (!preset) return false
  if (preset.capabilities.requiresApiKey && !provider.apiKeyPreview) return false
  if (kind === 'llm' || kind === 'tts' || kind === 'ocr') return Boolean(provider.defaultModel)
  return true
}
