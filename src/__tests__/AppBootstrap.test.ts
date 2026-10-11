import { describe, expect, it } from 'vitest'
import type { DesktopBootstrap, DesktopBootstrapCache } from '../lib/tauri'
import { bootstrapConfigPatch, isBootstrapCacheUsable } from '../lib/desktopBootstrap'
import appSource from '../App.tsx?raw'
import mainWindowSource from '../windows/MainWindowApp.tsx?raw'
import markdownEditorWindowSource from '../windows/MarkdownEditorWindowApp.tsx?raw'
import mainStartupSource from '../windows/useMainStartup.ts?raw'
import mainUsageModeSource from '../windows/useMainUsageMode.ts?raw'
import workbenchSource from '../components/HomePage/Workbench.tsx?raw'
import settingsSource from '../components/Settings/ControlPanel.tsx?raw'
import inputSettingsSource from '../components/Settings/InputSettingsPanel.tsx?raw'
import speechSettingsSource from '../components/Settings/SpeechSettingsPanel.tsx?raw'
import aiSettingsSource from '../components/Settings/AiSettingsPanel.tsx?raw'
import systemSettingsSource from '../components/Settings/SystemSettingsPanel.tsx?raw'
import backendAccountSource from '../components/Settings/useBackendAccount.ts?raw'
import settingsCacheSource from '../components/Settings/settingsCache.ts?raw'
import desktopAuthSource from '../lib/desktopAuth.ts?raw'

function bootstrap(override: Partial<DesktopBootstrap>): DesktopBootstrap {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-29T00:00:00.000Z',
    apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
    ...override,
  }
}

describe('desktop bootstrap helpers', () => {
  it('ignores every pre-0.2 browser state key', () => {
    const sources = [
      appSource,
      mainWindowSource,
      markdownEditorWindowSource,
      mainStartupSource,
      mainUsageModeSource,
      workbenchSource,
      settingsSource,
      inputSettingsSource,
      speechSettingsSource,
      aiSettingsSource,
      systemSettingsSource,
      backendAccountSource,
      settingsCacheSource,
      desktopAuthSource,
    ]
    for (const source of sources) {
      expect(source).not.toContain('echolikeAuthToken')
      expect(source).not.toContain('echoAuthToken')
      expect(source).not.toContain("'echolike.pendingUpdate'")
    }
    expect(sources.join('\n')).toContain('echolike.v2.authToken')
    expect(settingsCacheSource).toContain('echolike.v2.pendingUpdate')
  })

  it('uses the last known good backend policy cache without TTL expiry', () => {
    const cachedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const cache: DesktopBootstrapCache = {
      packageVersion: '0.2.0',
      cachedAt,
      authToken: 'desktop-token',
      bootstrap: bootstrap({
        user: {
          email: 'owner@example.com',
          name: null,
          plan: 'pro',
          subscriptionEnd: null,
        },
        policy: {
          preferProxy: true,
          allowDirectProviderKeys: false,
          allowByok: true,
          allowLocalModels: true,
          remoteConfigDelivery: 'startup',
          activation: 'next_start',
          backgroundPolling: false,
        },
      }),
    }

    expect(isBootstrapCacheUsable(cache, 'desktop-token')).toBe(true)
    expect(isBootstrapCacheUsable(cache, 'newer-token')).toBe(false)
    expect(
      isBootstrapCacheUsable(
        {
          ...cache,
          bootstrap: bootstrap({ user: undefined }),
        },
        'desktop-token',
      ),
    ).toBe(false)
    expect(
      isBootstrapCacheUsable(
        {
          ...cache,
          authToken: null,
          bootstrap: bootstrap({ user: undefined }),
        },
        null,
      ),
    ).toBe(true)
    expect(isBootstrapCacheUsable({ ...cache, cachedAt: 'not-a-date' }, 'desktop-token')).toBe(
      false,
    )
  })

  it('never persists provider credential downlinks into local config', () => {
    expect(
      bootstrapConfigPatch(
        bootstrap({
          services: {
            llm: {
              mode: 'proxy',
              providerId: 'openrouter',
              apiKey: 'server-key',
              baseUrl: 'https://openrouter.ai/api/v1',
              defaultModel: 'google/gemini-2.5-flash',
            },
            stt: {
              mode: 'proxy',
              providerId: 'glm-asr',
              apiKey: 'server-stt-key',
              defaultLanguage: 'multi',
            },
          },
        }),
      ),
    ).toEqual({})

    expect(
      bootstrapConfigPatch(
        bootstrap({
          services: {
            llm: {
              mode: 'direct',
              providerId: 'openrouter',
              apiKey: 'server-key',
              baseUrl: 'https://openrouter.ai/api/v1',
              defaultModel: 'google/gemini-2.5-flash',
            },
            stt: {
              mode: 'direct',
              providerId: 'glm-asr',
              apiKey: 'server-stt-key',
              defaultLanguage: 'zh',
            },
          },
        }),
      ),
    ).toEqual({})
  })
})
