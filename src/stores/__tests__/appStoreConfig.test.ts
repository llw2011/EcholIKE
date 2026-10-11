import { describe, expect, it } from 'vitest'
import { localOcrConfigurationKey } from '../appStore'
import {
  applyPersistedConfigPatchTransition,
  createDefaultConfig,
  createInitialConfigState,
  finishLocalOcrProbeTransition,
  resetConfigTransition,
  updateConfigTransition,
} from '../appStore.config'
import { createInitialSettingsState } from '../appStore.settings'
import {
  availableLocalOcrCapabilities,
  getState,
  setupAppStoreTestLifecycle,
  useAppStore,
} from './appStoreTestHarness'

describe('appStore config transitions', () => {
  it('creates platform-specific defaults and normalizes local OCR target identities', () => {
    const windows = createDefaultConfig(false)
    const mac = createDefaultConfig(true)

    expect(windows.hotkey).toBe('Ctrl+/')
    expect(windows.screen_ocr_hotkey).toBe('Ctrl+Shift+O')
    expect(mac.hotkey).toBe('Option+/')
    expect(mac.screen_ocr_hotkey).toBe('Option+Shift+O')
    expect(localOcrConfigurationKey(windows)).toBe(
      localOcrConfigurationKey({ ...windows, ocr_base_url: ' http://127.0.0.1:11434/// ' }),
    )
    expect(localOcrConfigurationKey({ ...windows, ocr_model: '  ' })).toBeNull()
    expect(localOcrConfigurationKey({ ...windows, ocr_base_url: '  ' })).toBeNull()
  })

  it('keeps config, saved baseline, local OCR, outcome, and notice in one pure patch', () => {
    const initial = createInitialConfigState(false)
    const settings = createInitialSettingsState()
    const state = {
      ...initial,
      localOcrAvailability: {
        configurationKey: localOcrConfigurationKey(initial.config),
        status: 'available' as const,
        leaseId: null,
        capabilities: availableLocalOcrCapabilities,
      },
      settingsConnectionOutcomes: {
        ...settings.settingsConnectionOutcomes,
        ocr: { status: 'success' as const, service: 'ocr' as const, result: 'ok', latencyMs: 1 },
      },
      settingsNotices: {
        ocr: {
          id: 1,
          scope: 'ocr' as const,
          phase: 'success' as const,
          text: 'old target',
          seenAt: null,
          expiresAt: null,
        },
      },
    }

    expect(updateConfigTransition(state, { ocr_model: 'new-model' })).toMatchObject({
      config: { ocr_model: 'new-model' },
      localOcrAvailability: {
        configurationKey: null,
        status: 'idle',
        leaseId: null,
        capabilities: null,
      },
      settingsConnectionOutcomes: {
        ocr: { status: 'idle', service: 'ocr', result: null, latencyMs: null },
      },
      settingsNotices: {},
    })
    expect(applyPersistedConfigPatchTransition(state, { theme: 'dark' })).toMatchObject({
      config: { theme: 'dark' },
      savedConfig: null,
    })
    expect(resetConfigTransition(state)).toEqual({})
  })

  it('classifies local OCR probe completion without changing unrelated settings facts', () => {
    const settings = createInitialSettingsState()
    settings.settingsConnectionOutcomes.stt = {
      status: 'success',
      service: 'stt',
      result: 'ok',
      latencyMs: 1,
    }
    const available = finishLocalOcrProbeTransition(
      settings.settingsConnectionOutcomes,
      'ocr-key',
      availableLocalOcrCapabilities,
    )
    expect(available.localOcrAvailability).toMatchObject({
      configurationKey: 'ocr-key',
      status: 'available',
      leaseId: null,
      capabilities: availableLocalOcrCapabilities,
    })
    expect(available.settingsConnectionOutcomes.stt).toBe(settings.settingsConnectionOutcomes.stt)
    expect(
      finishLocalOcrProbeTransition(settings.settingsConnectionOutcomes, 'ocr-key', null)
        .localOcrAvailability.status,
    ).toBe('unavailable')
  })
})

