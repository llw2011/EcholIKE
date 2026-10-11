import { describe, expect, it, vi } from 'vitest'
import {
  createProviderRuntimeAddressResolver,
  defaultIpv4Gateway,
  isWslWindowsHostEndpointFor,
  WSL_WINDOWS_HOSTNAME,
  wslWindowsHostEndpoint,
} from '../services/security/provider-runtime-address.js'

const WSL_RELEASE = '6.18.33.1-microsoft-standard-WSL2\n'

function routeTable(gatewayHex: string, metric = 0) {
  return [
    'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask',
    `eth0\t00000000\t${gatewayHex}\t0003\t0\t0\t${metric}\t00000000`,
    'eth0\t00801AAC\t00000000\t0001\t0\t0\t0\t00F0FFFF',
    '',
  ].join('\n')
}

describe('provider runtime WSL host addressing', () => {
  it('resolves the current NAT gateway on every logical-host lookup', async () => {
    let routes = routeTable('01801AAC')
    const fallbackResolver = { resolve: vi.fn(async () => []) }
    const resolver = createProviderRuntimeAddressResolver({
      fallbackResolver,
      readWslNetworkingMode: async () => 'nat',
      readTextFile: async (path) => (path.endsWith('osrelease') ? WSL_RELEASE : routes),
    })

    await expect(resolver.resolve(WSL_WINDOWS_HOSTNAME)).resolves.toEqual([
      { address: '172.26.128.1', family: 4 },
    ])
    routes = routeTable('01001CAC')
    await expect(resolver.resolve(WSL_WINDOWS_HOSTNAME)).resolves.toEqual([
      { address: '172.28.0.1', family: 4 },
    ])
    expect(fallbackResolver.resolve).not.toHaveBeenCalled()
  })

  it('uses Windows loopback in mirrored mode without consulting a NAT route', async () => {
    const readTextFile = vi.fn(async (path: string) => {
      if (path.endsWith('osrelease')) return WSL_RELEASE
      throw new Error('route table must not be read in mirrored mode')
    })
    const resolver = createProviderRuntimeAddressResolver({
      readWslNetworkingMode: async () => 'mirrored',
      readTextFile,
    })

    await expect(resolver.resolve(WSL_WINDOWS_HOSTNAME)).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ])
    expect(readTextFile).toHaveBeenCalledTimes(1)
  })

  it('fails closed outside WSL, without a private default route, or in disabled networking', async () => {
    const cases = [
      {
        release: '6.8.0-generic',
        mode: 'nat',
        routes: routeTable('01801AAC'),
        code: 'wsl_runtime_unavailable',
      },
      {
        release: WSL_RELEASE,
        mode: 'nat',
        routes: routeTable('01010101'),
        code: 'wsl_gateway_invalid',
      },
      {
        release: WSL_RELEASE,
        mode: 'none',
        routes: routeTable('01801AAC'),
        code: 'wsl_network_unavailable',
      },
    ] as const

    for (const testCase of cases) {
      const resolver = createProviderRuntimeAddressResolver({
        readWslNetworkingMode: async () => testCase.mode,
        readTextFile: async (path) =>
          path.endsWith('osrelease') ? testCase.release : testCase.routes,
      })
      await expect(resolver.resolve(WSL_WINDOWS_HOSTNAME)).rejects.toMatchObject({
        code: testCase.code,
      })
    }
  })

  it('delegates every non-product hostname to the normal provider resolver', async () => {
    const fallbackResolver = {
      resolve: vi.fn(async () => [{ address: '203.0.113.8', family: 4 as const }]),
    }
    const resolver = createProviderRuntimeAddressResolver({ fallbackResolver })

    await expect(resolver.resolve('provider.example')).resolves.toEqual([
      { address: '203.0.113.8', family: 4 },
    ])
    expect(fallbackResolver.resolve).toHaveBeenCalledWith('provider.example')
  })

  it('accepts only the exact alias form of a product-owned loopback endpoint', () => {
    const local = 'http://127.0.0.1:11434/api/generate'
    const logical = `http://${WSL_WINDOWS_HOSTNAME}:11434/api/generate`

    expect(wslWindowsHostEndpoint(local)).toBe(logical)
    expect(isWslWindowsHostEndpointFor(logical, local)).toBe(true)
    expect(isWslWindowsHostEndpointFor(`${logical}/extra`, local)).toBe(false)
    expect(
      isWslWindowsHostEndpointFor(`http://${WSL_WINDOWS_HOSTNAME}:8080/api/generate`, local),
    ).toBe(false)
    expect(wslWindowsHostEndpoint('https://127.0.0.1:11434/api/generate')).toBeNull()
    expect(wslWindowsHostEndpoint('http://10.0.0.8:11434/api/generate')).toBeNull()
  })

  it('selects the lowest-metric valid default route and rejects malformed rows', () => {
    const routes = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask',
      'eth1\t00000000\t01001CAC\t0003\t0\t0\t50\t00000000',
      'eth0\t00000000\t01801AAC\t0003\t0\t0\t10\t00000000',
      'bad0\t00000000\tNOTHEX00\t0003\t0\t0\t0\t00000000',
      'down0\t00000000\t0100000A\t0000\t0\t0\t0\t00000000',
      'flags0\t00000000\t0100000A\t0003junk\t0\t0\t0\t00000000',
      'metric0\t00000000\t0100000A\t0003\t0\t0\t10junk\t00000000',
    ].join('\n')

    expect(defaultIpv4Gateway(routes)).toBe('172.26.128.1')
    expect(
      defaultIpv4Gateway(
        [
          'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask',
          'eth0\t00000000\t01801AAC\t0003\t0\t0\t10\t00000000',
          'eth1\t00000000\t01001CAC\t0003\t0\t0\t10\t00000000',
        ].join('\n'),
      ),
    ).toBeNull()
    expect(
      defaultIpv4Gateway('Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n'),
    ).toBeNull()
    expect(
      defaultIpv4Gateway(
        [
          'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask',
          'eth0\t00000000\t01801AAC\t0003junk\t0\t0\t10\t00000000',
          'eth1\t00000000\t01001CAC\t0003\t0\t0\tbad\t00000000',
        ].join('\n'),
      ),
    ).toBeNull()
  })
})
