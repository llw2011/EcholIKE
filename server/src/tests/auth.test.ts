import { describe, expect, it } from 'vitest'
import { businessRouteSpecs } from '../app.js'
import { createBetterAuthRequestSessionVerifier } from '../auth/session.js'
import { request, testApp } from './helpers.js'

describe('auth boundary', () => {
  for (const route of businessRouteSpecs) {
    it(`rejects unauthenticated business route ${route.method} ${route.path}`, async () => {
      const res = await testApp().fetch(
        request('/echo-api' + route.path, {
          method: route.method,
        }),
      )
      const body = await res.json()

      expect(res.status).toBe(401)
      expect(body.code).toBe('unauthorized')
    })
  }

  it('rejects protected business routes without bearer token', async () => {
    const res = await testApp().fetch(request('/echo-api/subscription/status'))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body).toMatchObject({
      code: 'unauthorized',
      error: 'Authentication required',
    })
  })

  it('rejects malformed bearer tokens before route logic', async () => {
    const res = await testApp().fetch(
      request('/echo-api/subscription/status', {
        headers: { authorization: 'Bearer bad' },
      }),
    )

    expect(res.status).toBe(401)
  })

  it('does not let an explicit invalid authorization header fall back to a session cookie', async () => {
    const verifier = createBetterAuthRequestSessionVerifier({
      api: {
        getSession: async ({ headers }) =>
          headers.has('cookie')
            ? {
                session: { token: 'cookie-session-token' },
                user: {
                  id: 'cookie-user',
                  email: 'cookie@example.com',
                  name: 'Cookie User',
                },
              }
            : null,
      },
    })

    const user = await verifier(
      request('/echo-api/desktop/bootstrap', {
        headers: {
          authorization: 'Bearer expired-session-token',
          cookie: 'better-auth.session_token=valid-cookie-session',
        },
      }),
    )

    expect(user).toBeNull()
  })

  it('keeps cookie-only session verification when no authorization header is present', async () => {
    const verifier = createBetterAuthRequestSessionVerifier({
      api: {
        getSession: async ({ headers }) =>
          headers.has('cookie')
            ? {
                session: { token: 'cookie-session-token' },
                user: {
                  id: 'cookie-user',
                  email: 'cookie@example.com',
                  name: 'Cookie User',
                },
              }
            : null,
      },
    })

    const user = await verifier(
      request('/echo-api/desktop/bootstrap', {
        headers: { cookie: 'better-auth.session_token=valid-cookie-session' },
      }),
    )

    expect(user).toMatchObject({
      id: 'cookie-user',
      email: 'cookie@example.com',
      name: 'Cookie User',
    })
  })

  it('rejects a malformed explicit authorization scheme before Better Auth sees it', async () => {
    let calls = 0
    const verifier = createBetterAuthRequestSessionVerifier({
      api: {
        getSession: async () => {
          calls += 1
          return null
        },
      },
    })

    const user = await verifier(
      request('/echo-api/desktop/bootstrap', {
        headers: { authorization: 'Basic not-a-bearer-token' },
      }),
    )

    expect(user).toBeNull()
    expect(calls).toBe(0)
  })

  it('returns subscription status for a verified session token', async () => {
    const res = await testApp().fetch(
      request('/echo-api/subscription/status', {
        headers: { authorization: 'Bearer valid-free-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      plan: 'free',
      sttSecondsLimit: 900,
      llmTokensLimit: 100000,
    })
  })

  it('keeps unknown routes closed', async () => {
    const res = await testApp().fetch(request('/echo-api/unknown'))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.code).toBe('not_found')
  })
})
