import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions as NodeRequestOptions } from 'node:https'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ValidatedProviderEndpoint } from '../services/security/provider-egress-policy.js'
import {
  createProviderNodeTransport,
  type ProviderNodeRequestFactory,
} from '../services/security/provider-node-transport.js'

const PROVIDER_ADDRESS = '93.184.216.34'

describe('provider Node transport', () => {
  it('pins the socket address while preserving Host and TLS SNI', async () => {
    const harness = respondingHarness({ bodyChunks: ['ok'] })
    const unusedHttp = vi.fn<ProviderNodeRequestFactory>()
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      httpRequest: unusedHttp,
      httpsRequest: harness.factory,
    })

    const response = await transport.request(providerEndpoint(), {
      method: 'GET',
      headers: {
        authorization: 'Bearer provider-secret',
        host: 'attacker.invalid',
      },
    })

    expect(await response.text()).toBe('ok')
    expect(unusedHttp).not.toHaveBeenCalled()
    expect(harness.factory).toHaveBeenCalledTimes(1)
    expect(harness.options).toMatchObject({
      protocol: 'https:',
      hostname: 'provider.test',
      port: 8443,
      path: '/v1/models?limit=1',
      method: 'GET',
      family: 4,
      servername: 'provider.test',
      agent: false,
    })

    const headers = new Headers(harness.options?.headers as HeadersInit)
    expect(headers.get('host')).toBe('provider.test:8443')
    expect(headers.get('authorization')).toBe('Bearer provider-secret')

    const lookup = harness.options?.lookup
    expect(lookup).toBeTypeOf('function')
    let resolvedAddress: unknown
    let resolvedFamily: unknown
    lookup?.('provider.test', { all: false }, (error, address, family) => {
      expect(error).toBeNull()
      resolvedAddress = address
      resolvedFamily = family
    })
    expect(resolvedAddress).toBe(PROVIDER_ADDRESS)
    expect(resolvedFamily).toBe(4)

    let rejectedLookupCode: string | undefined
    lookup?.('different.test', { all: false }, (error) => {
      rejectedLookupCode = error?.code
    })
    expect(rejectedLookupCode).toBe('EAI_FAIL')
  })

  it('uses the same pinned lookup for HTTP without inventing TLS options', async () => {
    const harness = respondingHarness({ bodyChunks: ['http-ok'] })
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      httpRequest: harness.factory,
      httpsRequest: vi.fn<ProviderNodeRequestFactory>(),
    })

    const response = await transport.request(providerEndpoint('http://provider.test:8080/models'), {
      method: 'HEAD',
    })

    expect(response.body).toBeNull()
    expect(harness.options).toMatchObject({
      protocol: 'http:',
      hostname: 'provider.test',
      port: 8080,
      method: 'HEAD',
    })
    expect(harness.options).not.toHaveProperty('servername')
  })

  it('rejects write methods unless the caller explicitly enables bounded request bodies', async () => {
    const requestFactory = vi.fn<ProviderNodeRequestFactory>()
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      httpsRequest: requestFactory,
    })

    await expect(transport.request(providerEndpoint(), { method: 'POST' })).rejects.toMatchObject({
      code: 'method_forbidden',
    })
    await expect(
      transport.request(providerEndpoint(), { method: 'GET', body: 'not-allowed' }),
    ).rejects.toMatchObject({ code: 'request_body_forbidden' })
    expect(requestFactory).not.toHaveBeenCalled()
  })

  it('serializes JSON and multipart POST bodies through the pinned socket', async () => {
    const jsonHarness = respondingHarness({ bodyChunks: ['{}'] })
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      allowRequestBody: true,
      httpsRequest: jsonHarness.factory,
    })

    await transport.request(providerEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'safe-model' }),
    })
    expect(Buffer.concat(jsonHarness.request?.writes ?? []).toString('utf8')).toBe(
      '{"model":"safe-model"}',
    )
    expect(new Headers(jsonHarness.options?.headers as HeadersInit).get('content-length')).toBe(
      '22',
    )

    const multipartHarness = respondingHarness({ bodyChunks: ['{}'] })
    const multipartTransport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      allowRequestBody: true,
      httpsRequest: multipartHarness.factory,
    })
    const form = new FormData()
    form.append('model', 'whisper-1')
    form.append('file', new Blob(['wave']), 'audio.wav')
    await multipartTransport.request(providerEndpoint(), { method: 'POST', body: form })

    const multipartHeaders = new Headers(multipartHarness.options?.headers as HeadersInit)
    expect(multipartHeaders.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    expect(Buffer.concat(multipartHarness.request?.writes ?? []).toString('utf8')).toContain(
      'whisper-1',
    )
  })

  it('rejects an inconsistent literal endpoint instead of bypassing pinned lookup', async () => {
    const requestFactory = vi.fn<ProviderNodeRequestFactory>()
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      httpsRequest: requestFactory,
    })
    const endpoint = providerEndpoint('https://192.0.2.10/models')

    await expect(transport.request(endpoint, {})).rejects.toMatchObject({
      code: 'validated_address_mismatch',
    })
    expect(requestFactory).not.toHaveBeenCalled()
  })

  it('rejects a pre-aborted request without opening a socket', async () => {
    const controller = new AbortController()
    controller.abort()
    const requestFactory = vi.fn<ProviderNodeRequestFactory>()
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      httpsRequest: requestFactory,
    })

    await expect(
      transport.request(providerEndpoint(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestFactory).not.toHaveBeenCalled()
  })

  it('destroys an in-flight socket when the caller aborts', async () => {
    const harness = hangingRequestHarness()
    const controller = new AbortController()
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      httpsRequest: harness.factory,
    })

    const pending = transport.request(providerEndpoint(), { signal: controller.signal })
    await harness.opened
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.request?.destroy).toHaveBeenCalledTimes(1)
    expect(harness.request?.destroy.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' })
  })

  it('aborts a response body after headers have been delivered', async () => {
    const harness = respondingHarness({ autoEnd: false })
    const controller = new AbortController()
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      httpsRequest: harness.factory,
    })
    const response = await transport.request(providerEndpoint(), { signal: controller.signal })
    const pendingRead = response.body?.getReader().read()

    controller.abort()

    await expect(pendingRead).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.request?.destroy).toHaveBeenCalled()
    expect(harness.incoming?.destroyed).toBe(true)
  })

  it('owns HEAD response stream errors after headers are delivered', async () => {
    const harness = respondingHarness({ autoEnd: false })
    const transport = createProviderNodeTransport({
      maxResponseBytes: 1024,
      httpsRequest: harness.factory,
    })

    const response = await transport.request(providerEndpoint(), { method: 'HEAD' })
    expect(response.body).toBeNull()
    expect(() => harness.incoming?.emit('error', new Error('late socket failure'))).not.toThrow()
  })

  it('errors the response stream and destroys the socket at the byte limit', async () => {
    const harness = respondingHarness({ bodyChunks: ['123', '456'] })
    const transport = createProviderNodeTransport({
      maxResponseBytes: 5,
      httpsRequest: harness.factory,
    })

    const response = await transport.request(providerEndpoint(), {})

    await expect(response.text()).rejects.toMatchObject({ code: 'response_too_large' })
    expect(harness.request?.destroy).toHaveBeenCalled()
    expect(harness.incoming?.destroyed).toBe(true)
  })

  it('rejects an oversized declared response before exposing a body', async () => {
    const harness = respondingHarness({
      headers: { 'content-length': '6' },
      bodyChunks: ['123456'],
    })
    const transport = createProviderNodeTransport({
      maxResponseBytes: 5,
      httpsRequest: harness.factory,
    })

    await expect(transport.request(providerEndpoint(), {})).rejects.toMatchObject({
      code: 'response_too_large',
    })
    expect(harness.request?.destroy).toHaveBeenCalled()
    expect(harness.incoming?.destroyed).toBe(true)
  })

  it('requires a positive caller-supplied response limit', () => {
    expect(() => createProviderNodeTransport({ maxResponseBytes: 0 })).toThrowError(
      expect.objectContaining({ code: 'invalid_max_response_bytes' }),
    )
    expect(() => createProviderNodeTransport({ maxResponseBytes: Number.NaN })).toThrowError(
      expect.objectContaining({ code: 'invalid_max_response_bytes' }),
    )
  })
})

