import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import {
  ADMIN_ACTOR_HEADER,
  requireAdminActorPrecondition,
  requireAdminWriteOrigin,
  verifyAdminActorPreconditionIfPresent,
} from '../middleware/admin-origin.js'
import {
  createAdminService,
  createMemoryAdminStore,
  type AdminRole,
} from '../services/admin/admin-service.js'
import { testEnv, testServices } from './helpers.js'
import type { AuthenticatedUser } from '../types.js'
import type { RequestContext } from '../http.js'

const adminUser: AuthenticatedUser = {
  id: 'admin-capability-user',
  email: 'admin-capability@example.com',
  name: 'Admin Capability',
  plan: 'pro',
  subscriptionEnd: null,
}

const regularUser: AuthenticatedUser = {
  id: 'regular-capability-user',
  email: 'regular-capability@example.com',
  name: 'Regular Capability',
  plan: 'free',
  subscriptionEnd: null,
}

describe('admin capability and browser-origin boundaries', () => {
  it('lets a viewer read only the redacted overview capability', async () => {
    const app = appForRole('viewer')

    const summary = await app.fetch(adminRequest('/echo-api/admin/summary'))
    expect(summary.status).toBe(200)
    expect((await summary.json()).admin.capabilities).toEqual(['overview:read'])

    expect((await app.fetch(adminRequest('/echo-api/admin/users'))).status).toBe(403)
    expect(
      (
        await app.fetch(
          adminRequest('/echo-api/admin/usage-overview?userId=regular-capability-user'),
        )
      ).status,
    ).toBe(403)
    expect((await app.fetch(adminRequest('/echo-api/admin/system'))).status).toBe(403)
  })

  it('keeps operator quota work while denying provider and release mutations', async () => {
    const app = appForRole('operator')

    expect((await app.fetch(adminRequest('/echo-api/admin/users'))).status).toBe(200)
    expect(
      (
        await app.fetch(
          adminRequest('/echo-api/admin/providers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.fetch(
          adminRequest('/echo-api/admin/ota-releases', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
        )
      ).status,
    ).toBe(403)
  })

  it('shows operators only provider origins, not provider paths', async () => {
    const env = testEnv()
    const services = servicesForRole('operator', env)
    await services.desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'operator-hidden-key',
      defaultModel: 'private-model',
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({ 'admin-capability-token': adminUser }),
      services,
    })

    const response = await app.fetch(adminRequest('/echo-api/admin/providers'))
    const body = await response.json()
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(body.providers[0].endpoint).toBe('https://openrouter.ai')
    expect(serialized).not.toContain('/api/v1')
    expect(serialized).not.toContain('operator-hidden-key')
  })

  it('reserves force-update activation for owners', async () => {
    const app = appForRole('admin')
    const response = await app.fetch(
      adminRequest('/echo-api/admin/ota-releases/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'release-force-owner-boundary', forceUpdate: true }),
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'forbidden' })
  })

  it('rejects ambient-cookie admin writes without the public same-origin proof', async () => {
    const env = testEnv()
    const services = servicesForRole('owner', env)
    const context = (request: Request): RequestContext => ({
      request,
      env,
      services,
      requestId: 'admin-origin-test',
      idempotencyKey: 'admin-origin-test',
      user: adminUser,
      state: new Map(),
    })
    const invoke = (request: Request) =>
      requireAdminWriteOrigin(context(request), async () => new Response(null, { status: 204 }))

    await expect(
      invoke(new Request('http://localhost:8787/echo-api/admin/providers', { method: 'POST' })),
    ).rejects.toMatchObject({ status: 403 })

    await expect(
      invoke(
        new Request('http://localhost:8787/echo-api/admin/providers', {
          method: 'POST',
          headers: { origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 })

    await expect(
      invoke(
        new Request('http://localhost:8787/echo-api/admin/providers', {
          method: 'POST',
          headers: { origin: 'http://localhost:8787', 'sec-fetch-site': 'same-origin' },
        }),
      ),
    ).resolves.toMatchObject({ status: 204 })
  })

  it('requires an immutable page actor for cookie requests and rejects stale actors', async () => {
    const env = testEnv()
    const services = servicesForRole('owner', env)
    const context = (request: Request): RequestContext => ({
      request,
      env,
      services,
      requestId: 'admin-actor-test',
      idempotencyKey: 'admin-actor-test',
      user: adminUser,
      state: new Map(),
    })
    const invoke = (request: Request) =>
      requireAdminActorPrecondition(
        context(request),
        async () => new Response(null, { status: 204 }),
      )

    await expect(
      invoke(new Request('http://localhost:8787/echo-api/admin/summary')),
    ).rejects.toMatchObject({ status: 428, code: 'admin_actor_precondition_required' })
    await expect(
      invoke(
        new Request('http://localhost:8787/echo-api/admin/summary', {
          headers: { [ADMIN_ACTOR_HEADER]: 'stale-admin-user' },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'admin_actor_changed' })
    await expect(
      invoke(
        new Request('http://localhost:8787/echo-api/admin/summary', {
          headers: { [ADMIN_ACTOR_HEADER]: adminUser.id },
        }),
      ),
    ).resolves.toMatchObject({ status: 204 })
    await expect(
      invoke(
        new Request('http://localhost:8787/echo-api/admin/summary', {
          headers: { authorization: 'Bearer explicit-automation-token' },
        }),
      ),
    ).resolves.toMatchObject({ status: 204 })
  })

  it('fences panel password and sign-out actions before Better Auth handles a stale actor', async () => {
    const app = appForRole('owner')
    for (const path of ['/echo-api/auth/change-password', '/echo-api/auth/sign-out']) {
      const response = await app.fetch(
        adminRequest(path, {
          method: 'POST',
          headers: {
            [ADMIN_ACTOR_HEADER]: 'stale-admin-user',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      )
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ code: 'admin_actor_changed' })
    }
  })

  it('preserves the untagged Better Auth sign-out contract for its own trusted origin', async () => {
    const env = testEnv({
      PUBLIC_API_BASE_URL: 'https://api.example/echo-api',
      BETTER_AUTH_URL: 'https://auth.example',
      CORS_ALLOWED_ORIGINS: 'https://auth.example',
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services: servicesForRole('owner', env),
    })
    const response = await app.fetch(
      new Request('https://auth.example/echo-api/auth/sign-out', {
        method: 'POST',
        headers: { origin: 'https://auth.example' },
      }),
    )

    expect(response.status).toBe(200)
  })

  it('reports an actor change before checking the new account admin role', async () => {
    const env = testEnv()
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({
        'regular-capability-token': regularUser,
      }),
      services: servicesForRole('owner', env),
    })
    const response = await app.fetch(
      new Request('http://localhost:8787/echo-api/admin/summary', {
        headers: {
          authorization: 'Bearer regular-capability-token',
          [ADMIN_ACTOR_HEADER]: adminUser.id,
        },
      }),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'admin_actor_changed' })
  })

  it('keeps the actor fence optional for non-panel Better Auth clients', async () => {
    const env = testEnv()
    const services = servicesForRole('owner', env)
    const request = new Request('http://localhost:8787/echo-api/auth/sign-out', {
      method: 'POST',
    })
    const context: RequestContext = {
      request,
      env,
      services,
      requestId: 'optional-admin-actor-test',
      idempotencyKey: 'optional-admin-actor-test',
      user: adminUser,
      state: new Map(),
    }

    await expect(
      verifyAdminActorPreconditionIfPresent(
        context,
        async () => new Response(null, { status: 204 }),
      ),
    ).resolves.toMatchObject({ status: 204 })
  })
})

function appForRole(role: AdminRole) {
  const env = testEnv()
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({ 'admin-capability-token': adminUser }),
    services: servicesForRole(role, env),
  })
}

function servicesForRole(role: AdminRole, env: ReturnType<typeof testEnv>) {
  const adminStore = createMemoryAdminStore([
    {
      userId: adminUser.id,
      role,
      status: 'active',
      createdBy: null,
      createdAt: null,
      updatedAt: null,
    },
  ])
  return {
    ...testServices(env),
    admin: createAdminService(adminStore),
  }
}

function adminRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', 'Bearer admin-capability-token')
  return new Request(`http://localhost:8787${path}`, { ...init, headers })
}
