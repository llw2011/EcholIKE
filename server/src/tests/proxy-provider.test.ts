import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { createStaticEntitlementService } from '../services/billing/entitlements.js'
import { disabledBillingSessionService } from '../services/billing/stripe.js'
import {
  createMemoryQuotaLedgerStore,
  createQuotaService,
  type QuotaKind,
  type QuotaLedgerStore,
} from '../services/quota/quota-service.js'
import { createLlmProxyService, type LlmProxyService } from '../services/proxy/llm-proxy.js'
import {
  createOcrProxyService,
  OCR_TIMEOUT_MS,
  type OcrDiagnosticSink,
  type OcrFailureDiagnostic,
  type OcrProxyService,
} from '../services/proxy/ocr-proxy.js'
import { createSttProxyService, type SttProxyService } from '../services/proxy/stt-proxy.js'
import {
  COSYVOICE2_VOICES_TIMEOUT_MS,
  createTtsProxyService,
  TTS_MAX_PROVIDER_AUDIO_BYTES,
  TTS_TIMEOUT_MS,
  type TtsProxyService,
} from '../services/proxy/tts-proxy.js'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
} from '../services/desktop/desktop-config-service.js'
import { utcPeriodKey } from '../services/quota/usage-ledger.js'
import { proUser, request, testEnv, testServices } from './helpers.js'

const PNG_BASE64 = 'iVBORw0KGgo='
const JPEG_BASE64 = '/9j/AA=='
const WEBP_BASE64 = 'UklGRgAAAABXRUJQ'
const BMP_BASE64 = 'Qk0='

