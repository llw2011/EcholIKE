import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ControlReleaseError,
  assertArtifactValidation,
  compareCanonicalVersions,
  computeExpectedCovered,
  createDraftPayload,
  executeControlAction,
  parseCanonicalVersion,
  parseCliArgs,
  parseManifestBytes,
  parseManifestText,
  releasePayloadMatches,
  runProductionCli,
  safeJson,
} from '../control-release.mjs'

const PUBLIC_API_BASE_URL = 'https://updates.example.test/echo-api'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ADAPTER_TEST_ROOT = join(REPO_ROOT, 'src-tauri', 'target-codex-check', 'ota-control-tests')

test('strict manifest preserves exact UTF-8 notes and validates signature metadata', () => {
  const source = manifestFixture({ releaseNotes: '修复历史记录。\n保留精确换行。' })
  const parsed = parseManifestBytes(Buffer.from(JSON.stringify(source), 'utf8'))

  assert.equal(parsed.releaseNotes, source.releaseNotes)
  assert.equal(parsed.artifact.signature.value, source.artifact.signature.value)
  assert.ok(Object.isFrozen(parsed))
  assert.ok(Object.isFrozen(parsed.artifact.signature))
})

test('strict manifest rejects extra fields, duplicate keys, BOM, bad paths, and changed signature bytes', () => {
  const source = manifestFixture()
  assert.throws(
    () => parseManifestText(JSON.stringify({ ...source, downloadUrl: 'https://attacker.invalid' })),
    hasCode('manifest_invalid'),
  )
  assert.throws(
    () =>
      parseManifestText(
        JSON.stringify(source).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      ),
    hasCode('manifest_invalid'),
  )
  assert.throws(
    () => parseManifestBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])),
    hasCode('manifest_invalid'),
  )
  assert.throws(() => parseManifestBytes(Buffer.from([0xc3, 0x28])), hasCode('manifest_invalid'))
  assert.throws(
    () =>
      parseManifestText(
        JSON.stringify({
          ...source,
          artifact: { ...source.artifact, sourcePath: '/tmp/../artifact.exe' },
        }),
      ),
    hasCode('manifest_invalid'),
  )
  assert.throws(
    () =>
      parseManifestText(
        JSON.stringify({
          ...source,
          artifact: {
            ...source.artifact,
            signature: {
              ...source.artifact.signature,
              value: `${source.artifact.signature.value}A`,
            },
          },
        }),
      ),
    hasCode('manifest_invalid'),
  )
  assert.throws(
    () => parseManifestText(JSON.stringify({ ...source, releaseNotes: 'changed\n' })),
    hasCode('manifest_invalid'),
  )
  assert.throws(
    () =>
      parseManifestText(
        JSON.stringify({
          ...source,
          artifact: {
            ...source.artifact,
            bytes: 512 * 1024 * 1024 + 1,
          },
        }),
      ),
    hasCode('manifest_invalid'),
  )
  assert.throws(
    () =>
      parseManifestText(
        JSON.stringify({
          ...source,
          artifact: {
            ...source.artifact,
            signature: {
              ...source.artifact.signature,
              sourcePath: source.artifact.sourcePath,
            },
          },
        }),
      ),
    hasCode('manifest_invalid'),
  )
})

test('canonical versions compare with BigInt and reject aliases or leading zeroes', () => {
  assert.deepEqual(parseCanonicalVersion('999999999999999999999.2.3'), [
    999999999999999999999n,
    2n,
    3n,
  ])
  assert.equal(compareCanonicalVersions('999999999999999999999.0.0', '9007199254740992.999.999'), 1)
  assert.throws(() => parseCanonicalVersion('01.2.3'), hasCode('version_invalid'))
  assert.throws(() => parseCanonicalVersion('1.2.3.0'), hasCode('version_invalid'))
  assert.throws(
    () => parseManifestText(JSON.stringify(manifestFixture({ baselineVersion: '0.2.15' }))),
    hasCode('baseline_version_not_lower'),
  )
})

