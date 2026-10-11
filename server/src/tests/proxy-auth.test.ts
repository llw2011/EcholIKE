import { describe, expect, it } from 'vitest'
import { businessRouteSpecs, createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { createAdminService, createMemoryAdminStore } from '../services/admin/admin-service.js'
import type { AuthenticatedUser } from '../types.js'
import { request, testApp, testEnv, testServices } from './helpers.js'

const backendOperatorUser: AuthenticatedUser = {
  id: 'user_backend_operator',
  email: 'operator@example.com',
  name: 'Backend Operator',
  plan: 'free',
  subscriptionEnd: null,
}

describe('pro-only route boundary', () => {
  for (const route of businessRouteSpecs.filter((spec) => spec.access === 'pro')) {
    it(`rejects free users on ${route.method} ${route.path}`, async () => {
      const res = await testApp().fetch(
        request('/echo-api' + route.path, {
          method: route.method,
          headers: { authorization: 'Bearer valid-free-token' },
        }),
      )
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.code).toBe('forbidden')
    })
  }

  it('rejects STT proxy without auth before implementation logic', async () => {
    const res = await testApp().fetch(
      request('/echo-api/proxy/stt', {
        method: 'POST',
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.code).toBe('unauthorized')
  })

  it('rejects free users before cloud proxy implementation logic', async () => {
    const res = await testApp().fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-free-token' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toBe('Pro plan required')
  })

  it('keeps pro proxy routes explicit while provider integration is pending', async () => {
    const res = await testApp().fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(501)
    expect(body.code).toBe('not_implemented')
  })

  it('lets active backend operators call proxy routes without a paid subscription', async () => {
    const env = testEnv()
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-backend-operator-token': backendOperatorUser,
      }),
      services: {
        ...testServices(env),
        admin: createAdminService(
          createMemoryAdminStore([
            {
              userId: backendOperatorUser.id,
              role: 'operator',
              status: 'active',
              createdBy: null,
              createdAt: null,
              updatedAt: null,
            },
          ]),
        ),
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-backend-operator-token' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(501)
    expect(body.code).toBe('not_implemented')
  })
})