class FakeClientRequest extends EventEmitter {
  destroyed = false
  readonly writes: Buffer[] = []
  readonly end: ReturnType<typeof vi.fn>
  readonly write = vi.fn((chunk: Uint8Array) => {
    this.writes.push(Buffer.from(chunk))
    return true
  })
  readonly destroy = vi.fn((error?: Error) => {
    if (this.destroyed) return this
    this.destroyed = true
    if (error) queueMicrotask(() => this.emit('error', error))
    queueMicrotask(() => this.emit('close'))
    return this
  })

  constructor(onEnd: () => void) {
    super()
    this.end = vi.fn(onEnd)
  }
}

interface ResponseHarnessOptions {
  status?: number
  headers?: Record<string, string>
  bodyChunks?: readonly string[]
  autoEnd?: boolean
}

interface RequestHarness {
  factory: ProviderNodeRequestFactory
  opened: Promise<void>
  options?: NodeRequestOptions
  request?: FakeClientRequest
  incoming?: FakeIncoming
}

type FakeIncoming = IncomingMessage & PassThrough

function respondingHarness(options: ResponseHarnessOptions = {}): RequestHarness {
  let markOpened: () => void = () => undefined
  const harness: RequestHarness = {
    factory: undefined as unknown as ProviderNodeRequestFactory,
    opened: new Promise<void>((resolve) => {
      markOpened = resolve
    }),
  }
  harness.factory = vi.fn((requestOptions, callback) => {
    markOpened()
    harness.options = requestOptions
    const incoming = fakeIncoming(options.status ?? 200, options.headers ?? {})
    harness.incoming = incoming
    const request = new FakeClientRequest(() => {
      queueMicrotask(() => {
        if (request.destroyed) return
        callback(incoming)
        if (options.autoEnd === false) return
        queueMicrotask(() => {
          if (incoming.destroyed) return
          for (const chunk of options.bodyChunks ?? []) incoming.write(Buffer.from(chunk))
          setIncomingComplete(incoming, true)
          incoming.end()
        })
      })
    })
    harness.request = request
    return request as unknown as ClientRequest
  })
  return harness
}