test('draft payload derives the fixed public artifact path and compares exact notes/signature', () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const payload = createDraftPayload(manifest, `${PUBLIC_API_BASE_URL}?ignored=path`)

  assert.equal(
    payload.downloadUrl,
    'https://updates.example.test/echo-panel/ota/EcholIKE_0.2.15_x64-setup.exe',
  )
  assert.equal(payload.releaseNotes, manifest.releaseNotes)
  assert.equal(payload.signature, manifest.artifact.signature.value)
  assert.equal(releasePayloadMatches(fullRelease(payload), payload), true)
  assert.equal(
    releasePayloadMatches(
      fullRelease({ ...payload, releaseNotes: `${payload.releaseNotes} ` }),
      payload,
    ),
    false,
  )
})

test('artifact result only accepts complete public validation and version or version.0 PE facts', () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const exact = validationFixture(manifest, manifest.version)
  const fourPart = validationFixture(manifest, `${manifest.version}.0`)

  assert.equal(assertArtifactValidation(exact, manifest), exact)
  assert.equal(assertArtifactValidation(fourPart, manifest), fourPart)
  assert.throws(
    () =>
      assertArtifactValidation(validationFixture(manifest, `${manifest.version}.0.0`), manifest),
    hasCode('artifact_validation_mismatch'),
  )
  assert.throws(
    () => assertArtifactValidation({ ...exact, contentLength: null }, manifest),
    hasCode('artifact_validation_mismatch'),
  )
  assert.throws(
    () => assertArtifactValidation({ ...exact, network: 'explicit_local' }, manifest),
    hasCode('artifact_validation_mismatch'),
  )
})

test('safe output rejects URL/signature/credential fields and values', () => {
  const safe = safeJson({
    ok: true,
    action: 'activate',
    release: { releaseId: 'release_1', version: '0.2.15', enabled: true, revision: 1 },
  })
  assert.doesNotMatch(safe, /https|signature|credential/i)
  assert.throws(() => safeJson({ downloadUrl: 'redacted' }), hasCode('safe_output_invalid'))
  assert.throws(
    () => safeJson({ value: 'https://updates.invalid/a.exe' }),
    hasCode('safe_output_invalid'),
  )
  assert.throws(() => safeJson({ signatureVerified: true }), hasCode('safe_output_invalid'))
})

test('CLI requires absolute WSL paths and exactly one explicit action', () => {
  assert.deepEqual(
    parseCliArgs([
      '--manifest',
      '/tmp/release.json',
      '--production-root',
      '/srv/echolike',
      '--activate',
    ]),
    {
      manifestPath: '/tmp/release.json',
      productionRoot: '/srv/echolike',
      action: 'activate',
    },
  )
  assert.throws(
    () =>
      parseCliArgs([
        '--manifest',
        'release.json',
        '--production-root',
        '/srv/echolike',
        '--inspect',
      ]),
    hasCode('arguments_invalid'),
  )
  assert.throws(
    () =>
      parseCliArgs([
        '--manifest',
        '/tmp/release.json',
        '--production-root',
        '/srv/echolike',
        '--inspect',
        '--activate',
      ]),
    hasCode('arguments_invalid'),
  )
})

test('control actions reject a manifest bound to a different public environment', async () => {
  const manifest = parseManifestText(
    JSON.stringify(manifestFixture({ publicApiBaseUrl: 'https://other.example.test/echo-api' })),
  )
  const fake = fakeServices(manifest, { withDraft: true, withBaseline: true })

  await assert.rejects(() => execute(fake, 'inspect'), hasCode('production_environment_mismatch'))
  assert.equal(fake.calls.upsert.length, 0)
  assert.equal(fake.calls.activate.length, 0)
})

