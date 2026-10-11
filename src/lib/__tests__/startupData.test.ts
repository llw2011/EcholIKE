import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../../stores/appStore'
import { loadStartupData, type StartupDataLoaders } from '../startupData'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    config_source: 'local',
    onboarding_version: 1,
    stt_provider: 'glm-asr',
    stt_api_key: '',
    stt_custom_api_key: '',
    stt_custom_preset: 'speaches',
    stt_custom_base_url: 'http://localhost:8000/v1',
    stt_custom_model: 'Systran/faster-whisper-large-v3',
    stt_language: 'multi',
    llm_provider: 'ollama',
    llm_api_key: '',
    llm_model: 'qwen3.5',
    llm_base_url: 'http://127.0.0.1:11434',
    ocr_base_url: 'http://127.0.0.1:11434',
    ocr_model: 'glm-ocr:latest',
    polish_enabled: true,
    translate_enabled: false,
    target_lang: 'zh',
    hotkey: 'Ctrl+/',
    screen_ocr_hotkey: 'Ctrl+Shift+O',
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
    network_proxy_bypass: 'localhost,127.0.0.1,::1',
    ...overrides,
  }
}

function makeLoaders(overrides: Partial<StartupDataLoaders> = {}): StartupDataLoaders {
  return {
    getConfig: vi.fn().mockResolvedValue({
      config: makeConfig({ theme_profile: 'ray' }),
      origin: 'persisted',
    }),
    getHistory: vi.fn().mockResolvedValue([
      {
        id: 1,
        created_at: '2026-07-07T00:00:00.000Z',
        app_name: 'Notes',
        app_type: 'Writing',
        raw_text: 'raw',
        polished_text: 'polished',
        language: 'zh',
        duration_ms: 1200,
      },
    ]),
    getDictionary: vi.fn().mockResolvedValue([{ id: 1, word: 'EcholIKE', pronunciation: null }]),
    getRuntimeAppVersion: vi.fn().mockResolvedValue('0.1.37'),
    ...overrides,
  }
}

describe('loadStartupData', () => {
  it('returns loaded local startup data when every source succeeds', async () => {
    const fallbackConfig = makeConfig()

    const data = await loadStartupData(makeLoaders(), {
      config: fallbackConfig,
      runtimeAppVersion: '0.0.0',
    })

    expect(data.config.theme_profile).toBe('ray')
    expect(data.configOrigin).toBe('persisted')
    expect(data.history).toHaveLength(1)
    expect(data.dictionary).toHaveLength(1)
    expect(data.runtimeAppVersion).toBe('0.1.37')
  })

  it('falls back per source instead of failing the first app render', async () => {
    const fallbackConfig = makeConfig({ theme_profile: 'echo' })
    const warn = vi.fn()

    const data = await loadStartupData(
      makeLoaders({
        getConfig: vi.fn().mockRejectedValue(new Error('settings store cold')),
        getHistory: vi.fn().mockRejectedValue(new Error('sqlite warming up')),
        getDictionary: vi.fn().mockRejectedValue(new Error('dictionary table locked')),
        getRuntimeAppVersion: vi.fn().mockRejectedValue(new Error('app api unavailable')),
      }),
      {
        config: fallbackConfig,
        runtimeAppVersion: '0.1.0',
      },
      warn,
    )

    expect(data).toEqual({
      config: fallbackConfig,
      configOrigin: 'unavailable',
      history: [],
      dictionary: [],
      runtimeAppVersion: '0.1.0',
    })
    expect(warn).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledWith('history', expect.any(Error))
  })
})
