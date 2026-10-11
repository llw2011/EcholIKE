#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, posix, relative, resolve, sep } from 'node:path'
import { parseEnv as parseDotEnv } from 'node:util'

const APP_NAME = 'EcholIKE'
const CHANNEL = 'stable'
const RELEASE_PLATFORM = 'all'
const RELEASE_ARCH = 'all'
const CONVERGENCE_PLATFORM = 'windows'
const CONVERGENCE_ARCH = 'x86_64'
const BUILD_MODE = 'online-nsis'
const ARTIFACT_PREFIX = '/echo-panel/ota/'
const ACTIONS = new Set(['inspect', 'create-draft', 'activate'])
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const LOWER_HEX_40 = /^[a-f0-9]{40}$/
const LOWER_HEX_64 = /^[a-f0-9]{64}$/
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const FORBIDDEN_OUTPUT_KEY = /url|signature|credential|secret|password|token|sourcepath/i
const FORBIDDEN_OUTPUT_VALUE = /(?:https?|postgres(?:ql)?):\/\/|-----BEGIN|untrusted comment:/i
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_JSON_DEPTH = 16
const MAX_RELEASE_NOTES_CHARS = 4000
const MAX_ONLINE_NSIS_BYTES = 512 * 1024 * 1024
const MAX_SIGNATURE_BYTES = 16 * 1024
const MAX_ENV_BYTES = 1024 * 1024
const MAX_PRODUCTION_MODULE_BYTES = 16 * 1024 * 1024

export class ControlReleaseError extends Error {
  constructor(code, options = {}) {
    super(code, options)
    this.name = 'ControlReleaseError'
    this.code = code
  }
}

export function parseCanonicalVersion(version) {
  if (typeof version !== 'string') throw new ControlReleaseError('version_invalid')
  const match = VERSION_PATTERN.exec(version)
  if (!match) throw new ControlReleaseError('version_invalid')
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]
}

export function compareCanonicalVersions(left, right) {
  const leftParts = parseCanonicalVersion(left)
  const rightParts = parseCanonicalVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1
    if (leftParts[index] > rightParts[index]) return 1
  }
  return 0
}

export function parseManifestBytes(input) {
  const bytes = Buffer.from(input)
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new ControlReleaseError('manifest_invalid')
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new ControlReleaseError('manifest_invalid')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ControlReleaseError('manifest_invalid')
  }
  return parseManifestText(text)
}

export function parseManifestText(text) {
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES ||
    text.includes('\0')
  ) {
    throw new ControlReleaseError('manifest_invalid')
  }
  assertNoDuplicateJsonKeys(text)
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new ControlReleaseError('manifest_invalid')
  }

  assertExactObjectKeys(
    value,
    [
      'schemaVersion',
      'sourceCommit',
      'publicApiBaseUrl',
      'baselineVersion',
      'version',
      'buildMode',
      'releaseNotes',
      'artifact',
    ],
    'manifest_invalid',
  )
  assertExactObjectKeys(
    value.artifact,
    ['fileName', 'sourcePath', 'bytes', 'sha256', 'signature'],
    'manifest_invalid',
  )
  assertExactObjectKeys(
    value.artifact.signature,
    ['fileName', 'sourcePath', 'bytes', 'sha256', 'value'],
    'manifest_invalid',
  )

  if (
    value.schemaVersion !== 1 ||
    typeof value.sourceCommit !== 'string' ||
    !LOWER_HEX_40.test(value.sourceCommit) ||
    typeof value.publicApiBaseUrl !== 'string' ||
    value.buildMode !== BUILD_MODE ||
    typeof value.releaseNotes !== 'string' ||
    value.releaseNotes.trim().length === 0 ||
    value.releaseNotes.trim() !== value.releaseNotes ||
    value.releaseNotes.length > MAX_RELEASE_NOTES_CHARS ||
    !isUnicodeScalarString(value.releaseNotes)
  ) {
    throw new ControlReleaseError('manifest_invalid')
  }

  parseCanonicalVersion(value.version)
  parseCanonicalVersion(value.baselineVersion)
  assertPublicApiBaseUrl(value.publicApiBaseUrl)
  if (compareCanonicalVersions(value.baselineVersion, value.version) >= 0) {
    throw new ControlReleaseError('baseline_version_not_lower')
  }

  const expectedArtifactName = `${APP_NAME}_${value.version}_x64-setup.exe`
  if (
    value.artifact.fileName !== expectedArtifactName ||
    !isCanonicalWslAbsolutePath(value.artifact.sourcePath) ||
    !isPositiveSafeInteger(value.artifact.bytes) ||
    value.artifact.bytes > MAX_ONLINE_NSIS_BYTES ||
    typeof value.artifact.sha256 !== 'string' ||
    !LOWER_HEX_64.test(value.artifact.sha256)
  ) {
    throw new ControlReleaseError('manifest_invalid')
  }

  const signature = value.artifact.signature
  const signatureBytes = Buffer.from(signature.value ?? '', 'utf8')
  if (
    signature.fileName !== `${expectedArtifactName}.sig` ||
    !isCanonicalWslAbsolutePath(signature.sourcePath) ||
    !isPositiveSafeInteger(signature.bytes) ||
    signature.bytes > MAX_SIGNATURE_BYTES ||
    typeof signature.sha256 !== 'string' ||
    !LOWER_HEX_64.test(signature.sha256) ||
    typeof signature.value !== 'string' ||
    signature.value.length === 0 ||
    signature.value.trim() !== signature.value ||
    !isUnicodeScalarString(signature.value) ||
    signature.value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(signature.value) ||
    Buffer.from(signature.value, 'base64').toString('base64') !== signature.value ||
    signatureBytes.length !== signature.bytes ||
    createHash('sha256').update(signatureBytes).digest('hex') !== signature.sha256
  ) {
    throw new ControlReleaseError('manifest_invalid')
  }
  if (value.artifact.sourcePath === signature.sourcePath) {
    throw new ControlReleaseError('manifest_invalid')
  }

  return deepFreeze(value)
}