test('create-draft writes a disabled record, reads it back, and replays the exact draft', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const fake = fakeServices(manifest)
  const first = await execute(fake, 'create-draft')
  const replay = await execute(fake, 'create-draft')

  assert.deepEqual(first.release, {
    releaseId: 'release_target',
    version: '0.2.15',
    enabled: false,
    revision: 0,
  })
  assert.equal(first.replayed, false)
  assert.equal(first.status, 'created')
  assert.equal(replay.replayed, true)
  assert.equal(replay.status, 'already-draft')
  assert.equal(fake.calls.upsert.length, 1)
  assert.match(fake.calls.upsert[0].options.control.requestId, /^request_\d+$/)
  assert.equal(fake.calls.upsert[0].options.control.actorUserId, 'owner_1')
})

test('create-draft resumes after the database commit succeeds but its ACK is lost', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const fake = fakeServices(manifest, { loseDraftAckOnce: true })

  await assert.rejects(() => execute(fake, 'create-draft'), /lost draft acknowledgement/)
  assert.equal(fake.release('release_target').enabled, false)
  assert.equal(fake.release('release_target').revision, 0)

  const replay = await execute(fake, 'create-draft')
  assert.equal(replay.status, 'already-draft')
  assert.equal(replay.replayed, true)
  assert.equal(fake.calls.upsert.length, 1)
})

test('create-draft treats an exact active target as a no-write resume state', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const fake = fakeServices(manifest, { withDraft: true, withBaseline: true })
  const target = fake.release('release_target')
  target.enabled = true
  target.revision = 1

  const result = await execute(fake, 'create-draft')
  assert.equal(result.status, 'already-active')
  assert.equal(result.state, 'active')
  assert.equal(fake.calls.upsert.length, 0)
})

test('inspect exposes only safe aggregate target and enabled-state facts', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const fake = fakeServices(manifest, {
    withDraft: true,
    withBaseline: true,
    withUnrelatedEnabled: true,
  })
  const result = await execute(fake, 'inspect')

  assert.equal(result.targetCount, 1)
  assert.equal(result.targetEnabled, false)
  assert.equal(result.targetRevision, 0)
  assert.equal(result.latestVersion, '0.2.14')
  assert.equal(result.enabledCount, 1)
  assert.doesNotMatch(safeJson(result), /https|signature|credential/i)
})

test('activate validates before CAS, uses exact covered snapshot, and verifies convergence readback', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const fake = fakeServices(manifest, { withDraft: true, withBaseline: true })
  const result = await execute(fake, 'activate')

  assert.equal(result.state, 'active')
  assert.equal(result.replayedActivation, false)
  assert.equal(result.deactivatedCount, 1)
  assert.equal(result.constraintValidated, true)
  assert.equal(fake.calls.validate.length, 1)
  assert.equal(fake.calls.activate[0].input.expectedRevision, 0)
  assert.deepEqual(fake.calls.converge[0].input.expectedCovered, [
    { id: 'release_baseline', revision: 1 },
  ])
  assert.equal(fake.calls.converge[0].input.currentVersion, '0.2.14')
  assert.equal(fake.release('release_target').enabled, true)
  assert.equal(fake.release('release_baseline').enabled, false)
})

test('activation-success ACK loss resumes through active revision-1 replay', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const fake = fakeServices(manifest, {
    withDraft: true,
    withBaseline: true,
    loseActivationAckOnce: true,
  })

  await assert.rejects(() => execute(fake, 'activate'), /lost activation acknowledgement/)
  assert.equal(fake.release('release_target').enabled, true)
  assert.equal(fake.release('release_target').revision, 1)

  const replay = await execute(fake, 'activate')
  assert.equal(replay.replayedActivation, true)
  assert.equal(replay.deactivatedCount, 1)
  assert.equal(fake.calls.activate.at(-1).input.expectedRevision, 0)
})

