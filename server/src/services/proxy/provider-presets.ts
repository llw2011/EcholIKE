import type { ProviderKind, ProviderModelRecord } from '../desktop/desktop-config-service.js'

export type ProviderProtocol =
  | 'openai'
  | 'ollama-chat'
  | 'sensevoice'
  | 'cosyvoice2'
  | 'ollama-generate'

export interface ProviderPresetCapabilities extends Record<string, unknown> {
  requiresApiKey: boolean
  supportsStreaming?: boolean
  supportsTranslate?: boolean
  supportsPartialStt?: boolean
  imageAvailable?: boolean
  pdfAvailable?: boolean
  acceptedMimeTypes?: string[]
  maxInputBytes?: number
  maxPdfPages?: number
  processingRoutes?: string[]
  pdfMode?: string
  voice?: string
}

export interface ProviderPreset {
  kind: ProviderKind
  providerId: string
  displayName: string
  defaultModel: string | null
  baseUrl: string | null
  endpoint: string | null
  endpointSuffix: string | null
  protocol: ProviderProtocol
  models: ProviderModelRecord[]
  capabilities: ProviderPresetCapabilities
  sttExtraFields?: Record<string, string>
}

const LLM_CAPABILITIES: ProviderPresetCapabilities = {
  requiresApiKey: true,
  supportsStreaming: true,
  supportsTranslate: true,
}

const LOCAL_LLM_CAPABILITIES: ProviderPresetCapabilities = {
  requiresApiKey: false,
  supportsStreaming: true,
  supportsTranslate: true,
}

const STT_CAPABILITIES: ProviderPresetCapabilities = {
  requiresApiKey: true,
  supportsPartialStt: false,
}

const LOCAL_STT_CAPABILITIES: ProviderPresetCapabilities = {
  requiresApiKey: false,
  supportsPartialStt: false,
}

const TTS_CAPABILITIES: ProviderPresetCapabilities = {
  requiresApiKey: true,
  voice: 'alloy',
}

const LOCAL_TTS_CAPABILITIES: ProviderPresetCapabilities = {
  requiresApiKey: false,
  voice: 'default',
}

export const OCR_PROXY_CAPABILITIES = {
  imageAvailable: true,
  pdfAvailable: false,
  // BMP remains a valid legacy route input, but no shared cloud-provider
  // contract guarantees it. Do not advertise it until a provider-specific
  // capability or a reliable PNG transcode path owns that promise.
  acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxInputBytes: 25 * 1024 * 1024,
  maxPdfPages: 0,
  processingRoutes: ['direct'],
  pdfMode: 'unsupported',
} satisfies Omit<ProviderPresetCapabilities, 'requiresApiKey'>

const OCR_CAPABILITIES: ProviderPresetCapabilities = {
  requiresApiKey: true,
  ...OCR_PROXY_CAPABILITIES,
}

