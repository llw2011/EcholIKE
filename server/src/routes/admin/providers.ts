import { ApiError, forbidden, json } from '../../errors.js'
import type { Handler } from '../../http.js'
import { currentAdminAccount } from '../../middleware/require-admin.js'
import { AdminAuthorizationChangedError } from '../../services/admin/admin-service.js'
import {
  ProviderRegistryStateError,
  type ProviderKind,
  type ProviderMode,
  type ProviderModelRecord,
  type ProviderRegistryInput,
} from '../../services/desktop/desktop-config-service.js'
import { providerPreset, resolvePresetEndpoint } from '../../services/proxy/provider-presets.js'
import { sameProviderOrigin } from '../../services/security/provider-egress-policy.js'
import { requireControlRole } from './control.js'
import {
  booleanField,
  integerField,
  optionalIntegerField,
  optionalStringField,
  POSTGRES_INTEGER_MAX,
  readJsonObject,
  stringField,
} from './http-fields.js'

export const adminProviders: Handler = async (ctx) => {
  const actor = currentAdminAccount(ctx)
  const providers = await ctx.services.desktopConfig.listProviders()
  return json({
    generatedAt: new Date().toISOString(),
    providers:
      actor?.role === 'owner' || actor?.role === 'admin'
        ? providers
        : providers.map((provider) => ({
            ...provider,
            endpoint: providerEndpointOriginPreview(provider.endpoint),
          })),
  })
}

export const adminUpsertProvider: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  const input = providerInput(body)
  let provider
  try {
    provider = await ctx.services.desktopConfig.upsertProvider(input, {
      control: { actorUserId: actor.userId, requestId: ctx.requestId },
      signal: ctx.request.signal,
      validateProvider: (candidate) => ctx.services.providerControl.assertSavable(candidate),
    })
  } catch (error) {
    throwProviderAdminError(error)
  }

  return json({ ok: true, provider })
}

export const adminProviderModels: Handler = async (ctx) => {
  requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  const kind = providerKindField(body, 'kind')
  const providerId = stringField(body, 'providerId', 80).toLowerCase()
  const endpoint = stringField(body, 'endpoint', 500)
  const submittedApiKey = optionalStringField(body, 'apiKey', 1000)
  const preset = providerPreset(kind, providerId)
  if (!preset) {
    throw new ApiError(422, 'validation_failed', `${kind} provider is not supported`)
  }

  const requestedEndpoint = resolvePresetEndpoint(preset, endpoint) ?? endpoint
  const configured = await ctx.services.desktopConfig.resolveProvider(kind)
  const configuredPreset = configured ? providerPreset(kind, configured.providerId) : null
  const configuredEndpoint =
    configured && configuredPreset
      ? resolvePresetEndpoint(configuredPreset, configured.endpoint)
      : null
  const reusableConfiguredKey = Boolean(
    configured &&
    configured.providerId === providerId &&
    configuredEndpoint &&
    sameProviderOrigin(configuredEndpoint, requestedEndpoint),
  )
  const models = await ctx.services.providerControl.listModels({
    kind,
    providerId,
    endpoint,
    apiKey: submittedApiKey ?? (reusableConfiguredKey ? (configured?.apiKey ?? null) : null),
    trustedLocalEndpoint:
      preset.protocol !== 'openai' &&
      configured?.providerId === providerId &&
      configuredEndpoint === requestedEndpoint
        ? configuredEndpoint
        : null,
    signal: ctx.request.signal,
  })

  return json({ ok: true, models })
}

export const adminCheckLlm: Handler = async (ctx) => {
  requireControlRole(ctx, ['owner', 'admin', 'operator'])
  const result = await ctx.services.proxy.llm.complete({
    messages: [{ role: 'user', content: 'ping' }],
  })

  return json({
    ok: Boolean(result.text.trim()),
    usageTokens: result.usageTokens,
  })
}

function providerEndpointOriginPreview(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function providerKindField(body: Record<string, unknown>, key: string): ProviderKind {
  const value = stringField(body, key)
  if (value !== 'llm' && value !== 'stt' && value !== 'tts' && value !== 'ocr') {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return value
}

function providerModeField(body: Record<string, unknown>, key: string): ProviderMode {
  const value = stringField(body, key)
  if (
    value !== 'proxy' &&
    value !== 'direct' &&
    value !== 'byok' &&
    value !== 'local' &&
    value !== 'disabled'
  ) {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return value
}

function providerInput(body: Record<string, unknown>): ProviderRegistryInput {
  const id = optionalStringField(body, 'id', 80) ?? undefined
  const expectedRevision = optionalIntegerField(body, 'expectedRevision', 0, POSTGRES_INTEGER_MAX)
  if (id && expectedRevision === null) {
    throw new ApiError(422, 'validation_failed', '修改服务配置时必须携带当前 revision')
  }
  const kind = providerKindField(body, 'kind')
  const providerId = stringField(body, 'providerId', 80).toLowerCase()
  const mode = providerModeField(body, 'mode')
  if (mode !== 'proxy') {
    throw new ApiError(422, 'validation_failed', 'backend-managed providers must use proxy mode')
  }
  const preset = providerPreset(kind, providerId)
  if (!preset) {
    throw new ApiError(422, 'validation_failed', `${kind} provider is not supported in proxy mode`)
  }
  const models = providerModelsField(body)
  return {
    ...(id ? { id } : {}),
    ...(id ? { expectedRevision: expectedRevision as number } : {}),
    kind,
    providerId,
    displayName: stringField(body, 'displayName', 120),
    enabled: booleanField(body, 'enabled'),
    mode,
    endpoint: optionalStringField(body, 'endpoint', 500),
    apiKey: Object.prototype.hasOwnProperty.call(body, 'apiKey')
      ? optionalStringField(body, 'apiKey', 1000)
      : undefined,
    defaultModel: optionalStringField(body, 'defaultModel', 180) ?? preset?.defaultModel ?? null,
    models: models.length ? models : (preset?.models ?? []),
    capabilities: preset.capabilities,
    priority: optionalIntegerField(body, 'priority', -100_000, 100_000) ?? 0,
  }
}

function throwProviderAdminError(error: unknown): never {
  if (error instanceof ProviderRegistryStateError) {
    if (error.code === 'provider_not_found') {
      throw new ApiError(404, 'not_found', '找不到这条服务配置')
    }
    if (error.code === 'provider_conflict') {
      throw new ApiError(409, 'validation_failed', '同类型的该服务已存在，请刷新后编辑现有记录')
    }
    throw new ApiError(409, 'validation_failed', '服务配置已变化，请刷新后重试')
  }
  if (error instanceof AdminAuthorizationChangedError) {
    throw forbidden('管理员权限状态已变化，请刷新页面后重试')
  }
  throw error
}

function providerModelsField(body: Record<string, unknown>): ProviderModelRecord[] {
  const value = body.models
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new ApiError(422, 'validation_failed', 'models must be an array of at most 100 items')
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ApiError(422, 'validation_failed', `models[${index}] is invalid`)
    }
    const row = item as Record<string, unknown>
    const model: ProviderModelRecord = {
      id: stringField(row, 'id', 180),
    }
    const label = optionalStringField(row, 'label', 180)
    if (label) model.label = label
    if (row.supportsStreaming !== undefined)
      model.supportsStreaming = booleanField(row, 'supportsStreaming')
    if (row.supportsTranslate !== undefined)
      model.supportsTranslate = booleanField(row, 'supportsTranslate')
    if (row.maxInputChars !== undefined) {
      model.maxInputChars = integerField(row, 'maxInputChars', 1, 1_000_000)
    }
    return model
  })
}
