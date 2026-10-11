import { describe, expect, it } from 'vitest'
import { adminRouteSpecs, businessRouteSpecs, createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { createAuditService, createMemoryAuditLogStore } from '../services/audit/audit-service.js'
import { requireInFlightLimit } from '../middleware/in-flight-limit.js'
import type { RequestContext } from '../http.js'
import type {
  RateLimitDecision,
  RateLimiter,
  RateLimitInput,
} from '../services/rate-limit/rate-limit-service.js'
import { request, testEnv, testServices, freeUser, proUser } from './helpers.js'

describe('backend hardening', () => {
  it('requires every business route to declare rate limits', () => {
    for (const route of businessRouteSpecs) {
      expect(route.rateLimits.length, `${route.method} ${route.path}`).toBeGreaterThan(0)
    }
  })

  it('requires every admin route to declare rate limits', () => {
    for (const route of adminRouteSpecs) {
      expect(route.rateLimits.length, `${route.method} ${route.path}`).toBeGreaterThan(0)
    }
  })

  it('rate limits authenticated business routes before route logic', async () => {
    const env = testEnv()
    const rateLimit = new RejectingRateLimiter()
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'valid-free-token': freeUser }),
      services: {
        ...testServices(env),
        rateLimit,
      },
    })

    const res = await app.fetch(
      request('/echo-api/subscription/status', {
        headers: {
          authorization: 'Bearer valid-free-token',
          origin: 'http://localhost:5173',
          'x-forwarded-for': '203.0.113.10',
        },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('17')
    expect(res.headers.get('access-control-expose-headers')).toContain('retry-after')
    expect(body).toMatchObject({
      code: 'rate_limited',
      error: 'Rate limit exceeded',
    })
    expect(rateLimit.inputs[0]).toMatchObject({
      identity: 'user:user_free',
    })
  })

  it('rate limits proxy uploads before inspecting their declared body length', async () => {
    const env = testEnv()
    const rateLimit = new RejectingRateLimiter()
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'valid-pro-token': proUser }),
      services: {
        ...testServices(env),
        rateLimit,
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
          'content-length': String(100 * 1024 * 1024),
        },
        body: '{}',
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body.code).toBe('rate_limited')
    expect(rateLimit.inputs[0]).toMatchObject({ identity: 'user:user_pro' })
  })

  it('limits one in-flight OCR request per user before reading another large body', async () => {
    const env = testEnv()
    const services = testServices(env)
    let providerCalls = 0
    let markStarted: () => void = () => undefined
    let releaseFirst: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    services.proxy = {
      ...services.proxy,
      ocr: {
        async read() {
          providerCalls += 1
          if (providerCalls === 1) {
            markStarted()
            await firstReleased
          }
          return { text: 'OCR text', model: 'vision-model', usageTokens: null }
        },
      },
    }
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'valid-pro-token': proUser }),
      services,
    })
    const validBody = JSON.stringify({ imageBase64: 'iVBORw0KGgo=' })
    const firstResponse = app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: validBody,
      }),
    )
    await started

    const concurrent = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
          'content-length': String(100 * 1024 * 1024),
        },
        body: '{}',
      }),
    )
    expect(concurrent.status).toBe(429)
    expect(await concurrent.json()).toMatchObject({ code: 'rate_limited' })
    expect(providerCalls).toBe(1)

    releaseFirst()
    expect((await firstResponse).status).toBe(200)
    const afterRelease = await app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: validBody,
      }),
    )
    expect(afterRelease.status).toBe(200)
    expect(providerCalls).toBe(2)
  })

  it('shares the pre-body in-flight gate between image OCR and document Pipeline OCR', async () => {
    const env = testEnv()
    const services = testServices(env)
    let markStarted: () => void = () => undefined
    let releaseFirst: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    services.proxy = {
      ...services.proxy,
      ocr: {
        async read() {
          markStarted()
          await held
          return { text: 'image result', model: 'vision-model', usageTokens: null }
        },
      },
    }
    let documentCalls = 0
    services.documentOcr = {
      async warmup() {},
      async capability() {
        return { available: true, providerAvailable: true, model: 'glm-ocr:latest' }
      },
      async process() {
        documentCalls += 1
        return {
          text: 'document result',
          model: 'glm-ocr:latest',
          pageCount: 1,
          warnings: [],
          degraded: false,
        }
      },
      async shutdown() {},
    }
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'valid-pro-token': proUser }),
      services,
    })
    const first = app.fetch(
      request('/echo-api/proxy/ocr', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token', 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: 'iVBORw0KGgo=' }),
      }),
    )
    await started
    const form = new FormData()
    form.append(
      'document',
      new Blob([new TextEncoder().encode('%PDF-1.4\n')], { type: 'application/pdf' }),
      'report.pdf',
    )

    const blocked = await app.fetch(
      request('/echo-api/proxy/ocr/document', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: form,
      }),
    )

    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: 'rate_limited' })
    expect(documentCalls).toBe(0)
    releaseFirst()
    expect((await first).status).toBe(200)
  })

  it('caps OCR-style in-flight work across users and releases the global slot', async () => {
    const env = testEnv()
    const services = testServices(env)
    const gate = requireInFlightLimit({ perUser: 2, total: 2 })
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const context = (id: string): RequestContext => ({
      request: request('/echo-api/proxy/ocr'),
      env,
      services,
      requestId: `req-${id}`,
      idempotencyKey: `operation-${id}`,
      user: { ...proUser, id },
      state: new Map(),
    })
    const handler = async () => {
      await held
      return new Response('ok')
    }

    const first = gate(context('one'), handler)
    const second = gate(context('two'), handler)
    const rejected = await gate(context('three'), handler)
    expect(rejected.status).toBe(429)
    expect(await rejected.json()).toMatchObject({ code: 'rate_limited' })

    release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect((await gate(context('four'), handler)).status).toBe(200)
  })

  it('records business route audit metadata without request secrets', async () => {
    const env = testEnv()
    const auditStore = createMemoryAuditLogStore()
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'valid-free-token': freeUser }),
      services: {
        ...testServices(env),
        audit: createAuditService(auditStore),
      },
    })

    const res = await app.fetch(
      request('/echo-api/subscription/status', {
        headers: {
          authorization: 'Bearer valid-free-token',
          cookie: 'session=secret',
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(auditStore.entries).toHaveLength(1)
    expect(auditStore.entries[0]).toMatchObject({
      userId: 'user_free',
      action: 'GET /echo-api/subscription/status',
      metadata: {
        method: 'GET',
        path: '/echo-api/subscription/status',
        access: 'auth',
        status: 200,
      },
    })
    expect(JSON.stringify(auditStore.entries[0])).not.toContain('valid-free-token')
    expect(JSON.stringify(auditStore.entries[0])).not.toContain('session=secret')
  })

  it('rejects oversized bodies even when the client omits content-length', async () => {
    const env = testEnv()
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'valid-pro-token': proUser }),
      services: testServices(env),
    })

    const res = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-pro-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(413)
    expect(body.code).toBe('payload_too_large')
  })

  it('answers CORS preflight only for allowlisted origins and auth headers', async () => {
    const app = createApp({
      env: testEnv({
        CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      }),
      sessionVerifier: createStaticSessionVerifier({}),
      services: testServices(),
    })

    const allowed = await app.fetch(
      request('/echo-api/subscription/status', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-headers': 'authorization,content-type',
        },
      }),
    )
    const blocked = await app.fetch(
      request('/echo-api/subscription/status', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-headers': 'authorization',
        },
      }),
    )

    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(allowed.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    expect(blocked.status).toBe(204)
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull()
  })
})

class RejectingRateLimiter implements RateLimiter {
  readonly inputs: RateLimitInput[] = []

  async check(input: RateLimitInput): Promise<RateLimitDecision> {
    this.inputs.push(input)
    return {
      allowed: false,
      retryAfterSeconds: 17,
      remaining: 0,
    }
  }
}