export function deriveArtifactUrl(publicApiBaseUrl, fileName) {
  let publicApi
  try {
    publicApi = new URL(publicApiBaseUrl)
  } catch {
    throw new ControlReleaseError('production_env_invalid')
  }
  if (
    !['http:', 'https:'].includes(publicApi.protocol) ||
    !publicApi.hostname ||
    publicApi.username ||
    publicApi.password
  ) {
    throw new ControlReleaseError('production_env_invalid')
  }
  const base = new URL(ARTIFACT_PREFIX, publicApi.origin)
  return new URL(encodeURIComponent(fileName), base).toString()
}

export function createDraftPayload(manifest, publicApiBaseUrl) {
  return {
    appName: APP_NAME,
    version: manifest.version,
    channel: CHANNEL,
    platform: RELEASE_PLATFORM,
    arch: RELEASE_ARCH,
    enabled: false,
    autoUpdate: false,
    forceUpdate: false,
    minVersion: null,
    artifactBytes: manifest.artifact.bytes,
    downloadUrl: deriveArtifactUrl(publicApiBaseUrl, manifest.artifact.fileName),
    sha256: manifest.artifact.sha256,
    signature: manifest.artifact.signature.value,
    releaseNotes: manifest.releaseNotes,
  }
}

export function releasePayloadMatches(release, payload) {
  return Boolean(
    release &&
    release.appName === payload.appName &&
    release.version === payload.version &&
    release.channel === payload.channel &&
    release.platform === payload.platform &&
    release.arch === payload.arch &&
    release.autoUpdate === payload.autoUpdate &&
    release.forceUpdate === payload.forceUpdate &&
    release.minVersion === payload.minVersion &&
    release.artifactBytes === payload.artifactBytes &&
    release.downloadUrl === payload.downloadUrl &&
    release.sha256 === payload.sha256 &&
    release.signature === payload.signature &&
    release.releaseNotes === payload.releaseNotes,
  )
}

export function visibleReleasePayloadMatches(release, payload) {
  return Boolean(
    release &&
    release.appName === payload.appName &&
    release.version === payload.version &&
    release.channel === payload.channel &&
    release.platform === payload.platform &&
    release.arch === payload.arch &&
    release.autoUpdate === payload.autoUpdate &&
    release.forceUpdate === payload.forceUpdate &&
    release.minVersion === payload.minVersion &&
    release.artifactBytes === payload.artifactBytes &&
    release.sha256 === payload.sha256 &&
    release.signature === payload.signature &&
    release.releaseNotes === payload.releaseNotes &&
    release.downloadUrlPreview === 'set',
  )
}