test('convergence-output ACK loss reruns as an idempotent zero-deactivation convergence', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const fake = fakeServices(manifest, {
    withDraft: true,
    withBaseline: true,
    loseConvergenceAckOnce: true,
  })

  await assert.rejects(() => execute(fake, 'activate'), /lost convergence acknowledgement/)
  assert.equal(fake.release('release_baseline').enabled, false)

  const replay = await execute(fake, 'activate')
  assert.equal(replay.replayedActivation, true)
  assert.equal(replay.deactivatedCount, 0)
  assert.deepEqual(fake.calls.converge.at(-1).input.expectedCovered, [])
})

test('post-convergence readback rejects a concurrently enabled equal-version competitor', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const fake = fakeServices(manifest, {
    withDraft: true,
    withBaseline: true,
    insertCompetingAfterConvergence: true,
  })

  await assert.rejects(() => execute(fake, 'activate'), hasCode('convergence_readback_mismatch'))
})

test('activate fails closed on baseline drift and exact payload mismatch', async () => {
  const manifest = parseManifestText(JSON.stringify(manifestFixture()))
  const drift = fakeServices(manifest, {
    withDraft: true,
    currentVersion: '0.2.13',
  })
  await assert.rejects(() => execute(drift, 'activate'), hasCode('baseline_release_drift'))
  assert.equal(drift.calls.activate.length, 0)

  const conflict = fakeServices(manifest, { withDraft: true, withBaseline: true })
  conflict.release('release_target').releaseNotes += ' changed'
  await assert.rejects(() => execute(conflict, 'activate'), hasCode('release_payload_conflict'))
  assert.equal(conflict.calls.activate.length, 0)
})

test('covered snapshot uses canonical BigInt ordering and target coverage dimensions', () => {
  const target = {
    id: 'target',
    appName: 'EcholIKE',
    version: '999999999999999999999.0.0',
    channel: 'stable',
    platform: 'all',
    arch: 'all',
    enabled: true,
    revision: 1,
  }
  const covered = computeExpectedCovered(
    [
      target,
      {
        ...target,
        id: 'old_windows',
        version: '9007199254740992.9.9',
        platform: 'win32',
        arch: 'amd64',
        revision: 7,
      },
      { ...target, id: 'other_channel', version: '1.0.0', channel: 'beta', revision: 2 },
    ],
    target,
  )
  assert.deepEqual(covered, [{ id: 'old_windows', revision: 7 }])
})

test(
  'production adapter binds exact files, returns inspect state, and closes its database',
  { skip: process.platform !== 'linux' },
  async (context) => {
    const fixture = await productionAdapterFixture(context)
    const result = await runProductionCli(fixture.args)

    assert.equal(result.latestVersion, '0.2.14')
    assert.equal(result.enabledCount, 1)
    assert.equal(await readFile(fixture.closeMarker, 'utf8'), 'closed')

    const failing = await productionAdapterFixture(context)
    await writeFile(
      join(failing.root, '.env'),
      'PUBLIC_API_BASE_URL=https://other.example.test/echo-api\n',
      'utf8',
    )
    await assert.rejects(
      () => runProductionCli(failing.args),
      hasCode('production_environment_mismatch'),
    )
    await assert.rejects(() => access(failing.closeMarker))

    const failingAfterCreate = await productionAdapterFixture(context, { invalidRelease: true })
    await assert.rejects(
      () => runProductionCli(failingAfterCreate.args),
      hasCode('release_state_invalid'),
    )
    assert.equal(await readFile(failingAfterCreate.closeMarker, 'utf8'), 'closed')
  },
)

