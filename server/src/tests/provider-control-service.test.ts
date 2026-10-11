import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ProviderAddressResolver,
  ProviderEgressTransport,
  ProviderResolvedAddress,
} from '../services/security/provider-egress-policy.js'
import { createProviderControlService } from '../services/security/provider-control-service.js'
import type {
  ProviderRegistryInput,
  ProviderRegistryRecord,
} from '../services/desktop/desktop-config-service.js'

const PUBLIC_ADDRESS = '93.184.216.34'
const CONTROL_OPTIONS = { deadlineMs: 1_000, maxInFlight: 2 } as const

afterEach(() => {
  vi.useRealTimers()
})

describe('provider control security', () => {
  it('validates an enabled public provider before it can be saved', async () => {
    const resolver = mappedResolver({
      'openrouter.ai': [{ address: PUBLIC_ADDRESS, family: 4 }],
    })
    const service = createProviderControlService({
      ...CONTROL_OPTIONS,
      resolver,
      transport: unusedTransport(),
    })

    await expect(
      service.assertSavable({ provider: openRouterInput(), existing: null }),
    ).resolves.toBeUndefined()
    expect(resolver.resolve).toHaveBeenCalledWith('openrouter.ai')
  })

  it('allows only the exact local origin declared by the selected product preset', async () => {
    const service = createProviderControlService({
      ...CONTROL_OPTIONS,
      transport: unusedTransport(),
    })

    await expect(
      service.assertSavable({
        provider: {
          kind: 'ocr',
          providerId: 'ollama-ocr-local',
          displayName: 'Local OCR',
          enabled: true,
          mode: 'proxy',
          endpoint: 'http://127.0.0.1:11434/api/generate',
          defaultModel: 'glm-ocr:latest',
        },
        existing: null,
      }),
    ).resolves.toBeUndefined()

    await expect(
      service.assertSavable({
        provider: {
          kind: 'ocr',
          providerId: 'ollama-ocr-local',
          displayName: 'Local OCR',
          enabled: true,
          mode: 'proxy',
          endpoint: 'http://169.254.169.254/latest/meta-data',
          defaultModel: 'glm-ocr:latest',
        },
        existing: null,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
  })

  it('allows only the canonical WSL-host form and pins model reads to its resolved address', async () => {
    const logicalEndpoint = 'http://wsl-host.echolike.invalid:11434/api/generate'
    const resolver = mappedResolver({
      'wsl-host.echolike.invalid': [{ address: '172.26.128.1', family: 4 }],
    })
    const transport: ProviderEgressTransport = {
      request: vi.fn(async (endpoint) => {
        expect(endpoint.addresses).toEqual([
          { address: '172.26.128.1', family: 4, scope: 'private' },
        ])
        return Response.json({ models: [{ name: 'glm-ocr:latest' }] })
      }),
    }
    const service = createProviderControlService({
      ...CONTROL_OPTIONS,
      resolver,
      transport,
    })
    const provider: ProviderRegistryInput = {
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Windows GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: logicalEndpoint,
      defaultModel: 'glm-ocr:latest',
    }

    await expect(service.assertSavable({ provider, existing: null })).resolves.toBeUndefined()
    await expect(
      service.listModels({
        kind: 'ocr',
        providerId: 'ollama-ocr-local',
        endpoint: logicalEndpoint,
        apiKey: null,
      }),
    ).resolves.toEqual([{ id: 'glm-ocr:latest', label: 'glm-ocr:latest' }])

    for (const endpoint of [
      'http://wsl-host.echolike.invalid:11435/api/generate',
      'http://wsl-host.echolike.invalid:11434/api/chat',
    ]) {
      await expect(
        service.assertSavable({ provider: { ...provider, endpoint }, existing: null }),
      ).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
    }
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('reads models from an active private endpoint without allowing new private endpoints', async () => {
    const activeEndpoint = 'http://10.24.0.8:11440/v1'
    const transport: ProviderEgressTransport = {
      request: vi.fn(async (endpoint) => {
        expect(endpoint.url.pathname).toBe('/v1/models')
        expect(endpoint.addresses).toEqual([{ address: '10.24.0.8', family: 4, scope: 'private' }])
        return Response.json({ data: [{ id: 'qwen-active' }] })
      }),
    }
    const service = createProviderControlService({ ...CONTROL_OPTIONS, transport })

    await expect(
      service.listModels({
        kind: 'llm',
        providerId: 'ollama',
        endpoint: activeEndpoint,
        trustedLocalEndpoint: activeEndpoint,
        apiKey: null,
      }),
    ).resolves.toEqual([{ id: 'qwen-active', label: 'qwen-active' }])

    await expect(
      service.listModels({
        kind: 'llm',
        providerId: 'ollama',
        endpoint: 'http://10.24.0.9:11440/v1',
        apiKey: null,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'provider_failed' })

    await expect(
      service.listModels({
        kind: 'llm',
        providerId: 'openai-compatible',
        endpoint: activeEndpoint,
        trustedLocalEndpoint: activeEndpoint,
        apiKey: 'configured-key',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'provider_failed' })

    await expect(
      service.assertSavable({
        provider: {
          kind: 'llm',
          providerId: 'ollama',
          displayName: 'Untrusted local model',
          enabled: true,
          mode: 'proxy',
          endpoint: 'http://10.24.0.9:11440/v1',
          defaultModel: 'qwen-untrusted',
        },
        existing: null,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://user:secret@openrouter.ai/api/v1',
    'https://openrouter.ai/api/v1?token=secret',
    'https://openrouter.ai/api/v1#secret',
  ])(
    'rejects unsafe endpoint shape for disabled drafts without network access',
    async (endpoint) => {
      const resolver = mappedResolver({})
      const transport = unusedTransport()
      const service = createProviderControlService({
        ...CONTROL_OPTIONS,
        resolver,
        transport,
      })

      await expect(
        service.assertSavable({
          provider: openRouterInput({ enabled: false, endpoint }),
          existing: null,
        }),
      ).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
      expect(resolver.resolve).not.toHaveBeenCalled()
      expect(transport.request).not.toHaveBeenCalled()
    },
  )

  it('requires a new key when an enabled provider changes credential origin', async () => {
    const resolver = mappedResolver({
      'old.example': [{ address: PUBLIC_ADDRESS, family: 4 }],
      'new.example': [{ address: '1.1.1.1', family: 4 }],
    })
    const service = createProviderControlService({
      ...CONTROL_OPTIONS,
      resolver,
      transport: unusedTransport(),
    })
    const existing = providerRecord({
      endpoint: 'https://old.example/v1',
      apiKeyPreview: 'configured',
    })

    await expect(
      service.assertSavable({
        provider: openRouterInput({
          id: existing.id,
          endpoint: 'https://new.example/v1',
          apiKey: undefined,
        }),
        existing,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
  })

  it('reads models only through the already-validated pinned transport', async () => {
    const resolver = mappedResolver({
      'provider.test': [{ address: PUBLIC_ADDRESS, family: 4 }],
    })
    const transport: ProviderEgressTransport = {
      request: vi.fn(async (endpoint, init) => {
        expect(endpoint.addresses).toEqual([
          { address: PUBLIC_ADDRESS, family: 4, scope: 'public' },
        ])
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-key')
        return Response.json({
          data: [
            { id: 'model-a' },
            { id: 'model-a' },
            { name: 'model-b' },
            { id: 'x'.repeat(181) },
          ],
        })
      }),
    }
    const service = createProviderControlService({ ...CONTROL_OPTIONS, resolver, transport })

    await expect(
      service.listModels({
        kind: 'llm',
        providerId: 'openai-compatible',
        endpoint: 'https://provider.test/v1',
        apiKey: 'secret-key',
      }),
    ).resolves.toEqual([
      { id: 'model-a', label: 'model-a' },
      { id: 'model-b', label: 'model-b' },
    ])
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('enforces the configured deadline while DNS resolution is still pending', async () => {
    vi.useFakeTimers()
    const resolver: ProviderAddressResolver = {
      resolve: vi.fn(() => new Promise<readonly ProviderResolvedAddress[]>(() => undefined)),
    }
    const service = createProviderControlService({
      deadlineMs: 25,
      maxInFlight: 1,
      resolver,
      transport: unusedTransport(),
    })

    const pending = service.assertSavable({ provider: openRouterInput(), existing: null })
    const rejection = expect(pending).rejects.toMatchObject({
      status: 504,
      code: 'provider_timeout',
    })
    await vi.advanceTimersByTimeAsync(25)

    await rejection
  })

  it('rejects excess concurrent control requests without opening another resolver task', async () => {
    let enterFirst: () => void = () => undefined
    let releaseFirst: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      enterFirst = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const resolver: ProviderAddressResolver & { resolve: ReturnType<typeof vi.fn> } = {
      resolve: vi.fn(async (_hostname: string): Promise<readonly ProviderResolvedAddress[]> => {
        enterFirst()
        await blocked
        return [{ address: PUBLIC_ADDRESS, family: 4 as const }]
      }),
    }
    const service = createProviderControlService({
      deadlineMs: 1_000,
      maxInFlight: 1,
      resolver,
      transport: unusedTransport(),
    })

    const first = service.assertSavable({ provider: openRouterInput(), existing: null })
    await entered
    await expect(
      service.assertSavable({ provider: openRouterInput(), existing: null }),
    ).rejects.toMatchObject({ status: 429, code: 'provider_busy' })
    expect(resolver.resolve).toHaveBeenCalledTimes(1)
    releaseFirst()
    await expect(first).resolves.toBeUndefined()
  })
})

function openRouterInput(overrides: Partial<ProviderRegistryInput> = {}): ProviderRegistryInput {
  return {
    kind: 'llm',
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    enabled: true,
    mode: 'proxy',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKey: 'test-provider-key',
    defaultModel: 'google/gemini-2.5-flash',
    ...overrides,
  }
}

function providerRecord(overrides: Partial<ProviderRegistryRecord>): ProviderRegistryRecord {
  return {
    id: 'provider-existing',
    kind: 'llm',
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    enabled: true,
    mode: 'proxy',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKeyPreview: 'configured',
    defaultModel: 'google/gemini-2.5-flash',
    models: [],
    capabilities: {},
    priority: 0,
    revision: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function mappedResolver(
  rows: Record<string, readonly ProviderResolvedAddress[]>,
): ProviderAddressResolver & { resolve: ReturnType<typeof vi.fn> } {
  return {
    resolve: vi.fn(async (hostname: string) => rows[hostname] ?? []),
  }
}

function unusedTransport(): ProviderEgressTransport {
  return {
    request: vi.fn(async () => {
      throw new Error('transport should not be used while validating a saved endpoint')
    }),
  }
}
