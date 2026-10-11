import { describe, expect, it } from 'vitest'
import {
  asProxyScheme,
  composeProxyUrl,
  defaultProxyPorts,
  describeProxyUrl,
  describeProxyUrlRedacted,
  parseProxyUrl,
  proxySchemeOptions,
} from '../proxyUrl'

describe('settings proxy URL domain', () => {
  it('keeps the supported schemes and their default ports stable', () => {
    expect(proxySchemeOptions).toEqual([
      { value: 'http', label: 'HTTP' },
      { value: 'https', label: 'HTTPS' },
      { value: 'socks5', label: 'SOCKS5' },
      { value: 'socks5h', label: 'SOCKS5H' },
    ])
    expect(defaultProxyPorts).toEqual({
      http: '7890',
      https: '7890',
      socks5: '1080',
      socks5h: '1080',
    })
  })

  it('falls back unknown or missing schemes to HTTP', () => {
    expect(asProxyScheme(null)).toBe('http')
    expect(asProxyScheme('ftp')).toBe('http')
    expect(asProxyScheme('socks5h')).toBe('socks5h')
  })

  it('uses the existing loopback defaults for an empty value', () => {
    expect(parseProxyUrl('   ')).toEqual({
      scheme: 'http',
      host: '127.0.0.1',
      port: '7890',
    })
  })

  it('parses scheme-less hosts and fills their default port', () => {
    expect(parseProxyUrl('proxy.example.test')).toEqual({
      scheme: 'http',
      host: 'proxy.example.test',
      port: '7890',
    })
  })

  it('preserves credentials and explicit SOCKS ports', () => {
    expect(parseProxyUrl('socks5://alice:secret@proxy.example.test:1180')).toEqual({
      scheme: 'socks5',
      host: 'alice:secret@proxy.example.test',
      port: '1180',
    })
  })

  it('keeps the existing malformed URL fallback behavior', () => {
    expect(parseProxyUrl('http://[broken:9010')).toEqual({
      scheme: 'http',
      host: '[broken',
      port: '7890',
    })
  })

  it('brackets bare IPv6 hosts and strips non-digits from ports', () => {
    expect(
      composeProxyUrl({
        scheme: 'https',
        host: '2001:db8::1',
        port: '7a8b9c0',
      }),
    ).toBe('https://[2001:db8::1]:7890')
  })

  it('returns an empty URL when the host is blank', () => {
    expect(composeProxyUrl({ scheme: 'http', host: '  ', port: '7890' })).toBe('')
  })

  it('describes proxy URLs with canonical defaults', () => {
    expect(describeProxyUrl('https://proxy.example.test')).toBe('https://proxy.example.test:7890')
  })

  it('redacts credentials without hiding the proxy host', () => {
    expect(describeProxyUrlRedacted('socks5h://alice:secret@proxy.example.test')).toBe(
      'socks5h://***@proxy.example.test:1080',
    )
  })
})
