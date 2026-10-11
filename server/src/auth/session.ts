import type { AuthenticatedUser } from '../types.js'

export type SessionVerifier = (token: string) => Promise<AuthenticatedUser | null>
export type RequestSessionVerifier = (request: Request) => Promise<AuthenticatedUser | null>
export interface BetterAuthSessionSource {
  api: {
    getSession: (options: { headers: Headers }) => Promise<{
      session?: {
        token?: string
      }
      user: {
        id: string
        email: string
        name: string
      }
    } | null>
  }
}

export function isValidBearerToken(token: string): boolean {
  return /^[\w\-._~+/]+=*$/.test(token) && token.length >= 10 && token.length <= 4096
}

export function createStaticSessionVerifier(
  usersByToken: Record<string, AuthenticatedUser>,
): SessionVerifier {
  return async (token) => usersByToken[token] ?? null
}

export function createBearerRequestSessionVerifier(
  verifier: SessionVerifier,
): RequestSessionVerifier {
  return async (request) => {
    const token = extractBearer(request.headers.get('authorization'))
    if (!token || !isValidBearerToken(token)) return null
    return verifier(token)
  }
}

export function createBetterAuthRequestSessionVerifier(
  auth: BetterAuthSessionSource,
): RequestSessionVerifier {
  return async (request) => {
    const authorization = request.headers.get('authorization')
    if (authorization !== null) {
      const token = extractBearer(authorization)
      if (!token || !isValidBearerToken(token)) return null
    }
    return sessionFromHeaders(auth, sessionVerificationHeaders(request.headers))
  }
}

function sessionVerificationHeaders(headers: Headers): Headers {
  if (headers.get('authorization') === null) return headers

  const bearerHeaders = new Headers(headers)
  bearerHeaders.delete('cookie')
  return bearerHeaders
}

function extractBearer(header: string | null): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

async function sessionFromHeaders(
  auth: BetterAuthSessionSource,
  headers: Headers,
): Promise<AuthenticatedUser | null> {
  const session = await auth.api.getSession({ headers })
  if (!session) return null

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    plan: 'free',
    subscriptionEnd: null,
  }
}