const LOCAL_OCR_CAPABILITIES: ProviderPresetCapabilities = {
  requiresApiKey: false,
  ...OCR_PROXY_CAPABILITIES,
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  llmPreset('openai', 'OpenAI', 'gpt-4o-mini', 'https://api.openai.com/v1'),
  llmPreset('deepseek', 'DeepSeek', 'deepseek-chat', 'https://api.deepseek.com/v1'),
  llmPreset('openrouter', 'OpenRouter', 'google/gemini-2.5-flash', 'https://openrouter.ai/api/v1'),
  llmPreset('groq', 'Groq', 'llama-3.3-70b-versatile', 'https://api.groq.com/openai/v1'),
  llmPreset(
    'siliconflow',
    'SiliconFlow',
    'Qwen/Qwen2.5-72B-Instruct',
    'https://api.siliconflow.cn/v1',
  ),
  llmPreset('openai-compatible', 'OpenAI Compatible', null, null),
  nativePreset(
    'llm',
    'ollama',
    'Ollama Local',
    'qwen3.5',
    'http://127.0.0.1:11440',
    'ollama-chat',
    LOCAL_LLM_CAPABILITIES,
  ),

  sttPreset(
    'glm-asr',
    'GLM ASR',
    'glm-asr-2512',
    'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
    { stream: 'false' },
  ),
  sttPreset(
    'openai-whisper',
    'OpenAI Whisper',
    'whisper-1',
    'https://api.openai.com/v1/audio/transcriptions',
  ),
  sttPreset(
    'openai',
    'OpenAI Audio',
    'whisper-1',
    'https://api.openai.com/v1/audio/transcriptions',
  ),
  sttPreset(
    'groq-whisper',
    'Groq Whisper',
    'whisper-large-v3-turbo',
    'https://api.groq.com/openai/v1/audio/transcriptions',
  ),
  sttPreset(
    'groq',
    'Groq Audio',
    'whisper-large-v3-turbo',
    'https://api.groq.com/openai/v1/audio/transcriptions',
  ),
  sttPreset(
    'siliconflow',
    'SiliconFlow SenseVoice',
    'FunAudioLLM/SenseVoiceSmall',
    'https://api.siliconflow.cn/v1/audio/transcriptions',
  ),
  nativePreset(
    'stt',
    'sensevoice-local',
    'SenseVoice Local',
    'SenseVoiceSmall',
    'http://127.0.0.1:9001/asr',
    'sensevoice',
    LOCAL_STT_CAPABILITIES,
  ),

  ttsPreset('openai', 'OpenAI TTS', 'tts-1', 'https://api.openai.com/v1'),
  ttsPreset('openrouter', 'OpenRouter TTS', 'tts-1', 'https://openrouter.ai/api/v1'),
  ttsPreset(
    'siliconflow',
    'SiliconFlow TTS',
    'FunAudioLLM/CosyVoice2-0.5B',
    'https://api.siliconflow.cn/v1',
  ),
  ttsPreset('openai-compatible', 'OpenAI Compatible TTS', null, null),
  nativePreset(
    'tts',
    'cosyvoice2-local',
    'CosyVoice2 Local',
    'CosyVoice2-0.5B',
    'http://127.0.0.1:18771/tts',
    'cosyvoice2',
    LOCAL_TTS_CAPABILITIES,
  ),

  ocrPreset('openai', 'OpenAI Vision', 'gpt-4o-mini', 'https://api.openai.com/v1'),
  ocrPreset(
    'openrouter',
    'OpenRouter Vision',
    'google/gemini-2.5-flash',
    'https://openrouter.ai/api/v1',
  ),
  ocrPreset('zhipu', '智谱 GLM Vision', 'glm-4.5v', 'https://open.bigmodel.cn/api/paas/v4'),
  ocrPreset(
    'siliconflow',
    'SiliconFlow Vision',
    'Qwen/Qwen2.5-VL-72B-Instruct',
    'https://api.siliconflow.cn/v1',
  ),
  ocrPreset('openai-compatible', 'OpenAI Compatible Vision', null, null),
  nativePreset(
    'ocr',
    'ollama-ocr-local',
    'Ollama GLM OCR Local',
    'glm-ocr:latest',
    'http://127.0.0.1:11434/api/generate',
    'ollama-generate',
    LOCAL_OCR_CAPABILITIES,
  ),
]

export function providerPreset(kind: ProviderKind, providerId: string | null | undefined) {
  const id = providerId?.trim().toLowerCase()
  if (!id) return null
  return PROVIDER_PRESETS.find((preset) => preset.kind === kind && preset.providerId === id) ?? null
}

export function providerDisplayName(kind: ProviderKind, providerId: string): string {
  return providerPreset(kind, providerId)?.displayName ?? providerId
}

export function providerPresetRequiresApiKey(
  kind: ProviderKind,
  providerId: string | null | undefined,
): boolean {
  return providerPreset(kind, providerId)?.capabilities.requiresApiKey ?? true
}

