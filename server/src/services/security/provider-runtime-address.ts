import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  nodeProviderAddressResolver,
  providerAddressScope,
  type ProviderAddressResolver,
  type ProviderResolvedAddress,
} from './provider-egress-policy.js'

/**
 * Product-owned logical hostname for services running on the Windows side of WSL.
 * `.invalid` guarantees that a missed interception cannot fall through to public DNS.
 */
export const WSL_WINDOWS_HOSTNAME = 'wsl-host.echolike.invalid'

export type ProviderRuntimeAddressErrorCode =
  | 'wsl_runtime_unavailable'
  | 'wsl_network_unavailable'
  | 'wsl_gateway_invalid'

export class ProviderRuntimeAddressError extends Error {
  constructor(
    readonly code: ProviderRuntimeAddressErrorCode,
    options: { cause?: unknown } = {},
  ) {
    super(`Provider runtime address resolution failed: ${code}`, options)
    this.name = 'ProviderRuntimeAddressError'
  }
}

type ReadTextFile = (path: string, encoding: BufferEncoding) => Promise<string>
type ReadWslNetworkingMode = () => Promise<string | null>

export interface ProviderRuntimeAddressResolverOptions {
  fallbackResolver?: ProviderAddressResolver
  readTextFile?: ReadTextFile
  readWslNetworkingMode?: ReadWslNetworkingMode
}

const execFileAsync = promisify(execFile)

export function createProviderRuntimeAddressResolver(
  options: ProviderRuntimeAddressResolverOptions = {},
): ProviderAddressResolver {
  const fallbackResolver = options.fallbackResolver ?? nodeProviderAddressResolver
  const readTextFile = options.readTextFile ?? readFile
  const readWslNetworkingMode = options.readWslNetworkingMode ?? defaultWslNetworkingMode

  return {
    async resolve(hostname) {
      if (hostname.toLowerCase() !== WSL_WINDOWS_HOSTNAME) {
        return await fallbackResolver.resolve(hostname)
      }
      return [await resolveWslWindowsHost(readTextFile, readWslNetworkingMode)]
    },
  }
}

export const providerRuntimeAddressResolver = createProviderRuntimeAddressResolver()

export function wslWindowsHostEndpoint(localEndpoint: string): string | null {
  let url: URL
  try {
    url = new URL(localEndpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash)
    return null
  if (providerAddressScope(url.hostname) !== 'loopback') return null
  url.hostname = WSL_WINDOWS_HOSTNAME
  return url.toString()
}

export function isWslWindowsHostEndpointFor(
  candidate: string,
  productLocalEndpoint: string | null | undefined,
): boolean {
  if (!productLocalEndpoint) return false
  const expected = wslWindowsHostEndpoint(productLocalEndpoint)
  if (!expected) return false
  try {
    return new URL(candidate).toString() === expected
  } catch {
    return false
  }
}

async function resolveWslWindowsHost(
  readTextFile: ReadTextFile,
  readWslNetworkingMode: ReadWslNetworkingMode,
): Promise<ProviderResolvedAddress> {
  const kernelRelease = await readTextFile('/proc/sys/kernel/osrelease', 'utf8').catch((error) => {
    throw new ProviderRuntimeAddressError('wsl_runtime_unavailable', { cause: error })
  })
  if (!/microsoft.*wsl/i.test(kernelRelease)) {
    throw new ProviderRuntimeAddressError('wsl_runtime_unavailable')
  }

  const networkingMode = (await readWslNetworkingMode())?.trim().toLowerCase() || null
  if (networkingMode === 'mirrored') {
    return { address: '127.0.0.1', family: 4 }
  }
  if (networkingMode && !['nat', 'virtioproxy'].includes(networkingMode)) {
    throw new ProviderRuntimeAddressError('wsl_network_unavailable')
  }

  const routeTable = await readTextFile('/proc/net/route', 'utf8').catch((error) => {
    throw new ProviderRuntimeAddressError('wsl_network_unavailable', { cause: error })
  })
  const gateway = defaultIpv4Gateway(routeTable)
  if (!gateway || providerAddressScope(gateway) !== 'private') {
    throw new ProviderRuntimeAddressError('wsl_gateway_invalid')
  }
  return { address: gateway, family: 4 }
}

export function defaultIpv4Gateway(routeTable: string): string | null {
  const routes = routeTable
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 8)
    .flatMap((columns) => {
      const [iface, destination, gateway, flags, , , metric, mask] = columns
      if (
        !iface ||
        destination !== '00000000' ||
        mask !== '00000000' ||
        !gateway ||
        !/^[0-9a-f]{8}$/i.test(gateway) ||
        gateway === '00000000'
      ) {
        return []
      }
      if (!/^[0-9a-f]{1,8}$/i.test(flags ?? '') || !/^\d+$/.test(metric ?? '')) return []
      const parsedFlags = Number.parseInt(flags ?? '', 16)
      const parsedMetric = Number.parseInt(metric ?? '', 10)
      if (
        !Number.isSafeInteger(parsedFlags) ||
        !Number.isSafeInteger(parsedMetric) ||
        (parsedFlags & 0x3) !== 0x3
      ) {
        return []
      }
      return [
        {
          iface,
          gateway: littleEndianIpv4(gateway),
          metric: parsedMetric,
        },
      ]
    })
    .filter((route) => route.gateway !== null)
    .sort((left, right) => left.metric - right.metric || left.iface.localeCompare(right.iface))

  const lowestMetric = routes[0]?.metric
  if (lowestMetric === undefined) return null
  const lowestGateways = new Set(
    routes.filter((route) => route.metric === lowestMetric).map((route) => route.gateway),
  )
  return lowestGateways.size === 1 ? (routes[0]?.gateway ?? null) : null
}

function littleEndianIpv4(value: string): string | null {
  const bytes = value.match(/../g)
  if (!bytes || bytes.length !== 4) return null
  const address = bytes
    .reverse()
    .map((byte) => Number.parseInt(byte, 16))
    .join('.')
  return providerAddressScope(address) === 'reserved' ? null : address
}

async function defaultWslNetworkingMode(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/wslinfo', ['--networking-mode'], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 1_024,
      windowsHide: true,
      env: { LANG: 'C', LC_ALL: 'C' },
    })
    const mode = stdout.trim()
    if (!mode) throw new ProviderRuntimeAddressError('wsl_network_unavailable')
    return mode
  } catch (error) {
    // Older WSL releases do not ship wslinfo. Their NAT mode is derived from /proc/net/route.
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown'
    if (code === 'ENOENT') return null
    throw new ProviderRuntimeAddressError('wsl_network_unavailable', { cause: error })
  }
}
