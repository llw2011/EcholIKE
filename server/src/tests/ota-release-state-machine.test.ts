import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
  OtaReleaseStateError,
  type OtaReleaseInput,
  type OtaReleaseStoredRecord,
} from '../services/desktop/desktop-config-service.js'
import type { OtaArtifactValidationResult } from '../services/desktop/ota-artifact-validator.js'
import { testEnv } from './helpers.js'

describe('OTA release administration state machine', () => {
  it('saves incomplete releases only as disabled drafts', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)

    const draft = await service.upsertOtaRelease({
      ...draftInput(),
      artifactBytes: null,
      downloadUrl: null,
      sha256: null,
      signature: null,
    })

    expect(draft).toMatchObject({
      enabled: false,
      forceUpdate: false,
      artifactBytes: null,
      revision: 0,
    })
    await expect(
      store.setOtaReleaseActivation({
        id: draft.id,
        expectedRevision: draft.revision,
        enabled: true,
        forceUpdate: false,
      }),
    ).resolves.toBeNull()
    await expect(
      service.upsertOtaRelease({ ...draftInput(), enabled: true }),
    ).rejects.toBeInstanceOf(OtaReleaseStateError)
    await expect(
      service.upsertOtaRelease({ ...draftInput(), id: 'missing-release' }),
    ).rejects.toMatchObject({ code: 'release_not_found' })
  })

  it('accepts only canonical stable versions and compares unbounded segments exactly', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    await expect(
      service.upsertOtaRelease({ ...draftInput(), version: '01.2.3' }),
    ).rejects.toMatchObject({ code: 'release_incomplete' })
    await expect(
      service.upsertOtaRelease({ ...draftInput(), version: '1.2.3-beta' }),
    ).rejects.toMatchObject({ code: 'release_incomplete' })

    const old = await activateFixture(service, {
      ...draftInput(),
      version: '2.0.0',
      downloadUrl: 'https://artifact.example/EcholIKE_2.0.0_x64-setup.exe',
    })
    const target = await activateFixture(service, {
      ...draftInput(),
      version: '999999999999999999999.0.0',
      downloadUrl: 'https://artifact.example/EcholIKE_999999999999999999999.0.0_x64-setup.exe',
    })
    const invalidTemplate = await store.getOtaReleaseById(target.id)
    if (!invalidTemplate) throw new Error('target fixture is missing')
    store.otaReleases.set('invalid-version', {
      ...invalidTemplate,
      id: 'invalid-version',
      version: '999999999999999999999.0.invalid',
      revision: 0,
    })

    await expect(
      service.resolveOtaPolicy({
        currentVersion: old.version,
        channel: 'stable',
        platform: 'windows',
        arch: 'x86_64',
      }),
    ).resolves.toMatchObject({
      latestVersion: target.version,
      updateAvailable: true,
    })
    await expect(
      service.convergeOtaReleases({
        id: target.id,
        expectedRevision: target.revision,
        currentVersion: old.version,
        channel: 'stable',
        platform: 'windows',
        arch: 'x86_64',
        expectedCovered: [{ id: old.id, revision: old.revision }],
      }),
    ).rejects.toMatchObject({ code: 'release_incomplete' })
    expect(await store.getOtaReleaseById(old.id)).toMatchObject({ enabled: true })
  })

  it('validates without enabling and validates again before activation', async () => {
    const store = createMemoryDesktopConfigStore()
    const validation = validatorFixture()
    const service = createDesktopConfigService(store, testEnv(), validation.options)
    const draft = await service.upsertOtaRelease(draftInput())

    const checked = await service.validateOtaRelease({
      id: draft.id,
      expectedRevision: draft.revision,
    })
    expect(checked.release).toMatchObject({ id: draft.id, enabled: false, revision: 0 })
    expect(checked.validation).toMatchObject({ valid: true, bytes: 4_832_676 })
    expect((await service.listOtaReleases())[0]).toMatchObject({ enabled: false })

    const activated = await service.activateOtaRelease({
      id: draft.id,
      expectedRevision: draft.revision,
      forceUpdate: true,
    })
    expect(activated.release).toMatchObject({
      enabled: true,
      forceUpdate: true,
      revision: 1,
    })
    expect(validation.validate).toHaveBeenCalledTimes(2)
    expect(validation.validate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: draft.id,
        artifactBytes: 4_832_676,
        sha256: 'a'.repeat(64),
        signature: 'signed-update',
      }),
    )
  })

  it('does not activate when artifact validation fails', async () => {
    const store = createMemoryDesktopConfigStore()
    const validation = validatorFixture()
    validation.validate.mockRejectedValueOnce(new Error('artifact rejected'))
    const service = createDesktopConfigService(store, testEnv(), validation.options)
    const draft = await service.upsertOtaRelease(draftInput())

    await expect(
      service.activateOtaRelease({
        id: draft.id,
        expectedRevision: draft.revision,
        forceUpdate: false,
      }),
    ).rejects.toThrow('artifact rejected')
    expect((await service.listOtaReleases())[0]).toMatchObject({
      enabled: false,
      revision: 0,
    })
  })

  it('replays activation and deactivation safely after an acknowledgement is lost', async () => {
    const store = createMemoryDesktopConfigStore()
    const validation = validatorFixture()
    const service = createDesktopConfigService(store, testEnv(), validation.options)
    const draft = await service.upsertOtaRelease(draftInput())

    const firstActivation = await service.activateOtaRelease({
      id: draft.id,
      expectedRevision: draft.revision,
      forceUpdate: false,
    })
    const activationReplay = await service.activateOtaRelease({
      id: draft.id,
      expectedRevision: draft.revision,
      forceUpdate: false,
    })
    expect(activationReplay.release).toEqual(firstActivation.release)
    expect(activationReplay.release.revision).toBe(1)
    expect(validation.validate).toHaveBeenCalledTimes(2)
    await expect(
      service.activateOtaRelease({
        id: draft.id,
        expectedRevision: draft.revision,
        forceUpdate: true,
      }),
    ).rejects.toMatchObject({ code: 'release_stale' })

    const firstDeactivation = await service.deactivateOtaRelease({
      id: draft.id,
      expectedRevision: firstActivation.release.revision,
    })
    const deactivationReplay = await service.deactivateOtaRelease({
      id: draft.id,
      expectedRevision: firstActivation.release.revision,
    })
    expect(deactivationReplay).toEqual(firstDeactivation)
    expect(deactivationReplay.revision).toBe(2)
  })

  it('locks artifact fields while enabled and permits edits only after deactivation', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    const draft = await service.upsertOtaRelease(draftInput())
    const activated = await service.activateOtaRelease({
      id: draft.id,
      expectedRevision: draft.revision,
      forceUpdate: false,
    })

    await expect(
      service.upsertOtaRelease({
        ...draftInput(),
        id: draft.id,
        downloadUrl: 'https://artifact.example/changed.exe',
      }),
    ).rejects.toMatchObject({ code: 'release_active' })

    const deactivated = await service.deactivateOtaRelease({
      id: draft.id,
      expectedRevision: activated.release.revision,
    })
    expect(deactivated).toMatchObject({
      enabled: false,
      forceUpdate: false,
      revision: activated.release.revision + 1,
    })
    const edited = await service.upsertOtaRelease({
      ...draftInput(),
      id: draft.id,
      expectedRevision: deactivated.revision,
      downloadUrl: 'https://artifact.example/changed.exe',
    })
    expect(edited).toMatchObject({
      enabled: false,
      downloadUrlPreview: 'set',
      revision: deactivated.revision + 1,
    })
    expect(await store.getOtaReleaseById(draft.id)).toMatchObject({
      downloadUrl: 'https://artifact.example/changed.exe',
    })
  })

  it('rejects activation if the draft changes after its validation snapshot', async () => {
    const store = createMemoryDesktopConfigStore()
    let draftId = ''
    const validation = validatorFixture(async (release) => {
      await store.upsertOtaRelease({
        ...draftInput(),
        id: draftId,
        expectedRevision: release.revision,
        releaseNotes: 'changed during validation',
      })
      return validationFacts(release)
    })
    const service = createDesktopConfigService(store, testEnv(), validation.options)
    const draft = await service.upsertOtaRelease(draftInput())
    draftId = draft.id

    await expect(
      service.activateOtaRelease({
        id: draft.id,
        expectedRevision: draft.revision,
        forceUpdate: false,
      }),
    ).rejects.toMatchObject({ code: 'release_stale' })
    expect((await service.listOtaReleases())[0]).toMatchObject({
      enabled: false,
      releaseNotes: 'changed during validation',
    })
  })

  it('rejects stale draft edits without overwriting the latest revision', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    const draft = await service.upsertOtaRelease(draftInput())

    const latest = await service.upsertOtaRelease({
      ...draftInput(),
      id: draft.id,
      expectedRevision: draft.revision,
      releaseNotes: 'saved by the newer editor',
    })
    await expect(
      service.upsertOtaRelease({
        ...draftInput(),
        id: draft.id,
        expectedRevision: draft.revision,
        releaseNotes: 'stale editor must not win',
      }),
    ).rejects.toMatchObject({ code: 'release_stale' })
    expect(await service.listOtaReleases()).toContainEqual(
      expect.objectContaining({
        id: draft.id,
        revision: latest.revision,
        releaseNotes: 'saved by the newer editor',
      }),
    )
  })

  it('does not mistake a later equal activation state for an acknowledgement replay', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    const draft = await service.upsertOtaRelease(draftInput())
    const first = await service.activateOtaRelease({
      id: draft.id,
      expectedRevision: draft.revision,
      forceUpdate: false,
    })
    const disabled = await service.deactivateOtaRelease({
      id: draft.id,
      expectedRevision: first.release.revision,
    })
    await service.activateOtaRelease({
      id: draft.id,
      expectedRevision: disabled.revision,
      forceUpdate: false,
    })

    await expect(
      service.activateOtaRelease({
        id: draft.id,
        expectedRevision: draft.revision,
        forceUpdate: false,
      }),
    ).rejects.toMatchObject({ code: 'release_stale' })
  })

  it('refuses a no-id save that collides with an existing release target', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    const original = await service.upsertOtaRelease(draftInput())

    await expect(
      service.upsertOtaRelease({ ...draftInput(), releaseNotes: 'must not overwrite' }),
    ).rejects.toMatchObject({ code: 'release_stale' })
    expect(await store.getOtaReleaseById(original.id)).toMatchObject({
      revision: original.revision,
      releaseNotes: 'Atomic OTA state test',
    })
  })

  it('atomically converges only lower releases fully covered by the current target', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    const target = await activateFixture(service, draftInput())
    const oldAll = await activateFixture(service, {
      ...draftInput(),
      version: '0.2.12',
      downloadUrl: 'https://artifact.example/EcholIKE_0.2.12_x64-setup.exe',
    })
    const oldWindows = await activateFixture(service, {
      ...draftInput(),
      version: '0.2.11',
      platform: 'windows',
      arch: 'x86_64',
      downloadUrl: 'https://artifact.example/EcholIKE_0.2.11_x64-setup.exe',
    })
    const otherChannel = await activateFixture(service, {
      ...draftInput(),
      version: '0.2.10',
      channel: 'beta',
      downloadUrl: 'https://artifact.example/EcholIKE_0.2.10_x64-setup.exe',
    })
    const otherApp = await activateFixture(service, {
      ...draftInput(),
      appName: 'OtherApp',
      version: '9.0.0',
      downloadUrl: 'https://artifact.example/OtherApp_9.0.0_x64-setup.exe',
    })

    const result = await service.convergeOtaReleases(
      {
        id: target.id,
        expectedRevision: target.revision,
        currentVersion: '0.2.12',
        channel: 'stable',
        platform: 'windows',
        arch: 'x86_64',
        expectedCovered: [
          { id: oldAll.id, revision: oldAll.revision },
          { id: oldWindows.id, revision: oldWindows.revision },
        ],
      },
      { control: { actorUserId: 'owner', requestId: 'converge-current-release' } },
    )

    expect(result).toMatchObject({
      release: { id: target.id, enabled: true, revision: target.revision },
      deactivatedCount: 2,
      constraintValidated: true,
    })
    expect(await store.getOtaReleaseById(oldAll.id)).toMatchObject({
      enabled: false,
      revision: oldAll.revision + 1,
    })
    expect(await store.getOtaReleaseById(oldWindows.id)).toMatchObject({
      enabled: false,
      revision: oldWindows.revision + 1,
    })
    expect(await store.getOtaReleaseById(otherChannel.id)).toMatchObject({ enabled: true })
    expect(await store.getOtaReleaseById(otherApp.id)).toMatchObject({ enabled: true })
    expect(store.controlAudits.at(-1)).toMatchObject({
      action: 'admin.ota.converge',
      metadata: { deactivatedCount: 2, constraintValidated: true },
    })
  })

  it('rejects convergence when the target is stale or no longer the highest matching release', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    const target = await activateFixture(service, draftInput())
    await activateFixture(service, {
      ...draftInput(),
      version: '0.2.14',
      platform: 'win32',
      arch: 'amd64',
      downloadUrl: 'https://artifact.example/EcholIKE_0.2.14_x64-setup.exe',
    })

    await expect(
      service.convergeOtaReleases({
        id: target.id,
        expectedRevision: target.revision - 1,
        currentVersion: '0.2.12',
        channel: 'stable',
        platform: 'windows',
        arch: 'x86_64',
        expectedCovered: [],
      }),
    ).rejects.toMatchObject({ code: 'release_stale' })
    await expect(
      service.convergeOtaReleases({
        id: target.id,
        expectedRevision: target.revision,
        currentVersion: '0.2.12',
        channel: 'stable',
        platform: 'windows',
        arch: 'x86_64',
        expectedCovered: [],
      }),
    ).rejects.toMatchObject({ code: 'release_not_current' })
    expect(await store.getOtaReleaseById(target.id)).toMatchObject({
      enabled: true,
      revision: target.revision,
    })
  })

  it('rejects convergence when the covered release snapshot changes before the transaction', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    const target = await activateFixture(service, draftInput())
    const expectedOld = await activateFixture(service, {
      ...draftInput(),
      version: '0.2.12',
      downloadUrl: 'https://artifact.example/EcholIKE_0.2.12_x64-setup.exe',
    })
    const concurrentOld = await activateFixture(service, {
      ...draftInput(),
      version: '0.2.11',
      downloadUrl: 'https://artifact.example/EcholIKE_0.2.11_x64-setup.exe',
    })

    await expect(
      service.convergeOtaReleases({
        id: target.id,
        expectedRevision: target.revision,
        currentVersion: '0.2.12',
        channel: 'stable',
        platform: 'windows',
        arch: 'x86_64',
        expectedCovered: [{ id: expectedOld.id, revision: expectedOld.revision }],
      }),
    ).rejects.toMatchObject({ code: 'release_stale' })
    expect(await store.getOtaReleaseById(expectedOld.id)).toMatchObject({ enabled: true })
    expect(await store.getOtaReleaseById(concurrentOld.id)).toMatchObject({ enabled: true })
  })

  it('rolls convergence back when any enabled release violates the artifact constraint', async () => {
    const store = createMemoryDesktopConfigStore()
    const service = createDesktopConfigService(store, testEnv(), validatorFixture().options)
    const target = await activateFixture(service, draftInput())
    const old = await activateFixture(service, {
      ...draftInput(),
      version: '0.2.12',
      downloadUrl: 'https://artifact.example/EcholIKE_0.2.12_x64-setup.exe',
    })
    const invalidTemplate = await store.getOtaReleaseById(target.id)
    if (!invalidTemplate) throw new Error('target fixture is missing')
    store.otaReleases.set('invalid-unrelated', {
      ...invalidTemplate,
      id: 'invalid-unrelated',
      appName: 'OtherApp',
      version: '1.0.0',
      channel: 'beta',
      enabled: true,
      artifactBytes: null,
      downloadUrl: null,
      downloadUrlPreview: 'missing',
      sha256: null,
      signature: null,
      revision: 0,
      createdAt: null,
      publishedAt: null,
    })

    await expect(
      service.convergeOtaReleases({
        id: target.id,
        expectedRevision: target.revision,
        currentVersion: '0.2.12',
        channel: 'stable',
        platform: 'windows',
        arch: 'x86_64',
        expectedCovered: [{ id: old.id, revision: old.revision }],
      }),
    ).rejects.toMatchObject({ code: 'release_incomplete' })
    expect(await store.getOtaReleaseById(old.id)).toMatchObject({
      enabled: true,
      revision: old.revision,
    })
    expect(store.controlAudits.some((audit) => audit.action === 'admin.ota.converge')).toBe(false)
  })
})