describe('appStore', () => {
  setupAppStoreTestLifecycle()

  describe('config', () => {
    it('has sensible defaults', () => {
      const { config } = getState()
      expect(config.config_source).toBe('backend')
      expect(config.onboarding_version).toBe(0)
      expect(config.theme).toBe('system')
      expect(config.theme_profile).toBe('echo')
      expect(config.hotkey).toBe('Ctrl+/')
      expect(config.screen_ocr_hotkey).toBe('Ctrl+Shift+O')
      expect(config.output_mode).toBe('keyboard')
      expect(config.polish_enabled).toBe(true)
      expect(config.stt_custom_api_key).toBe('')
      expect(config.capsule_auto_hide).toBe(true)
      expect(config.capsule_style).toBe('classic')
      expect(config.mute_system_audio_during_recording).toBe(false)
      expect(config.ocr_base_url).toBe('http://127.0.0.1:11434')
      expect(config.ocr_model).toBe('glm-ocr:latest')
      expect(config.network_proxy_enabled).toBe(false)
      expect(config.network_proxy_url).toBe('')
      expect(config.network_proxy_bypass).toContain('127.0.0.1')
    })

    it('setConfig replaces entire config', () => {
      const newConfig = { ...getState().config, theme: 'dark' as const }
      getState().setConfig(newConfig)
      expect(getState().config.theme).toBe('dark')
    })

    it('updateConfig merges partial config immutably', () => {
      const original = getState().config
      getState().updateConfig({ theme: 'dark' })
      const updated = getState().config

      expect(updated.theme).toBe('dark')
      expect(updated.hotkey).toBe('Ctrl+/') // unchanged
      expect(updated.screen_ocr_hotkey).toBe('Ctrl+Shift+O') // unchanged
      expect(updated).not.toBe(original) // new object
    })

    it('invalidates verified local OCR availability when its normalized target changes', () => {
      const originalKey = localOcrConfigurationKey(getState().config)
      expect(originalKey).not.toBeNull()
      const leaseId = getState().beginLocalOcrProbe(originalKey ?? '') ?? -1
      getState().finishLocalOcrProbe(originalKey ?? '', leaseId, availableLocalOcrCapabilities)
      expect(getState().localOcrAvailability).toMatchObject({
        configurationKey: originalKey,
        status: 'available',
      })
      getState().publishSettingsNotice('ocr', 'success', '旧模型可用')

      getState().updateConfig({ ocr_base_url: 'http://127.0.0.1:11434/' })
      expect(getState().localOcrAvailability.status).toBe('available')
      expect(getState().settingsNotices.ocr?.text).toBe('旧模型可用')

      getState().updateConfig({ ocr_model: 'another-ocr-model' })
      expect(getState().localOcrAvailability).toEqual({
        configurationKey: null,
        status: 'idle',
        leaseId: null,
        capabilities: null,
      })
      expect(getState().settingsConnectionOutcomes.ocr.status).toBe('idle')
      expect(getState().settingsNotices.ocr).toBeUndefined()
    })

    it('publishes config and all local OCR invalidation facts in one subscriber snapshot', () => {
      const originalKey = localOcrConfigurationKey(getState().config) ?? ''
      const probeLease = getState().beginLocalOcrProbe(originalKey) ?? -1
      getState().finishLocalOcrProbe(originalKey, probeLease, availableLocalOcrCapabilities)
      const settingsLease = getState().tryStartSettingsOperation('ocr-test') ?? -1
      getState().completeSettingsConnection(settingsLease, 'ocr', 'available', 1)
      getState().publishSettingsNotice('ocr', 'success', 'old target')

      const snapshots: Array<{
        model: string
        availability: string
        outcome: string
        notice: string | null
      }> = []
      const unsubscribe = useAppStore.subscribe((state) => {
        snapshots.push({
          model: state.config.ocr_model,
          availability: state.localOcrAvailability.status,
          outcome: state.settingsConnectionOutcomes.ocr.status,
          notice: state.settingsNotices.ocr?.text ?? null,
        })
      })

      getState().updateConfig({ ocr_model: 'new-ocr-model' })
      unsubscribe()

      expect(snapshots).toEqual([
        {
          model: 'new-ocr-model',
          availability: 'idle',
          outcome: 'idle',
          notice: null,
        },
      ])
    })

    it('ignores a late local OCR probe after a new configuration and lease take ownership', () => {
      const originalKey = localOcrConfigurationKey(getState().config) ?? ''
      const originalLease = getState().beginLocalOcrProbe(originalKey) ?? -1
      expect(getState().beginLocalOcrProbe(originalKey)).toBeNull()

      getState().updateConfig({ ocr_model: 'new-ocr-model' })
      const nextKey = localOcrConfigurationKey(getState().config) ?? ''
      const nextLease = getState().beginLocalOcrProbe(nextKey) ?? -1

      expect(
        getState().finishLocalOcrProbe(originalKey, originalLease, availableLocalOcrCapabilities),
      ).toBe(false)
      expect(getState().localOcrAvailability).toEqual({
        configurationKey: nextKey,
        status: 'checking',
        leaseId: nextLease,
        capabilities: null,
      })

      expect(getState().finishLocalOcrProbe(nextKey, nextLease, null)).toBe(true)
      expect(getState().localOcrAvailability).toEqual({
        configurationKey: nextKey,
        status: 'unavailable',
        leaseId: null,
        capabilities: null,
      })
    })

    it('clears a stale settings success when a fresh local OCR probe reports unavailable', () => {
      const settingsLease = getState().tryStartSettingsOperation('ocr-test') ?? -1
      getState().completeSettingsConnection(settingsLease, 'ocr', '本地可用', 12)
      expect(getState().settingsConnectionOutcomes.ocr.status).toBe('success')

      const configurationKey = localOcrConfigurationKey(getState().config) ?? ''
      const probeLease = getState().beginLocalOcrProbe(configurationKey) ?? -1
      getState().finishLocalOcrProbe(configurationKey, probeLease, null)

      expect(getState().localOcrAvailability.status).toBe('unavailable')
      expect(getState().settingsConnectionOutcomes.ocr.status).toBe('idle')
    })

    it('preserves independently available local OCR paths', () => {
      const configurationKey = localOcrConfigurationKey(getState().config) ?? ''
      const probeLease = getState().beginLocalOcrProbe(configurationKey) ?? -1
      const capabilities = {
        ...availableLocalOcrCapabilities,
        pdfAvailable: false,
        pipelineAvailable: false,
        issues: ['Document pipeline unavailable'],
      }

      getState().finishLocalOcrProbe(configurationKey, probeLease, capabilities)

      expect(getState().localOcrAvailability).toEqual({
        configurationKey,
        status: 'available',
        leaseId: null,
        capabilities,
      })
    })
  })

  describe('savedConfig / resetConfig', () => {
    it('applyPersistedConfigPatch updates config and savedConfig for patched fields', () => {
      const saved = { ...getState().config, capsule_auto_hide: false }
      getState().setSavedConfig(saved)
      getState().applyPersistedConfigPatch({ capsule_auto_hide: true })

      expect(getState().config.capsule_auto_hide).toBe(true)
      expect(getState().savedConfig?.capsule_auto_hide).toBe(true)
    })

    it('applyPersistedConfigPatch preserves unrelated dirty fields', () => {
      const saved = { ...getState().config, theme: 'system' as const, capsule_auto_hide: false }
      getState().setSavedConfig(saved)
      getState().updateConfig({ theme: 'dark' })

      getState().applyPersistedConfigPatch({ capsule_auto_hide: true })

      expect(getState().config.theme).toBe('dark')
      expect(getState().savedConfig?.theme).toBe('system')
      expect(getState().config.capsule_auto_hide).toBe(true)
      expect(getState().savedConfig?.capsule_auto_hide).toBe(true)
    })

    it('applyPersistedConfigPatch lets persisted patch win for the same dirty field', () => {
      const saved = { ...getState().config, capsule_auto_hide: false }
      getState().setSavedConfig(saved)
      getState().updateConfig({ capsule_auto_hide: true })

      getState().applyPersistedConfigPatch({ capsule_auto_hide: false })

      expect(getState().config.capsule_auto_hide).toBe(false)
      expect(getState().savedConfig?.capsule_auto_hide).toBe(false)
    })

    it('resetConfig restores to savedConfig', () => {
      const saved = { ...getState().config }
      getState().setSavedConfig(saved)

      getState().updateConfig({ theme: 'dark', polish_enabled: false })
      expect(getState().config.theme).toBe('dark')

      getState().resetConfig()
      expect(getState().config.theme).toBe('system')
      expect(getState().config.polish_enabled).toBe(true)
    })

    it('resetConfig is a no-op when savedConfig is null', () => {
      getState().updateConfig({ theme: 'dark' })
      getState().resetConfig()
      // Should remain dark since savedConfig is null
      expect(getState().config.theme).toBe('dark')
    })
  })
})
