import { describe, expect, it, vi } from 'vitest'
import { createProviderEgressFetch } from '../services/security/provider-egress-fetch.js'
import type {
  ProviderAddressResolver,
  ProviderEgressTransport,
} from '../services/security/provider-egress-policy.js'

describe('production provider egress fetch', () => {
  it('validates and pins every real POST request instead of trusting save-time DNS', async () => {
    const resolver: ProviderAddressResolver & { resolve: ReturnType<typeof vi.fn> } = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '10.0.0.8', family: 4 }]),
    }
    const transport: ProviderEgressTransport = {
      request: vi.fn(async (endpoint, init) => {
        expect(endpoint.addresses[0]).toMatchObject({ address: '93.184.216.34', scope: 'public' })
        expect(init.method).toBe('POST')
        return Response.json({ ok: true })
      }),
    }
    const providerFetch = createProviderEgressFetch({
      maxResponseBytes: 1024,
      resolver,
      transport,
    })

    await expect(
      providerFetch('https://provider.test/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: '{}',
      }),
    ).resolves.toMatchObject({ status: 200 })
    await expect(
      providerFetch('https://provider.test/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toMatchObject({ code: 'address_scope_forbidden' })
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('allows product-owned loopback origins but rejects arbitrary local services', async () => {
    const transport: ProviderEgressTransport = {
      request: vi.fn(async () => Response.json({ ok: true })),
    }
    const providerFetch = createProviderEgressFetch({ maxResponseBytes: 1024, transport })

    await expect(
      providerFetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        body: '{}',
      }),
    ).resolves.toMatchObject({ status: 200 })
    await expect(
      providerFetch('http://127.0.0.1:6553/internal', { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({ code: 'address_scope_forbidden' })
  })

  it('allows only server-authoritative active native origins at request time', async () => {
    const resolver: ProviderAddressResolver = {
      resolve: vi.fn(async () => [{ address: '10.0.0.8', family: 4 as const }]),
    }
    const transport: ProviderEgressTransport = {
      request: vi.fn(async () => Response.json({ ok: true })),
    }
    const trustedLocalOrigins = vi.fn(async () => ['http://llm-gateway.test:11440'])
    const providerFetch = createProviderEgressFetch({
      maxResponseBytes: 1024,
      resolver,
      transport,
      trustedLocalOrigins,
    })

    await expect(
      providerFetch('http://llm-gateway.test:11440/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      }),
    ).resolves.toMatchObject({ status: 200 })
    await expect(
      providerFetch('http://other-private.test:11440/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toMatchObject({ code: 'address_scope_forbidden' })
    expect(trustedLocalOrigins).toHaveBeenCalledTimes(2)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('revokes a previously trusted private origin on the next request', async () => {
    const resolver: ProviderAddressResolver = {
      resolve: vi.fn(async () => [{ address: '10.0.0.8', family: 4 as const }]),
    }
    const transport: ProviderEgressTransport = {
      request: vi.fn(async () => Response.json({ ok: true })),
    }
    const trustedLocalOrigins = vi
      .fn<() => Promise<readonly string[]>>()
      .mockResolvedValueOnce(['http://llm-gateway.test:11440'])
      .mockResolvedValueOnce([])
    const providerFetch = createProviderEgressFetch({
      maxResponseBytes: 1024,
      resolver,
      transport,
      trustedLocalOrigins,
    })
    const request = () =>
      providerFetch('http://llm-gateway.test:11440/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      })

    await expect(request()).resolves.toMatchObject({ status: 200 })
    await expect(request()).rejects.toMatchObject({ code: 'address_scope_forbidden' })
    expect(trustedLocalOrigins).toHaveBeenCalledTimes(2)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a trusted-origin supplier returns a path instead of an origin', async () => {
    const resolver: ProviderAddressResolver = {
      resolve: vi.fn(async () => [{ address: '10.0.0.8', family: 4 as const }]),
    }
    const transport: ProviderEgressTransport = {
      request: vi.fn(async () => Response.json({ ok: true })),
    }
    const providerFetch = createProviderEgressFetch({
      maxResponseBytes: 1024,
      resolver,
      transport,
      trustedLocalOrigins: async () => ['http://llm-gateway.test:11440/v1'],
    })

    await expect(
      providerFetch('http://llm-gateway.test:11440/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toMatchObject({ code: 'origin_policy_invalid' })
    expect(transport.request).not.toHaveBeenCalled()
  })
})