function hangingRequestHarness(): RequestHarness {
  let markOpened: () => void = () => undefined
  const harness: RequestHarness = {
    factory: undefined as unknown as ProviderNodeRequestFactory,
    opened: new Promise<void>((resolve) => {
      markOpened = resolve
    }),
  }
  harness.factory = vi.fn((requestOptions) => {
    markOpened()
    harness.options = requestOptions
    const request = new FakeClientRequest(() => undefined)
    harness.request = request
    return request as unknown as ClientRequest
  })
  return harness
}

function fakeIncoming(status: number, headers: Record<string, string>): FakeIncoming {
  const incoming = new PassThrough() as FakeIncoming
  Object.assign(incoming, {
    statusCode: status,
    statusMessage: 'OK',
    headers,
    complete: false,
  })
  return incoming
}

function setIncomingComplete(incoming: FakeIncoming, complete: boolean): void {
  Object.assign(incoming, { complete })
}

function providerEndpoint(
  input = 'https://provider.test:8443/v1/models?limit=1',
): ValidatedProviderEndpoint {
  const url = new URL(input)
  return {
    url,
    origin: url.origin,
    hostname: url.hostname,
    addresses: [{ address: PROVIDER_ADDRESS, family: 4, scope: 'public' }],
    network: 'public',
  }
}
