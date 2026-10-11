import { notImplemented } from '../../errors.js'
import type { ServerEnv } from '../../env.js'
import type {
  ProviderKind,
  DesktopConfigService,
  ProviderRegistryStoredRecord,
} from '../desktop/desktop-config-service.js'
import { providerPreset, resolvePresetEndpoint, type ProviderProtocol } from './provider-presets.js'

export interface LlmProviderConfig {
  provider: string
  endpoint: string
  apiKey: string | null
  model: string
  protocol: ProviderProtocol
}

export interface SttProviderConfig {
  provider: string
  endpoint: string
  apiKey: string | null
  model: string
  protocol: ProviderProtocol
  extraFields: Record<string, string>
}

export interface TtsProviderConfig {
  provider: string
  endpoint: string
  apiKey: string | null
  model: string
  protocol: ProviderProtocol
  voice: string
}

export interface OcrProviderConfig {
  provider: string
  endpoint: string
  apiKey: string | null
  model: string
  protocol: ProviderProtocol
}

export async function resolveLlmProviderConfig(
  env: ServerEnv,
  desktopConfig?: DesktopConfigService,
): Promise<LlmProviderConfig> {
  const registry = await desktopConfig?.resolveProvider('llm')
  const provider = (registry?.providerId ?? env.llmProvider)?.trim().toLowerCase()
  if (!provider || provider === 'mock') {
    throw notImplemented('Cloud LLM provider is not configured')
  }
  const preset = providerPreset('llm', provider)
  if (!preset) {
    throw notImplemented(`Unsupported cloud LLM provider: ${provider}`)
  }
  const apiKey = registry?.apiKey ?? env.llmApiKey
  const model = registry?.defaultModel ?? env.llmModel ?? preset.defaultModel
  if (!providerHasRequiredApiKey(preset, apiKey) || !model || !providerEnabled(registry)) {
    throw notImplemented('Cloud LLM provider is not configured')
  }

  const endpoint = resolvePresetEndpoint(preset, registry?.endpoint ?? env.llmBaseUrl)
  if (!endpoint) {
    throw notImplemented(`Cloud LLM provider endpoint is not configured: ${provider}`)
  }

  return {
    provider,
    endpoint,
    apiKey,
    model,
    protocol: preset.protocol,
  }
}

export async function resolveSttProviderConfig(
  env: ServerEnv,
  desktopConfig?: DesktopConfigService,
): Promise<SttProviderConfig> {
  const registry = await desktopConfig?.resolveProvider('stt')
  const provider = (registry?.providerId ?? env.sttProvider)?.trim().toLowerCase()
  if (!provider || provider === 'mock') {
    throw notImplemented('Cloud STT provider is not configured')
  }
  const preset = providerPreset('stt', provider)
  if (!preset) {
    throw notImplemented(`Unsupported cloud STT provider: ${provider}`)
  }
  const apiKey = registry?.apiKey ?? env.sttApiKey
  if (!providerHasRequiredApiKey(preset, apiKey) || !providerEnabled(registry)) {
    throw notImplemented('Cloud STT provider is not configured')
  }

  const endpoint = resolvePresetEndpoint(preset, registry?.endpoint ?? env.sttBaseUrl)
  if (!endpoint) {
    throw notImplemented(`Cloud STT provider endpoint is not configured: ${provider}`)
  }

  return {
    provider,
    endpoint,
    apiKey,
    model: registry?.defaultModel ?? env.sttModel ?? preset.defaultModel ?? 'whisper-1',
    protocol: preset.protocol,
    extraFields: preset.sttExtraFields ?? {},
  }
}

export async function resolveTtsProviderConfig(
  env: ServerEnv,
  desktopConfig?: DesktopConfigService,
): Promise<TtsProviderConfig> {
  const registry = await desktopConfig?.resolveProvider('tts')
  const provider = (registry?.providerId ?? env.ttsProvider)?.trim().toLowerCase()
  if (!provider || provider === 'mock') {
    throw notImplemented('Cloud TTS provider is not configured')
  }
  const preset = providerPreset('tts', provider)
  if (!preset) {
    throw notImplemented(`Unsupported cloud TTS provider: ${provider}`)
  }
  const apiKey = registry?.apiKey ?? env.ttsApiKey
  const model = registry?.defaultModel ?? env.ttsModel ?? preset.defaultModel
  if (!providerHasRequiredApiKey(preset, apiKey) || !model || !providerEnabled(registry)) {
    throw notImplemented('Cloud TTS provider is not configured')
  }

  const endpoint = resolvePresetEndpoint(preset, registry?.endpoint ?? env.ttsBaseUrl)
  if (!endpoint) {
    throw notImplemented(`Cloud TTS provider endpoint is not configured: ${provider}`)
  }

  return {
    provider,
    endpoint,
    apiKey,
    model,
    protocol: preset.protocol,
    voice:
      stringCapability(registry?.capabilities.voice) ??
      env.ttsVoice ??
      stringCapability(preset.capabilities.voice) ??
      'alloy',
  }
}

export async function resolveOcrProviderConfig(
  _env: ServerEnv,
  desktopConfig?: DesktopConfigService,
): Promise<OcrProviderConfig> {
  const registry = await desktopConfig?.resolveProvider('ocr')
  const provider = registry?.providerId?.trim().toLowerCase()
  if (!provider || provider === 'mock') {
    throw notImplemented('Cloud OCR provider is not configured')
  }
  const preset = providerPreset('ocr', provider)
  if (!preset) {
    throw notImplemented(`Unsupported cloud OCR provider: ${provider}`)
  }
  const apiKey = registry?.apiKey ?? null
  const model = registry?.defaultModel ?? preset.defaultModel
  if (!providerHasRequiredApiKey(preset, apiKey) || !model || !providerEnabled(registry)) {
    throw notImplemented('Cloud OCR provider is not configured')
  }

  const endpoint = resolvePresetEndpoint(preset, registry?.endpoint)
  if (!endpoint) {
    throw notImplemented(`Cloud OCR provider endpoint is not configured: ${provider}`)
  }

  return {
    provider,
    endpoint,
    apiKey,
    model,
    protocol: preset.protocol,
  }
}

function providerHasRequiredApiKey(
  preset: NonNullable<ReturnType<typeof providerPreset>>,
  apiKey: string | null | undefined,
): boolean {
  return !preset.capabilities.requiresApiKey || Boolean(apiKey)
}

function providerEnabled(provider: ProviderRegistryStoredRecord | null | undefined): boolean {
  if (!provider) return true
  return provider.enabled && provider.mode === 'proxy' && providerSupported(provider)
}

function providerSupported(provider: ProviderRegistryStoredRecord): boolean {
  return Boolean(providerPreset(provider.kind as ProviderKind, provider.providerId))
}

function stringCapability(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