export function computeExpectedCovered(releases, target) {
  assertReleaseCollection(releases)
  if (!target || typeof target.id !== 'string') {
    throw new ControlReleaseError('release_state_invalid')
  }
  parseCanonicalVersion(target.version)

  const invalidCovered = releases.some(
    (release) =>
      release.enabled === true &&
      release.id !== target.id &&
      release.appName === target.appName &&
      release.channel === target.channel &&
      coversDimension(target.platform, release.platform) &&
      coversDimension(target.arch, release.arch) &&
      !VERSION_PATTERN.test(release.version),
  )
  if (invalidCovered) throw new ControlReleaseError('release_incomplete')

  const invalidMatching = releases.some(
    (release) =>
      release.enabled === true &&
      release.appName === target.appName &&
      matchesDimension(release.channel, CHANNEL) &&
      matchesDimension(release.platform, CONVERGENCE_PLATFORM) &&
      matchesDimension(release.arch, CONVERGENCE_ARCH) &&
      !VERSION_PATTERN.test(release.version),
  )
  if (invalidMatching) throw new ControlReleaseError('release_incomplete')

  return releases
    .filter(
      (release) =>
        release.enabled === true &&
        release.id !== target.id &&
        release.appName === target.appName &&
        release.channel === target.channel &&
        VERSION_PATTERN.test(release.version) &&
        compareCanonicalVersions(release.version, target.version) < 0 &&
        coversDimension(target.platform, release.platform) &&
        coversDimension(target.arch, release.arch),
    )
    .map((release) => {
      if (!SAFE_ID.test(release.id) || !isNonNegativeSafeInteger(release.revision)) {
        throw new ControlReleaseError('release_state_invalid')
      }
      return { id: release.id, revision: release.revision }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function currentMatchingVersion(releases, targetId = null) {
  assertReleaseCollection(releases)
  const matching = releases.filter((release) => {
    if (release.enabled !== true || release.id === targetId || release.appName !== APP_NAME) {
      return false
    }
    if (
      !matchesDimension(release.channel, CHANNEL) ||
      !matchesDimension(release.platform, CONVERGENCE_PLATFORM) ||
      !matchesDimension(release.arch, CONVERGENCE_ARCH)
    ) {
      return false
    }
    if (!VERSION_PATTERN.test(release.version)) {
      throw new ControlReleaseError('release_incomplete')
    }
    return true
  })
  matching.sort((left, right) => compareCanonicalVersions(right.version, left.version))
  return matching[0]?.version ?? null
}

function matchingEnabledCount(releases) {
  assertReleaseCollection(releases)
  return releases.filter((release) => {
    if (release.enabled !== true || release.appName !== APP_NAME) return false
    if (
      !matchesDimension(release.channel, CHANNEL) ||
      !matchesDimension(release.platform, CONVERGENCE_PLATFORM) ||
      !matchesDimension(release.arch, CONVERGENCE_ARCH)
    ) {
      return false
    }
    if (!VERSION_PATTERN.test(release.version)) {
      throw new ControlReleaseError('release_incomplete')
    }
    return true
  }).length
}

export function assertArtifactValidation(validation, manifest) {
  const allowedPeVersions = new Set([manifest.version, `${manifest.version}.0`])
  const facts = validation?.versionFacts
  if (
    validation?.valid !== true ||
    validation.bytes !== manifest.artifact.bytes ||
    validation.sha256 !== manifest.artifact.sha256 ||
    validation.contentLength !== manifest.artifact.bytes ||
    validation.redirects !== 0 ||
    validation.network !== 'public' ||
    validation.signaturePresent !== true ||
    validation.artifactType !== 'windows-pe-installer' ||
    validation.expectedVersion !== manifest.version ||
    !isPlainObject(facts) ||
    typeof facts.installerFileVersion !== 'string' ||
    typeof facts.installerProductVersion !== 'string' ||
    !allowedPeVersions.has(facts.installerFileVersion) ||
    !allowedPeVersions.has(facts.installerProductVersion) ||
    Object.values(facts).some(
      (version) => typeof version !== 'string' || !allowedPeVersions.has(version),
    )
  ) {
    throw new ControlReleaseError('artifact_validation_mismatch')
  }
  return validation
}

export function safeReleaseSummary(release) {
  if (
    !release ||
    !SAFE_ID.test(release.id) ||
    typeof release.version !== 'string' ||
    !VERSION_PATTERN.test(release.version) ||
    typeof release.enabled !== 'boolean' ||
    !isNonNegativeSafeInteger(release.revision)
  ) {
    throw new ControlReleaseError('safe_output_invalid')
  }
  return {
    releaseId: release.id,
    version: release.version,
    enabled: release.enabled,
    revision: release.revision,
  }
}

export function safeValidationSummary(validation) {
  const versions = Object.values(validation.versionFacts)
  return {
    artifactBytes: validation.bytes,
    artifactSha256: validation.sha256,
    contentLength: validation.contentLength,
    redirects: validation.redirects,
    network: validation.network,
    artifactType: validation.artifactType,
    peVersions: [...new Set(versions)].sort(),
  }
}

export function safeJson(value) {
  assertSafeOutput(value)
  return JSON.stringify(value)
}

export function parseCliArgs(argv) {
  const parsed = { manifestPath: null, productionRoot: null, action: null }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--manifest' || argument === '--production-root') {
      if (seen.has(argument)) throw new ControlReleaseError('arguments_invalid')
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new ControlReleaseError('arguments_invalid')
      seen.add(argument)
      if (argument === '--manifest') parsed.manifestPath = value
      else parsed.productionRoot = value
      index += 1
      continue
    }
    if (argument === '--inspect' || argument === '--create-draft' || argument === '--activate') {
      const action = argument.slice(2)
      if (parsed.action !== null) throw new ControlReleaseError('arguments_invalid')
      parsed.action = action
      continue
    }
    throw new ControlReleaseError('arguments_invalid')
  }

  if (
    !parsed.manifestPath ||
    !parsed.productionRoot ||
    !parsed.action ||
    !ACTIONS.has(parsed.action) ||
    !isCanonicalWslAbsolutePath(parsed.manifestPath) ||
    !isCanonicalWslAbsolutePath(parsed.productionRoot)
  ) {
    throw new ControlReleaseError('arguments_invalid')
  }
  return parsed
}

export async function executeControlAction({
  action,
  manifest,
  env,
  services,
  requestIdFactory = randomUUID,
}) {
  if (!ACTIONS.has(action)) throw new ControlReleaseError('arguments_invalid')
  if (!env || typeof env.publicApiBaseUrl !== 'string') {
    throw new ControlReleaseError('production_env_invalid')
  }
  if (env.publicApiBaseUrl !== manifest.publicApiBaseUrl) {
    throw new ControlReleaseError('production_environment_mismatch')
  }
  if (!services?.desktopConfig || !services?.admin) {
    throw new ControlReleaseError('production_services_invalid')
  }

  const payload = createDraftPayload(manifest, env.publicApiBaseUrl)
  let releases = await listFullReleases(services.desktopConfig)
  let target = findTargetRelease(releases, payload)

  if (action === 'inspect') {
    const payloadExact = target ? releasePayloadMatches(target, payload) : false
    return {
      ok: true,
      action,
      version: manifest.version,
      baselineVersion: manifest.baselineVersion,
      targetCount: target ? 1 : 0,
      targetEnabled: target?.enabled ?? false,
      targetRevision: target?.revision ?? null,
      latestVersion: currentMatchingVersion(releases),
      enabledCount: matchingEnabledCount(releases),
      state: target ? (target.enabled ? 'active' : 'draft') : 'absent',
      payloadExact,
      baselineMatches:
        currentMatchingVersion(releases, target?.id ?? null) === manifest.baselineVersion,
      ...(target ? { release: safeReleaseSummary(target) } : {}),
    }
  }

  if (action === 'create-draft') {
    if (target) {
      assertExactTargetPayload(target, payload)
      if (target.enabled) {
        return {
          ok: true,
          action,
          status: 'already-active',
          state: 'active',
          replayed: true,
          release: safeReleaseSummary(target),
        }
      }
      if (target.revision !== 0) throw new ControlReleaseError('release_state_invalid')
      return {
        ok: true,
        action,
        status: 'already-draft',
        state: 'draft',
        replayed: true,
        release: safeReleaseSummary(target),
      }
    }

    const actorUserId = await resolveActiveOwnerUserId(services.admin)
    const created = await services.desktopConfig.upsertOtaRelease(payload, {
      control: controlContext(actorUserId, requestIdFactory),
    })
    if (
      !visibleReleasePayloadMatches(created, payload) ||
      created.enabled ||
      created.revision !== 0
    ) {
      throw new ControlReleaseError('draft_write_mismatch')
    }

    releases = await listFullReleases(services.desktopConfig)
    target = findTargetRelease(releases, payload)
    assertExactTargetPayload(target, payload)
    if (target.enabled || target.revision !== 0 || target.id !== created.id) {
      throw new ControlReleaseError('draft_readback_mismatch')
    }
    return {
      ok: true,
      action,
      status: 'created',
      state: 'draft',
      replayed: false,
      release: safeReleaseSummary(target),
    }
  }

  if (!target) throw new ControlReleaseError('release_not_found')
  assertExactTargetPayload(target, payload)
  const replayedActivation = target.enabled
  if ((target.enabled && target.revision !== 1) || (!target.enabled && target.revision !== 0)) {
    throw new ControlReleaseError('release_state_invalid')
  }

  const lowerCurrent = currentMatchingVersion(releases, target.id)
  if ((!target.enabled || lowerCurrent !== null) && lowerCurrent !== manifest.baselineVersion) {
    throw new ControlReleaseError('baseline_release_drift')
  }

  const actorUserId = await resolveActiveOwnerUserId(services.admin)
  if (!target.enabled) {
    const checked = await services.desktopConfig.validateOtaRelease(
      { id: target.id, expectedRevision: target.revision },
      { control: controlContext(actorUserId, requestIdFactory) },
    )
    if (
      !visibleReleasePayloadMatches(checked.release, payload) ||
      checked.release.enabled ||
      checked.release.revision !== target.revision
    ) {
      throw new ControlReleaseError('validation_snapshot_mismatch')
    }
    assertArtifactValidation(checked.validation, manifest)

    releases = await listFullReleases(services.desktopConfig)
    target = findTargetRelease(releases, payload)
    assertExactTargetPayload(target, payload)
    if (target.enabled || target.revision !== 0) {
      throw new ControlReleaseError('validation_snapshot_mismatch')
    }
    if (currentMatchingVersion(releases, target.id) !== manifest.baselineVersion) {
      throw new ControlReleaseError('baseline_release_drift')
    }
  }

  const activationExpectedRevision = target.revision - (target.enabled ? 1 : 0)
  const activated = await services.desktopConfig.activateOtaRelease(
    {
      id: target.id,
      expectedRevision: activationExpectedRevision,
      forceUpdate: false,
    },
    { control: controlContext(actorUserId, requestIdFactory) },
  )
  if (
    !visibleReleasePayloadMatches(activated.release, payload) ||
    !activated.release.enabled ||
    activated.release.revision !== 1
  ) {
    throw new ControlReleaseError('activation_readback_mismatch')
  }
  assertArtifactValidation(activated.validation, manifest)

  releases = await listFullReleases(services.desktopConfig)
  target = findTargetRelease(releases, payload)
  assertExactTargetPayload(target, payload)
  if (!target.enabled || target.revision !== 1) {
    throw new ControlReleaseError('activation_readback_mismatch')
  }
  const liveLowerCurrent = currentMatchingVersion(releases, target.id)
  if (liveLowerCurrent !== null && liveLowerCurrent !== manifest.baselineVersion) {
    throw new ControlReleaseError('baseline_release_drift')
  }

  const expectedCovered = computeExpectedCovered(releases, target)
  const converged = await services.desktopConfig.convergeOtaReleases(
    {
      id: target.id,
      expectedRevision: target.revision,
      currentVersion: manifest.baselineVersion,
      channel: CHANNEL,
      platform: CONVERGENCE_PLATFORM,
      arch: CONVERGENCE_ARCH,
      expectedCovered,
    },
    { control: controlContext(actorUserId, requestIdFactory) },
  )
  if (
    !visibleReleasePayloadMatches(converged.release, payload) ||
    !converged.release.enabled ||
    converged.release.revision !== 1 ||
    converged.deactivatedCount !== expectedCovered.length ||
    converged.constraintValidated !== true
  ) {
    throw new ControlReleaseError('convergence_result_mismatch')
  }

  releases = await listFullReleases(services.desktopConfig)
  target = findTargetRelease(releases, payload)
  assertExactTargetPayload(target, payload)
  assertConvergedReadback(releases, target, expectedCovered)

  return {
    ok: true,
    action,
    state: 'active',
    replayedActivation,
    release: safeReleaseSummary(target),
    validation: safeValidationSummary(activated.validation),
    deactivatedCount: converged.deactivatedCount,
    constraintValidated: true,
  }
}

export async function runProductionCli(argv) {
  const arguments_ = parseCliArgs(argv)
  const manifestFile = await readStableRegularFile(
    arguments_.manifestPath,
    MAX_MANIFEST_BYTES,
    'manifest_invalid',
  )
  const manifest = parseManifestBytes(manifestFile.bytes)
  const rootBinding = await bindExactEntry(
    arguments_.productionRoot,
    'directory',
    null,
    'production_root_invalid',
  )
  const root = rootBinding.path
  const distBinding = await bindContainedEntry(
    root,
    join(root, 'dist'),
    'directory',
    null,
    'production_dist_invalid',
  )
  const envFile = await readStableRegularFile(
    join(root, '.env'),
    MAX_ENV_BYTES,
    'production_dist_invalid',
    root,
  )
  const envModule = await bindContainedEntry(
    root,
    join(root, 'dist', 'env.js'),
    'file',
    MAX_PRODUCTION_MODULE_BYTES,
    'production_dist_invalid',
  )
  const servicesModule = await bindContainedEntry(
    root,
    join(root, 'dist', 'services', 'app-services.js'),
    'file',
    MAX_PRODUCTION_MODULE_BYTES,
    'production_dist_invalid',
  )

  const previousWorkingDirectory = process.cwd()
  let services = null
  let primaryError = null
  try {
    process.chdir(root)
    const envSource = parseDotEnv(decodeUtf8(envFile.bytes, 'production_env_invalid'))
    const [{ parseEnv }, { createDefaultServices }] = await Promise.all([
      import(pathToFileURL(envModule.path).href),
      import(pathToFileURL(servicesModule.path).href),
    ])
    await Promise.all([
      revalidateBinding(rootBinding),
      revalidateBinding(distBinding),
      revalidateBinding(envFile),
      revalidateBinding(envModule),
      revalidateBinding(servicesModule),
    ])
    if (typeof parseEnv !== 'function' || typeof createDefaultServices !== 'function') {
      throw new ControlReleaseError('production_dist_invalid')
    }
    const env = parseEnv(envSource)
    if (env.publicApiBaseUrl !== manifest.publicApiBaseUrl) {
      throw new ControlReleaseError('production_environment_mismatch')
    }
    services = createDefaultServices(env)
    return await executeControlAction({
      action: arguments_.action,
      manifest,
      env,
      services,
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (services) {
      try {
        await services.closeDatabase()
      } catch (closeError) {
        if (!primaryError)
          throw new ControlReleaseError('database_close_failed', { cause: closeError })
      }
    }
    process.chdir(previousWorkingDirectory)
  }
}

async function main() {
  const action = actionHint(process.argv.slice(2))
  try {
    const result = await runProductionCli(process.argv.slice(2))
    process.stdout.write(`${safeJson(result)}\n`)
  } catch (error) {
    process.exitCode = 1
    const result = {
      ok: false,
      action,
      errorCode: safeErrorCode(error),
    }
    try {
      process.stdout.write(`${safeJson(result)}\n`)
    } catch {
      process.stdout.write('{"ok":false,"action":"unknown","errorCode":"operation_failed"}\n')
    }
  }
}

function actionHint(argv) {
  const actions = argv
    .filter((argument) => /^--(?:inspect|create-draft|activate)$/.test(argument))
    .map((argument) => argument.slice(2))
  return actions.length === 1 ? actions[0] : 'unknown'
}

function safeErrorCode(error) {
  const code = error?.code
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)) return code
  return 'operation_failed'
}

async function bindExactEntry(path, expectedType, maxBytes, errorCode) {
  const lexicalPath = resolve(path)
  try {
    const realPath = await realpath(lexicalPath)
    const facts = await lstat(lexicalPath, { bigint: true })
    const validType =
      expectedType === 'directory' ? facts.isDirectory() : expectedType === 'file' && facts.isFile()
    if (
      realPath !== lexicalPath ||
      !validType ||
      (expectedType === 'file' &&
        (facts.size <= 0n || (maxBytes !== null && facts.size > BigInt(maxBytes))))
    ) {
      throw new ControlReleaseError(errorCode)
    }
    return {
      path: lexicalPath,
      expectedType,
      maxBytes,
      errorCode,
      identity: statIdentity(facts),
    }
  } catch (error) {
    if (error instanceof ControlReleaseError) throw error
    throw new ControlReleaseError(errorCode, { cause: error })
  }
}

async function bindContainedEntry(root, candidate, expectedType, maxBytes, errorCode) {
  const lexicalPath = resolve(candidate)
  const fromRoot = relative(root, lexicalPath)
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(root, fromRoot) !== lexicalPath
  ) {
    throw new ControlReleaseError(errorCode)
  }
  return bindExactEntry(lexicalPath, expectedType, maxBytes, errorCode)
}

