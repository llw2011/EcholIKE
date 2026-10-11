import { describe, expect, it, vi } from 'vitest'
import type {
  DesktopConfigService,
  ProviderKind,
} from '../services/desktop/desktop-config-service.js'
import { activeNativeProviderOrigins } from '../services/proxy/proxy-services.js'

describe('proxy service runtime local origin authority', () => {
  it.each([
    ['llm', 'ollama', 'http://10.0.0.8:11440/v1', 'http://10.0.0.8:11440'],
    ['stt', 'sensevoice-local', 'http://10.0.0.8:9001/asr', 'http://10.0.0.8:9001'],
    ['tts', 'cosyvoice2-local', 'http://10.0.0.8:18771/tts', 'http://10.0.0.8:18771'],
    ['ocr', 'ollama-ocr-local', 'http://10.0.0.8:11434/api/generate', 'http://10.0.0.8:11434'],
  ] satisfies Array<readonly [ProviderKind, string, string, string]>)(
    'derives the exact active %s native provider origin',
    async (kind, providerId, endpoint, origin) => {
      const desktopConfig = {
        resolveProvider: vi.fn(async () => ({ providerId, endpoint })),
      } as unknown as DesktopConfigService

      await expect(activeNativeProviderOrigins(desktopConfig, kind)).resolves.toEqual([origin])
      expect(desktopConfig.resolveProvider).toHaveBeenCalledWith(kind)
    },
  )

  it('does not trust arbitrary private OpenAI-compatible providers', async () => {
    const desktopConfig = {
      resolveProvider: vi.fn(async () => ({
        providerId: 'openai-compatible',
        endpoint: 'http://10.0.0.9:8080/v1',
      })),
    } as unknown as DesktopConfigService

    await expect(activeNativeProviderOrigins(desktopConfig, 'llm')).resolves.toEqual([])
  })

  it('fails closed without an active server-authoritative provider', async () => {
    const desktopConfig = {
      resolveProvider: vi.fn(async () => null),
    } as unknown as DesktopConfigService

    await expect(activeNativeProviderOrigins(desktopConfig, 'llm')).resolves.toEqual([])
  })
})
