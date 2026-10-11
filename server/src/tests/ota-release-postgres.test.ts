import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createPostgresConnection,
  createPostgresDesktopConfigStore,
  OTA_CONTROL_LOCK_KEY,
} from '../db/client.js'
import { createDesktopConfigService } from '../services/desktop/desktop-config-service.js'
import { testEnv } from './helpers.js'

describe('OTA release PostgreSQL state contract', () => {
  it('declares artifact length and non-negative revision facts in the migration', () => {
    const migration = readFileSync(
      new URL('../db/migrations/0012_ota_artifact_bytes.sql', import.meta.url),
      'utf8',
    )
    const journal = JSON.parse(
      readFileSync(new URL('../db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries?: Array<{ idx?: number; tag?: string }> }

    expect(migration).toContain('ADD COLUMN "artifact_bytes" integer')
    expect(migration).toContain('ALTER COLUMN "enabled" SET DEFAULT false')
    expect(migration).toContain('"ota_release_artifact_bytes_check"')
    expect(migration).toContain('ADD COLUMN "revision" integer DEFAULT 0 NOT NULL')
    expect(migration).toContain('"ota_release_revision_check"')
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 12, tag: '0012_ota_artifact_bytes' }),
    )
    const invariantMigration = readFileSync(
      new URL('../db/migrations/0013_control_revisions_and_invariants.sql', import.meta.url),
      'utf8',
    )
    expect(invariantMigration).toContain('"provider_registry_revision_check"')
    expect(invariantMigration).toContain('"ota_release_force_enabled_check"')
    expect(invariantMigration).toContain('"ota_release_enabled_artifact_check"')
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 13, tag: '0013_control_revisions_and_invariants' }),
    )
  })
})

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'serializes activation, field locking, deactivation, and stale revisions on PostgreSQL',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

    const sql = createPostgresConnection(databaseUrl)
    const store = createPostgresDesktopConfigStore(
      sql,
      `ota-state-${randomUUID()}`,
      testEnv().providerControlDeadlineMs,
    )
    const actorUserId = `ota-state-owner-${randomUUID()}`
    const control = { actorUserId, requestId: `ota-state-${randomUUID()}` }
    let releaseId: string | null = null
    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values (${actorUserId}, ${`${actorUserId}@example.invalid`}, 'OTA state owner', true)
      `
      await sql`
        insert into admin_account (user_id, role, status)
        values (${actorUserId}, 'owner', 'active')
      `
      const versionGroup = await sql<{ value: string }[]>`
        select txid_current()::text as value
      `
      if (!versionGroup[0]?.value) throw new Error('OTA version group is missing')
      const version = `${versionGroup[0].value}.0.0`
      const draft = await store.upsertOtaRelease(
        {
          appName: 'EcholIKE',
          version,
          channel: 'test',
          platform: 'windows',
          arch: 'x86_64',
          enabled: false,
          autoUpdate: false,
          forceUpdate: false,
          artifactBytes: 1024,
          downloadUrl: `https://artifact.example/${version}.exe`,
          sha256: 'a'.repeat(64),
          signature: 'postgres-state-fixture',
          releaseNotes: 'PostgreSQL OTA state fixture',
        },
        control,
      )
      expect(draft).toMatchObject({ enabled: false, forceUpdate: false, revision: 0 })
      if (!draft) throw new Error('OTA PostgreSQL draft was not saved')
      releaseId = draft.id

      const concurrent = await Promise.all([
        store.setOtaReleaseActivation({
          id: draft.id,
          expectedRevision: draft.revision,
          enabled: true,
          forceUpdate: false,
          control,
        }),
        store.setOtaReleaseActivation({
          id: draft.id,
          expectedRevision: draft.revision,
          enabled: true,
          forceUpdate: false,
          control,
        }),
      ])
      expect(concurrent.filter(Boolean)).toHaveLength(1)
      const active = concurrent.find(Boolean)
      expect(active).toMatchObject({ enabled: true, revision: 1 })

      await expect(
        store.upsertOtaRelease(
          {
            ...draft,
            expectedRevision: draft.revision,
            enabled: false,
            forceUpdate: false,
            releaseNotes: 'must not overwrite an active release',
          },
          control,
        ),
      ).resolves.toBeNull()

      const deactivated = await store.setOtaReleaseActivation({
        id: draft.id,
        expectedRevision: 1,
        enabled: false,
        forceUpdate: false,
        control,
      })
      expect(deactivated).toMatchObject({ enabled: false, forceUpdate: false, revision: 2 })

      const edited = await store.upsertOtaRelease(
        {
          ...draft,
          expectedRevision: 2,
          enabled: false,
          forceUpdate: false,
          releaseNotes: 'edited after deactivation',
        },
        control,
      )
      expect(edited).toMatchObject({ enabled: false, revision: 3 })
      await expect(
        store.upsertOtaRelease(
          {
            ...draft,
            expectedRevision: 2,
            enabled: false,
            forceUpdate: false,
            releaseNotes: 'stale editor must not overwrite revision 3',
          },
          control,
        ),
      ).resolves.toBeNull()
      await expect(
        store.setOtaReleaseActivation({
          id: draft.id,
          expectedRevision: 2,
          enabled: true,
          forceUpdate: false,
          control,
        }),
      ).resolves.toBeNull()
    } finally {
      if (releaseId)
        await sql`delete from ota_release where id = ${releaseId}`.catch(() => undefined)
      await sql`delete from audit_log where user_id = ${actorUserId}`.catch(() => undefined)
      await sql`delete from "user" where id = ${actorUserId}`.catch(() => undefined)
      await sql.end()
    }
  },
)

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'converges covered releases and validates the artifact constraint in one PostgreSQL transaction',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

    const sql = createPostgresConnection(databaseUrl)
    const store = createPostgresDesktopConfigStore(
      sql,
      `ota-converge-${randomUUID()}`,
      testEnv().providerControlDeadlineMs,
    )
    const actorUserId = `ota-converge-owner-${randomUUID()}`
    const control = { actorUserId, requestId: `ota-converge-${randomUUID()}` }
    const releaseIds: string[] = []
    let auditFailureConstraint: string | null = null
    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values (${actorUserId}, ${`${actorUserId}@example.invalid`}, 'OTA converge owner', true)
      `
      await sql`
        insert into admin_account (user_id, role, status)
        values (${actorUserId}, 'owner', 'active')
      `
      await sql`
        alter table public.ota_release
        drop constraint ota_release_enabled_artifact_check
      `
      await sql`
        alter table public.ota_release
        add constraint ota_release_enabled_artifact_check
        check (
          not enabled or (
            artifact_bytes is not null and artifact_bytes > 0 and
            nullif(btrim(download_url_encrypted), '') is not null and
            sha256 is not null and sha256 ~* '^[a-f0-9]{64}$' and
            nullif(btrim(signature), '') is not null
          )
        ) not valid
      `
      const initiallyUnvalidated = await sql<{ convalidated: boolean }[]>`
        select convalidated
        from pg_catalog.pg_constraint
        where conname = 'ota_release_enabled_artifact_check'
          and conrelid = 'public.ota_release'::regclass
      `
      expect(initiallyUnvalidated).toEqual([{ convalidated: false }])
      const versionGroup = await sql<{ value: string }[]>`
        select txid_current()::text as value
      `
      const versionGroupValue = versionGroup[0]?.value
      if (!versionGroupValue) throw new Error('OTA version group is missing')
      const version = (patch: number) => `${versionGroupValue}.0.${patch}`
      const createActive = async (version: string, channel = 'test') => {
        const draft = await store.upsertOtaRelease(
          {
            appName: 'EcholIKE',
            version,
            channel,
            platform: 'all',
            arch: 'all',
            enabled: false,
            autoUpdate: false,
            forceUpdate: false,
            artifactBytes: 1024,
            downloadUrl: `https://artifact.example/${version}.exe`,
            sha256: 'b'.repeat(64),
            signature: 'postgres-convergence-fixture',
            releaseNotes: 'PostgreSQL OTA convergence fixture',
          },
          control,
        )
        if (!draft) throw new Error('OTA convergence draft was not saved')
        releaseIds.push(draft.id)
        const active = await store.setOtaReleaseActivation({
          id: draft.id,
          expectedRevision: draft.revision,
          enabled: true,
          forceUpdate: false,
          control,
        })
        if (!active) throw new Error('OTA convergence fixture was not activated')
        return active
      }
      const old = await createActive(version(1))
      const target = await createActive(version(5))
      const otherChannel = await createActive(version(0), 'other-test')

      const service = createDesktopConfigService(store, testEnv())
      const result = await service.convergeOtaReleases(
        {
          id: target.id,
          expectedRevision: target.revision,
          currentVersion: old.version,
          channel: target.channel,
          platform: 'windows',
          arch: 'x86_64',
          expectedCovered: [{ id: old.id, revision: old.revision }],
        },
        { control },
      )

      expect(result).toMatchObject({
        release: { id: target.id, enabled: true, revision: target.revision },
        deactivatedCount: 1,
        constraintValidated: true,
      })
      expect(await store.getOtaReleaseById(old.id)).toMatchObject({
        enabled: false,
        revision: old.revision + 1,
      })
      expect(await store.getOtaReleaseById(otherChannel.id)).toMatchObject({ enabled: true })
      const constraint = await sql<{ convalidated: boolean }[]>`
        select convalidated
        from pg_constraint
        where conname = 'ota_release_enabled_artifact_check'
          and conrelid = 'public.ota_release'::regclass
      `
      expect(constraint).toEqual([{ convalidated: true }])
      const audit = await sql<{ action: string; metadata_json: unknown }[]>`
        select action, metadata_json
        from audit_log
        where request_id = ${control.requestId}
          and action = 'admin.ota.converge'
      `
      expect(audit).toEqual([
        expect.objectContaining({
          action: 'admin.ota.converge',
          metadata_json: expect.objectContaining({
            deactivatedCount: 1,
            constraintValidated: true,
          }),
        }),
      ])

      const rollbackOld = await createActive(version(2))
      const convergenceRequestId = `ota-converge-stale-${randomUUID()}`
      const expectedCovered = [{ id: rollbackOld.id, revision: rollbackOld.revision }]
      const concurrentOld = await createActive(version(3))
      await expect(
        service.convergeOtaReleases(
          {
            id: target.id,
            expectedRevision: target.revision,
            currentVersion: rollbackOld.version,
            channel: target.channel,
            platform: 'windows',
            arch: 'x86_64',
            expectedCovered,
          },
          { control: { ...control, requestId: convergenceRequestId } },
        ),
      ).rejects.toMatchObject({ code: 'release_stale' })
      expect(await store.getOtaReleaseById(rollbackOld.id)).toMatchObject({
        enabled: true,
        revision: rollbackOld.revision,
      })
      expect(await store.getOtaReleaseById(concurrentOld.id)).toMatchObject({
        enabled: true,
        revision: concurrentOld.revision,
      })
      const staleAudits = await sql<{ count: number }[]>`
        select count(*)::integer as count
        from public.audit_log
        where request_id = ${convergenceRequestId}
      `
      expect(staleAudits).toEqual([{ count: 0 }])

      auditFailureConstraint = `audit_reject_converge_${randomUUID().replaceAll('-', '')}`
      await sql.unsafe(`
        alter table public.audit_log
        add constraint "${auditFailureConstraint}"
        check (action <> 'admin.ota.converge') not valid
      `)
      await expect(
        service.convergeOtaReleases(
          {
            id: target.id,
            expectedRevision: target.revision,
            currentVersion: rollbackOld.version,
            channel: target.channel,
            platform: 'windows',
            arch: 'x86_64',
            expectedCovered: [
              { id: rollbackOld.id, revision: rollbackOld.revision },
              { id: concurrentOld.id, revision: concurrentOld.revision },
            ],
          },
          {
            control: { ...control, requestId: `ota-converge-rollback-${randomUUID()}` },
          },
        ),
      ).rejects.toBeTruthy()
      expect(await store.getOtaReleaseById(rollbackOld.id)).toMatchObject({
        enabled: true,
        revision: rollbackOld.revision,
      })
      expect(await store.getOtaReleaseById(concurrentOld.id)).toMatchObject({
        enabled: true,
        revision: concurrentOld.revision,
      })
      await sql.unsafe(`alter table public.audit_log drop constraint "${auditFailureConstraint}"`)
      auditFailureConstraint = null
    } finally {
      if (auditFailureConstraint)
        await sql
          .unsafe(`alter table public.audit_log drop constraint "${auditFailureConstraint}"`)
          .catch(() => undefined)
      if (releaseIds.length)
        await sql`delete from ota_release where id in ${sql(releaseIds)}`.catch(() => undefined)
      await sql`delete from audit_log where user_id = ${actorUserId}`.catch(() => undefined)
      await sql`delete from "user" where id = ${actorUserId}`.catch(() => undefined)
      await sql`
        alter table public.ota_release
        validate constraint ota_release_enabled_artifact_check
      `.catch(() => undefined)
      await sql.end()
    }
  },
)

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'bounds the shared advisory lock for concurrent activation and deactivation transactions',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

    const env = testEnv()
    const sql = createPostgresConnection(databaseUrl)
    const blocker = createPostgresConnection(databaseUrl)
    const store = createPostgresDesktopConfigStore(
      sql,
      `ota-lock-${randomUUID()}`,
      env.providerControlDeadlineMs,
    )
    const actorUserId = `ota-lock-owner-${randomUUID()}`
    const control = { actorUserId, requestId: `ota-lock-${randomUUID()}` }
    const releaseIds: string[] = []
    try {
      await sql`
        insert into "user" (id, email, name, email_verified)
        values (${actorUserId}, ${`${actorUserId}@example.invalid`}, 'OTA lock owner', true)
      `
      await sql`
        insert into admin_account (user_id, role, status)
        values (${actorUserId}, 'owner', 'active')
      `
      const createDraft = async (version: string) => {
        const draft = await store.upsertOtaRelease(
          {
            appName: 'EcholIKE',
            version,
            channel: 'lock-test',
            platform: 'all',
            arch: 'all',
            enabled: false,
            autoUpdate: false,
            forceUpdate: false,
            artifactBytes: 1024,
            downloadUrl: `https://artifact.example/${version}.exe`,
            sha256: 'c'.repeat(64),
            signature: 'postgres-lock-fixture',
            releaseNotes: 'PostgreSQL OTA lock fixture',
          },
          control,
        )
        if (!draft) throw new Error('OTA lock draft was not saved')
        releaseIds.push(draft.id)
        return draft
      }
      const versionGroup = await sql<{ value: string }[]>`
        select txid_current()::text as value
      `
      if (!versionGroup[0]?.value) throw new Error('OTA version group is missing')
      const activationDraft = await createDraft(`${versionGroup[0].value}.0.1`)
      const deactivationDraft = await createDraft(`${versionGroup[0].value}.0.2`)
      const active = await store.setOtaReleaseActivation({
        id: deactivationDraft.id,
        expectedRevision: deactivationDraft.revision,
        enabled: true,
        forceUpdate: false,
        control,
      })
      if (!active) throw new Error('OTA lock active fixture was not saved')

      await blocker.begin(async (transaction) => {
        await transaction`
          select pg_advisory_xact_lock(hashtextextended(${OTA_CONTROL_LOCK_KEY}, 0))
        `
        const activationControl = {
          ...control,
          requestId: `ota-lock-blocked-activate-${randomUUID()}`,
        }
        const deactivationControl = {
          ...control,
          requestId: `ota-lock-blocked-deactivate-${randomUUID()}`,
        }
        const blocked = await Promise.allSettled([
          store.setOtaReleaseActivation({
            id: activationDraft.id,
            expectedRevision: activationDraft.revision,
            enabled: true,
            forceUpdate: false,
            control: activationControl,
          }),
          store.setOtaReleaseActivation({
            id: active.id,
            expectedRevision: active.revision,
            enabled: false,
            forceUpdate: false,
            control: deactivationControl,
          }),
        ])
        expect(blocked).toHaveLength(2)
        for (const result of blocked) {
          expect(result.status).toBe('rejected')
          if (result.status === 'rejected') {
            expect(['55P03', '57014']).toContain(result.reason?.code)
          }
        }
        const blockedAudits = await transaction<{ count: number }[]>`
          select count(*)::integer as count
          from public.audit_log
          where request_id in (${activationControl.requestId}, ${deactivationControl.requestId})
        `
        expect(blockedAudits).toEqual([{ count: 0 }])
      })

      expect(await store.getOtaReleaseById(activationDraft.id)).toMatchObject({
        enabled: false,
        revision: activationDraft.revision,
      })
      expect(await store.getOtaReleaseById(active.id)).toMatchObject({
        enabled: true,
        revision: active.revision,
      })
      const completed = await Promise.all([
        store.setOtaReleaseActivation({
          id: activationDraft.id,
          expectedRevision: activationDraft.revision,
          enabled: true,
          forceUpdate: false,
          control,
        }),
        store.setOtaReleaseActivation({
          id: active.id,
          expectedRevision: active.revision,
          enabled: false,
          forceUpdate: false,
          control,
        }),
      ])
      expect(completed).toEqual([
        expect.objectContaining({ enabled: true, revision: activationDraft.revision + 1 }),
        expect.objectContaining({ enabled: false, revision: active.revision + 1 }),
      ])
    } finally {
      if (releaseIds.length)
        await sql`delete from ota_release where id in ${sql(releaseIds)}`.catch(() => undefined)
      await sql`delete from audit_log where user_id = ${actorUserId}`.catch(() => undefined)
      await sql`delete from "user" where id = ${actorUserId}`.catch(() => undefined)
      await Promise.all([sql.end(), blocker.end()])
    }
  },
  testEnv().providerControlDeadlineMs * 3,
)