async function revalidateBinding(binding) {
  try {
    const [realPath, facts] = await Promise.all([
      realpath(binding.path),
      lstat(binding.path, { bigint: true }),
    ])
    const validType = binding.expectedType === 'directory' ? facts.isDirectory() : facts.isFile()
    if (
      realPath !== binding.path ||
      !validType ||
      !sameStatIdentity(binding.identity, statIdentity(facts)) ||
      (binding.expectedType === 'file' &&
        (facts.size <= 0n || (binding.maxBytes !== null && facts.size > BigInt(binding.maxBytes))))
    ) {
      throw new ControlReleaseError(binding.errorCode)
    }
  } catch (error) {
    if (error instanceof ControlReleaseError) throw error
    throw new ControlReleaseError(binding.errorCode, { cause: error })
  }
}

async function readStableRegularFile(path, maxBytes, errorCode, containedRoot = null) {
  const binding = containedRoot
    ? await bindContainedEntry(containedRoot, path, 'file', maxBytes, errorCode)
    : await bindExactEntry(path, 'file', maxBytes, errorCode)
  const requiredFlags = [fsConstants.O_RDONLY, fsConstants.O_NOFOLLOW, fsConstants.O_NONBLOCK]
  if (requiredFlags.some((flag) => !Number.isInteger(flag))) {
    throw new ControlReleaseError(errorCode)
  }
  let handle = null
  try {
    handle = await open(
      binding.path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    )
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !sameStatIdentity(binding.identity, statIdentity(before))) {
      throw new ControlReleaseError(errorCode)
    }
    const expectedBytes = Number(before.size)
    const bytes = Buffer.allocUnsafe(expectedBytes)
    let offset = 0
    while (offset < expectedBytes) {
      const result = await handle.read(bytes, offset, expectedBytes - offset, offset)
      if (result.bytesRead <= 0) throw new ControlReleaseError(errorCode)
      offset += result.bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await handle.read(extra, 0, 1, expectedBytes)).bytesRead !== 0) {
      throw new ControlReleaseError(errorCode)
    }
    const after = await handle.stat({ bigint: true })
    if (!sameStatIdentity(binding.identity, statIdentity(after))) {
      throw new ControlReleaseError(errorCode)
    }
    await revalidateBinding(binding)
    return { ...binding, bytes }
  } catch (error) {
    if (error instanceof ControlReleaseError) throw error
    throw new ControlReleaseError(errorCode, { cause: error })
  } finally {
    if (handle) await handle.close()
  }
}

