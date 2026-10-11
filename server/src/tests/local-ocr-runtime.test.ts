import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
} from '../services/desktop/desktop-config-service.js'
import { createLocalOcrRuntime } from '../services/ocr/local-ocr-runtime.js'
import type {
  ProviderAddressResolver,
  ProviderEgressTransport,
} from '../services/security/provider-egress-policy.js'
import { WSL_WINDOWS_HOSTNAME } from '../services/security/provider-runtime-address.js'
import { testEnv } from './helpers.js'

const LOGICAL_ENDPOINT = `http://${WSL_WINDOWS_HOSTNAME}:11434/api/generate`

function runtimeFixture(options: {
  address?: string
  response?: () => Response | Promise<Response>
}) {
  let address = options.address ?? '172.26.128.1'
  const resolver: ProviderAddressResolver = {
    resolve: vi.fn(async (hostname) => {
      if (hostname !== WSL_WINDOWS_HOSTNAME) throw new Error(`unexpected hostname ${hostname}`)
      return [{ address, family: 4 as const }]
    }),
  }
  const transport: ProviderEgressTransport = {
    request: vi.fn(async () =>
      options.response
        ? await options.response()
        : Response.json({ models: [{ name: 'glm-ocr:latest' }] }),
    ),
  }
  const env = testEnv()
  const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
  const runtime = createLocalOcrRuntime(env, desktopConfig, { resolver, transport })
  return {
    runtime,
    resolver,
    transport,
    setAddress(next: string) {
      address = next
    },
  }
}

function localConfig(endpoint = LOGICAL_ENDPOINT, model = 'glm-ocr:latest') {
  return {
    provider: 'ollama-ocr-local',
    protocol: 'ollama-generate' as const,
    endpoint,
    apiKey: null,
    model,
  }
}

