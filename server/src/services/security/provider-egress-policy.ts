import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type ProviderAddressScope =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'carrier_grade'
  | 'documentation'
  | 'benchmark'
  | 'multicast'
  | 'reserved'
  | 'unspecified'

export type ProviderEgressErrorCode =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'userinfo_forbidden'
  | 'query_forbidden'
  | 'fragment_forbidden'
  | 'origin_policy_invalid'
  | 'dns_resolution_failed'
  | 'dns_resolution_empty'
  | 'resolved_address_invalid'
  | 'address_scope_forbidden'
  | 'mixed_address_scope'
  | 'insecure_http_forbidden'
  | 'redirect_location_missing'
  | 'redirect_limit_exceeded'
  | 'cross_origin_redirect_forbidden'

export class ProviderEgressPolicyError extends Error {
  constructor(
    readonly code: ProviderEgressErrorCode,
    options: { cause?: unknown } = {},
  ) {
    super(`Provider endpoint rejected: ${code}`, options)
    this.name = 'ProviderEgressPolicyError'
  }
}

export interface ProviderResolvedAddress {
  address: string
  family: 4 | 6
}

export interface ProviderAddressResolver {
  resolve(hostname: string): Promise<readonly ProviderResolvedAddress[]>
}

export interface ProviderEndpointPolicy {
  /** Exact origins which may resolve entirely to loopback or RFC1918/ULA addresses. */
  allowedLocalOrigins?: readonly string[]
  /** Public provider traffic is HTTPS-only unless the caller opts in explicitly. */
  allowInsecurePublicHttp?: boolean
  /** Cross-origin redirects are rejected unless explicitly enabled. */
  allowCrossOriginRedirects?: boolean
}

export interface ValidatedProviderEndpoint {
  url: URL
  origin: string
  hostname: string
  addresses: readonly (ProviderResolvedAddress & { scope: ProviderAddressScope })[]
  network: 'public' | 'explicit_local'
}

/**
 * The transport must connect only to one of `endpoint.addresses`, while preserving
 * `endpoint.hostname` for the HTTP Host header and TLS SNI/certificate checks.
 * Re-resolving the hostname inside the transport would reopen a DNS-rebinding gap.
 */
export interface ProviderEgressTransport {
  request(endpoint: ValidatedProviderEndpoint, init: RequestInit): Promise<Response>
}

export interface ProviderEgressRequestOptions {
  transport: ProviderEgressTransport
  resolver?: ProviderAddressResolver
  policy?: ProviderEndpointPolicy
  maxRedirects?: number
}

export interface ProviderEgressResponse {
  response: Response
  endpoint: ValidatedProviderEndpoint
  redirects: number
}

const MAX_REDIRECTS_UPPER_BOUND = 10
const DEFAULT_MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const REDIRECT_SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'cookie'] as const
const EXPLICIT_LOCAL_SCOPES = new Set<ProviderAddressScope>(['loopback', 'private'])

export const nodeProviderAddressResolver: ProviderAddressResolver = {
  async resolve(hostname) {
    const rows = await lookup(hostname, { all: true, verbatim: true })
    return rows.map((row) => ({
      address: row.address,
      family: row.family === 6 ? 6 : 4,
    }))
  },
}

export async function validateProviderEndpoint(
  input: string | URL,
  policy: ProviderEndpointPolicy = {},
  resolver: ProviderAddressResolver = nodeProviderAddressResolver,
  signal?: AbortSignal | null,
): Promise<ValidatedProviderEndpoint> {
  throwIfProviderRequestAborted(signal)
  const url = providerHttpUrl(input)
  const hostname = normalizedHostname(url)
  const allowedLocalOrigins = normalizeAllowedLocalOrigins(policy.allowedLocalOrigins ?? [])
  const explicitlyAllowedLocal = allowedLocalOrigins.has(url.origin)

  let resolved: readonly ProviderResolvedAddress[]
  const literalFamily = isIP(hostname)
  if (literalFamily === 4 || literalFamily === 6) {
    resolved = [{ address: hostname, family: literalFamily }]
  } else {
    resolved = await resolveProviderAddresses(hostname, resolver, signal)
  }
  throwIfProviderRequestAborted(signal)

  if (!resolved.length) throw new ProviderEgressPolicyError('dns_resolution_empty')

  const addresses = deduplicateAddresses(
    resolved.map((row) => {
      const actualFamily = isIP(row.address)
      if (actualFamily !== row.family || (actualFamily !== 4 && actualFamily !== 6)) {
        throw new ProviderEgressPolicyError('resolved_address_invalid')
      }
      return { ...row, scope: providerAddressScope(row.address) }
    }),
  )
  const scopes = new Set(addresses.map((row) => row.scope))
  const hasPublic = scopes.has('public')
  const hasNonPublic = addresses.some((row) => row.scope !== 'public')

  if (hasPublic && hasNonPublic) {
    throw new ProviderEgressPolicyError('mixed_address_scope')
  }

  let network: ValidatedProviderEndpoint['network']
  if (!hasNonPublic) {
    network = 'public'
    if (url.protocol === 'http:' && !policy.allowInsecurePublicHttp) {
      throw new ProviderEgressPolicyError('insecure_http_forbidden')
    }
  } else {
    const allExplicitLocal = addresses.every((row) => EXPLICIT_LOCAL_SCOPES.has(row.scope))
    if (!explicitlyAllowedLocal || !allExplicitLocal) {
      throw new ProviderEgressPolicyError('address_scope_forbidden')
    }
    network = 'explicit_local'
  }

  return {
    url: new URL(url.toString()),
    origin: url.origin,
    hostname,
    addresses,
    network,
  }
}

