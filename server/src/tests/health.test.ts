import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { request, testApp } from './helpers.js'
import { testEnv, testServices } from './helpers.js'

describe('health routes', () => {
  it('allows public liveness checks', async () => {
    const res = await testApp().fetch(request('/echo-api/healthz'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, service: 'echo-api' })
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('x-idempotency-key')).toBeTruthy()
  })

  it('echoes a valid idempotency key independently from the request trace id', async () => {
    const res = await testApp().fetch(
      request('/echo-api/healthz', {
        headers: {
          'x-request-id': 'trace-one-hop',
          'x-idempotency-key': '018f-idempotency-key',
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBe('trace-one-hop')
    expect(res.headers.get('x-idempotency-key')).toBe('018f-idempotency-key')
  })

  it('rejects malformed idempotency keys before a business handler runs', async () => {
    const res = await testApp().fetch(
      request('/echo-api/healthz', {
        headers: { 'x-idempotency-key': 'contains whitespace' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.code).toBe('idempotency_key_invalid')
    expect(body.requestId).toBeTruthy()
  })

  it('allows public readiness checks without leaking secrets', async () => {
    const res = await testApp().fetch(request('/echo-api/readyz'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.dependencies.databaseReady).toBe(true)
    expect(JSON.stringify(body)).not.toContain('test-secret')
  })

  it('reports readiness failure when the database is unavailable', async () => {
    const env = testEnv()
    const services = {
      ...testServices(env),
      database: {
        async ready() {
          return false
        },
        async close() {},
      },
    }
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services,
    })

    const res = await app.fetch(request('/echo-api/readyz'))
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.dependencies.databaseReady).toBe(false)
  })
})