function statIdentity(facts) {
  return {
    dev: facts.dev,
    ino: facts.ino,
    mode: facts.mode,
    size: facts.size,
    mtimeNs: facts.mtimeNs,
    ctimeNs: facts.ctimeNs,
  }
}

function sameStatIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key])
}

function decodeUtf8(bytes, errorCode) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new ControlReleaseError(errorCode, { cause: error })
  }
}

async function listFullReleases(desktopConfig) {
  const releases = await desktopConfig.listOtaReleases({ includeDownloadUrl: true })
  assertReleaseCollection(releases)
  return releases
}

function assertReleaseCollection(releases) {
  if (!Array.isArray(releases)) throw new ControlReleaseError('release_state_invalid')
  const ids = new Set()
  for (const release of releases) {
    if (
      !release ||
      typeof release !== 'object' ||
      typeof release.id !== 'string' ||
      !SAFE_ID.test(release.id) ||
      ids.has(release.id) ||
      typeof release.version !== 'string' ||
      typeof release.appName !== 'string' ||
      typeof release.channel !== 'string' ||
      typeof release.platform !== 'string' ||
      typeof release.arch !== 'string' ||
      typeof release.enabled !== 'boolean' ||
      !isNonNegativeSafeInteger(release.revision)
    ) {
      throw new ControlReleaseError('release_state_invalid')
    }
    ids.add(release.id)
  }
}