test(
  'production adapter rejects symlinked authorities and a module changed during import',
  { skip: process.platform !== 'linux' },
  async (context) => {
    const envSymlink = await productionAdapterFixture(context)
    const envBackup = join(envSymlink.root, 'env-backup')
    await writeFile(envBackup, `PUBLIC_API_BASE_URL=${PUBLIC_API_BASE_URL}\n`, 'utf8')
    await unlink(join(envSymlink.root, '.env'))
    await symlink(envBackup, join(envSymlink.root, '.env'))
    await assert.rejects(
      () => runProductionCli(envSymlink.args),
      hasCode('production_dist_invalid'),
    )
    await assert.rejects(() => access(envSymlink.closeMarker))

    const manifestSymlink = await productionAdapterFixture(context)
    const manifestBackup = `${manifestSymlink.manifestPath}.backup`
    await writeFile(manifestBackup, JSON.stringify(manifestFixture()), 'utf8')
    await unlink(manifestSymlink.manifestPath)
    await symlink(manifestBackup, manifestSymlink.manifestPath)
    await assert.rejects(() => runProductionCli(manifestSymlink.args), hasCode('manifest_invalid'))
    await assert.rejects(() => access(manifestSymlink.closeMarker))

    const changedModule = await productionAdapterFixture(context, { mutateEnvOnImport: true })
    await assert.rejects(
      () => runProductionCli(changedModule.args),
      hasCode('production_dist_invalid'),
    )
    await assert.rejects(() => access(changedModule.closeMarker))
  },
)

test(
  'production adapter rejects oversized and special-file manifests before parsing',
  { skip: process.platform !== 'linux' },
  async (context) => {
    const oversized = await productionAdapterFixture(context)
    await writeFile(oversized.manifestPath, Buffer.alloc(1024 * 1024 + 1, 0x20))
    await assert.rejects(() => runProductionCli(oversized.args), hasCode('manifest_invalid'))
    await assert.rejects(() => access(oversized.closeMarker))

    const special = await productionAdapterFixture(context)
    special.args[1] = '/dev/null'
    await assert.rejects(() => runProductionCli(special.args), hasCode('manifest_invalid'))
    await assert.rejects(() => access(special.closeMarker))
  },
)

async function productionAdapterFixture(context, options = {}) {
  await mkdir(ADAPTER_TEST_ROOT, { recursive: true })
  const root = join(ADAPTER_TEST_ROOT, randomUUID())
  const dist = join(root, 'dist')
  const services = join(dist, 'services')
  const manifestPath = join(root, 'manifest.json')
  const closeMarker = join(root, 'database-closed.marker')
  await mkdir(services, { recursive: true })
  context.after(async () => {
    const fromTestRoot = relative(ADAPTER_TEST_ROOT, root)
    if (fromTestRoot === '' || fromTestRoot === '..' || fromTestRoot.startsWith(`..${sep}`)) {
      throw new Error('refusing to clean an unexpected adapter test path')
    }
    await rm(root, { recursive: true, force: true })
  })

  await writeFile(join(root, '.env'), `PUBLIC_API_BASE_URL=${PUBLIC_API_BASE_URL}\n`, 'utf8')
  await writeFile(manifestPath, JSON.stringify(manifestFixture()), 'utf8')
  const mutateSource = options.mutateEnvOnImport
    ? `
import { appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
await appendFile(fileURLToPath(import.meta.url), '\\n')
`
    : ''
  await writeFile(
    join(dist, 'env.js'),
    `${mutateSource}
export function parseEnv(source) {
  return { publicApiBaseUrl: source.PUBLIC_API_BASE_URL }
}
`,
    'utf8',
  )
  const baseline = {
    id: 'release_baseline',
    appName: 'EcholIKE',
    version: '0.2.14',
    channel: 'stable',
    platform: 'all',
    arch: 'all',
    enabled: true,
    revision: options.invalidRelease ? -1 : 1,
  }
  await writeFile(
    join(services, 'app-services.js'),
    `
import { writeFile } from 'node:fs/promises'

export function createDefaultServices() {
  return {
    desktopConfig: {
      async listOtaReleases() { return [${JSON.stringify(baseline)}] }
    },
    admin: {},
    async closeDatabase() { await writeFile(${JSON.stringify(closeMarker)}, 'closed') }
  }
}
`,
    'utf8',
  )

  return {
    root,
    manifestPath,
    closeMarker,
    args: ['--manifest', manifestPath, '--production-root', root, '--inspect'],
  }
}