describe('cloud proxy providers', () => {
  it('calls an OpenAI-compatible LLM provider with server-owned credentials', async () => {
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
    })
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/chat/completions')
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer server-llm-key',
        'content-type': 'application/json',
      })
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-test',
        stream: false,
        messages: [{ role: 'system', content: 'policy' }],
      })
      return Response.json({
        choices: [{ message: { content: 'polished text' } }],
        usage: { total_tokens: 11 },
      })
    }

    const result = await createLlmProxyService(env, fetchImpl).complete({
      messages: [{ role: 'system', content: 'policy' }],
    })

    expect(result).toEqual({ text: 'polished text', usageTokens: 11 })
  })

  it('calls a Whisper-compatible STT provider with server-owned credentials', async () => {
    const env = testEnv({
      STT_PROVIDER: 'openai-whisper',
      STT_API_KEY: 'server-stt-key',
    })
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/audio/transcriptions')
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer server-stt-key',
      })
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect(form.get('model')).toBe('whisper-1')
      expect(form.get('language')).toBe('en')
      expect(form.get('file')).toBeInstanceOf(Blob)
      return Response.json({ text: 'hello world' })
    }

    const result = await createSttProxyService(env, fetchImpl).transcribe({
      audio: new Blob(['audio']),
      language: 'en',
      estimatedSeconds: 1,
    })

    expect(result).toEqual({ text: 'hello world', durationSeconds: 1 })
  })

  it('calls an OpenAI-compatible TTS provider with server-owned credentials', async () => {
    const env = testEnv({
      TTS_PROVIDER: 'openai',
      TTS_API_KEY: 'server-tts-key',
      TTS_MODEL: 'gpt-4o-mini-tts',
      TTS_VOICE: 'alloy',
    })
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/audio/speech')
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer server-tts-key',
        'content-type': 'application/json',
      })
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-4o-mini-tts',
        input: 'hello',
        voice: 'alloy',
        response_format: 'mp3',
      })
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg' },
      })
    }

    const result = await createTtsProxyService(env, fetchImpl).synthesize({
      text: 'hello',
      voice: null,
      format: null,
      speed: null,
    })

    expect(result.contentType).toBe('audio/mpeg')
    expect(result.usageChars).toBe(5)
    expect(result.audio.byteLength).toBe(3)
  })

  it('allows enough provider time for generated TTS audio', () => {
    expect(TTS_TIMEOUT_MS).toBe(120_000)
  })

  it('keeps the TTS deadline active after headers while the provider body stalls', async () => {
    vi.useFakeTimers()
    try {
      const env = testEnv({
        TTS_PROVIDER: 'openai',
        TTS_API_KEY: 'server-tts-key',
        TTS_MODEL: 'gpt-4o-mini-tts',
      })
      let providerSignal: AbortSignal | null = null
      const service = createTtsProxyService(env, async (_input, init) => {
        providerSignal = init?.signal ?? null
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => undefined)
            },
          }),
        )
      })
      const assertion = expect(
        service.synthesize({ text: 'hello', voice: null, format: null, speed: null }),
      ).rejects.toMatchObject({
        status: 504,
        code: 'tts_timeout',
        message: 'Cloud TTS timed out',
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(TTS_TIMEOUT_MS)
      await assertion
      expect(providerSignal).not.toBeNull()
      expect((providerSignal as unknown as AbortSignal).aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects declared oversized TTS audio before buffering the provider body', async () => {
    const env = testEnv({
      TTS_PROVIDER: 'openai',
      TTS_API_KEY: 'server-tts-key',
      TTS_MODEL: 'gpt-4o-mini-tts',
    })
    let cancelled = false
    const service = createTtsProxyService(
      env,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => undefined)
            },
            cancel() {
              cancelled = true
            },
          }),
          {
            headers: {
              'content-length': String(TTS_MAX_PROVIDER_AUDIO_BYTES + 1),
            },
          },
        ),
    )

    await expect(
      service.synthesize({ text: 'hello', voice: null, format: null, speed: null }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'tts_failed',
      message: 'Cloud TTS provider response is too large',
    })
    expect(cancelled).toBe(true)
  })

  it('cancels a chatty TTS provider after its streamed audio crosses the size limit', async () => {
    const env = testEnv({
      TTS_PROVIDER: 'openai',
      TTS_API_KEY: 'server-tts-key',
      TTS_MODEL: 'gpt-4o-mini-tts',
    })
    const chunk = new Uint8Array(1024 * 1024)
    let cancelled = false
    const service = createTtsProxyService(
      env,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk)
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )

    await expect(
      service.synthesize({ text: 'hello', voice: null, format: null, speed: null }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'tts_failed',
      message: 'Cloud TTS provider response is too large',
    })
    expect(cancelled).toBe(true)
  })

  it('uses stable invalid-key codes without exposing provider responses', async () => {
    const secret = 'sk-fake-provider-token'
    const providerError: typeof fetch = async () =>
      Response.json({ error: `invalid token ${secret}` }, { status: 401 })
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
      STT_PROVIDER: 'openai-whisper',
      STT_API_KEY: 'server-stt-key',
      TTS_PROVIDER: 'openai',
      TTS_API_KEY: 'server-tts-key',
      TTS_MODEL: 'gpt-4o-mini-tts',
    })
    const ocr = await openAiOcrProxy(providerError)

    await expect(
      createLlmProxyService(env, providerError).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'llm_invalid_key',
      message: 'Cloud LLM provider credentials are invalid',
    })
    await expect(
      createSttProxyService(env, providerError).transcribe({
        audio: new Blob(['audio']),
        language: null,
        estimatedSeconds: 1,
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'stt_invalid_key',
      message: 'Cloud STT provider credentials are invalid',
    })
    await expect(
      createTtsProxyService(env, providerError).synthesize({
        text: 'hello',
        voice: null,
        format: null,
        speed: null,
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'tts_invalid_key',
      message: 'Cloud TTS provider credentials are invalid',
    })
    await expect(
      ocr.read({ imageBase64: PNG_BASE64, imageMimeType: 'image/png' }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'ocr_invalid_key',
      message: 'Cloud OCR provider credentials are invalid',
    })
  })

  it('uses the stable LLM timeout code', async () => {
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
    })
    const fetchImpl: typeof fetch = async () => {
      throw new DOMException('The request was aborted', 'AbortError')
    }

    await expect(
      createLlmProxyService(env, fetchImpl).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({
      status: 504,
      code: 'llm_timeout',
      message: 'Cloud LLM timed out',
    })
  })

  it('keeps the LLM deadline active while an accepted response body is stalled', async () => {
    vi.useFakeTimers()
    try {
      let bodyAborted = false
      const env = testEnv({
        LLM_PROVIDER: 'openai',
        LLM_API_KEY: 'server-llm-key',
        LLM_MODEL: 'gpt-test',
      })
      const fetchImpl: typeof fetch = async (_input, init) => {
        const signal = init?.signal
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                'abort',
                () => {
                  bodyAborted = true
                  controller.error(new DOMException('The request was aborted', 'AbortError'))
                },
                { once: true },
              )
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      const completion = createLlmProxyService(env, fetchImpl).complete({
        messages: [{ role: 'user', content: 'hello' }],
      })
      const rejection = expect(completion).rejects.toMatchObject({
        status: 504,
        code: 'llm_timeout',
      })
      await vi.advanceTimersByTimeAsync(60_001)

      await rejection
      expect(bodyAborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an oversized LLM body without relying on content-length', async () => {
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
    })
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024))
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )

    await expect(
      createLlmProxyService(env, fetchImpl).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'llm_failed',
      message: 'Cloud LLM response is too large',
    })
  })

  it('rejects an OpenAI stream whose terminal event has no generated text', async () => {
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
    })
    const result = await createLlmProxyService(
      env,
      async () =>
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
    ).stream({ messages: [{ role: 'user', content: 'hello' }] })
    const responseBody = result.response.text()

    await expect(result.completed).rejects.toMatchObject({
      status: 502,
      code: 'llm_failed',
      message: 'Cloud LLM returned an empty response',
    })
    await responseBody
  })

  it('does not expose non-auth LLM or OCR provider error bodies', async () => {
    const secret = 'sk-fake-provider-token'
    const diagnostics: OcrFailureDiagnostic[] = []
    const providerError: typeof fetch = async () =>
      new Response(`<html>provider failed with ${secret}</html>`, { status: 503 })
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
    })
    const ocr = await openAiOcrProxy(providerError, (diagnostic) => diagnostics.push(diagnostic))

    await expect(
      createLlmProxyService(env, providerError).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'llm_failed',
      message: 'Cloud LLM provider request failed',
    })
    await expect(
      ocr.read({
        imageBase64: PNG_BASE64,
        imageMimeType: 'image/png',
        requestId: 'req-ocr-upstream-status',
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'ocr_failed',
      message: 'Cloud OCR provider request failed',
    })
    expect(diagnostics).toEqual([
      expect.objectContaining({
        event: 'ocr_provider_failure',
        requestId: 'req-ocr-upstream-status',
        provider: 'openai',
        protocol: 'openai',
        model: 'gpt-4o-mini',
        endpointHost: 'registry.example',
        failureStage: 'upstream_status',
        errorStatus: 502,
        errorCode: 'ocr_failed',
        upstreamStatus: 503,
        causeCode: null,
        terminalReason: null,
        attemptCount: 1,
        retryCount: 0,
      }),
    ])
    expect(JSON.stringify(diagnostics)).not.toContain(secret)
    expect(JSON.stringify(diagnostics)).not.toContain('/chat/completions')
  })

  it('records an allowlisted OCR network cause without logging raw error details', async () => {
    const secret = 'private-network-detail'
    const diagnostics: OcrFailureDiagnostic[] = []
    const cause = Object.assign(new Error(`connect failed: ${secret}`), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    })
    const networkError = Object.assign(new TypeError(`fetch failed: ${secret}`), { cause })
    const service = await openAiOcrProxy(
      async () => {
        throw networkError
      },
      (diagnostic) => diagnostics.push(diagnostic),
    )

    await expect(
      service.read({
        imageBase64: PNG_BASE64,
        imageMimeType: 'image/png',
        requestId: 'req-ocr-connect-timeout',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'ocr_failed' })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        requestId: 'req-ocr-connect-timeout',
        failureStage: 'connect',
        upstreamStatus: null,
        causeCode: 'UND_ERR_CONNECT_TIMEOUT',
        errorStatus: 502,
        errorCode: 'ocr_failed',
        attemptCount: 1,
        retryCount: 0,
      }),
    ])
    expect(JSON.stringify(diagnostics)).not.toContain(secret)
  })

  it('returns a stable TTS gateway error without leaking the provider body', async () => {
    const secret = 'sk-fake-provider-token'
    const env = testEnv({
      TTS_PROVIDER: 'openai',
      TTS_API_KEY: 'server-tts-key',
      TTS_MODEL: 'gpt-4o-mini-tts',
    })
    const tts = createTtsProxyService(
      env,
      async () => new Response(`<html>upstream failed: ${secret}</html>`, { status: 429 }),
    )
    const app = testProxyApp({ ledger: createMemoryQuotaLedgerStore(), tts })

    const res = await app.fetch(
      request('/echo-api/proxy/tts', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
          'x-request-id': 'req-tts-provider-failure',
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body).toEqual({
      error: 'Cloud TTS provider request failed',
      code: 'tts_failed',
      requestId: 'req-tts-provider-failure',
    })
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(JSON.stringify(body)).not.toContain('<html>')
  })

  it('calls a local SenseVoice STT provider without requiring a server API key', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'stt',
      providerId: 'sensevoice-local',
      displayName: 'SenseVoice Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:9001/asr',
      defaultModel: 'SenseVoiceSmall',
      priority: 10,
    })
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('http://127.0.0.1:9001/asr')
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect(form.get('model')).toBeNull()
      expect(form.get('language')).toBe('auto')
      expect(form.get('file')).toBeInstanceOf(Blob)
      return Response.json({ text: 'local transcript' })
    }

    const result = await createSttProxyService(env, fetchImpl, desktopConfig).transcribe({
      audio: new Blob(['audio']),
      language: 'multi',
      estimatedSeconds: 2,
    })

    expect(result).toEqual({ text: 'local transcript', durationSeconds: 2 })
  })

  it('calls a local CosyVoice2 TTS provider with the local JSON shape', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'tts',
      providerId: 'cosyvoice2-local',
      displayName: 'CosyVoice2 Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:18771/tts',
      defaultModel: 'CosyVoice2-0.5B',
      capabilities: { requiresApiKey: false, voice: 'longxiaochun' },
      priority: 10,
    })
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input) === 'http://127.0.0.1:18771/voices') {
        expect(new Headers(init?.headers).get('authorization')).toBeNull()
        return Response.json({ voices: { default: {}, longxiaochun: {} } })
      }

      expect(String(input)).toBe('http://127.0.0.1:18771/tts')
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      expect(JSON.parse(String(init?.body))).toEqual({
        text: '你好',
        voice: 'longxiaochun',
        format: 'wav',
        speed: 1.1,
      })
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/wav' },
      })
    }

    const result = await createTtsProxyService(env, fetchImpl, desktopConfig).synthesize({
      text: '你好',
      voice: null,
      format: null,
      speed: 1.1,
    })

    expect(result.contentType).toBe('audio/wav')
    expect(result.audio.byteLength).toBe(3)
  })

  it('falls back to the default local CosyVoice2 voice when registry voice is unavailable', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'tts',
      providerId: 'cosyvoice2-local',
      displayName: 'CosyVoice2 Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:18771/tts',
      defaultModel: 'CosyVoice2-0.5B',
      capabilities: { requiresApiKey: false, voice: 'longxiaochun' },
      priority: 10,
    })

    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input) === 'http://127.0.0.1:18771/voices') {
        return Response.json({ voices: { default: {}, official_happy_zh: {} } })
      }

      expect(String(input)).toBe('http://127.0.0.1:18771/tts')
      expect(JSON.parse(String(init?.body))).toEqual({
        text: '你好',
        voice: 'default',
        format: 'wav',
      })
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/wav' },
      })
    }

    const result = await createTtsProxyService(env, fetchImpl, desktopConfig).synthesize({
      text: '你好',
      voice: null,
      format: null,
      speed: null,
    })

    expect(result.contentType).toBe('audio/wav')
    expect(result.audio.byteLength).toBe(3)
  })

  it('falls back to the requested CosyVoice2 voice when the voices body stalls', async () => {
    vi.useFakeTimers()
    try {
      const env = testEnv()
      const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
      await desktopConfig.upsertProvider({
        kind: 'tts',
        providerId: 'cosyvoice2-local',
        displayName: 'CosyVoice2 Local',
        enabled: true,
        mode: 'proxy',
        endpoint: 'http://127.0.0.1:18771/tts',
        defaultModel: 'CosyVoice2-0.5B',
        capabilities: { requiresApiKey: false, voice: 'longxiaochun' },
        priority: 10,
      })
      let voicesSignal: AbortSignal | null = null
      let voicesCancelled = false
      const fetchImpl: typeof fetch = async (input, init) => {
        if (String(input) === 'http://127.0.0.1:18771/voices') {
          voicesSignal = init?.signal ?? null
          return new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                return new Promise(() => undefined)
              },
              cancel() {
                voicesCancelled = true
              },
            }),
          )
        }

        expect(JSON.parse(String(init?.body))).toMatchObject({ voice: 'longxiaochun' })
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'audio/wav' },
        })
      }
      const promise = createTtsProxyService(env, fetchImpl, desktopConfig).synthesize({
        text: '你好',
        voice: null,
        format: null,
        speed: null,
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(COSYVOICE2_VOICES_TIMEOUT_MS)
      const result = await promise

      expect(result.audio.byteLength).toBe(3)
      expect(voicesSignal).not.toBeNull()
      expect((voicesSignal as unknown as AbortSignal).aborted).toBe(true)
      expect(voicesCancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caches a CosyVoice2 voice registry probe across chunk synthesis calls', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'tts',
      providerId: 'cosyvoice2-local',
      displayName: 'CosyVoice2 Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:18771/tts',
      defaultModel: 'CosyVoice2-0.5B',
      capabilities: { requiresApiKey: false, voice: 'longxiaochun' },
      priority: 10,
    })
    let voicesCalls = 0
    let ttsCalls = 0
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === 'http://127.0.0.1:18771/voices') {
        voicesCalls += 1
        return Response.json({ voices: { default: {}, longxiaochun: {} } })
      }
      ttsCalls += 1
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/wav' },
      })
    }
    const service = createTtsProxyService(env, fetchImpl, desktopConfig)

    await service.synthesize({ text: '第一段', voice: null, format: null, speed: null })
    await service.synthesize({ text: '第二段', voice: null, format: null, speed: null })

    expect(voicesCalls).toBe(1)
    expect(ttsCalls).toBe(2)
  })

  it('falls back when a CosyVoice2 voices response exceeds its bounded reader', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'tts',
      providerId: 'cosyvoice2-local',
      displayName: 'CosyVoice2 Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:18771/tts',
      defaultModel: 'CosyVoice2-0.5B',
      capabilities: { requiresApiKey: false, voice: 'longxiaochun' },
      priority: 10,
    })
    const chunk = new Uint8Array(32 * 1024)
    let voicesCancelled = false
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input) === 'http://127.0.0.1:18771/voices') {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk)
            },
            cancel() {
              voicesCancelled = true
            },
          }),
        )
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({ voice: 'longxiaochun' })
      return new Response(new Uint8Array([1, 2, 3]))
    }

    const result = await createTtsProxyService(env, fetchImpl, desktopConfig).synthesize({
      text: '你好',
      voice: null,
      format: null,
      speed: null,
    })

    expect(result.audio.byteLength).toBe(3)
    expect(voicesCancelled).toBe(true)
  })

  it('calls an OpenAI-compatible OCR provider with server-owned credentials', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'openai',
      displayName: 'OpenAI Vision',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://registry.example/v1',
      apiKey: 'registry-ocr-key',
      defaultModel: 'gpt-4o-mini',
      priority: 10,
    })
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://registry.example/v1/chat/completions')
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer registry-ocr-key',
        'content-type': 'application/json',
      })
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('gpt-4o-mini')
      expect(JSON.stringify(body)).toContain('data:image/png;base64,aGVsbG8=')
      expect(JSON.stringify(body)).not.toContain('providerApiKey')
      return Response.json({
        choices: [{ message: { content: '{"text":"# OCR\\n正文"}' }, finish_reason: 'stop' }],
        usage: { total_tokens: 17 },
      })
    }

    const result = await createOcrProxyService(env, fetchImpl, desktopConfig).read({
      imageBase64: 'aGVsbG8=',
      imageMimeType: 'image/png',
    })

    expect(result).toEqual({
      text: '# OCR\n正文',
      model: 'gpt-4o-mini',
      usageTokens: 17,
      route: 'direct',
      processingReason: 'cloud-provider-direct',
      warnings: [],
      degraded: false,
      pageCount: 1,
    })
  })

  it('calls a local Ollama OCR provider without exposing model ports to the client', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Ollama GLM OCR Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('http://127.0.0.1:11434/api/generate')
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('glm-ocr:latest')
      expect(body.prompt).toBe('Text Recognition:')
      expect(body.images).toEqual(['aGVsbG8='])
      expect(body.stream).toBe(false)
      expect(body.options).toEqual({
        num_ctx: 16_384,
        num_predict: 8192,
        temperature: 0,
      })
      return Response.json({
        response: '```markdown\n# OCR\n正文\n```',
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 3,
        eval_count: 5,
      })
    }

    const result = await createOcrProxyService(env, fetchImpl, desktopConfig).read({
      imageBase64: 'aGVsbG8=',
      imageMimeType: 'image/png',
    })

    expect(result).toEqual({
      text: '# OCR\n正文',
      model: 'glm-ocr:latest',
      usageTokens: 8,
      route: 'direct',
      processingReason: 'cloud-provider-direct',
      warnings: [],
      degraded: false,
      pageCount: 1,
    })
  })

  it('retries one local Ollama 500 response inside the same OCR request', async () => {
    let calls = 0
    let firstBodyCancelled = false
    const serializedBodies: string[] = []
    const diagnostics: OcrFailureDiagnostic[] = []
    const service = await ollamaOcrProxy(
      async (_input, init) => {
        calls += 1
        serializedBodies.push(String(init?.body))
        if (calls === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                firstBodyCancelled = true
              },
            }),
            { status: 500 },
          )
        }
        return Response.json({
          response: '# OCR\n正文',
          done: true,
          done_reason: 'stop',
        })
      },
      (diagnostic) => diagnostics.push(diagnostic),
    )

    const result = await service.read({
      imageBase64: PNG_BASE64,
      imageMimeType: 'image/png',
      requestId: 'req-ollama-retry-success',
    })

    expect(result.text).toBe('# OCR\n正文')
    expect(calls).toBe(2)
    expect(serializedBodies[1]).toBe(serializedBodies[0])
    expect(firstBodyCancelled).toBe(true)
    expect(diagnostics).toEqual([])
  })

  it('starts the local Ollama retry after requesting response cleanup without waiting on it', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    let markFirstBodyClosing: () => void = () => undefined
    const firstBodyClosing = new Promise<void>((resolve) => {
      markFirstBodyClosing = resolve
    })
    try {
      let calls = 0
      const service = await ollamaOcrProxy(async () => {
        calls += 1
        if (calls === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                markFirstBodyClosing()
                return new Promise<void>(() => undefined)
              },
            }),
            { status: 500 },
          )
        }
        return Response.json({
          response: '# OCR\n正文',
          done: true,
          done_reason: 'stop',
        })
      })
      const result = service.read({
        imageBase64: PNG_BASE64,
        imageMimeType: 'image/png',
        signal: caller.signal,
      })

      await firstBodyClosing
      expect(calls).toBe(1)

      await vi.advanceTimersByTimeAsync(250)
      await expect(result).resolves.toMatchObject({ text: '# OCR\n正文' })
      expect(calls).toBe(2)
    } finally {
      caller.abort()
      vi.useRealTimers()
    }
  })

  it('stops after one local Ollama retry and records the final safe attempt metadata', async () => {
    const secret = 'private-ollama-error-body'
    let calls = 0
    const diagnostics: OcrFailureDiagnostic[] = []
    const service = await ollamaOcrProxy(
      async () => {
        calls += 1
        return Response.json({ error: secret }, { status: 500 })
      },
      (diagnostic) => diagnostics.push(diagnostic),
    )

    await expect(
      service.read({
        imageBase64: PNG_BASE64,
        imageMimeType: 'image/png',
        requestId: 'req-ollama-retry-failed',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'ocr_failed' })

    expect(calls).toBe(2)
    expect(diagnostics).toEqual([
      expect.objectContaining({
        requestId: 'req-ollama-retry-failed',
        failureStage: 'upstream_status',
        upstreamStatus: 500,
        attemptCount: 2,
        retryCount: 1,
      }),
    ])
    expect(JSON.stringify(diagnostics)).not.toContain(secret)
  })

  it('does not count a retry when local Ollama OCR is cancelled during retry backoff', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    try {
      const diagnostics: OcrFailureDiagnostic[] = []
      let calls = 0
      let markFirstBodyCancelled: () => void = () => undefined
      const firstBodyCancelled = new Promise<void>((resolve) => {
        markFirstBodyCancelled = resolve
      })
      const service = await ollamaOcrProxy(
        async () => {
          calls += 1
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                markFirstBodyCancelled()
              },
            }),
            { status: 500 },
          )
        },
        (diagnostic) => diagnostics.push(diagnostic),
      )
      const assertion = expect(
        service.read({
          imageBase64: PNG_BASE64,
          imageMimeType: 'image/png',
          requestId: 'req-ollama-retry-cancelled',
          signal: caller.signal,
        }),
      ).rejects.toMatchObject({ status: 499, code: 'ocr_failed' })

      await firstBodyCancelled
      await vi.advanceTimersByTimeAsync(0)
      caller.abort()
      await assertion

      expect(calls).toBe(1)
      expect(diagnostics).toEqual([
        expect.objectContaining({
          requestId: 'req-ollama-retry-cancelled',
          failureStage: 'cancelled',
          attemptCount: 1,
          retryCount: 0,
        }),
      ])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      caller.abort()
      vi.useRealTimers()
    }
  })

  it('shares one OCR deadline across both local Ollama attempts', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    try {
      const diagnostics: OcrFailureDiagnostic[] = []
      const providerSignals: AbortSignal[] = []
      let calls = 0
      const service = await ollamaOcrProxy(
        async (_input, init) => {
          calls += 1
          if (init?.signal) providerSignals.push(init.signal)
          if (calls === 1) {
            await new Promise((resolve) => setTimeout(resolve, OCR_TIMEOUT_MS - 500))
            return Response.json({ error: 'transient' }, { status: 500 })
          }
          return new Promise<Response>(() => undefined)
        },
        (diagnostic) => diagnostics.push(diagnostic),
      )
      const observed = service
        .read({
          imageBase64: PNG_BASE64,
          imageMimeType: 'image/png',
          requestId: 'req-ollama-shared-deadline',
          signal: caller.signal,
        })
        .then(
          () => ({ error: null as unknown }),
          (error: unknown) => ({ error }),
        )
      let settled = false
      void observed.then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS - 500)
      await vi.advanceTimersByTimeAsync(250)
      expect(calls).toBe(2)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(250)
      expect(settled).toBe(true)
      await expect(observed).resolves.toMatchObject({
        error: expect.objectContaining({ status: 504, code: 'ocr_timeout' }),
      })
      expect(providerSignals).toHaveLength(2)
      expect(providerSignals[1]).toBe(providerSignals[0])
      expect(providerSignals[0]?.aborted).toBe(true)
      expect(diagnostics).toEqual([
        expect.objectContaining({
          requestId: 'req-ollama-shared-deadline',
          failureStage: 'deadline',
          attemptCount: 2,
          retryCount: 1,
        }),
      ])
    } finally {
      caller.abort()
      vi.useRealTimers()
    }
  })

  it('keeps the detailed OCR instruction for generic Ollama vision models', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Ollama Vision Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      defaultModel: 'qwen2.5vl:latest',
      priority: 10,
    })
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('qwen2.5vl:latest')
      expect(body.prompt).toContain('完整读取')
      expect(body.prompt).toContain('return clean Markdown')
      expect(body.prompt).not.toBe('Text Recognition:')
      expect(body.options).toEqual({ num_predict: 8192, temperature: 0 })
      return Response.json({ response: '# OCR\n正文', done: true, done_reason: 'stop' })
    }

    const result = await createOcrProxyService(env, fetchImpl, desktopConfig).read({
      imageBase64: 'aGVsbG8=',
      imageMimeType: 'image/png',
    })

    expect(result.text).toBe('# OCR\n正文')
  })

  it.each([
    ['length', 'truncated'],
    ['content_filter', 'content filter'],
  ])(
    'rejects OpenAI OCR finish_reason=%s instead of returning partial text',
    async (reason, message) => {
      const service = await openAiOcrProxy(async () =>
        Response.json({
          choices: [{ message: { content: 'partial text' }, finish_reason: reason }],
        }),
      )

      await expect(
        service.read({ imageBase64: PNG_BASE64, imageMimeType: 'image/png' }),
      ).rejects.toMatchObject({
        status: 502,
        code: 'ocr_failed',
        message: expect.stringContaining(message),
      })
    },
  )

  it('rejects non-terminal Ollama OCR responses instead of returning partial text', async () => {
    const service = await ollamaOcrProxy(async () =>
      Response.json({ response: 'partial text', done: true, done_reason: 'length' }),
    )

    await expect(
      service.read({ imageBase64: PNG_BASE64, imageMimeType: 'image/png' }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'ocr_failed',
      message: expect.stringContaining('truncated'),
    })
  })

  it('does not expose an unrecognized provider terminal reason in errors or diagnostics', async () => {
    const secret = 'test-provider-secret'
    const diagnostics: OcrFailureDiagnostic[] = []
    const service = await ollamaOcrProxy(
      async () =>
        Response.json({
          response: 'partial text',
          done: true,
          done_reason: secret,
        }),
      (diagnostic) => diagnostics.push(diagnostic),
    )

    const failure = service.read({
      imageBase64: PNG_BASE64,
      imageMimeType: 'image/png',
      requestId: 'req-ocr-terminal-reason',
    })
    await expect(failure).rejects.toMatchObject({
      status: 502,
      code: 'ocr_failed',
      message: expect.stringContaining('done_reason=unrecognized'),
    })
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining(secret) })
    expect(diagnostics).toEqual([
      expect.objectContaining({
        requestId: 'req-ocr-terminal-reason',
        failureStage: 'completion',
        terminalReason: 'unrecognized',
      }),
    ])
    expect(JSON.stringify(diagnostics)).not.toContain(secret)
  })

  it('preserves an empty rendered document page as an explicit degraded result', async () => {
    const service = await openAiOcrProxy(async () =>
      Response.json({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      }),
    )

    const result = await service.read({
      imageBase64: PNG_BASE64,
      imageMimeType: 'image/png',
      documentPage: true,
    })

    expect(result).toMatchObject({
      text: '',
      route: 'direct',
      processingReason: 'cloud-provider-direct',
      degraded: true,
      pageCount: 1,
    })
    expect(result.warnings).toEqual([expect.stringContaining('空白页')])
  })

  it('rejects an OpenAI document page whose response omits text content', async () => {
    const service = await openAiOcrProxy(async () =>
      Response.json({ choices: [{ message: {}, finish_reason: 'stop' }] }),
    )

    await expect(
      service.read({
        imageBase64: PNG_BASE64,
        imageMimeType: 'image/png',
        documentPage: true,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'ocr_failed' })
  })

  it('rejects an Ollama document page whose response omits text content', async () => {
    const service = await ollamaOcrProxy(async () =>
      Response.json({ done: true, done_reason: 'stop' }),
    )

    await expect(
      service.read({
        imageBase64: PNG_BASE64,
        imageMimeType: 'image/png',
        documentPage: true,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'ocr_failed' })
  })

  it('still rejects empty OCR output for screenshots and ordinary images', async () => {
    const service = await openAiOcrProxy(async () =>
      Response.json({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      }),
    )

    await expect(
      service.read({ imageBase64: PNG_BASE64, imageMimeType: 'image/png' }),
    ).rejects.toMatchObject({ code: 'ocr_failed' })
  })

  it('rejects an oversized successful provider body before buffering it', async () => {
    const service = await openAiOcrProxy(
      async () =>
        new Response(null, {
          headers: { 'content-length': String(64 * 1024 * 1024) },
        }),
    )

    await expect(
      service.read({ imageBase64: PNG_BASE64, imageMimeType: 'image/png' }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'ocr_failed',
      message: expect.stringContaining('too large'),
    })
  })

  it('cancels a provider error body without waiting for or exposing it', async () => {
    let cancelled = false
    const service = await openAiOcrProxy(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => undefined)
            },
            cancel() {
              cancelled = true
            },
          }),
          {
            status: 503,
          },
        ),
    )

    await expect(
      service.read({ imageBase64: PNG_BASE64, imageMimeType: 'image/png' }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'ocr_failed',
      message: 'Cloud OCR provider request failed',
    })
    expect(cancelled).toBe(true)
  })

  it('keeps the OCR deadline active while reading a slow successful provider body', async () => {
    vi.useFakeTimers()
    try {
      const diagnostics: OcrFailureDiagnostic[] = []
      const service = await openAiOcrProxy(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                return new Promise(() => undefined)
              },
            }),
            { status: 200 },
          ),
        (diagnostic) => diagnostics.push(diagnostic),
      )
      const assertion = expect(
        service.read({
          imageBase64: PNG_BASE64,
          imageMimeType: 'image/png',
          requestId: 'req-ocr-deadline',
        }),
      ).rejects.toMatchObject({ status: 504, code: 'ocr_timeout' })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS)
      await assertion
      expect(diagnostics).toEqual([
        expect.objectContaining({
          requestId: 'req-ocr-deadline',
          failureStage: 'deadline',
          upstreamStatus: 200,
          errorStatus: 504,
          errorCode: 'ocr_timeout',
        }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('links caller cancellation to the provider fetch and body reader', async () => {
    const caller = new AbortController()
    const diagnostics: OcrFailureDiagnostic[] = []
    let providerSignal: AbortSignal | null = null
    let markProviderStarted: () => void = () => undefined
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve
    })
    const service = await openAiOcrProxy(
      async (_input, init) => {
        providerSignal = init?.signal ?? null
        markProviderStarted()
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => undefined)
            },
          }),
        )
      },
      (diagnostic) => diagnostics.push(diagnostic),
    )
    const assertion = expect(
      service.read({
        imageBase64: PNG_BASE64,
        imageMimeType: 'image/png',
        requestId: 'req-ocr-cancelled',
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ status: 499, code: 'ocr_failed' })

    await providerStarted
    caller.abort()
    await assertion
    expect(providerSignal).not.toBeNull()
    expect((providerSignal as unknown as AbortSignal).aborted).toBe(true)
    expect(diagnostics).toEqual([
      expect.objectContaining({
        requestId: 'req-ocr-cancelled',
        failureStage: 'cancelled',
        errorStatus: 499,
        errorCode: 'ocr_failed',
      }),
    ])
  })

  it('falls back to Ollama native chat for a local no-key LLM provider', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'ollama',
      displayName: 'Ollama Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11440',
      defaultModel: 'qwen3.5',
      priority: 10,
    })
    const seen: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(String(input))
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('qwen3.5')
      if (String(input).endsWith('/v1/chat/completions')) {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      expect(String(input)).toBe('http://127.0.0.1:11440/api/chat')
      expect(body.options.num_predict).toBeGreaterThan(0)
      return Response.json({
        message: { role: 'assistant', content: 'local answer' },
        prompt_eval_count: 2,
        eval_count: 4,
      })
    }

    const result = await createLlmProxyService(env, fetchImpl, desktopConfig).complete({
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(seen).toEqual([
      'http://127.0.0.1:11440/v1/chat/completions',
      'http://127.0.0.1:11440/api/chat',
    ])
    expect(result).toEqual({ text: 'local answer', usageTokens: 6 })
  })

  it('rejects an Ollama stream that reaches EOF without done=true', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'ollama',
      displayName: 'Ollama Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11440',
      defaultModel: 'qwen3.5',
      priority: 10,
    })
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/v1/chat/completions')) {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      return new Response(
        `${JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false })}\n`,
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      )
    }
    const result = await createLlmProxyService(env, fetchImpl, desktopConfig).stream({
      messages: [{ role: 'user', content: 'hello' }],
    })
    const responseBody = result.response.text()

    await expect(result.completed).rejects.toMatchObject({
      status: 502,
      code: 'llm_failed',
      message: 'Cloud LLM stream ended before completion',
    })
    await expect(responseBody).resolves.toContain('partial')
  })

  it('rejects an Ollama done=true stream with no generated text', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'ollama',
      displayName: 'Ollama Local',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11440',
      defaultModel: 'qwen3.5',
      priority: 10,
    })
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/v1/chat/completions')) {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      return new Response(`${JSON.stringify({ done: true, done_reason: 'stop' })}\n`, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }
    const result = await createLlmProxyService(env, fetchImpl, desktopConfig).stream({
      messages: [{ role: 'user', content: 'hello' }],
    })
    const responseBody = result.response.text()

    await expect(result.completed).rejects.toMatchObject({
      status: 502,
      code: 'llm_failed',
      message: 'Cloud LLM returned an empty response',
    })
    await responseBody
  })

  it('resolves LLM and STT provider settings from the backend registry before env fallback', async () => {
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'env-llm-key',
      LLM_MODEL: 'env-model',
      STT_PROVIDER: 'openai-whisper',
      STT_API_KEY: 'env-stt-key',
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://registry.example/v1',
      apiKey: 'registry-llm-key',
      defaultModel: 'registry-llm-model',
      priority: 10,
    })
    await desktopConfig.upsertProvider({
      kind: 'stt',
      providerId: 'glm-asr',
      displayName: 'GLM ASR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://registry.example/audio/transcriptions',
      apiKey: 'registry-stt-key',
      defaultModel: 'registry-stt-model',
      priority: 10,
    })

    const llmFetch: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://registry.example/v1/chat/completions')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer registry-llm-key' })
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'registry-llm-model',
      })
      return Response.json({ choices: [{ message: { content: 'registry llm' } }] })
    }
    const sttFetch: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://registry.example/audio/transcriptions')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer registry-stt-key' })
      expect((init?.body as FormData).get('model')).toBe('registry-stt-model')
      return Response.json({ text: 'registry stt' })
    }

    await expect(
      createLlmProxyService(env, llmFetch, desktopConfig).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).resolves.toMatchObject({ text: 'registry llm' })
    await expect(
      createSttProxyService(env, sttFetch, desktopConfig).transcribe({
        audio: new Blob(['audio']),
        language: null,
        estimatedSeconds: 1,
      }),
    ).resolves.toMatchObject({ text: 'registry stt' })
  })

  it('falls back to env proxy config when stored provider records are not backend-usable', async () => {
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'env-llm-key',
      LLM_MODEL: 'env-model',
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openrouter',
      displayName: 'Direct OpenRouter',
      enabled: true,
      mode: 'direct',
      endpoint: 'https://registry.example/v1',
      apiKey: 'registry-direct-key',
      defaultModel: 'registry-model',
      priority: 100,
    })
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'deepseek',
      displayName: 'Missing Key DeepSeek',
      enabled: true,
      mode: 'proxy',
      defaultModel: 'deepseek-chat',
      priority: 90,
    })
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/chat/completions')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer env-llm-key' })
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'env-model',
      })
      return Response.json({ choices: [{ message: { content: 'env llm' } }] })
    }

    await expect(
      createLlmProxyService(env, fetchImpl, desktopConfig).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).resolves.toMatchObject({ text: 'env llm' })
  })

  it('does not route unsupported registry providers through cloud proxy services', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'claude',
      displayName: 'Claude',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://api.anthropic.com/v1',
      apiKey: 'registry-llm-key',
      defaultModel: 'claude-test',
      priority: 10,
    })
    const fetchImpl: typeof fetch = async () => {
      throw new Error('should not call unsupported provider')
    }

    await expect(
      createLlmProxyService(env, fetchImpl, desktopConfig).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({
      code: 'not_implemented',
    })
  })
})