function findTargetRelease(releases, payload) {
  const targets = releases.filter(
    (release) =>
      release.appName === payload.appName &&
      release.version === payload.version &&
      release.channel === payload.channel &&
      release.platform === payload.platform &&
      release.arch === payload.arch,
  )
  if (targets.length > 1) throw new ControlReleaseError('release_state_invalid')
  return targets[0] ?? null
}

function assertExactTargetPayload(target, payload) {
  if (!target || !releasePayloadMatches(target, payload)) {
    throw new ControlReleaseError('release_payload_conflict')
  }
}

function assertConvergedReadback(releases, target, expectedCovered) {
  const competing = releases.some(
    (release) =>
      release.enabled === true &&
      release.id !== target.id &&
      release.appName === target.appName &&
      matchesDimension(release.channel, CHANNEL) &&
      matchesDimension(release.platform, CONVERGENCE_PLATFORM) &&
      matchesDimension(release.arch, CONVERGENCE_ARCH) &&
      (!VERSION_PATTERN.test(release.version) ||
        compareCanonicalVersions(release.version, target.version) >= 0),
  )
  if (
    !target.enabled ||
    target.revision !== 1 ||
    competing ||
    computeExpectedCovered(releases, target).length
  ) {
    throw new ControlReleaseError('convergence_readback_mismatch')
  }
  const byId = new Map(releases.map((release) => [release.id, release]))
  for (const expected of expectedCovered) {
    const release = byId.get(expected.id)
    if (!release || release.enabled || release.revision !== expected.revision + 1) {
      throw new ControlReleaseError('convergence_readback_mismatch')
    }
  }
}

