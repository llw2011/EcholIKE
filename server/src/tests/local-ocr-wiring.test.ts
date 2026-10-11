import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
} from '../services/desktop/desktop-config-service.js'
import {
  createDocumentOcrService,
  createLocalOcrExecutionGate,
} from '../services/ocr/document-ocr-service.js'
import { createLocalOcrRuntime } from '../services/ocr/local-ocr-runtime.js'
import { createOcrProxyService } from '../services/proxy/ocr-proxy.js'
import type {
  ProviderAddressResolver,
  ProviderEgressTransport,
  ValidatedProviderEndpoint,
} from '../services/security/provider-egress-policy.js'
import { WSL_WINDOWS_HOSTNAME } from '../services/security/provider-runtime-address.js'
import { testEnv } from './helpers.js'

const LOGICAL_ENDPOINT = `http://${WSL_WINDOWS_HOSTNAME}:11434/api/generate`

async function fixture(
  request: (endpoint: ValidatedProviderEndpoint, init: RequestInit) => Promise<Response>,
  model = 'glm-ocr:latest',
) {
  let address = '172.26.128.1'
  const resolver: ProviderAddressResolver = {
    resolve: vi.fn(async () => [{ address, family: 4 as const }]),
  }
  const transport: ProviderEgressTransport = { request: vi.fn(request) }
  const env = testEnv()
  const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
  await desktopConfig.upsertProvider({
    kind: 'ocr',
    providerId: 'ollama-ocr-local',
    displayName: 'Windows GLM OCR',
    enabled: true,
    mode: 'proxy',
    endpoint: LOGICAL_ENDPOINT,
    apiKey: null,
    defaultModel: model,
    priority: 10,
  })
  const gate = createLocalOcrExecutionGate()
  const runtime = createLocalOcrRuntime(env, desktopConfig, { resolver, transport })
  const unexpectedFetch = vi.fn(async () => {
    throw new Error('local OCR must use the pinned runtime transport')
  }) as unknown as typeof fetch
  const service = createOcrProxyService(
    env,
    unexpectedFetch,
    desktopConfig,
    () => undefined,
    gate,
    runtime,
  )
  return {
    env,
    gate,
    runtime,
    service,
    resolver,
    transport,
    unexpectedFetch,
    setAddress(next: string) {
      address = next
    },
  }
}

describe('local OCR runtime wiring across the shared gate', () => {
  it('resolves the current gateway only after queued image work acquires the gate', async () => {
    const seen: string[] = []
    const test = await fixture(async (endpoint) => {
      seen.push(`${endpoint.url.pathname}@${endpoint.addresses[0]?.address}`)
      return endpoint.url.pathname === '/api/tags'
        ? Response.json({ models: [{ name: 'glm-ocr:latest' }] })
        : Response.json({ response: 'image text', done: true, done_reason: 'stop' })
    })
    let release: () => void = () => undefined
    let markHeld: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      markHeld = resolve
    })
    const blocker = test.gate.run(undefined, async () => {
      markHeld()
      await held
    })
    await entered

    const image = test.service.read({ imageBase64: 'aW1hZ2U=', imageMimeType: 'image/png' })
    await Promise.resolve()
    expect(seen).toEqual([])
    test.setAddress('172.28.0.1')
    release()
    await blocker
    await expect(image).resolves.toMatchObject({ text: 'image text', model: 'glm-ocr:latest' })

    expect(seen).toEqual(['/api/tags@172.28.0.1', '/api/generate@172.28.0.1'])
    expect(test.unexpectedFetch).not.toHaveBeenCalled()
    await test.gate.close()
  })

  it('pins both retry attempts to one snapshot and moves only the next operation', async () => {
    const seen: string[] = []
    let generateAttempts = 0
    let test: Awaited<ReturnType<typeof fixture>>
    test = await fixture(async (endpoint) => {
      const address = endpoint.addresses[0]?.address ?? 'missing'
      seen.push(`${endpoint.url.pathname}@${address}`)
      if (endpoint.url.pathname === '/api/tags') {
        return Response.json({ models: [{ name: 'glm-ocr:latest' }] })
      }
      generateAttempts += 1
      if (generateAttempts === 1) {
        test.setAddress('172.28.0.1')
        return new Response('{}', { status: 503 })
      }
      return Response.json({
        response: `result-${generateAttempts}`,
        done: true,
        done_reason: 'stop',
      })
    })

    await expect(
      test.service.read({ imageBase64: 'Zmlyc3Q=', imageMimeType: 'image/png' }),
    ).resolves.toMatchObject({ text: 'result-2' })
    await expect(
      test.service.read({ imageBase64: 'c2Vjb25k', imageMimeType: 'image/png' }),
    ).resolves.toMatchObject({ text: 'result-3' })

    expect(seen).toEqual([
      '/api/tags@172.26.128.1',
      '/api/generate@172.26.128.1',
      '/api/generate@172.26.128.1',
      '/api/tags@172.28.0.1',
      '/api/generate@172.28.0.1',
    ])
    await test.gate.close()
  })

  it('keeps generic Ollama image OCR direct while refusing the GLM-only PDF capability', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const test = await fixture(async (endpoint, init) => {
      if (endpoint.url.pathname === '/api/tags') {
        return Response.json({ models: [{ name: 'qwen-vl:latest' }] })
      }
      requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return Response.json({ response: 'generic image text', done: true, done_reason: 'stop' })
    }, 'qwen-vl:latest')
    const pipelineRunner = vi.fn(async () => {
      throw new Error('generic Ollama models must not enter the GLM PDF Pipeline')
    })
    const documentOcr = createDocumentOcrService(test.env, test.gate, {
      localOcrRuntime: test.runtime,
      processRunner: pipelineRunner,
    })

    try {
      await expect(
        test.service.read({ imageBase64: 'aW1hZ2U=', imageMimeType: 'image/png' }),
      ).resolves.toMatchObject({
        text: 'generic image text',
        model: 'qwen-vl:latest',
        route: 'direct',
      })
      await expect(documentOcr.capability()).resolves.toEqual({
        available: false,
        providerAvailable: true,
        model: 'qwen-vl:latest',
      })

      expect(requestBodies).toHaveLength(1)
      expect(requestBodies[0]).toMatchObject({
        model: 'qwen-vl:latest',
        options: { num_predict: 8192, temperature: 0 },
      })
      expect((requestBodies[0]?.options as Record<string, unknown>).num_ctx).toBeUndefined()
      expect(pipelineRunner).not.toHaveBeenCalled()
      expect(test.unexpectedFetch).not.toHaveBeenCalled()
    } finally {
      await documentOcr.shutdown()
    }
  })
})