function manifestFixture(overrides = {}) {
  const signatureValue = 'A'.repeat(420)
  const signatureBytes = Buffer.from(signatureValue, 'utf8')
  const base = {
    schemaVersion: 1,
    sourceCommit: 'a'.repeat(40),
    publicApiBaseUrl: PUBLIC_API_BASE_URL,
    baselineVersion: '0.2.14',
    version: '0.2.15',
    buildMode: 'online-nsis',
    releaseNotes: '修复历史记录。',
    artifact: {
      fileName: 'EcholIKE_0.2.15_x64-setup.exe',
      sourcePath: '/tmp/EcholIKE_0.2.15_x64-setup.exe',
      bytes: 4_871_597,
      sha256: 'b'.repeat(64),
      signature: {
        fileName: 'EcholIKE_0.2.15_x64-setup.exe.sig',
        sourcePath: '/tmp/EcholIKE_0.2.15_x64-setup.exe.sig',
        bytes: signatureBytes.length,
        sha256: createHash('sha256').update(signatureBytes).digest('hex'),
        value: signatureValue,
      },
    },
  }
  const merged = { ...base, ...overrides }
  if (overrides.version && !overrides.artifact) {
    merged.artifact = {
      ...base.artifact,
      fileName: `EcholIKE_${overrides.version}_x64-setup.exe`,
      signature: {
        ...base.artifact.signature,
        fileName: `EcholIKE_${overrides.version}_x64-setup.exe.sig`,
      },
    }
  }
  return merged
}

function validationFixture(manifest, peVersion = `${manifest.version}.0`) {
  return {
    valid: true,
    bytes: manifest.artifact.bytes,
    sha256: manifest.artifact.sha256,
    contentLength: manifest.artifact.bytes,
    redirects: 0,
    network: 'public',
    signaturePresent: true,
    artifactType: 'windows-pe-installer',
    expectedVersion: manifest.version,
    versionFacts: {
      installerFileVersion: peVersion,
      installerProductVersion: peVersion,
    },
  }
}

function fullRelease(payload, overrides = {}) {
  return {
    id: 'release_target',
    ...payload,
    downloadUrlPreview: 'set',
    revision: 0,
    createdAt: null,
    publishedAt: null,
    ...overrides,
  }
}

function visibleRelease(release) {
  const { downloadUrl: _downloadUrl, ...visible } = release
  return { ...visible, downloadUrlPreview: release.downloadUrl ? 'set' : 'missing' }
}