async function resolveActiveOwnerUserId(admin) {
  const owners = new Set()
  const seenCursors = new Set()
  let cursor = null
  const now = new Date()
  const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  do {
    if (cursor !== null) {
      if (seenCursors.has(cursor)) throw new ControlReleaseError('admin_pagination_invalid')
      seenCursors.add(cursor)
    }
    const page = await admin.listUsers({ periodKey, query: null, cursor, limit: 100 })
    if (
      !page ||
      !Array.isArray(page.users) ||
      (page.nextCursor !== null && typeof page.nextCursor !== 'string')
    ) {
      throw new ControlReleaseError('admin_pagination_invalid')
    }
    for (const user of page.users) {
      if (user?.adminRole === 'owner' && user.adminStatus === 'active' && SAFE_ID.test(user.id)) {
        owners.add(user.id)
      }
    }
    cursor = page.nextCursor
  } while (cursor !== null)

  if (owners.size === 0) throw new ControlReleaseError('active_owner_missing')
  return [...owners].sort()[0]
}

function controlContext(actorUserId, requestIdFactory) {
  const requestId = requestIdFactory()
  if (!SAFE_ID.test(actorUserId) || typeof requestId !== 'string' || !SAFE_ID.test(requestId)) {
    throw new ControlReleaseError('control_context_invalid')
  }
  return { actorUserId, requestId }
}

