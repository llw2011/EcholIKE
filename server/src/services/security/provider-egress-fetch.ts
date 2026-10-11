import { PROVIDER_PRESETS } from '../proxy/provider-presets.js'
import {
  requestProviderEndpoint,
  type ProviderAddressResolver,
  type ProviderEgressTransport,
  type ProviderEndpointPolicy,
} from './provider-egress-policy.js'
import { createProviderNodeTransport } from './provider-node-transport.js'
import { providerRuntimeAddressResolver } from './provider-runtime-address.js'

export interface ProviderEgressFetchOptions {
  maxResponseBytes: number
  resolver?: ProviderAddressResolver
  transport?: ProviderEgressTransport
  /** Server-authoritative active native origins; never derive these from a request body. */
  trustedLocalOrigins?: () => readonly string[] | Promise<readonly string[]>
}

/**
 * Fetch-compatible provider transport used by production proxy services.
 * Every request and redirect is resolved, scope-checked and connected through
 * one validated address without a second DNS lookup.
 */
export function createProviderEgressFetch(options: ProviderEgressFetchOptions): typeof fetch {
  const resolver = options.resolver ?? providerRuntimeAddressResolver
  const transport =
    options.transport ??
    createProviderNodeTransport({
      maxResponseBytes: options.maxResponseBytes,
      allowRequestBody: true,
    })

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const normalized = await normalizeFetchInput(input, init)
    const trustedLocalOrigins = (await options.trustedLocalOrigins?.()) ?? []
    const { response } = await requestProviderEndpoint(normalized.url, normalized.init, {
      resolver,
      transport,
      policy: runtimeProviderPolicy(trustedLocalOrigins),
    })
    return response
  }) as typeof fetch
}

export function runtimeProviderPolicy(
  trustedLocalOrigins: readonly string[] = [],
): ProviderEndpointPolicy {
  const localOrigins = new Set<string>()
  for (const preset of PROVIDER_PRESETS) {
    for (const value of [preset.baseUrl, preset.endpoint]) {
      if (!value) continue
      try {
        const url = new URL(value)
        if (url.protocol === 'http:') localOrigins.add(url.origin)
      } catch {
        // Product preset validation remains fail-closed at request time.
      }
    }
  }
  for (const origin of trustedLocalOrigins) localOrigins.add(origin)
  return { allowedLocalOrigins: [...localOrigins] }
}

async function normalizeFetchInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ url: string; init: RequestInit }> {
  if (!(input instanceof Request)) {
    return { url: input.toString(), init: init ?? {} }
  }

  const request = new Request(input, init)
  const method = request.method.toUpperCase()
  const body =
    method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer())
  return {
    url: request.url,
    init: {
      method,
      headers: new Headers(request.headers),
      ...(body ? { body } : {}),
      signal: request.signal,
    },
  }
}