export function providerPresetGroupsForPanel() {
  const groups: Record<ProviderKind, ProviderPreset[]> = {
    llm: [],
    stt: [],
    tts: [],
    ocr: [],
  }
  for (const preset of PROVIDER_PRESETS) {
    groups[preset.kind].push(preset)
  }
  return groups
}

export function providerPresetModel(
  model: string,
  preset: ProviderPreset | null,
): ProviderModelRecord {
  const record: ProviderModelRecord = {
    id: model,
    label: model,
    supportsStreaming: Boolean(preset?.capabilities.supportsStreaming),
    supportsTranslate: Boolean(preset?.capabilities.supportsTranslate),
  }
  if (preset?.kind === 'llm') record.maxInputChars = 24000
  return record
}

export function resolvePresetEndpoint(
  preset: ProviderPreset,
  overrideBaseOrEndpoint: string | null | undefined,
): string | null {
  const baseOrEndpoint = overrideBaseOrEndpoint?.trim() || preset.endpoint || preset.baseUrl
  if (!baseOrEndpoint) return null
  if (!preset.endpointSuffix) return baseOrEndpoint
  return openAiCompatibleEndpoint(baseOrEndpoint, preset.endpointSuffix)
}

function llmPreset(
  providerId: string,
  displayName: string,
  defaultModel: string | null,
  baseUrl: string | null,
): ProviderPreset {
  return openAiLikePreset('llm', providerId, displayName, defaultModel, baseUrl, 'chat/completions')
}

function ttsPreset(
  providerId: string,
  displayName: string,
  defaultModel: string | null,
  baseUrl: string | null,
): ProviderPreset {
  return openAiLikePreset('tts', providerId, displayName, defaultModel, baseUrl, 'audio/speech')
}

function ocrPreset(
  providerId: string,
  displayName: string,
  defaultModel: string | null,
  baseUrl: string | null,
): ProviderPreset {
  return openAiLikePreset('ocr', providerId, displayName, defaultModel, baseUrl, 'chat/completions')
}

function openAiLikePreset(
  kind: ProviderKind,
  providerId: string,
  displayName: string,
  defaultModel: string | null,
  baseUrl: string | null,
  endpointSuffix: string,
): ProviderPreset {
  const capabilities =
    kind === 'llm' ? LLM_CAPABILITIES : kind === 'tts' ? TTS_CAPABILITIES : OCR_CAPABILITIES
  return {
    kind,
    providerId,
    displayName,
    defaultModel,
    baseUrl,
    endpoint: null,
    endpointSuffix,
    protocol: 'openai',
    models: defaultModel ? [{ id: defaultModel, label: defaultModel }] : [],
    capabilities,
  }
}

function nativePreset(
  kind: ProviderKind,
  providerId: string,
  displayName: string,
  defaultModel: string,
  endpointOrBaseUrl: string,
  protocol: ProviderProtocol,
  capabilities: ProviderPresetCapabilities,
): ProviderPreset {
  return {
    kind,
    providerId,
    displayName,
    defaultModel,
    baseUrl: kind === 'llm' ? endpointOrBaseUrl : null,
    endpoint: kind === 'llm' ? null : endpointOrBaseUrl,
    endpointSuffix: null,
    protocol,
    models: [{ id: defaultModel, label: defaultModel }],
    capabilities,
  }
}

function sttPreset(
  providerId: string,
  displayName: string,
  defaultModel: string,
  endpoint: string,
  sttExtraFields: Record<string, string> = {},
): ProviderPreset {
  return {
    kind: 'stt',
    providerId,
    displayName,
    defaultModel,
    baseUrl: null,
    endpoint,
    endpointSuffix: null,
    protocol: 'openai',
    models: [{ id: defaultModel, label: defaultModel }],
    capabilities: STT_CAPABILITIES,
    sttExtraFields,
  }
}

function openAiCompatibleEndpoint(baseUrl: string, suffix: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith(`/${suffix}`)) return trimmed
  return `${trimmed}/${suffix}`
}