describe('proxy route quota accounting', () => {
  it('commits provider-reported LLM usage after a successful cloud proxy response', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      llm: {
        async complete() {
          return { text: 'polished', usageTokens: 7 }
        },
        async stream() {
          throw new Error('not used')
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'policy' },
            { role: 'user', content: 'hello' },
          ],
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ text: 'polished' })
    await expect(used(ledger, 'llm_tokens')).resolves.toBe(7)
  })

  it('streams LLM proxy responses and commits usage after completion', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      llm: {
        async complete() {
          throw new Error('not used')
        },
        async stream(input) {
          expect(input.messages).toEqual([{ role: 'user', content: 'hello' }])
          const encoder = new TextEncoder()
          return {
            response: new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    encoder.encode('data: {"choices":[{"delta":{"content":"hello stream"}}]}\n\n'),
                  )
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                  controller.close()
                },
              }),
              {
                headers: {
                  'content-type': 'text/event-stream; charset=utf-8',
                },
              },
            ),
            completed: Promise.resolve({ text: 'hello stream', usageTokens: 13 }),
          }
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await expect(res.text()).resolves.toContain('hello stream')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(used(ledger, 'llm_tokens')).resolves.toBe(13)
  })

  it('releases LLM quota when an OpenAI stream ends without its terminal event', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
    })
    const llm = createLlmProxyService(
      env,
      async () =>
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
    )
    const app = testProxyApp({ ledger, llm })

    const response = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ code: 'llm_failed' })
    await expect(used(ledger, 'llm_tokens')).resolves.toBe(0)
  })

  it('does not charge LLM quota for an empty terminal stream', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const env = testEnv({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'server-llm-key',
      LLM_MODEL: 'gpt-test',
    })
    const llm = createLlmProxyService(
      env,
      async () =>
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
    )
    const app = testProxyApp({ ledger, llm })

    const response = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ code: 'llm_failed' })
    await expect(used(ledger, 'llm_tokens')).resolves.toBe(0)
  })

  it('releases reserved LLM quota when the provider fails', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      llm: {
        async complete() {
          throw new Error('provider failed')
        },
        async stream() {
          throw new Error('not used')
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.code).toBe('internal_error')
    await expect(used(ledger, 'llm_tokens')).resolves.toBe(0)
  })

  it('commits STT duration after a successful cloud proxy response', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      stt: {
        async transcribe() {
          return { text: 'hello from audio', durationSeconds: 3 }
        },
      },
    })
    const formData = new FormData()
    formData.append('audio', new Blob([new Uint8Array(64_000)]), 'audio.wav')
    formData.append('language', 'en')

    const res = await app.fetch(
      request('/echo-api/proxy/stt', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: formData,
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ text: 'hello from audio' })
    await expect(used(ledger, 'stt_seconds')).resolves.toBe(3)
  })

  it('commits OCR image usage after a successful cloud proxy response', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      ocr: {
        async read(input) {
          expect(input.imageBase64).toBe(PNG_BASE64)
          expect(input.imageMimeType).toBe('image/png')
          expect(input.documentPage).toBe(false)
          expect(input.requestId).toBe('req-ocr-success')
          expect(input.signal).toBeInstanceOf(AbortSignal)
          return { text: '# OCR', model: 'vision-model', usageTokens: 9 }
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
          'x-request-id': 'req-ocr-success',
        },
        body: JSON.stringify({ imageBase64: PNG_BASE64 }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      text: '# OCR',
      model: 'vision-model',
      route: 'direct',
      processingReason: 'cloud-provider-direct',
      warnings: [],
      degraded: false,
      pageCount: 1,
    })
    await expect(used(ledger, 'ocr_images')).resolves.toBe(1)
  })

  it('normalizes legacy BMP MIME aliases before calling the OCR provider', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      ocr: {
        async read(input) {
          expect(input.imageBase64).toBe(BMP_BASE64)
          expect(input.imageMimeType).toBe('image/bmp')
          return { text: 'BMP text', model: 'vision-model', usageTokens: null }
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          imageBase64: BMP_BASE64,
          imageMimeType: 'image/x-ms-bmp',
        }),
      }),
    )

    expect(res.status).toBe(200)
    await expect(used(ledger, 'ocr_images')).resolves.toBe(1)
  })

  it.each([
    ['PNG', PNG_BASE64, 'image/png'],
    ['JPEG', JPEG_BASE64, 'image/jpeg'],
    ['WebP', WEBP_BASE64, 'image/webp'],
    ['BMP', BMP_BASE64, 'image/bmp'],
  ])(
    'accepts contract v2 %s only with its matching canonical MIME',
    async (_name, base64, mime) => {
      const ledger = createMemoryQuotaLedgerStore()
      const app = testProxyApp({
        ledger,
        ocr: {
          async read(input) {
            expect(input.imageMimeType).toBe(mime)
            return { text: 'recognized', model: 'vision-model', usageTokens: null }
          },
        },
      })

      const res = await app.fetch(
        request('/echo-api/proxy/ocr', {
          method: 'POST',
          headers: {
            authorization: 'Bearer valid-pro-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            contractVersion: 2,
            imageBase64: base64,
            imageMimeType: mime,
          }),
        }),
      )

      expect(res.status).toBe(200)
      await expect(used(ledger, 'ocr_images')).resolves.toBe(1)
    },
  )

  it('keeps 0.2.3 clients working by correcting their legacy JPEG-as-PNG declaration', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      ocr: {
        async read(input) {
          expect(input.imageMimeType).toBe('image/jpeg')
          return { text: 'JPEG text', model: 'vision-model', usageTokens: null }
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          imageBase64: JPEG_BASE64,
          imageMimeType: 'image/png',
        }),
      }),
    )

    expect(res.status).toBe(200)
    await expect(used(ledger, 'ocr_images')).resolves.toBe(1)
  })

  it('commits one OCR unit for an explicitly preserved blank document page', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      ocr: {
        async read(input) {
          expect(input.documentPage).toBe(true)
          return {
            text: '',
            model: 'vision-model',
            usageTokens: 4,
            warnings: ['当前文档页是空白页。'],
            degraded: true,
            pageCount: 1,
          }
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contractVersion: 2,
          imageBase64: PNG_BASE64,
          imageMimeType: 'image/png',
          documentPage: true,
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      text: '',
      route: 'direct',
      warnings: ['当前文档页是空白页。'],
      degraded: true,
      pageCount: 1,
    })
    await expect(used(ledger, 'ocr_images')).resolves.toBe(1)
  })

  it.each([
    {
      name: 'non-canonical Base64',
      payload: { imageBase64: 'Zh==', imageMimeType: 'image/png' },
    },
    {
      name: 'unsupported image magic',
      payload: { imageBase64: 'aGVsbG8=', imageMimeType: 'image/png' },
    },
    {
      name: 'MIME and image magic mismatch',
      payload: {
        contractVersion: 2,
        imageBase64: PNG_BASE64,
        imageMimeType: 'image/jpeg',
      },
    },
    {
      name: 'missing contract v2 MIME',
      payload: { contractVersion: 2, imageBase64: PNG_BASE64 },
    },
    {
      name: 'empty contract v2 MIME',
      payload: { contractVersion: 2, imageBase64: PNG_BASE64, imageMimeType: '' },
    },
    {
      name: 'unsupported contract version',
      payload: { contractVersion: 3, imageBase64: PNG_BASE64 },
    },
    {
      name: 'invalid documentPage type',
      payload: { imageBase64: PNG_BASE64, documentPage: 'true' },
    },
  ])('rejects $name before reserving OCR quota', async ({ payload }) => {
    const ledger = createMemoryQuotaLedgerStore()
    let providerCalls = 0
    const app = testProxyApp({
      ledger,
      ocr: {
        async read() {
          providerCalls += 1
          throw new Error('should not call provider')
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.code).toBe('validation_failed')
    expect(providerCalls).toBe(0)
    await expect(used(ledger, 'ocr_images')).resolves.toBe(0)
  })

  it('accepts an image exactly at the 25 MiB decoded boundary', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const bytes = Buffer.alloc(25 * 1024 * 1024)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    const app = testProxyApp({
      ledger,
      ocr: {
        async read(input) {
          expect(input.imageMimeType).toBe('image/png')
          return { text: 'boundary image', model: 'vision-model', usageTokens: null }
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contractVersion: 2,
          imageBase64: bytes.toString('base64'),
          imageMimeType: 'image/png',
        }),
      }),
    )

    expect(res.status).toBe(200)
    await expect(used(ledger, 'ocr_images')).resolves.toBe(1)
  })

  it('rejects an image larger than 25 MiB decoded before reserving OCR quota', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    let providerCalls = 0
    const bytes = Buffer.alloc(25 * 1024 * 1024 + 1)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    const app = testProxyApp({
      ledger,
      ocr: {
        async read() {
          providerCalls += 1
          throw new Error('should not call provider')
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ imageBase64: bytes.toString('base64') }),
      }),
    )
    const body = await res.json()

    expect(body.code).toBe('payload_too_large')
    expect(res.status).toBe(413)
    expect(providerCalls).toBe(0)
    await expect(used(ledger, 'ocr_images')).resolves.toBe(0)
  })

  it('releases OCR quota when the provider returns an HTTP failure', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const ocr = await openAiOcrProxy(
      async () => new Response('provider unavailable', { status: 503 }),
    )
    const app = testProxyApp({ ledger, ocr })

    const res = await app.fetch(ocrProxyRequest())
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.code).toBe('ocr_failed')
    await expect(used(ledger, 'ocr_images')).resolves.toBe(0)
  })

  it('releases OCR quota when local Ollama reports a truncated completion', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const ocr = await ollamaOcrProxy(async () =>
      Response.json({ response: 'partial text', done: true, done_reason: 'length' }),
    )
    const app = testProxyApp({ ledger, ocr })

    const res = await app.fetch(ocrProxyRequest())
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.code).toBe('ocr_failed')
    await expect(used(ledger, 'ocr_images')).resolves.toBe(0)
  })

  it('releases OCR quota when the provider response is too large', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const ocr = await openAiOcrProxy(
      async () => new Response(null, { headers: { 'content-length': String(64 * 1024 * 1024) } }),
    )
    const app = testProxyApp({ ledger, ocr })

    const res = await app.fetch(ocrProxyRequest())
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.code).toBe('ocr_failed')
    await expect(used(ledger, 'ocr_images')).resolves.toBe(0)
  })

  it('releases OCR quota when the provider body exceeds the full request deadline', async () => {
    vi.useFakeTimers()
    try {
      const ledger = createMemoryQuotaLedgerStore()
      const ocr = await openAiOcrProxy(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                return new Promise(() => undefined)
              },
            }),
          ),
      )
      const app = testProxyApp({ ledger, ocr })
      const responsePromise = app.fetch(ocrProxyRequest())

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS)
      const res = await responsePromise
      const body = await res.json()

      expect(res.status).toBe(504)
      expect(body.code).toBe('ocr_timeout')
      await expect(used(ledger, 'ocr_images')).resolves.toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('commits TTS character usage after a successful cloud proxy response', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      tts: {
        async synthesize(input) {
          expect(input.text).toBe('hello')
          return {
            audio: new Uint8Array([1, 2, 3]).buffer,
            contentType: 'audio/mpeg',
            usageChars: 5,
          }
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/tts', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('x-tts-usage-chars')).toBe('5')
    await expect(used(ledger, 'tts_chars')).resolves.toBe(5)
  })

  it('rejects client-owned provider fields on the TTS proxy', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      tts: {
        async synthesize() {
          throw new Error('should not call provider')
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/tts', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text: 'hello',
          apiKey: 'client-key',
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.code).toBe('validation_failed')
  })

  it('rejects client-owned provider fields on the OCR proxy', async () => {
    const ledger = createMemoryQuotaLedgerStore()
    const app = testProxyApp({
      ledger,
      ocr: {
        async read() {
          throw new Error('should not call provider')
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          imageBase64: 'aGVsbG8=',
          providerApiKey: 'client-key',
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.code).toBe('validation_failed')
  })
})

async function openAiOcrProxy(
  fetchImpl: typeof fetch,
  diagnosticSink?: OcrDiagnosticSink,
): Promise<OcrProxyService> {
  const env = testEnv()
  const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
  await desktopConfig.upsertProvider({
    kind: 'ocr',
    providerId: 'openai',
    displayName: 'OpenAI Vision',
    enabled: true,
    mode: 'proxy',
    endpoint: 'https://registry.example/v1',
    apiKey: 'registry-ocr-key',
    defaultModel: 'gpt-4o-mini',
    priority: 10,
  })
  return createOcrProxyService(env, fetchImpl, desktopConfig, diagnosticSink)
}

async function ollamaOcrProxy(
  fetchImpl: typeof fetch,
  diagnosticSink?: OcrDiagnosticSink,
): Promise<OcrProxyService> {
  const env = testEnv()
  const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
  await desktopConfig.upsertProvider({
    kind: 'ocr',
    providerId: 'ollama-ocr-local',
    displayName: 'Ollama GLM OCR Local',
    enabled: true,
    mode: 'proxy',
    endpoint: 'http://127.0.0.1:11434/api/generate',
    defaultModel: 'glm-ocr:latest',
    priority: 10,
  })
  return createOcrProxyService(env, fetchImpl, desktopConfig, diagnosticSink)
}

function ocrProxyRequest() {
  return request('/echo-api/proxy/ocr', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-pro-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ imageBase64: PNG_BASE64 }),
  })
}

