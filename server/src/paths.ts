export function apiBasePathFromPublicUrl(publicApiBaseUrl: string): string {
  const pathname = new URL(publicApiBaseUrl).pathname.replace(/\/+$/, '')
  return normalizeApiBasePath(pathname)
}

export function normalizeApiBasePath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed || trimmed === '/') return ''
  if (!trimmed.startsWith('/')) {
    throw new Error('PUBLIC_API_BASE_URL path must start with /')
  }
  if (trimmed.includes('//')) {
    throw new Error('PUBLIC_API_BASE_URL path must not contain empty segments')
  }
  return trimmed
}

export function joinApiPath(apiBasePath: string, path: string): string {
  if (!path.startsWith('/')) {
    throw new Error('route path must start with /')
  }
  if (!apiBasePath) return path
  if (path === '/') return apiBasePath
  return apiBasePath + path
}

export function authBasePath(apiBasePath: string): string {
  return joinApiPath(apiBasePath, '/auth')
}