function fakeServices(manifest, options = {}) {
  const payload = createDraftPayload(manifest, PUBLIC_API_BASE_URL)
  const releases = []
  const calls = { upsert: [], validate: [], activate: [], converge: [] }
  let request = 0
  let loseDraftAck = options.loseDraftAckOnce === true
  let loseActivationAck = options.loseActivationAckOnce === true
  let loseConvergenceAck = options.loseConvergenceAckOnce === true

  if (options.withDraft) releases.push(fullRelease(payload))
  const currentVersion = options.withBaseline
    ? manifest.baselineVersion
    : (options.currentVersion ?? null)
  if (currentVersion) {
    const oldPayload = {
      ...payload,
      version: currentVersion,
      downloadUrl: `https://updates.example.test/echo-panel/ota/EcholIKE_${currentVersion}_x64-setup.exe`,
      artifactBytes: 100,
      sha256: 'c'.repeat(64),
      signature: 'B'.repeat(420),
      releaseNotes: 'older release',
    }
    releases.push(
      fullRelease(oldPayload, {
        id: 'release_baseline',
        enabled: true,
        revision: 1,
      }),
    )
  }
  if (options.withUnrelatedEnabled) {
    releases.push(
      fullRelease(
        {
          ...payload,
          version: '9.9.9',
          channel: 'beta',
          downloadUrl: 'https://updates.example.test/echo-panel/ota/unrelated.exe',
          artifactBytes: 100,
          sha256: 'd'.repeat(64),
          signature: 'C'.repeat(420),
          releaseNotes: 'unrelated release',
        },
        {
          id: 'release_unrelated',
          enabled: true,
          revision: 1,
        },
      ),
    )
  }

  const desktopConfig = {
    async listOtaReleases() {
      return releases.map((release) => structuredClone(release))
    },
    async upsertOtaRelease(input, mutationOptions) {
      calls.upsert.push({
        input: structuredClone(input),
        options: structuredClone(mutationOptions),
      })
      const release = fullRelease(input)
      releases.push(release)
      if (loseDraftAck) {
        loseDraftAck = false
        throw new Error('lost draft acknowledgement')
      }
      return visibleRelease(structuredClone(release))
    },
    async validateOtaRelease(input, validationOptions) {
      calls.validate.push({
        input: structuredClone(input),
        options: structuredClone(validationOptions),
      })
      const release = findRelease(input.id)
      assert.equal(release.revision, input.expectedRevision)
      return {
        release: visibleRelease(structuredClone(release)),
        validation: validationFixture(manifest),
      }
    },
    async activateOtaRelease(input, validationOptions) {
      calls.activate.push({
        input: structuredClone(input),
        options: structuredClone(validationOptions),
      })
      const release = findRelease(input.id)
      if (!(release.enabled && release.revision === input.expectedRevision + 1)) {
        assert.equal(release.enabled, false)
        assert.equal(release.revision, input.expectedRevision)
        release.enabled = true
        release.revision += 1
      }
      const result = {
        release: visibleRelease(structuredClone(release)),
        validation: validationFixture(manifest),
      }
      if (loseActivationAck) {
        loseActivationAck = false
        throw new Error('lost activation acknowledgement')
      }
      return result
    },
    async convergeOtaReleases(input, mutationOptions) {
      calls.converge.push({
        input: structuredClone(input),
        options: structuredClone(mutationOptions),
      })
      const target = findRelease(input.id)
      assert.equal(target.enabled, true)
      assert.equal(target.revision, input.expectedRevision)
      const actual = computeExpectedCovered(releases, target)
      assert.deepEqual(input.expectedCovered, actual)
      for (const expected of actual) {
        const release = findRelease(expected.id)
        release.enabled = false
        release.revision += 1
      }
      const result = {
        release: visibleRelease(structuredClone(target)),
        deactivatedCount: actual.length,
        constraintValidated: true,
      }
      if (options.insertCompetingAfterConvergence) {
        releases.push({
          ...structuredClone(target),
          id: 'release_competing',
          platform: 'windows',
          arch: 'x86_64',
        })
        options.insertCompetingAfterConvergence = false
      }
      if (loseConvergenceAck) {
        loseConvergenceAck = false
        throw new Error('lost convergence acknowledgement')
      }
      return result
    },
  }

  function findRelease(id) {
    const release = releases.find((candidate) => candidate.id === id)
    if (!release) throw new Error(`missing fake release ${id}`)
    return release
  }

  return {
    services: {
      desktopConfig,
      admin: {
        async listUsers() {
          return {
            users: [{ id: 'owner_1', adminRole: 'owner', adminStatus: 'active' }],
            nextCursor: null,
          }
        },
      },
    },
    env: { publicApiBaseUrl: PUBLIC_API_BASE_URL },
    manifest,
    calls,
    requestIdFactory: () => `request_${++request}`,
    release: findRelease,
  }
}

function execute(fake, action) {
  return executeControlAction({
    action,
    manifest: fake.manifest,
    env: fake.env,
    services: fake.services,
    requestIdFactory: fake.requestIdFactory,
  })
}

function hasCode(code) {
  return (error) => error instanceof ControlReleaseError && error.code === code
}