function testProxyApp(options: {
  ledger: QuotaLedgerStore
  llm?: LlmProxyService
  ocr?: OcrProxyService
  stt?: SttProxyService
  tts?: TtsProxyService
}) {
  const env = testEnv()
  const entitlements = createStaticEntitlementService(env.planLimits, {
    [proUser.id]: {
      plan: 'pro',
      subscriptionEnd: '2026-12-31T00:00:00.000Z',
    },
  })
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({
      'valid-pro-token': proUser,
    }),
    services: {
      ...testServices(env),
      entitlements,
      billing: disabledBillingSessionService,
      quota: createQuotaService(entitlements, options.ledger),
      proxy: {
        llm: options.llm ?? failingLlmProxy(),
        ocr: options.ocr ?? failingOcrProxy(),
        stt: options.stt ?? failingSttProxy(),
        tts: options.tts ?? failingTtsProxy(),
      },
    },
  })
}

function failingLlmProxy(): LlmProxyService {
  return {
    async complete() {
      throw new Error('unexpected llm call')
    },
    async stream() {
      throw new Error('unexpected llm stream call')
    },
  }
}

function failingOcrProxy(): OcrProxyService {
  return {
    async read() {
      throw new Error('unexpected ocr call')
    },
  }
}

function failingSttProxy(): SttProxyService {
  return {
    async transcribe() {
      throw new Error('unexpected stt call')
    },
  }
}

function failingTtsProxy(): TtsProxyService {
  return {
    async synthesize() {
      throw new Error('unexpected tts call')
    },
  }
}

function used(ledger: QuotaLedgerStore, kind: QuotaKind) {
  return ledger.getUsed(proUser.id, kind, utcPeriodKey())
}