export async function requestProviderEndpoint(
  input: string | URL,
  init: RequestInit,
  options: ProviderEgressRequestOptions,
): Promise<ProviderEgressResponse> {
  const resolver = options.resolver ?? nodeProviderAddressResolver
  const policy = options.policy ?? {}
  const maxRedirects = validatedRedirectLimit(options.maxRedirects)
  let endpoint = await validateProviderEndpoint(input, policy, resolver, init.signal)
  let requestInit = withManualRedirect(init)
  let redirects = 0

  while (true) {
    const response = await options.transport.request(endpoint, requestInit)
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, endpoint, redirects }
    }

    if (redirects >= maxRedirects) {
      await cancelResponseBody(response)
      throw new ProviderEgressPolicyError('redirect_limit_exceeded')
    }

    const location = response.headers.get('location')?.trim()
    if (!location) {
      await cancelResponseBody(response)
      throw new ProviderEgressPolicyError('redirect_location_missing')
    }

    let redirectedUrl: URL
    try {
      redirectedUrl = new URL(location, endpoint.url)
    } catch (error) {
      await cancelResponseBody(response)
      throw new ProviderEgressPolicyError('invalid_url', { cause: error })
    }

    // Validate and resolve every hop before any redirected request is sent.
    const nextEndpoint = await validateProviderEndpoint(
      redirectedUrl,
      policy,
      resolver,
      requestInit.signal,
    ).catch(async (error) => {
      await cancelResponseBody(response)
      throw error
    })
    const sameOrigin = endpoint.origin === nextEndpoint.origin
    if (!sameOrigin && !policy.allowCrossOriginRedirects) {
      await cancelResponseBody(response)
      throw new ProviderEgressPolicyError('cross_origin_redirect_forbidden')
    }

    await cancelResponseBody(response)
    requestInit = redirectRequestInit(requestInit, response.status, sameOrigin)
    endpoint = nextEndpoint
    redirects += 1
  }
}

/** Returns false for malformed/non-HTTP(S) endpoints instead of permitting key reuse. */
export function sameProviderOrigin(left: string | URL, right: string | URL): boolean {
  try {
    return providerHttpUrl(left).origin === providerHttpUrl(right).origin
  } catch {
    return false
  }
}

/** Validates only the URL shape; it performs no DNS lookup or network request. */
export function validateProviderEndpointShape(input: string | URL): URL {
  return providerHttpUrl(input)
}

export function providerAddressScope(address: string): ProviderAddressScope {
  const family = isIP(address)
  if (family === 4) return ipv4Scope(address)
  if (family === 6) return ipv6Scope(address)
  return 'reserved'
}

function providerHttpUrl(input: string | URL): URL {
  let url: URL
  try {
    url = new URL(input.toString())
  } catch (error) {
    throw new ProviderEgressPolicyError('invalid_url', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderEgressPolicyError('unsupported_protocol')
  }
  if (url.username || url.password) {
    throw new ProviderEgressPolicyError('userinfo_forbidden')
  }
  if (url.search) throw new ProviderEgressPolicyError('query_forbidden')
  if (url.hash) throw new ProviderEgressPolicyError('fragment_forbidden')
  if (!url.hostname || url.origin === 'null') {
    throw new ProviderEgressPolicyError('invalid_url')
  }
  return url
}

function normalizeAllowedLocalOrigins(values: readonly string[]): Set<string> {
  const origins = new Set<string>()
  for (const value of values) {
    let url: URL
    try {
      url = providerHttpUrl(value)
    } catch (error) {
      throw new ProviderEgressPolicyError('origin_policy_invalid', { cause: error })
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new ProviderEgressPolicyError('origin_policy_invalid')
    }
    origins.add(url.origin)
  }
  return origins
}

function normalizedHostname(url: URL): string {
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname
  if (hostname.includes('%')) throw new ProviderEgressPolicyError('invalid_url')
  return hostname
}

function deduplicateAddresses(
  rows: Array<ProviderResolvedAddress & { scope: ProviderAddressScope }>,
): Array<ProviderResolvedAddress & { scope: ProviderAddressScope }> {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.family}:${row.address}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validatedRedirectLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_REDIRECTS_UPPER_BOUND) {
    throw new ProviderEgressPolicyError('redirect_limit_exceeded')
  }
  return limit
}