async function activateFixture(
  service: ReturnType<typeof createDesktopConfigService>,
  input: OtaReleaseInput,
): Promise<Awaited<ReturnType<typeof service.activateOtaRelease>>['release']> {
  const draft = await service.upsertOtaRelease(input)
  return (
    await service.activateOtaRelease({
      id: draft.id,
      expectedRevision: draft.revision,
      forceUpdate: false,
    })
  ).release
}

function draftInput(): OtaReleaseInput {
  return {
    appName: 'EcholIKE',
    version: '0.2.13',
    channel: 'stable',
    platform: 'all',
    arch: 'all',
    enabled: false,
    autoUpdate: false,
    forceUpdate: false,
    minVersion: null,
    artifactBytes: 4_832_676,
    downloadUrl: 'https://artifact.example/EcholIKE_0.2.13_x64-setup.exe',
    sha256: 'a'.repeat(64),
    signature: 'signed-update',
    releaseNotes: 'Atomic OTA state test',
  }
}

function validatorFixture(
  implementation: (
    release: OtaReleaseStoredRecord,
  ) => Promise<OtaArtifactValidationResult> = async (release) => validationFacts(release),
) {
  const validate = vi.fn(implementation)
  return {
    validate,
    options: { validateOtaReleaseArtifact: validate },
  }
}

function validationFacts(release: OtaReleaseStoredRecord): OtaArtifactValidationResult {
  return {
    valid: true,
    bytes: release.artifactBytes ?? 0,
    sha256: release.sha256 ?? '',
    contentLength: release.artifactBytes,
    redirects: 0,
    network: 'public',
    signaturePresent: true,
    artifactType: 'windows-pe-installer',
    expectedVersion: release.version,
    versionFacts: {
      installerFileVersion: `${release.version}.0`,
      installerProductVersion: `${release.version}.0`,
    },
  }
}
