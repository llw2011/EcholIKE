import { createIdleSettingsConnectionOutcome, withoutSettingsNotice } from './appStore.settings'
import type { AppConfig, AppState, LocalOcrAvailabilityState } from './appStore.types'

type ConfigState = Pick<AppState, 'config' | 'savedConfig' | 'localOcrAvailability'>
type ConfigTransitionState = Pick<
  AppState,
  | 'config'
  | 'savedConfig'
  | 'localOcrAvailability'
  | 'settingsConnectionOutcomes'
  | 'settingsNotices'
>
type ConfigPatch = Partial<
  Pick<
    AppState,
    | 'config'
    | 'savedConfig'
    | 'localOcrAvailability'
    | 'settingsConnectionOutcomes'
    | 'settingsNotices'
  >
>
type LocalOcrProbePatch = Pick<AppState, 'localOcrAvailability'>
type LocalOcrProbeCompletionPatch = Pick<
  AppState,
  'localOcrAvailability' | 'settingsConnectionOutcomes'
>
type LocalOcrCapabilities = Parameters<AppState['finishLocalOcrProbe']>[2]

export function createDefaultConfig(isMac: boolean): AppConfig {
  return {
    config_source: 'backend',
    onboarding_version: 0,
    stt_provider: 'glm-asr',
    stt_api_key: '',
    stt_custom_api_key: '',
    stt_custom_preset: 'speaches',
    stt_custom_base_url: 'http://localhost:8000/v1',
    stt_custom_model: 'Systran/faster-whisper-large-v3',
    stt_language: 'multi',
    llm_provider: 'openrouter',
    llm_api_key: '',
    llm_model: 'google/gemini-2.5-flash',
    llm_base_url: 'https://openrouter.ai/api/v1',
    ocr_base_url: 'http://127.0.0.1:11434',
    ocr_model: 'glm-ocr:latest',
    polish_enabled: true,
    translate_enabled: false,
    target_lang: 'en',
    hotkey: isMac ? 'Option+/' : 'Ctrl+/',
    screen_ocr_hotkey: isMac ? 'Option+Shift+O' : 'Ctrl+Shift+O',
    hotkey_mode: 'hold',
    output_mode: 'keyboard',
    selected_text_enabled: false,
    theme: 'system',
    theme_profile: 'echo',
    auto_start: false,
    close_to_tray: true,
    start_minimized: false,
    max_recording_seconds: 30,
    mute_system_audio_during_recording: false,
    ui_language: 'zh',
    capsule_auto_hide: true,
    capsule_style: 'classic',
    network_proxy_enabled: false,
    network_proxy_url: '',
    network_proxy_bypass: 'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
  }
}

export function createIdleLocalOcrAvailability(): LocalOcrAvailabilityState {
  return {
    configurationKey: null,
    status: 'idle',
    leaseId: null,
    capabilities: null,
  }
}

export function createInitialConfigState(isMac: boolean): ConfigState {
  return {
    config: createDefaultConfig(isMac),
    savedConfig: null,
    localOcrAvailability: createIdleLocalOcrAvailability(),
  }
}

export function localOcrConfigurationKey(
  config: Pick<AppConfig, 'ocr_base_url' | 'ocr_model'>,
): string | null {
  const baseUrl = config.ocr_base_url.trim().replace(/\/+$/u, '')
  const model = config.ocr_model.trim()
  return baseUrl && model ? JSON.stringify([baseUrl, model]) : null
}

function localOcrAvailabilityForConfig(
  current: LocalOcrAvailabilityState,
  config: Pick<AppConfig, 'ocr_base_url' | 'ocr_model'>,
): LocalOcrAvailabilityState {
  const configurationKey = localOcrConfigurationKey(config)
  return current.configurationKey === configurationKey ? current : createIdleLocalOcrAvailability()
}

function localOcrConfigStatePatch(
  state: ConfigTransitionState,
  nextConfig: AppConfig,
): ConfigPatch {
  const configurationChanged =
    localOcrConfigurationKey(state.config) !== localOcrConfigurationKey(nextConfig)
  return {
    localOcrAvailability: localOcrAvailabilityForConfig(state.localOcrAvailability, nextConfig),
    ...(configurationChanged
      ? {
          settingsConnectionOutcomes: {
            ...state.settingsConnectionOutcomes,
            ocr: createIdleSettingsConnectionOutcome('ocr'),
          },
          settingsNotices: withoutSettingsNotice(state.settingsNotices, 'ocr'),
        }
      : {}),
  }
}

export function setConfigTransition(state: ConfigTransitionState, config: AppConfig): ConfigPatch {
  return { config, ...localOcrConfigStatePatch(state, config) }
}

export function updateConfigTransition(
  state: ConfigTransitionState,
  partial: Partial<AppConfig>,
): ConfigPatch {
  const config = { ...state.config, ...partial }
  return { config, ...localOcrConfigStatePatch(state, config) }
}

export function applyPersistedConfigPatchTransition(
  state: ConfigTransitionState,
  patch: Partial<AppConfig>,
): ConfigPatch {
  const config = { ...state.config, ...patch }
  return {
    config,
    savedConfig: state.savedConfig ? { ...state.savedConfig, ...patch } : state.savedConfig,
    ...localOcrConfigStatePatch(state, config),
  }
}

export function setSavedConfigTransition(savedConfig: AppConfig): Pick<AppState, 'savedConfig'> {
  return { savedConfig }
}

export function resetConfigTransition(state: ConfigTransitionState): ConfigPatch {
  if (!state.savedConfig) return {}
  const config = { ...state.savedConfig }
  return { config, ...localOcrConfigStatePatch(state, config) }
}

export function startLocalOcrProbeTransition(
  configurationKey: string,
  leaseId: number,
): LocalOcrProbePatch {
  return {
    localOcrAvailability: {
      configurationKey,
      status: 'checking',
      leaseId,
      capabilities: null,
    },
  }
}

export function finishLocalOcrProbeTransition(
  outcomes: AppState['settingsConnectionOutcomes'],
  configurationKey: string,
  capabilities: LocalOcrCapabilities,
): LocalOcrProbeCompletionPatch {
  return {
    localOcrAvailability: {
      configurationKey,
      status:
        capabilities && (capabilities.imageAvailable || capabilities.pdfAvailable)
          ? 'available'
          : 'unavailable',
      leaseId: null,
      capabilities,
    },
    settingsConnectionOutcomes: {
      ...outcomes,
      ocr: createIdleSettingsConnectionOutcome('ocr'),
    },
  }
}