describe('single local OCR runtime target authority', () => {
  it('resolves each operation to the current WSL host while keeping an active snapshot pinned', async () => {
    const fixture = runtimeFixture({})
    const first = await fixture.runtime.resolveConfig(localConfig())
    expect(first).toMatchObject({
      logicalEndpoint: LOGICAL_ENDPOINT,
      model: 'glm-ocr:latest',
      source: 'wsl-windows-host',
      validated: {
        hostname: WSL_WINDOWS_HOSTNAME,
        addresses: [{ address: '172.26.128.1', family: 4, scope: 'private' }],
      },
    })

    fixture.setAddress('172.28.0.1')
    const second = await fixture.runtime.resolveConfig(localConfig())
    expect(second.validated.addresses).toEqual([
      { address: '172.28.0.1', family: 4, scope: 'private' },
    ])

    await fixture.runtime.request(first, { method: 'POST', body: '{}' })
    await fixture.runtime.request(second, { method: 'POST', body: '{}' })
    expect(fixture.transport.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        addresses: [expect.objectContaining({ address: '172.26.128.1' })],
      }),
      expect.anything(),
    )
    expect(fixture.transport.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        addresses: [expect.objectContaining({ address: '172.28.0.1' })],
      }),
      expect.anything(),
    )
  })

  it.each([
    `http://${WSL_WINDOWS_HOSTNAME}:11435/api/generate`,
    `http://${WSL_WINDOWS_HOSTNAME}:11434/api/chat`,
    `https://${WSL_WINDOWS_HOSTNAME}:11434/api/generate`,
    `http://${WSL_WINDOWS_HOSTNAME}:11434/api/generate?target=other`,
    `http://user:password@${WSL_WINDOWS_HOSTNAME}:11434/api/generate`,
  ])('rejects a non-canonical logical endpoint before transport: %s', async (endpoint) => {
    const fixture = runtimeFixture({})
    await expect(fixture.runtime.resolveConfig(localConfig(endpoint))).rejects.toMatchObject({
      code: 'endpoint_invalid',
    })
    expect(fixture.transport.request).not.toHaveBeenCalled()
  })

  it('keeps a normal loopback local endpoint unchanged and never invokes WSL discovery', async () => {
    const fixture = runtimeFixture({})
    const target = await fixture.runtime.resolveConfig(
      localConfig('http://127.0.0.1:11434/api/generate'),
    )

    expect(target).toMatchObject({
      source: 'configured',
      validated: {
        hostname: '127.0.0.1',
        addresses: [{ address: '127.0.0.1', family: 4, scope: 'loopback' }],
      },
    })
    expect(fixture.resolver.resolve).not.toHaveBeenCalled()
  })

  it('verifies the exact configured model and caches only the same target fingerprint', async () => {
    const fixture = runtimeFixture({})
    const first = await fixture.runtime.resolveConfig(localConfig())
    await expect(fixture.runtime.probe(first)).resolves.toEqual({ available: true, reason: 'ok' })
    await expect(fixture.runtime.probe(first)).resolves.toEqual({ available: true, reason: 'ok' })
    expect(fixture.transport.request).toHaveBeenCalledTimes(1)

    fixture.setAddress('172.28.0.1')
    const second = await fixture.runtime.resolveConfig(localConfig())
    await expect(fixture.runtime.probe(second)).resolves.toEqual({ available: true, reason: 'ok' })
    expect(fixture.transport.request).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed probe and immediately rechecks the same target', async () => {
    let responses = 0
    const fixture = runtimeFixture({
      response: () => {
        responses += 1
        return responses === 1
          ? new Response('{}', { status: 503 })
          : Response.json({ models: [{ name: 'glm-ocr:latest' }] })
      },
    })
    const target = await fixture.runtime.resolveConfig(localConfig())

    await expect(fixture.runtime.probe(target)).resolves.toEqual({
      available: false,
      reason: 'upstream_status',
    })
    await expect(fixture.runtime.probe(target)).resolves.toEqual({ available: true, reason: 'ok' })
    await expect(fixture.runtime.probe(target)).resolves.toEqual({ available: true, reason: 'ok' })

    expect(responses).toBe(2)
    expect(fixture.transport.request).toHaveBeenCalledTimes(2)
  })

  it('evicts a prior success when a forced probe fails', async () => {
    let healthy = true
    const fixture = runtimeFixture({
      response: () =>
        healthy
          ? Response.json({ models: [{ name: 'glm-ocr:latest' }] })
          : new Response('{}', { status: 503 }),
    })
    const target = await fixture.runtime.resolveConfig(localConfig())

    await expect(fixture.runtime.probe(target)).resolves.toEqual({ available: true, reason: 'ok' })
    healthy = false
    await expect(fixture.runtime.probe(target, undefined, { force: true })).resolves.toEqual({
      available: false,
      reason: 'upstream_status',
    })
    await expect(fixture.runtime.probe(target)).resolves.toEqual({
      available: false,
      reason: 'upstream_status',
    })

    expect(fixture.transport.request).toHaveBeenCalledTimes(3)
  })

  it('does not let a late same-target success overwrite a newer forced failure', async () => {
    let releaseFirst: () => void = () => undefined
    let markFirstStarted: () => void = () => undefined
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    let requests = 0
    const fixture = runtimeFixture({
      response: async () => {
        requests += 1
        if (requests === 1) {
          markFirstStarted()
          await firstHeld
          return Response.json({ models: [{ name: 'glm-ocr:latest' }] })
        }
        return new Response('{}', { status: 503 })
      },
    })
    const target = await fixture.runtime.resolveConfig(localConfig())
    const first = fixture.runtime.probe(target)
    await firstStarted

    await expect(fixture.runtime.probe(target, undefined, { force: true })).resolves.toEqual({
      available: false,
      reason: 'upstream_status',
    })
    releaseFirst()
    await expect(first).resolves.toEqual({ available: false, reason: 'superseded' })
    await expect(fixture.runtime.probe(target)).resolves.toEqual({
      available: false,
      reason: 'upstream_status',
    })
    expect(requests).toBe(3)
  })

  it('does not let a late same-target failure delete a newer success', async () => {
    let releaseFirst: () => void = () => undefined
    let markFirstStarted: () => void = () => undefined
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    let requests = 0
    const fixture = runtimeFixture({
      response: async () => {
        requests += 1
        if (requests === 1) {
          markFirstStarted()
          await firstHeld
          return new Response('{}', { status: 503 })
        }
        return Response.json({ models: [{ name: 'glm-ocr:latest' }] })
      },
    })
    const target = await fixture.runtime.resolveConfig(localConfig())
    const first = fixture.runtime.probe(target)
    await firstStarted

    await expect(fixture.runtime.probe(target, undefined, { force: true })).resolves.toEqual({
      available: true,
      reason: 'ok',
    })
    releaseFirst()
    await expect(first).resolves.toEqual({ available: false, reason: 'superseded' })
    await expect(fixture.runtime.probe(target)).resolves.toEqual({ available: true, reason: 'ok' })
    expect(requests).toBe(2)
  })

  it('reports model-missing, invalid, oversized, status, and unreachable probes without inference', async () => {
    const cases: Array<{
      response: () => Response | Promise<Response>
      reason: string
    }> = [
      {
        response: () => Response.json({ models: [{ name: 'other:latest' }] }),
        reason: 'model_missing',
      },
      { response: () => new Response('{bad-json'), reason: 'invalid_response' },
      {
        response: () =>
          new Response(JSON.stringify({ models: [] }), {
            headers: { 'content-length': String(600 * 1024) },
          }),
        reason: 'invalid_response',
      },
      { response: () => new Response('{}', { status: 503 }), reason: 'upstream_status' },
      { response: async () => Promise.reject(new Error('connect failed')), reason: 'unreachable' },
    ]

    for (const testCase of cases) {
      const fixture = runtimeFixture({ response: testCase.response })
      const target = await fixture.runtime.resolveConfig(localConfig())
      await expect(fixture.runtime.probe(target, undefined, { force: true })).resolves.toEqual({
        available: false,
        reason: testCase.reason,
      })
    }
  })

  it('rejects a public or link-local address returned for the logical host', async () => {
    for (const [address, code] of [
      ['93.184.216.34', 'insecure_http_forbidden'],
      ['169.254.169.254', 'address_scope_forbidden'],
    ] as const) {
      const fixture = runtimeFixture({ address })
      await expect(fixture.runtime.resolveConfig(localConfig())).rejects.toMatchObject({
        code,
      })
      expect(fixture.transport.request).not.toHaveBeenCalled()
    }
  })

  it('rejects non-native/cloud configs while preserving generic Ollama image models', async () => {
    const fixture = runtimeFixture({
      response: () => Response.json({ models: [{ name: 'qwen-vl:latest' }] }),
    })
    await expect(
      fixture.runtime.resolveConfig({
        ...localConfig(),
        provider: 'openai-compatible',
        protocol: 'openai',
        endpoint: 'https://provider.example/v1/chat/completions',
      }),
    ).rejects.toMatchObject({ code: 'provider_mismatch' })
    const generic = await fixture.runtime.resolveConfig(localConfig(LOGICAL_ENDPOINT, 'qwen-vl'))
    expect(generic).toMatchObject({ model: 'qwen-vl' })
    await expect(fixture.runtime.probe(generic)).resolves.toEqual({
      available: true,
      reason: 'ok',
    })
  })
})
