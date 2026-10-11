export type ProxyScheme = 'http' | 'https' | 'socks5' | 'socks5h'
export type ProxyParts = {
  scheme: ProxyScheme
  host: string
  port: string
}

export const proxySchemeOptions: { value: ProxyScheme; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks5h', label: 'SOCKS5H' },
]

export const defaultProxyPorts: Record<ProxyScheme, string> = {
  http: '7890',
  https: '7890',
  socks5: '1080',
  socks5h: '1080',
}

export function asProxyScheme(value: string | null | undefined): ProxyScheme {
  return value === 'https' || value === 'socks5' || value === 'socks5h' ? value : 'http'
}

function bracketIpv6Host(host: string) {
  if (host.includes('@')) return host
  if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) return `[${host}]`
  return host
}

export function parseProxyUrl(value: string): ProxyParts {
  const trimmed = value.trim()
  if (!trimmed) {
    return {
      scheme: 'http',
      host: '127.0.0.1',
      port: defaultProxyPorts.http,
    }
  }

  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    const scheme = asProxyScheme(parsed.protocol.replace(':', ''))
    const auth =
      parsed.username || parsed.password
        ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
        : ''
    return {
      scheme,
      host: `${auth}${parsed.hostname}`,
      port: parsed.port || defaultProxyPorts[scheme],
    }
  } catch {
    return {
      scheme: 'http',
      host: trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/:\d+$/, ''),
      port: defaultProxyPorts.http,
    }
  }
}

export function composeProxyUrl(parts: ProxyParts) {
  const host = parts.host.trim()
  const port = parts.port.trim()
  if (!host) return ''
  const safePort = port.replace(/[^\d]/g, '')
  return `${parts.scheme}://${bracketIpv6Host(host)}${safePort ? `:${safePort}` : ''}`
}

export function describeProxyUrl(value: string) {
  const parts = parseProxyUrl(value)
  return `${parts.scheme}://${parts.host}:${parts.port}`
}

export function describeProxyUrlRedacted(value: string) {
  const parts = parseProxyUrl(value)
  const host = parts.host.includes('@') ? `***@${parts.host.split('@').pop()}` : parts.host
  return `${parts.scheme}://${host}:${parts.port}`
}
