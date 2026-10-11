import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { maskSecret } from '../routes/desktop-bootstrap.js'
import { createAdminService, createMemoryAdminStore } from '../services/admin/admin-service.js'
import { providerPreset } from '../services/proxy/provider-presets.js'
import { createSceneService, createStaticSceneStore } from '../services/scenes/scene-service.js'
import { freeUser, proUser, request, testEnv, testServices } from './helpers.js'
import type { AuthenticatedUser } from '../types.js'

const backendAdminUser: AuthenticatedUser = {
  id: 'user_backend_admin',
  email: 'backend-admin@example.com',
  name: 'Backend Admin',
  plan: 'free',
  subscriptionEnd: null,
}

function bootstrapApp(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  const env = testEnv(overrides)
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({
      'valid-free-token': freeUser,
      'valid-pro-token': proUser,
    }),
    services: testServices(env),
  })
}

describe('desktop bootstrap route', () => {
  it('returns non-sensitive policy to unauthenticated desktop clients', async () => {
    const res = await bootstrapApp({
      LLM_PROVIDER: 'openrouter',
      LLM_API_KEY: 'test-server-llm-key',
      LLM_MODEL: 'google/gemini-2.5-flash',
      DESKTOP_UPDATE_ENABLED: 'true',
      DESKTOP_UPDATE_LATEST_VERSION: '0.2.0',
      DESKTOP_UPDATE_DOWNLOAD_URL: 'https://example.com/EcholIKE-0.2.0.exe',
    }).fetch(request('/echo-api/desktop/bootstrap?version=0.1.0&platform=windows'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.user).toMatchObject({
      email: null,
      plan: 'free',
      adminRole: null,
      quotaLevel: 1,
      quotaMultiplier: 1,
    })
    expect(body.quotas.llm).toMatchObject({
      used: 0,
      limit: 100_000,
      remaining: 100_000,
      unit: 'tokens',
    })
    expect(body.features.cloudLlm).toBe(false)
    expect(body.services.ocr.capabilities).toMatchObject({
      imageAvailable: false,
      pdfAvailable: false,
      pdfMode: 'unsupported',
      processingRoutes: ['direct'],
    })
    expect(body.services.llm).toMatchObject({
      mode: 'byok',
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      defaultModel: 'google/gemini-2.5-flash',
      apiKey: null,
      apiKeyPreview: null,
    })
    expect(body.ota).toMatchObject({
      latestVersion: '0.2.0',
      updateAvailable: true,
      downloadAvailable: true,
    })
    expect(JSON.stringify(body)).not.toContain('test-server-llm-key')
    expect(body.services.llm).not.toHaveProperty('baseUrl')
    expect(body.services.llm).not.toHaveProperty('endpoint')
    expect(JSON.stringify(body.ota)).not.toContain('EcholIKE-0.2.0.exe')
  })

  it('never exposes stored provider routes or desktop-policy route overrides', async () => {
    const env = testEnv()
    const services = testServices(env)
    const taintedModel = {
      id: 'private-model',
      label: 'Private model',
      apiKey: 'nested-model-secret',
      metadata: { endpoint: 'https://nested-model.example/private' },
    }
    await services.desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://private-provider.example/internal/path?token=route-secret',
      apiKey: 'provider-secret',
      defaultModel: 'private-model',
      models: [taintedModel],
      capabilities: {
        apiKey: 'nested-capability-secret',
        endpoint: 'https://nested-capability.example/private',
      },
      priority: 10,
    })
    await services.desktopConfig.upsertDesktopPolicy({
      channel: 'stable',
      platform: 'all',
      plan: 'all',
      features: {
        cloudLlm: true,
        translate: false,
        apiKey: 'feature-secret',
        nested: { endpoint: 'https://nested-feature.example/private' },
      },
      services: {
        llm: {
          baseUrl: 'https://policy-private.example/secret',
          endpoint: 'https://policy-private.example/alternate',
          apiKey: 'policy-secret',
          defaultModel: 'policy-model',
          models: [{ id: 'policy-model', apiKey: 'nested-policy-model-secret' }],
          capabilities: { endpoint: 'https://nested-service.example/private' },
        },
      },
      policy: {
        preferProxy: true,
        allowDirectProviderKeys: true,
        allowByok: false,
        allowLocalModels: false,
        remoteConfigDelivery: 'immediate',
        activation: 'now',
        backgroundPolling: true,
        apiKey: 'runtime-policy-secret',
        nested: { endpoint: 'https://nested-policy.example/private' },
      },
      enabled: true,
    })
    const app = createApp({ env, services })

    const response = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.2.12&platform=windows'),
    )
    const body = await response.json()
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(body.features).toMatchObject({ cloudLlm: false, translate: false })
    expect(body.services.llm).toMatchObject({ defaultModel: 'private-model', apiKey: null })
    expect(body.services.llm.models).toEqual([{ id: 'private-model', label: 'Private model' }])
    expect(body.services.llm).not.toHaveProperty('baseUrl')
    expect(body.services.llm).not.toHaveProperty('endpoint')
    expect(body.policy).toMatchObject({
      preferProxy: false,
      allowDirectProviderKeys: false,
      allowByok: false,
      allowLocalModels: false,
      remoteConfigDelivery: 'startup',
      activation: 'next_start',
      backgroundPolling: false,
    })
    expect(serialized).not.toContain('private-provider.example')
    expect(serialized).not.toContain('policy-private.example')
    expect(serialized).not.toContain('nested-model.example')
    expect(serialized).not.toContain('nested-capability.example')
    expect(serialized).not.toContain('nested-feature.example')
    expect(serialized).not.toContain('nested-service.example')
    expect(serialized).not.toContain('nested-policy.example')
    expect(serialized).not.toContain('route-secret')
    expect(serialized).not.toContain('provider-secret')
    expect(serialized).not.toContain('policy-secret')
    expect(serialized).not.toContain('runtime-policy-secret')
    expect(serialized).not.toContain('nested-model-secret')
    expect(serialized).not.toContain('nested-capability-secret')
    expect(serialized).not.toContain('nested-policy-model-secret')
  })

  it('keeps bootstrap anonymous when a browser cookie is present without Authorization', async () => {
    const env = testEnv()
    const app = createApp({
      env,
      sessionVerifier: async () => proUser,
      services: testServices(env),
    })

    const res = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0&platform=windows', {
        headers: { cookie: 'better-auth.session_token=browser-session' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.user).toMatchObject({ email: null, name: null, plan: 'free' })
    expect(body.features.cloudLlm).toBe(false)
  })

  it.each([
    ['an expired bearer', 'Bearer expired-session-token'],
    ['a malformed authorization scheme', 'Basic not-a-bearer-token'],
  ])('rejects %s instead of downgrading it to an anonymous bootstrap', async (_, authorization) => {
    const requestId = 'req-bootstrap-invalid-auth'
    const res = await bootstrapApp().fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0&platform=windows', {
        headers: {
          authorization,
          'x-request-id': requestId,
        },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body).toEqual({
      error: 'Authentication required',
      code: 'unauthorized',
      requestId,
    })
    expect(JSON.stringify(body)).not.toContain(authorization)
  })

  it('does not apply bootstrap optional authentication to other public routes', async () => {
    const res = await bootstrapApp().fetch(
      request('/echo-api/healthz', {
        headers: { authorization: 'Bearer expired-session-token' },
      }),
    )

    expect(res.status).toBe(200)
  })

  it('announces proxy providers to pro desktop clients without downlinking provider keys', async () => {
    const app = bootstrapApp({
      LLM_PROVIDER: 'openrouter',
      LLM_API_KEY: 'test-server-llm-key',
      LLM_MODEL: 'google/gemini-2.5-flash',
      STT_PROVIDER: 'glm-asr',
      STT_API_KEY: 'stt-live-server-key',
      DESKTOP_UPDATE_ENABLED: 'true',
      DESKTOP_AUTO_UPDATE_ENABLED: 'true',
      DESKTOP_UPDATE_LATEST_VERSION: '0.2.0',
      DESKTOP_UPDATE_DOWNLOAD_URL: 'https://example.com/EcholIKE-0.2.0.exe',
    })

    const res = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      schemaVersion: 1,
      apiBaseUrl: 'http://localhost:8787/echo-api',
      user: {
        email: 'pro@example.com',
        name: 'Pro User',
        plan: 'pro',
        adminRole: null,
        quotaLevel: 1,
        quotaMultiplier: 1,
      },
      quotas: {
        llm: {
          used: 0,
          limit: 5_000_000,
          remaining: 5_000_000,
          unit: 'tokens',
        },
        tts: {
          used: 0,
          limit: 2_000_000,
          remaining: 2_000_000,
          unit: 'chars',
        },
      },
      services: {
        llm: {
          mode: 'proxy',
          providerId: 'openrouter',
          defaultModel: 'google/gemini-2.5-flash',
          apiKey: null,
          apiKeyPreview: 'configured',
        },
        stt: {
          mode: 'proxy',
          providerId: 'glm-asr',
          defaultModel: 'glm-asr-2512',
          apiKey: null,
          apiKeyPreview: 'configured',
        },
      },
      ota: {
        enabled: true,
        autoUpdate: true,
        updateAvailable: true,
        status: 'available',
        downloadAvailable: true,
      },
      policy: {
        remoteConfigDelivery: 'startup',
        activation: 'next_start',
        backgroundPolling: false,
      },
    })
    expect(JSON.stringify(body)).not.toContain('test-server-llm-key')
    expect(JSON.stringify(body)).not.toContain('stt-live-server-key')
    expect(body.services.llm).not.toHaveProperty('baseUrl')
    expect(body.services.stt).not.toHaveProperty('endpoint')
    expect(JSON.stringify(body.ota)).not.toContain('EcholIKE-0.2.0.exe')
  })

  it('does not downlink provider keys to free desktop clients', async () => {
    const app = bootstrapApp({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
      STT_PROVIDER: 'openai-whisper',
      STT_API_KEY: 'server-stt-key',
    })

    const res = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-free-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.user).toMatchObject({
      email: 'free@example.com',
      plan: 'free',
      adminRole: null,
      quotaLevel: 1,
      quotaMultiplier: 1,
    })
    expect(body.services.llm).toMatchObject({
      mode: 'byok',
      apiKey: null,
      apiKeyPreview: null,
    })
    expect(body.services.stt).toMatchObject({
      mode: 'byok',
      apiKey: null,
      apiKeyPreview: null,
    })
  })

  it('includes scene presets filtered by the desktop user plan', async () => {
    const env = testEnv()
    const services = testServices(env)
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-free-token': freeUser,
        'valid-pro-token': proUser,
      }),
      services: {
        ...services,
        scenes: createSceneService(
          createStaticSceneStore([
            {
              id: 'scene_free',
              slug: 'meeting-notes',
              name: 'Meeting Notes',
              description: 'Clean meeting transcript',
              category: 'work',
              promptTemplate: 'Format as notes',
              dictionaryTerms: [],
              isPro: false,
            },
            {
              id: 'scene_pro',
              slug: 'contract-review',
              name: 'Contract Review',
              description: 'Careful legal review',
              category: 'legal',
              promptTemplate: 'Review carefully',
              dictionaryTerms: [],
              isPro: true,
            },
          ]),
        ),
      },
    })

    const freeRes = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-free-token' },
      }),
    )
    const proRes = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const freeBody = await freeRes.json()
    const proBody = await proRes.json()

    expect(freeRes.status).toBe(200)
    expect(proRes.status).toBe(200)
    expect(freeBody.scenes.map((scene: { slug: string }) => scene.slug)).toEqual(['meeting-notes'])
    expect(proBody.scenes.map((scene: { slug: string }) => scene.slug)).toEqual([
      'meeting-notes',
      'contract-review',
    ])
  })

  it('does not treat direct provider registry keys as multi-user desktop config', async () => {
    const env = testEnv()
    const services = testServices(env)
    await services.desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      enabled: true,
      mode: 'direct',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'server-owned-direct-key',
      defaultModel: 'google/gemini-2.5-flash',
      priority: 10,
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-pro-token': proUser,
      }),
      services,
    })

    const res = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.features.cloudLlm).toBe(false)
    expect(body.policy.allowDirectProviderKeys).toBe(false)
    expect(body.services.llm).toMatchObject({
      mode: 'byok',
      configured: false,
      providerId: null,
      apiKey: null,
      apiKeyPreview: null,
    })
    expect(JSON.stringify(body)).not.toContain('server-owned-direct-key')
  })

  it('uses the highest priority usable proxy provider instead of an unusable record', async () => {
    const env = testEnv()
    const services = testServices(env)
    await services.desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openrouter',
      displayName: 'OpenRouter Missing Key',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://openrouter.ai/api/v1',
      defaultModel: 'google/gemini-2.5-flash',
      priority: 100,
    })
    await services.desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'deepseek',
      displayName: 'DeepSeek',
      enabled: true,
      mode: 'proxy',
      apiKey: 'deepseek-live-key',
      defaultModel: 'deepseek-chat',
      priority: 10,
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-pro-token': proUser,
      }),
      services,
    })

    const res = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.features.cloudLlm).toBe(true)
    expect(body.services.llm).toMatchObject({
      mode: 'proxy',
      configured: true,
      providerId: 'deepseek',
      defaultModel: 'deepseek-chat',
      apiKey: null,
      apiKeyPreview: maskSecret('deepseek-live-key'),
    })
    expect(JSON.stringify(body)).not.toContain('deepseek-live-key')
  })

  it('announces cloud OCR proxy to pro clients without downlinking the provider key', async () => {
    const env = testEnv()
    const services = testServices(env)
    await services.desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'openai',
      displayName: 'OpenAI Vision',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'ocr-live-server-key',
      defaultModel: 'gpt-4o-mini',
      priority: 10,
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-pro-token': proUser,
      }),
      services,
    })

    const res = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0&platform=windows', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.features.cloudOcr).toBe(true)
    expect(body.services.ocr).toMatchObject({
      mode: 'proxy',
      providerId: 'openai',
      defaultModel: 'gpt-4o-mini',
      capabilities: {
        imageAvailable: true,
        pdfAvailable: true,
        acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
        maxInputBytes: 25 * 1024 * 1024,
        maxPdfPages: 20,
        processingRoutes: ['direct'],
        pdfMode: 'client-rasterized',
      },
      apiKey: null,
      apiKeyPreview: maskSecret('ocr-live-server-key'),
    })
    expect(JSON.stringify(body)).not.toContain('ocr-live-server-key')

    const negotiatedCloudRes = await app.fetch(
      request(
        '/echo-api/desktop/bootstrap?version=0.1.0&platform=windows&docContracts=ocr-document-v1',
        { headers: { authorization: 'Bearer valid-pro-token' } },
      ),
    )
    const negotiatedCloudBody = await negotiatedCloudRes.json()
    expect(negotiatedCloudBody.services.ocr.capabilities).toMatchObject({
      pdfAvailable: true,
      pdfMode: 'client-rasterized',
      processingRoutes: ['direct'],
    })
    expect(negotiatedCloudBody.services.ocr.capabilities.documentContract).toBeUndefined()

    const linuxRes = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0&platform=linux', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const linuxBody = await linuxRes.json()
    expect(linuxRes.status).toBe(200)
    expect(linuxBody.services.ocr.capabilities).toMatchObject({
      imageAvailable: true,
      pdfAvailable: false,
      acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
      maxPdfPages: 0,
      processingRoutes: ['direct'],
      pdfMode: 'unsupported',
    })
    expect(linuxBody.services.ocr.capabilities.acceptedMimeTypes).not.toContain('application/pdf')

    for (const platform of ['win32', 'windows-x86_64', 'x86_64-pc-windows-msvc']) {
      const windowsAliasRes = await app.fetch(
        request(`/echo-api/desktop/bootstrap?version=0.1.0&platform=${platform}`, {
          headers: { authorization: 'Bearer valid-pro-token' },
        }),
      )
      const windowsAliasBody = await windowsAliasRes.json()
      expect(windowsAliasRes.status).toBe(200)
      expect(windowsAliasBody.services.ocr.capabilities).toMatchObject({
        pdfAvailable: true,
        maxPdfPages: 20,
        pdfMode: 'client-rasterized',
      })
    }
  })

  it('announces local backend providers to pro clients without requiring provider keys', async () => {
    const env = testEnv()
    const services = testServices(env)
    await services.desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'ollama',
      displayName: 'Ollama Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11440',
      defaultModel: 'qwen3.5',
      priority: 10,
    })
    await services.desktopConfig.upsertProvider({
      kind: 'stt',
      providerId: 'sensevoice-local',
      displayName: 'SenseVoice Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:9001/asr',
      defaultModel: 'SenseVoiceSmall',
      priority: 10,
    })
    await services.desktopConfig.upsertProvider({
      kind: 'tts',
      providerId: 'cosyvoice2-local',
      displayName: 'CosyVoice2 Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:18771/tts',
      defaultModel: 'CosyVoice2-0.5B',
      capabilities: { requiresApiKey: false, voice: 'default' },
      priority: 10,
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-pro-token': proUser,
      }),
      services,
    })

    const res = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.features).toMatchObject({
      cloudLlm: true,
      cloudStt: true,
      cloudTts: true,
    })
    expect(body.services.llm).toMatchObject({
      mode: 'proxy',
      providerId: 'ollama',
      defaultModel: 'qwen3.5',
      apiKey: null,
      apiKeyPreview: null,
    })
    expect(body.services.stt).toMatchObject({
      mode: 'proxy',
      providerId: 'sensevoice-local',
      apiKey: null,
      apiKeyPreview: null,
    })
    expect(body.services.tts).toMatchObject({
      mode: 'proxy',
      providerId: 'cosyvoice2-local',
      defaultVoice: 'default',
      apiKey: null,
      apiKeyPreview: null,
    })
    expect(body.services.llm).not.toHaveProperty('baseUrl')
    expect(body.services.stt).not.toHaveProperty('endpoint')
    expect(body.services.tts).not.toHaveProperty('baseUrl')
  })

  it('negotiates the singular server PDF Pipeline contract without changing legacy clients', async () => {
    const env = testEnv()
    const services = testServices(env)
    await services.desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Ollama GLM OCR Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://10.0.0.8:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    let capabilityCalls = 0
    services.documentOcr = {
      async warmup() {},
      async capability() {
        capabilityCalls += 1
        return {
          available: true,
          providerAvailable: true,
          model: 'glm-ocr:latest',
          documentContract: 'ocr-document-v1',
        }
      },
      async process() {
        throw new Error('not used')
      },
      async shutdown() {},
    }
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-free-token': freeUser,
        'valid-pro-token': proUser,
      }),
      services,
    })

    const negotiated = await app.fetch(
      request(
        '/echo-api/desktop/bootstrap?version=0.2.9&platform=windows&docContracts=ocr-document-v1',
        { headers: { authorization: 'Bearer valid-pro-token' } },
      ),
    )
    const negotiatedBody = await negotiated.json()
    expect(negotiated.status).toBe(200)
    expect(negotiatedBody.services.ocr.capabilities).toMatchObject({
      imageAvailable: true,
      documentContract: 'ocr-document-v1',
      pdfAvailable: true,
      pdfMode: 'server-pipeline',
      maxPdfPages: 20,
      processingRoutes: ['direct', 'pipeline'],
    })
    expect(capabilityCalls).toBe(1)

    const legacy = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.2.9&platform=windows', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const legacyBody = await legacy.json()
    expect(legacy.status).toBe(200)
    expect(legacyBody.services.ocr.capabilities).toMatchObject({
      pdfAvailable: true,
      pdfMode: 'client-rasterized',
      processingRoutes: ['direct'],
    })
    expect(legacyBody.services.ocr.capabilities.documentContract).toBeUndefined()
    expect(capabilityCalls).toBe(2)

    for (const authorization of [undefined, 'Bearer valid-free-token']) {
      const unentitled = await app.fetch(
        request(
          '/echo-api/desktop/bootstrap?version=0.2.9&platform=windows&docContracts=ocr-document-v1',
          authorization ? { headers: { authorization } } : undefined,
        ),
      )
      const unentitledBody = await unentitled.json()
      expect(unentitled.status).toBe(200)
      expect(unentitledBody.services.ocr.capabilities).toMatchObject({
        pdfAvailable: false,
        pdfMode: 'unsupported',
        processingRoutes: ['direct'],
      })
      expect(unentitledBody.services.ocr.capabilities.documentContract).toBeUndefined()
    }
    expect(capabilityCalls).toBe(2)
  })

  it('keeps the explicit Windows client-rasterized fallback when document runtime is not ready', async () => {
    const env = testEnv()
    const services = testServices(env)
    await services.desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Ollama GLM OCR Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://10.0.0.8:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    services.documentOcr = {
      async warmup() {},
      async capability() {
        return {
          available: false,
          providerAvailable: true,
          model: 'glm-ocr:latest',
        }
      },
      async process() {
        throw new Error('not used')
      },
      async shutdown() {},
    }
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'valid-pro-token': proUser }),
      services,
    })

    const response = await app.fetch(
      request(
        '/echo-api/desktop/bootstrap?version=0.2.9&platform=windows&docContracts=ocr-document-v1',
        { headers: { authorization: 'Bearer valid-pro-token' } },
      ),
    )
    const body = await response.json()
    expect(body.services.ocr.capabilities).toMatchObject({
      pdfAvailable: true,
      pdfMode: 'client-rasterized',
      maxPdfPages: 20,
      processingRoutes: ['direct'],
    })
    expect(body.services.ocr.capabilities.documentContract).toBeUndefined()
  })

  it('does not advertise image or rasterized PDF when the local provider target is unavailable', async () => {
    const env = testEnv()
    const services = testServices(env)
    await services.desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Ollama GLM OCR Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://wsl-host.echolike.invalid:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    services.documentOcr = {
      async warmup() {},
      async capability() {
        return {
          available: false,
          providerAvailable: false,
          model: 'glm-ocr:latest',
        }
      },
      async process() {
        throw new Error('not used')
      },
      async shutdown() {},
    }
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'valid-pro-token': proUser }),
      services,
    })

    for (const suffix of ['', '&docContracts=ocr-document-v1']) {
      const response = await app.fetch(
        request(`/echo-api/desktop/bootstrap?version=0.2.29&platform=windows${suffix}`, {
          headers: { authorization: 'Bearer valid-pro-token' },
        }),
      )
      const body = await response.json()
      expect(body.features.cloudOcr).toBe(false)
      expect(body.services.ocr.capabilities).toMatchObject({
        imageAvailable: false,
        pdfAvailable: false,
        maxPdfPages: 0,
        pdfMode: 'unsupported',
        processingRoutes: ['direct'],
      })
      expect(body.services.ocr.capabilities.documentContract).toBeUndefined()
    }
  })

  it('enables proxy mode for active backend operators without downlinking provider keys', async () => {
    const env = testEnv()
    const services = testServices(env)
    await services.desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'server-owned-llm-key',
      defaultModel: 'google/gemini-2.5-flash',
      priority: 10,
    })
    await services.desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Ollama GLM OCR Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    services.documentOcr = {
      async warmup() {},
      async capability() {
        return {
          available: true,
          providerAvailable: true,
          model: 'glm-ocr:latest',
          documentContract: 'ocr-document-v1',
        }
      },
      async process() {
        throw new Error('not used')
      },
      async shutdown() {},
    }
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-backend-admin-token': backendAdminUser,
      }),
      services: {
        ...services,
        admin: createAdminService(
          createMemoryAdminStore([
            {
              userId: backendAdminUser.id,
              role: 'operator',
              status: 'active',
              createdBy: null,
              createdAt: null,
              updatedAt: null,
            },
          ]),
        ),
      },
    })

    const res = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-backend-admin-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.user).toMatchObject({
      email: 'backend-admin@example.com',
      plan: 'free',
      adminRole: 'operator',
      quotaLevel: 1,
      quotaMultiplier: 1,
    })
    expect(body.quotas.ocr).toMatchObject({
      used: 0,
      limit: 50,
      remaining: 50,
      unit: 'images',
    })
    expect(body.features).toMatchObject({
      cloudLlm: true,
      cloudOcr: true,
    })
    expect(body.policy).toMatchObject({
      preferProxy: true,
      allowDirectProviderKeys: false,
    })
    expect(body.services.llm).toMatchObject({
      mode: 'proxy',
      providerId: 'openrouter',
      apiKey: null,
      apiKeyPreview: null,
    })
    expect(body.services.ocr).toMatchObject({
      mode: 'proxy',
      providerId: 'ollama-ocr-local',
      defaultModel: 'glm-ocr:latest',
    })
    expect(JSON.stringify(body)).not.toContain('server-owned-llm-key')
  })

  it('reports configured secrets without exposing any fragment', () => {
    expect(maskSecret('a')).toBe('configured')
    expect(maskSecret('abcd')).toBe('configured')
    expect(maskSecret('test-server-llm-key')).toBe('configured')
    expect(maskSecret('')).toBeNull()
  })

  it('keeps OCR provider presets on the platform-neutral direct image contract', () => {
    for (const providerId of ['openai', 'openai-compatible', 'ollama-ocr-local']) {
      expect(providerPreset('ocr', providerId)?.capabilities).toMatchObject({
        imageAvailable: true,
        pdfAvailable: false,
        acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
        maxInputBytes: 25 * 1024 * 1024,
        maxPdfPages: 0,
        processingRoutes: ['direct'],
        pdfMode: 'unsupported',
      })
      expect(providerPreset('ocr', providerId)?.capabilities.processingRoutes).not.toContain(
        'pipeline',
      )
      expect(providerPreset('ocr', providerId)?.capabilities.acceptedMimeTypes).not.toContain(
        'application/pdf',
      )
      expect(providerPreset('ocr', providerId)?.capabilities.acceptedMimeTypes).not.toContain(
        'image/bmp',
      )
    }
  })
})