function matchesDimension(policyValue, requestValue) {
  const policy = normalizeDimension(policyValue)
  const request = normalizeDimension(requestValue)
  return policy === 'all' || policy === request
}

function coversDimension(coveringValue, coveredValue) {
  const covering = normalizeDimension(coveringValue)
  const covered = normalizeDimension(coveredValue)
  return covering === 'all' || covering === covered
}

function normalizeDimension(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'darwin') return 'macos'
  if (normalized === 'win32') return 'windows'
  if (normalized === 'x64' || normalized === 'amd64') return 'x86_64'
  if (normalized === 'arm64') return 'aarch64'
  return normalized
}

function assertSafeOutput(value, path = '$') {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ControlReleaseError('safe_output_invalid')
    return
  }
  if (typeof value === 'string') {
    if (!isUnicodeScalarString(value) || FORBIDDEN_OUTPUT_VALUE.test(value)) {
      throw new ControlReleaseError('safe_output_invalid')
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeOutput(item, `${path}[${index}]`))
    return
  }
  if (!isPlainObject(value)) throw new ControlReleaseError('safe_output_invalid')
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEY.test(key)) throw new ControlReleaseError('safe_output_invalid')
    assertSafeOutput(item, `${path}.${key}`)
  }
}

function assertExactObjectKeys(value, expected, errorCode) {
  if (!isPlainObject(value)) throw new ControlReleaseError(errorCode)
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ControlReleaseError(errorCode)
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isCanonicalWslAbsolutePath(value) {
  return Boolean(
    typeof value === 'string' &&
    isUnicodeScalarString(value) &&
    !/[\0\r\n\\]/u.test(value) &&
    posix.isAbsolute(value) &&
    value !== '/' &&
    !value.endsWith('/') &&
    posix.normalize(value) === value,
  )
}

function assertPublicApiBaseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new ControlReleaseError('manifest_invalid')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/echo-api' ||
    parsed.toString() !== value
  ) {
    throw new ControlReleaseError('manifest_invalid')
  }
}

function isUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

function assertNoDuplicateJsonKeys(text) {
  let index = 0
  const fail = () => {
    throw new ControlReleaseError('manifest_invalid')
  }
  const whitespace = () => {
    while (/[\u0009\u000a\u000d\u0020]/u.test(text[index] ?? '')) index += 1
  }
  const stringToken = () => {
    if (text[index] !== '"') fail()
    const start = index
    index += 1
    while (index < text.length) {
      const character = text[index]
      if (character === '"') {
        index += 1
        try {
          return JSON.parse(text.slice(start, index))
        } catch {
          fail()
        }
      }
      if (character === '\\') {
        index += 1
        const escape = text[index]
        if (escape === 'u') {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(index + 1, index + 5))) fail()
          index += 5
          continue
        }
        if (!'"\\/bfnrt'.includes(escape ?? '')) fail()
        index += 1
        continue
      }
      if ((character?.charCodeAt(0) ?? 0) < 0x20) fail()
      index += 1
    }
    fail()
  }
  const valueToken = (depth) => {
    if (depth > MAX_JSON_DEPTH) fail()
    whitespace()
    const character = text[index]
    if (character === '{') return objectToken(depth + 1)
    if (character === '[') return arrayToken(depth + 1)
    if (character === '"') {
      stringToken()
      return
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) {
        index += literal.length
        return
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))
    if (!number) fail()
    index += number[0].length
  }
  const objectToken = (depth) => {
    index += 1
    whitespace()
    const keys = new Set()
    if (text[index] === '}') {
      index += 1
      return
    }
    while (index < text.length) {
      whitespace()
      const key = stringToken()
      if (keys.has(key)) fail()
      keys.add(key)
      whitespace()
      if (text[index] !== ':') fail()
      index += 1
      valueToken(depth)
      whitespace()
      if (text[index] === '}') {
        index += 1
        return
      }
      if (text[index] !== ',') fail()
      index += 1
    }
    fail()
  }
  const arrayToken = (depth) => {
    index += 1
    whitespace()
    if (text[index] === ']') {
      index += 1
      return
    }
    while (index < text.length) {
      valueToken(depth)
      whitespace()
      if (text[index] === ']') {
        index += 1
        return
      }
      if (text[index] !== ',') fail()
      index += 1
    }
    fail()
  }

  whitespace()
  valueToken(0)
  whitespace()
  if (index !== text.length) fail()
}

const thisFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  await main()
}
