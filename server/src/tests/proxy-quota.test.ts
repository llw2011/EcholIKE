import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { createStaticEntitlementService } from '../services/billing/entitlements.js'
import { disabledBillingSessionService } from '../services/billing/stripe.js'
import {
  createMemoryQuotaLedgerStore,
  createQuotaService,
} from '../services/quota/quota-service.js'
import { disabledProxyServices } from '../services/proxy/proxy-services.js'
import { proUser, request, testEnv, testServices } from './helpers.js'

describe('proxy quota boundary', () => {
  it('allows proxy reservations above the base plan when a user has a higher quota level', async () => {
    const env = testEnv()
    env.planLimits.pro.llmTokensLimit = 1030
    const entitlements = createStaticEntitlementService(env.planLimits, {
      [proUser.id]: {
        plan: 'pro',
        subscriptionEnd: '2026-12-31T00:00:00.000Z',
        quotaLevel: 2,
      },
    })
    const llmComplete = vi.fn().mockResolvedValue({ text: 'ok', usageTokens: 10 })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-pro-token': proUser,
      }),
      services: {
        ...testServices(env),
        entitlements,
        billing: disabledBillingSessionService,
        quota: createQuotaService(entitlements, createMemoryQuotaLedgerStore()),
        proxy: {
          ...disabledProxyServices,
          llm: {
            complete: llmComplete,
            stream: vi.fn(),
          },
        },
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(2000) }] }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ text: 'ok' })
    expect(llmComplete).toHaveBeenCalledTimes(1)
  })

  it('rejects exhausted LLM quota before provider integration logic', async () => {
    const env = testEnv()
    const entitlements = createStaticEntitlementService(env.planLimits, {
      [proUser.id]: {
        plan: 'pro',
        llmTokensLimit: 1,
      },
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'valid-pro-token': proUser,
      }),
      services: {
        ...testServices(env),
        entitlements,
        billing: disabledBillingSessionService,
        quota: createQuotaService(entitlements, createMemoryQuotaLedgerStore()),
      },
    })

    const res = await app.fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '12345678' }] }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('llm_quota_exceeded')
  })

  it('rejects client-side provider configuration on cloud LLM proxy requests', async () => {
    const res = await createApp({
      env: testEnv(),
      sessionVerifier: createStaticSessionVerifier({
        'valid-pro-token': proUser,
      }),
      services: testProxyServices(),
    }).fetch(
      request('/echo-api/proxy/llm', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-pro-token' },
        body: JSON.stringify({
          model: 'client-chosen-model',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.code).toBe('validation_failed')
    expect(body.error).toContain('model')
  })
})

function testProxyServices() {
  const env = testEnv()
  const entitlements = createStaticEntitlementService(env.planLimits, {
    [proUser.id]: {
      plan: 'pro',
      subscriptionEnd: '2026-12-31T00:00:00.000Z',
    },
  })
  return {
    ...testServices(env),
    entitlements,
    billing: disabledBillingSessionService,
    quota: createQuotaService(entitlements, createMemoryQuotaLedgerStore()),
    proxy: disabledProxyServices,
  }
}