function withManualRedirect(init: RequestInit): RequestInit {
  return { ...init, redirect: 'manual' }
}

function redirectRequestInit(init: RequestInit, status: number, sameOrigin: boolean): RequestInit {
  const headers = new Headers(init.headers)
  if (!sameOrigin) {
    for (const name of REDIRECT_SENSITIVE_HEADERS) headers.delete(name)
  }

  const method = (init.method ?? 'GET').toUpperCase()
  const switchToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST')
  if (!switchToGet) return { ...init, headers, redirect: 'manual' }

  headers.delete('content-length')
  headers.delete('content-type')
  return { ...init, method: 'GET', body: null, headers, redirect: 'manual' }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function resolveProviderAddresses(
  hostname: string,
  resolver: ProviderAddressResolver,
  signal: AbortSignal | null | undefined,
): Promise<readonly ProviderResolvedAddress[]> {
  throwIfProviderRequestAborted(signal)

  let resolution: Promise<readonly ProviderResolvedAddress[]>
  try {
    resolution = Promise.resolve(resolver.resolve(hostname)).catch((error: unknown) => {
      throw new ProviderEgressPolicyError('dns_resolution_failed', { cause: error })
    })
  } catch (error) {
    resolution = Promise.reject(
      new ProviderEgressPolicyError('dns_resolution_failed', { cause: error }),
    )
  }

  if (!signal) return await resolution
  return await waitForProviderOperation(resolution, signal)
}

function waitForProviderOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: (value: T | PromiseLike<T>) => void, value: T) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      complete(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = () => fail(providerRequestAbortReason(signal))

    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => finish(resolve, value),
      (error: unknown) => fail(error),
    )
    if (signal.aborted) onAbort()
  })
}

function throwIfProviderRequestAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw providerRequestAbortReason(signal)
}

function providerRequestAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}

function ipv4Scope(address: string): ProviderAddressScope {
  const bytes = parseIpv4(address)
  if (!bytes) return 'reserved'
  const [a, b, c, d] = bytes
  if (a === undefined || b === undefined || c === undefined || d === undefined) return 'reserved'

  if (a === 0) return 'unspecified'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'private'
  }
  if (a === 100 && b >= 64 && b <= 127) return 'carrier_grade'
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link_local'
  if (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return 'documentation'
  }
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark'
  if (a >= 224 && a <= 239) return 'multicast'
  if (
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    a >= 240 ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  ) {
    return 'reserved'
  }
  return 'public'
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : NaN))
  return bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? bytes
    : null
}

function ipv6Scope(address: string): ProviderAddressScope {
  const words = parseIpv6(address)
  if (!words) return 'reserved'
  const allZero = words.every((word) => word === 0)
  if (allZero) return 'unspecified'
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return 'loopback'

  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0)
  if (ipv4Mapped || ipv4Compatible) {
    return ipv4Scope(wordsToIpv4(words[6] ?? 0, words[7] ?? 0))
  }

  const first = words[0] ?? 0
  if ((first & 0xfe00) === 0xfc00) return 'private'
  if ((first & 0xffc0) === 0xfe80) return 'link_local'
  if ((first & 0xffc0) === 0xfec0) return 'private'
  if ((first & 0xff00) === 0xff00) return 'multicast'
  if (first === 0x2001 && words[1] === 0x0db8) return 'documentation'
  if (first === 0x2001 && words[1] === 0x0002 && words[2] === 0) return 'benchmark'
  if (first === 0x0100 && words.slice(1, 4).every((word) => word === 0)) return 'reserved'
  if (first === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001) return 'reserved'
  if ((first & 0xe000) === 0x2000) return 'public'
  return 'reserved'
}

function parseIpv6(address: string): number[] | null {
  let value = address.toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (!value || value.includes('%')) return null

  const dottedAt = value.lastIndexOf(':')
  if (value.includes('.')) {
    if (dottedAt < 0) return null
    const ipv4 = parseIpv4(value.slice(dottedAt + 1))
    if (!ipv4) return null
    const [a = 0, b = 0, c = 0, d = 0] = ipv4
    value = `${value.slice(0, dottedAt)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  if ((value.match(/::/g) ?? []).length > 1) return null
  const compressed = value.includes('::')
  const [leftRaw = '', rightRaw = ''] = compressed ? value.split('::') : [value, '']
  const left = leftRaw ? leftRaw.split(':') : []
  const right = rightRaw ? rightRaw.split(':') : []
  if (![...left, ...right].every((word) => /^[0-9a-f]{1,4}$/.test(word))) return null

  const missing = 8 - left.length - right.length
  if ((compressed && missing < 1) || (!compressed && missing !== 0)) return null
  const words = [
    ...left.map((word) => Number.parseInt(word, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((word) => Number.parseInt(word, 16)),
  ]
  return words.length === 8 ? words : null
}

function wordsToIpv4(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}
