import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createPostgresConnection, createPostgresDesktopConfigStore } from '../db/client.js'
import { AdminAuthorizationChangedError } from '../services/admin/admin-service.js'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
} from '../services/desktop/desktop-config-service.js'
import { testEnv } from './helpers.js'

describe('desktop provider credential origin boundary', () => {
  it('never exposes URL credentials, query parameters, or fragments in provider previews', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv())
    const created = await service.upsertProvider({
      kind: 'llm',
      providerId: 'openai-compatible',
      displayName: 'Compatible',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://user:password@provider.example/v1?token=secret#private',
      apiKey: 'provider-secret',
      defaultModel: 'model-a',
    })

    expect(created.endpoint).toBe('https://provider.example/v1')
    expect(JSON.stringify(created)).not.toContain('password')
    expect(JSON.stringify(created)).not.toContain('token=secret')
    expect(store.providers.get(created.id)?.endpoint).toContain('token=secret')
    await expect(service.listProviders()).resolves.toEqual([
      expect.objectContaining({ endpoint: 'https://provider.example/v1' }),
    ])
  })

  it('preserves a key for same-origin path changes but clears it across origins', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv())
    const created = await service.upsertProvider({
      kind: 'llm',
      providerId: 'openai-compatible',
      displayName: 'Compatible',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://provider.example/v1',
      apiKey: 'provider-secret',
      defaultModel: 'model-a',
    })

    const sameOrigin = await service.upsertProvider({
      id: created.id,
      expectedRevision: created.revision,
      kind: 'llm',
      providerId: 'openai-compatible',
      displayName: 'Compatible',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://provider.example/v2',
      apiKey: created.apiKeyPreview,
      defaultModel: 'model-a',
    })
    expect(created.apiKeyPreview).toBe('configured')
    expect(store.providers.get(created.id)?.apiKey).toBe('provider-secret')

    const moved = await service.upsertProvider({
      id: created.id,
      expectedRevision: sameOrigin.revision,
      kind: 'llm',
      providerId: 'openai-compatible',
      displayName: 'Compatible',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://other-provider.example/v1',
      defaultModel: 'model-a',
    })
    expect(store.providers.get(created.id)?.apiKey).toBeNull()
    expect(moved.apiKeyPreview).toBeNull()
  })

  it('rejects no-id conflicts and clears a masked key only through revision-bound editing', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv())
    const created = await service.upsertProvider({
      kind: 'llm',
      providerId: 'openai-compatible',
      displayName: 'Compatible',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://old-provider.example/v1',
      apiKey: 'provider-secret',
      defaultModel: 'model-a',
    })

    await expect(
      service.upsertProvider({
        kind: 'llm',
        providerId: 'openai-compatible',
        displayName: 'Compatible',
        enabled: false,
        mode: 'proxy',
        endpoint: 'https://new-provider.example/v1',
        apiKey: created.apiKeyPreview,
        defaultModel: 'model-a',
      }),
    ).rejects.toMatchObject({ code: 'provider_conflict' })
    expect(store.providers.get(created.id)?.apiKey).toBe('provider-secret')

    const moved = await service.upsertProvider({
      id: created.id,
      expectedRevision: created.revision,
      kind: 'llm',
      providerId: 'openai-compatible',
      displayName: 'Compatible',
      enabled: false,
      mode: 'proxy',
      endpoint: 'https://new-provider.example/v1',
      apiKey: created.apiKeyPreview,
      defaultModel: 'model-a',
    })

    expect(moved.id).toBe(created.id)
    expect(moved.apiKeyPreview).toBeNull()
    expect(store.providers.get(created.id)?.apiKey).toBeNull()

    const enabled = await service.upsertProvider({
      id: created.id,
      expectedRevision: moved.revision,
      kind: 'llm',
      providerId: 'openai-compatible',
      displayName: 'Compatible',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://new-provider.example/v1',
      defaultModel: 'model-a',
    })
    expect(enabled.apiKeyPreview).toBeNull()
  })
})

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'rejects no-id provider conflicts and revision-binds cross-origin key clearing on PostgreSQL',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

    const sql = createPostgresConnection(databaseUrl)
    const suffix = randomUUID()
    const actorUserId = `provider-security-owner-${suffix}`
    const control = {
      actorUserId,
      requestId: `provider-security-${suffix}`,
    }
    const providerId = 'openai-compatible'
    const store = createPostgresDesktopConfigStore(
      sql,
      `provider-security-${suffix}`,
      testEnv().providerControlDeadlineMs,
    )
    const service = createDesktopConfigService(store, testEnv())
    let recordId: string | null = null
    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values (${actorUserId}, ${`${actorUserId}@example.invalid`}, 'Provider security owner', true)
      `
      await sql`
        insert into admin_account (user_id, role, status)
        values (${actorUserId}, 'owner', 'active')
      `
      await expect(
        service.upsertProvider({
          kind: 'llm',
          providerId,
          displayName: 'Unauthorized provider mutation',
          enabled: false,
          mode: 'proxy',
          endpoint: 'https://old-provider.example/v1',
          defaultModel: 'model-a',
        }),
      ).rejects.toBeInstanceOf(AdminAuthorizationChangedError)

      const created = await service.upsertProvider(
        {
          kind: 'llm',
          providerId,
          displayName: 'Concurrent compatible provider',
          enabled: true,
          mode: 'proxy',
          endpoint: 'https://old-provider.example/v1',
          apiKey: 'provider-secret-that-must-be-cleared',
          defaultModel: 'model-a',
        },
        { control },
      )
      recordId = created.id

      const conflicts = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          service.upsertProvider(
            {
              kind: 'llm',
              providerId,
              displayName: 'Concurrent compatible provider',
              enabled: false,
              mode: 'proxy',
              endpoint: 'https://new-provider.example/v1',
              apiKey: created.apiKeyPreview,
              defaultModel: 'model-a',
            },
            { control },
          ),
        ),
      )
      expect(conflicts.every((result) => result.status === 'rejected')).toBe(true)
      expect(
        conflicts.every(
          (result) =>
            result.status === 'rejected' &&
            result.reason instanceof Error &&
            'code' in result.reason &&
            result.reason.code === 'provider_conflict',
        ),
      ).toBe(true)

      const moved = await service.upsertProvider(
        {
          id: created.id,
          expectedRevision: created.revision,
          kind: 'llm',
          providerId,
          displayName: 'Concurrent compatible provider',
          enabled: false,
          mode: 'proxy',
          endpoint: 'https://new-provider.example/v1',
          apiKey: created.apiKeyPreview,
          defaultModel: 'model-a',
        },
        { control },
      )
      expect(moved).toMatchObject({ id: created.id, revision: 1, apiKeyPreview: null })
      const rows = await sql<
        {
          endpoint_is_set: boolean
          key_is_null: boolean
          revision: number | string
          records: number | string
        }[]
      >`
        select
          bool_and(endpoint_encrypted is not null) as endpoint_is_set,
          bool_and(api_key_encrypted is null) as key_is_null,
          max(revision)::int as revision,
          count(*)::int as records
        from provider_registry
        where kind = 'llm' and provider_id = ${providerId}
      `
      expect(rows[0]).toMatchObject({
        endpoint_is_set: true,
        key_is_null: true,
        revision: 1,
        records: 1,
      })
    } finally {
      if (recordId)
        await sql`delete from provider_registry where id = ${recordId}`.catch(() => undefined)
      await sql`delete from audit_log where user_id = ${actorUserId}`.catch(() => undefined)
      await sql`delete from "user" where id = ${actorUserId}`.catch(() => undefined)
      await sql.end()
    }
  },
)
