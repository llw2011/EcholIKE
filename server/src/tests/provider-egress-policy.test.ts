import { describe, expect, it, vi } from 'vitest'
import {
  requestProviderEndpoint,
  sameProviderOrigin,
  validateProviderEndpoint,
  type ProviderAddressResolver,
  type ProviderEgressTransport,
  type ProviderResolvedAddress,
} from '../services/security/provider-egress-policy.js'

const PUBLIC_ORIGIN = 'https://provider.test'
const REDIRECT_ORIGIN = 'https://redirect.test'
const LOCAL_ORIGIN = 'http://127.0.0.1:11434'
const PUBLIC_ADDRESS = '93.184.216.34'
const SECOND_PUBLIC_ADDRESS = '1.1.1.1'

describe('provider endpoint egress policy', () => {
  it('accepts a public HTTPS endpoint and returns the addresses the transport must pin', async () => {
    const resolver = mappedResolver({
      'provider.test': [{ address: PUBLIC_ADDRESS, family: 4 }],
    })

    const endpoint = await validateProviderEndpoint(`${PUBLIC_ORIGIN}/v1/models`, {}, resolver)

    expect(endpoint.origin).toBe(PUBLIC_ORIGIN)
    expect(endpoint.network).toBe('public')
    expect(endpoint.addresses).toEqual([{ address: PUBLIC_ADDRESS, family: 4, scope: 'public' }])
  })

  it.each([
    ['unsupported protocol', 'ftp://provider.test/models', 'unsupported_protocol'],
    ['embedded username', 'https://user@provider.test/models', 'userinfo_forbidden'],
    ['embedded password', 'https://user:secret@provider.test/models', 'userinfo_forbidden'],
    ['query parameters', 'https://provider.test/models?token=secret', 'query_forbidden'],
    ['URL fragment', 'https://provider.test/models#private', 'fragment_forbidden'],
  ])('rejects %s', async (_label, url, code) => {
    await expect(validateProviderEndpoint(url, {}, mappedResolver({}))).rejects.toMatchObject({
      code,
    })
  })

  it('requires an explicit opt-in before sending public provider traffic over HTTP', async () => {
    const resolver = mappedResolver({
      'provider.test': [{ address: PUBLIC_ADDRESS, family: 4 }],
    })

    await expect(
      validateProviderEndpoint('http://provider.test/models', {}, resolver),
    ).rejects.toMatchObject({ code: 'insecure_http_forbidden' })

    await expect(
      validateProviderEndpoint(
        'http://provider.test/models',
        { allowInsecurePublicHttp: true },
        resolver,
      ),
    ).resolves.toMatchObject({ network: 'public' })
  })

  it.each([
    ['loopback', 'http://127.0.0.1:11434/models'],
    ['private IPv4', 'http://10.10.0.8/models'],
    ['link-local metadata range', 'http://169.254.169.254/metadata'],
    ['private IPv6', 'https://[fd00::1]/models'],
    ['IPv6 loopback', 'http://[::1]/models'],
    ['IPv4-mapped private IPv6', 'https://[::ffff:192.168.1.8]/models'],
  ])('rejects %s without an exact local-origin policy', async (_label, url) => {
    await expect(validateProviderEndpoint(url)).rejects.toMatchObject({
      code: 'address_scope_forbidden',
    })
  })

  it('allows only explicitly listed loopback/private origins and still rejects link-local targets', async () => {
    await expect(
      validateProviderEndpoint(`${LOCAL_ORIGIN}/api/tags`, {
        allowedLocalOrigins: [LOCAL_ORIGIN],
      }),
    ).resolves.toMatchObject({ network: 'explicit_local' })

    const metadataOrigin = 'http://169.254.169.254'
    await expect(
      validateProviderEndpoint(`${metadataOrigin}/metadata`, {
        allowedLocalOrigins: [metadataOrigin],
      }),
    ).rejects.toMatchObject({ code: 'address_scope_forbidden' })
  })

  it('rejects DNS answers which mix public and private scopes', async () => {
    const resolver = mappedResolver({
      'provider.test': [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: '10.0.0.9', family: 4 },
      ],
    })

    await expect(validateProviderEndpoint(PUBLIC_ORIGIN, {}, resolver)).rejects.toMatchObject({
      code: 'mixed_address_scope',
    })
  })

  it('compares normalized origins so a stored key cannot silently cross origins', () => {
    expect(sameProviderOrigin('https://PROVIDER.test:443/v1/models', `${PUBLIC_ORIGIN}/chat`)).toBe(
      true,
    )
    expect(sameProviderOrigin(PUBLIC_ORIGIN, 'https://provider.test:8443/v1')).toBe(false)
    expect(sameProviderOrigin(PUBLIC_ORIGIN, REDIRECT_ORIGIN)).toBe(false)
    expect(sameProviderOrigin(PUBLIC_ORIGIN, 'file:///tmp/provider')).toBe(false)
    expect(sameProviderOrigin(PUBLIC_ORIGIN, 'https://user@provider.test')).toBe(false)
  })

  it('resolves and validates every same-origin redirect before the transport follows it', async () => {
    const resolver = mappedResolver({
      'provider.test': [{ address: PUBLIC_ADDRESS, family: 4 }],
    })
    const transport: ProviderEgressTransport = {
      request: vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: '/v2/models' } }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 })),
    }

    const result = await requestProviderEndpoint(
      `${PUBLIC_ORIGIN}/v1/models`,
      { method: 'GET' },
      { resolver, transport },
    )

    expect(result.response.status).toBe(200)
    expect(result.redirects).toBe(1)
    expect(resolver.resolve).toHaveBeenCalledTimes(2)
    expect(transport.request).toHaveBeenCalledTimes(2)
  })

  it('aborts while the initial DNS resolution is pending and ignores a late resolution', async () => {
    const resolution = deferred<readonly ProviderResolvedAddress[]>()
    const resolverEntered = deferred<void>()
    const resolver: ProviderAddressResolver & { resolve: ReturnType<typeof vi.fn> } = {
      resolve: vi.fn(() => {
        resolverEntered.resolve()
        return resolution.promise
      }),
    }
    const transport: ProviderEgressTransport = {
      request: vi.fn(async () => Response.json({ ok: true })),
    }
    const controller = new AbortController()
    const reason = new Error('provider request cancelled during DNS resolution')

    const request = requestProviderEndpoint(
      `${PUBLIC_ORIGIN}/v1/models`,
      { method: 'GET', signal: controller.signal },
      { resolver, transport },
    )
    await resolverEntered.promise

    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
    expect(transport.request).not.toHaveBeenCalled()

    resolution.resolve([{ address: PUBLIC_ADDRESS, family: 4 }])
    await eventLoopBarrier()
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('aborts redirect DNS validation, cancels the prior response, and absorbs a late rejection', async () => {
    const redirectedResolution = deferred<readonly ProviderResolvedAddress[]>()
    const redirectedResolverEntered = deferred<void>()
    const responseBodyCancelled = deferred<void>()
    const resolver: ProviderAddressResolver & { resolve: ReturnType<typeof vi.fn> } = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce([{ address: PUBLIC_ADDRESS, family: 4 }])
        .mockImplementationOnce(() => {
          redirectedResolverEntered.resolve()
          return redirectedResolution.promise
        }),
    }
    const controller = new AbortController()
    const transport: ProviderEgressTransport = {
      request: vi.fn(async (_endpoint, init) => {
        expect(init.signal).toBe(controller.signal)
        return new Response(
          new ReadableStream({
            cancel() {
              responseBodyCancelled.resolve()
            },
          }),
          { status: 302, headers: { location: '/redirected' } },
        )
      }),
    }
    const reason = new Error('provider request cancelled during redirect DNS resolution')

    const request = requestProviderEndpoint(
      PUBLIC_ORIGIN,
      { signal: controller.signal },
      { resolver, transport },
    )
    await redirectedResolverEntered.promise

    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
    await responseBodyCancelled.promise
    expect(transport.request).toHaveBeenCalledTimes(1)

    redirectedResolution.reject(new Error('late resolver failure'))
    await eventLoopBarrier()
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('blocks DNS rebinding when the same redirect host changes from public to private', async () => {
    const resolver: ProviderAddressResolver & { resolve: ReturnType<typeof vi.fn> } = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce([{ address: PUBLIC_ADDRESS, family: 4 }])
        .mockResolvedValueOnce([{ address: '10.0.0.7', family: 4 }]),
    }
    const transport: ProviderEgressTransport = {
      request: vi.fn(
        async () => new Response(null, { status: 302, headers: { location: '/redirected' } }),
      ),
    }

    await expect(
      requestProviderEndpoint(PUBLIC_ORIGIN, {}, { resolver, transport }),
    ).rejects.toMatchObject({ code: 'address_scope_forbidden' })
    expect(resolver.resolve).toHaveBeenCalledTimes(2)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('validates a cross-origin redirect before rejecting it by default', async () => {
    const resolver = mappedResolver({
      'provider.test': [{ address: PUBLIC_ADDRESS, family: 4 }],
      'redirect.test': [{ address: SECOND_PUBLIC_ADDRESS, family: 4 }],
    })
    const transport: ProviderEgressTransport = {
      request: vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: `${REDIRECT_ORIGIN}/models` } }),
      ),
    }

    await expect(
      requestProviderEndpoint(
        `${PUBLIC_ORIGIN}/models`,
        { headers: { authorization: 'Bearer test-secret' } },
        { resolver, transport },
      ),
    ).rejects.toMatchObject({ code: 'cross_origin_redirect_forbidden' })

    expect(resolver.resolve).toHaveBeenCalledTimes(2)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('strips credentials if a caller explicitly permits a validated cross-origin redirect', async () => {
    const resolver = mappedResolver({
      'provider.test': [{ address: PUBLIC_ADDRESS, family: 4 }],
      'redirect.test': [{ address: SECOND_PUBLIC_ADDRESS, family: 4 }],
    })
    const seenHeaders: Headers[] = []
    const transport: ProviderEgressTransport = {
      request: vi.fn(async (endpoint, init) => {
        seenHeaders.push(new Headers(init.headers))
        return endpoint.origin === PUBLIC_ORIGIN
          ? new Response(null, {
              status: 302,
              headers: { location: `${REDIRECT_ORIGIN}/models` },
            })
          : new Response('{}', { status: 200 })
      }),
    }

    const result = await requestProviderEndpoint(
      `${PUBLIC_ORIGIN}/models`,
      {
        headers: {
          authorization: 'Bearer test-secret',
          cookie: 'session=test-secret',
          'x-correlation-id': 'safe-value',
        },
      },
      {
        resolver,
        transport,
        policy: { allowCrossOriginRedirects: true },
      },
    )

    expect(result.redirects).toBe(1)
    expect(seenHeaders[1]?.has('authorization')).toBe(false)
    expect(seenHeaders[1]?.has('cookie')).toBe(false)
    expect(seenHeaders[1]?.get('x-correlation-id')).toBe('safe-value')
  })

  it('rejects a redirect to a private target even when cross-origin redirects are enabled', async () => {
    const resolver = mappedResolver({
      'provider.test': [{ address: PUBLIC_ADDRESS, family: 4 }],
      'internal.test': [{ address: '192.168.10.2', family: 4 }],
    })
    const transport: ProviderEgressTransport = {
      request: vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://internal.test/models' },
          }),
      ),
    }

    await expect(
      requestProviderEndpoint(
        PUBLIC_ORIGIN,
        {},
        {
          resolver,
          transport,
          policy: { allowCrossOriginRedirects: true },
        },
      ),
    ).rejects.toMatchObject({ code: 'address_scope_forbidden' })
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('bounds redirect chains', async () => {
    const resolver = mappedResolver({
      'provider.test': [{ address: PUBLIC_ADDRESS, family: 4 }],
    })
    const transport: ProviderEgressTransport = {
      request: vi.fn(
        async () => new Response(null, { status: 302, headers: { location: '/again' } }),
      ),
    }

    await expect(
      requestProviderEndpoint(PUBLIC_ORIGIN, {}, { resolver, transport, maxRedirects: 1 }),
    ).rejects.toMatchObject({ code: 'redirect_limit_exceeded' })
    expect(transport.request).toHaveBeenCalledTimes(2)
  })
})

function mappedResolver(
  rows: Record<string, readonly ProviderResolvedAddress[]>,
): ProviderAddressResolver & { resolve: ReturnType<typeof vi.fn> } {
  return {
    resolve: vi.fn(async (hostname: string) => rows[hostname] ?? []),
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function eventLoopBarrier(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
