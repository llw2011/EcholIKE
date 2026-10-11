import type { ServerEnv } from '../../env.js'
import type { DesktopConfigService, ProviderKind } from '../desktop/desktop-config-service.js'
import type { LocalOcrExecutionGate } from '../ocr/document-ocr-service.js'
import type { LocalOcrRuntime } from '../ocr/local-ocr-runtime.js'
import {
  createLlmProxyService,
  disabledLlmProxyService,
  LLM_MAX_PROVIDER_RESPONSE_BYTES,
  type LlmProxyService,
} from './llm-proxy.js'
import {
  createOcrProxyService,
  disabledOcrProxyService,
  OCR_MAX_PROVIDER_RESPONSE_BYTES,
  type OcrProxyService,
  writeOcrFailureDiagnostic,
} from './ocr-proxy.js'
import {
  createSttProxyService,
  disabledSttProxyService,
  STT_MAX_PROVIDER_RESPONSE_BYTES,
  type SttProxyService,
} from './stt-proxy.js'
import {
  createTtsProxyService,
  disabledTtsProxyService,
  TTS_MAX_PROVIDER_AUDIO_BYTES,
  type TtsProxyService,
} from './tts-proxy.js'
import { createProviderEgressFetch } from '../security/provider-egress-fetch.js'
import { providerPreset, resolvePresetEndpoint } from './provider-presets.js'

export interface ProxyServices {
  llm: LlmProxyService
  ocr: OcrProxyService
  stt: SttProxyService
  tts: TtsProxyService
}

export interface ProxyServiceOptions {
  ocrFetch?: typeof fetch
  localOcrRuntime?: LocalOcrRuntime
}

export function createProxyServices(
  env: ServerEnv,
  desktopConfig?: DesktopConfigService,
  localOcrExecutionGate?: LocalOcrExecutionGate,
  options: ProxyServiceOptions = {},
): ProxyServices {
  const llmFetch = createProviderEgressFetch({
    maxResponseBytes: LLM_MAX_PROVIDER_RESPONSE_BYTES,
    trustedLocalOrigins: () => activeNativeProviderOrigins(desktopConfig, 'llm'),
  })
  const ocrFetch = options.ocrFetch ?? createOcrProviderFetch(desktopConfig)
  const sttFetch = createProviderEgressFetch({
    maxResponseBytes: STT_MAX_PROVIDER_RESPONSE_BYTES,
    trustedLocalOrigins: () => activeNativeProviderOrigins(desktopConfig, 'stt'),
  })
  const ttsFetch = createProviderEgressFetch({
    maxResponseBytes: TTS_MAX_PROVIDER_AUDIO_BYTES,
    trustedLocalOrigins: () => activeNativeProviderOrigins(desktopConfig, 'tts'),
  })
  return {
    llm: createLlmProxyService(env, llmFetch, desktopConfig),
    ocr: createOcrProxyService(
      env,
      ocrFetch,
      desktopConfig,
      writeOcrFailureDiagnostic,
      localOcrExecutionGate,
      options.localOcrRuntime,
    ),
    stt: createSttProxyService(env, sttFetch, desktopConfig),
    tts: createTtsProxyService(env, ttsFetch, desktopConfig),
  }
}

export function createOcrProviderFetch(desktopConfig?: DesktopConfigService): typeof fetch {
  return createProviderEgressFetch({
    maxResponseBytes: OCR_MAX_PROVIDER_RESPONSE_BYTES,
    trustedLocalOrigins: () => activeNativeProviderOrigins(desktopConfig, 'ocr'),
  })
}

export async function activeNativeProviderOrigins(
  desktopConfig: DesktopConfigService | undefined,
  kind: ProviderKind,
): Promise<readonly string[]> {
  const provider = await desktopConfig?.resolveProvider(kind)
  if (!provider) return []
  const preset = providerPreset(kind, provider.providerId)
  if (!preset || preset.protocol === 'openai') return []
  const endpoint = resolvePresetEndpoint(preset, provider.endpoint)
  if (!endpoint) return []
  try {
    const url = new URL(endpoint)
    return url.protocol === 'http:' ? [url.origin] : []
  } catch {
    return []
  }
}

export const disabledProxyServices: ProxyServices = {
  llm: disabledLlmProxyService,
  ocr: disabledOcrProxyService,
  stt: disabledSttProxyService,
  tts: disabledTtsProxyService,
}
