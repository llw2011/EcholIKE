import { createHash } from 'node:crypto'
import {
  ProviderEgressPolicyError,
  requestProviderEndpoint,
  type ProviderEgressRequestOptions,
} from '../security/provider-egress-policy.js'
import {
  createTauriUpdaterSignatureVerifier,
  TauriUpdaterSignatureError,
  type TauriUpdaterSignatureVerifier,
} from '../security/tauri-updater-signature.js'

export type OtaArtifactValidationErrorCode =
  | 'input_invalid'
  | 'signature_missing'
  | 'signature_key_missing'
  | 'signature_invalid'
  | 'url_policy_rejected'
  | 'artifact_fetch_failed'
  | 'artifact_http_status'
  | 'artifact_encoding_forbidden'
  | 'content_length_invalid'
  | 'content_length_mismatch'
  | 'artifact_body_missing'
  | 'artifact_too_large'
  | 'artifact_read_failed'
  | 'artifact_length_mismatch'
  | 'artifact_sha256_mismatch'
  | 'version_inspector_failed'
  | 'version_facts_invalid'
  | 'artifact_version_mismatch'

export interface OtaArtifactValidationFacts {
  expected?: number | string
  actual?: number | string
  status?: number
}

export class OtaArtifactValidationError extends Error {
  constructor(
    readonly code: OtaArtifactValidationErrorCode,
    readonly facts: OtaArtifactValidationFacts = {},
    options: { cause?: unknown } = {},
  ) {
    super(`OTA artifact validation failed: ${code}`, options)
    this.name = 'OtaArtifactValidationError'
  }
}

export interface OtaArtifactValidationInput {
  artifactUrl: string
  expectedAppName: string
  expectedPlatform: string
  expectedArch: string
  expectedBytes: number
  maxBytes: number
  expectedSha256: string
  signature: string
  expectedVersion: string
}

export interface OtaArtifactInspectorContext {
  expectedBytes: number
  expectedVersion: string
  contentLength: number | null
}

export interface OtaArtifactInspectorResult {
  artifactType: string
  /** Named version facts only, for example installerVersion and executableProductVersion. */
  versions: Readonly<Record<string, string>>
}

export interface OtaArtifactInspectorSession {
  write(chunk: Uint8Array): void | Promise<void>
  finish(): OtaArtifactInspectorResult | Promise<OtaArtifactInspectorResult>
  abort(reason: OtaArtifactValidationErrorCode): void | Promise<void>
}

export interface OtaArtifactVersionInspector {
  open(
    context: OtaArtifactInspectorContext,
  ): OtaArtifactInspectorSession | Promise<OtaArtifactInspectorSession>
}

export interface OtaArtifactValidationDependencies {
  egress: ProviderEgressRequestOptions
  inspector: OtaArtifactVersionInspector
  updaterPublicKeyBase64: string | null
  artifactBaseUrl: string
  versionMatches?: (expectedVersion: string, facts: Readonly<Record<string, string>>) => boolean
  signal?: AbortSignal
}

export interface OtaArtifactValidationResult {
  valid: true
  bytes: number
  sha256: string
  contentLength: number | null
  redirects: number
  network: 'public' | 'explicit_local'
  /** True only after the complete artifact passes the configured Tauri Minisign verifier. */
  signaturePresent: true
  artifactType: string
  expectedVersion: string
  versionFacts: Readonly<Record<string, string>>
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/
const APP_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const VERSION_FACT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const WINDOWS_RELEASE_PLATFORMS = new Set(['all', 'windows', 'windows-x86_64'])
const X64_RELEASE_ARCHES = new Set(['all', 'x64', 'x86_64', 'amd64'])
const OTA_ARTIFACT_PATH = '/echo-panel/ota/'

export function otaArtifactBaseUrlFromPublicApiBaseUrl(publicApiBaseUrl: string): string {
  let publicApiUrl: URL
  try {
    publicApiUrl = new URL(publicApiBaseUrl)
  } catch {
    throw new OtaArtifactValidationError('input_invalid')
  }
  if (
    !['http:', 'https:'].includes(publicApiUrl.protocol) ||
    !publicApiUrl.hostname ||
    publicApiUrl.username ||
    publicApiUrl.password ||
    publicApiUrl.search ||
    publicApiUrl.hash
  ) {
    throw new OtaArtifactValidationError('input_invalid')
  }
  return new URL(OTA_ARTIFACT_PATH, publicApiUrl.origin).toString()
}

export async function validateOtaArtifact(
  input: OtaArtifactValidationInput,
  dependencies: OtaArtifactValidationDependencies,
): Promise<OtaArtifactValidationResult> {
  const normalized = normalizedInput(input)
  assertArtifactLocation(normalized, dependencies.artifactBaseUrl)
  const signatureVerifier = createSignatureVerifier(
    dependencies.updaterPublicKeyBase64,
    normalized.signature,
  )
  const requestInit: RequestInit = {
    method: 'GET',
    headers: {
      accept: 'application/octet-stream',
      'accept-encoding': 'identity',
    },
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  }
  const egressResult = await requestProviderEndpoint(normalized.artifactUrl, requestInit, {
    ...dependencies.egress,
    maxRedirects: 0,
  }).catch((error) => {
    if (error instanceof ProviderEgressPolicyError) {
      throw new OtaArtifactValidationError('url_policy_rejected', {}, { cause: error })
    }
    throw new OtaArtifactValidationError('artifact_fetch_failed', {}, { cause: error })
  })

  const { response } = egressResult
  if (response.status !== 200) {
    await cancelResponse(response)
    throw new OtaArtifactValidationError('artifact_http_status', { status: response.status })
  }

  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') {
    await cancelResponse(response)
    throw new OtaArtifactValidationError('artifact_encoding_forbidden')
  }

  let contentLength: number | null
  try {
    contentLength = parsedContentLength(response.headers.get('content-length'))
  } catch (error) {
    await cancelResponse(response)
    throw error
  }
  if (contentLength !== null && contentLength > normalized.maxBytes) {
    await cancelResponse(response)
    throw new OtaArtifactValidationError('artifact_too_large', {
      expected: normalized.maxBytes,
      actual: contentLength,
    })
  }
  if (contentLength !== null && contentLength !== normalized.expectedBytes) {
    await cancelResponse(response)
    throw new OtaArtifactValidationError('content_length_mismatch', {
      expected: normalized.expectedBytes,
      actual: contentLength,
    })
  }
  if (!response.body) throw new OtaArtifactValidationError('artifact_body_missing')

  let inspector: OtaArtifactInspectorSession
  try {
    inspector = await dependencies.inspector.open({
      expectedBytes: normalized.expectedBytes,
      expectedVersion: normalized.expectedVersion,
      contentLength,
    })
  } catch (error) {
    await cancelResponse(response)
    throw new OtaArtifactValidationError('version_inspector_failed', {}, { cause: error })
  }

  const hash = createHash('sha256')
  const reader = response.body.getReader()
  let bytes = 0
  let inspectorFinished = false

  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (error) {
        throw new OtaArtifactValidationError('artifact_read_failed', {}, { cause: error })
      }
      if (next.done) break
      const chunk = next.value
      bytes += chunk.byteLength
      if (bytes > normalized.maxBytes) {
        throw new OtaArtifactValidationError('artifact_too_large', {
          expected: normalized.maxBytes,
          actual: bytes,
        })
      }
      hash.update(chunk)
      try {
        signatureVerifier.update(chunk)
      } catch (error) {
        throw signatureValidationError(error)
      }
      try {
        await inspector.write(chunk)
      } catch (error) {
        throw new OtaArtifactValidationError('version_inspector_failed', {}, { cause: error })
      }
    }

    if (bytes !== normalized.expectedBytes) {
      throw new OtaArtifactValidationError('artifact_length_mismatch', {
        expected: normalized.expectedBytes,
        actual: bytes,
      })
    }
    const sha256 = hash.digest('hex')
    if (sha256 !== normalized.expectedSha256) {
      throw new OtaArtifactValidationError('artifact_sha256_mismatch', {
        expected: normalized.expectedSha256,
        actual: sha256,
      })
    }

    try {
      signatureVerifier.finalize()
    } catch (error) {
      throw signatureValidationError(error)
    }

    let inspection: OtaArtifactInspectorResult
    try {
      inspection = await inspector.finish()
      inspectorFinished = true
    } catch (error) {
      throw new OtaArtifactValidationError('version_inspector_failed', {}, { cause: error })
    }
    const facts = normalizedVersionFacts(inspection)
    const versionMatches = dependencies.versionMatches ?? strictVersionMatch
    let matches: boolean
    try {
      matches = versionMatches(normalized.expectedVersion, facts.versions)
    } catch (error) {
      throw new OtaArtifactValidationError('version_inspector_failed', {}, { cause: error })
    }
    if (!matches) {
      throw new OtaArtifactValidationError('artifact_version_mismatch', {
        expected: normalized.expectedVersion,
      })
    }

    return {
      valid: true,
      bytes,
      sha256,
      contentLength,
      redirects: egressResult.redirects,
      network: egressResult.endpoint.network,
      signaturePresent: true,
      artifactType: facts.artifactType,
      expectedVersion: normalized.expectedVersion,
      versionFacts: facts.versions,
    }
  } catch (error) {
    const validationError =
      error instanceof OtaArtifactValidationError
        ? error
        : new OtaArtifactValidationError('artifact_read_failed', {}, { cause: error })
    await reader.cancel().catch(() => undefined)
    if (!inspectorFinished) {
      await Promise.resolve(inspector.abort(validationError.code)).catch(() => undefined)
    }
    throw validationError
  } finally {
    reader.releaseLock()
  }
}

function normalizedInput(input: OtaArtifactValidationInput): OtaArtifactValidationInput {
  const expectedAppName = input.expectedAppName.trim()
  const expectedPlatform = input.expectedPlatform.trim().toLowerCase()
  const expectedArch = input.expectedArch.trim().toLowerCase()
  const expectedSha256 = input.expectedSha256.trim().toLowerCase()
  const expectedVersion = input.expectedVersion.trim().replace(/^v/i, '')
  if (
    !input.artifactUrl.trim() ||
    !APP_NAME_PATTERN.test(expectedAppName) ||
    !WINDOWS_RELEASE_PLATFORMS.has(expectedPlatform) ||
    !X64_RELEASE_ARCHES.has(expectedArch) ||
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes <= 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < input.expectedBytes ||
    !SHA256_PATTERN.test(expectedSha256) ||
    !VERSION_PATTERN.test(expectedVersion)
  ) {
    throw new OtaArtifactValidationError('input_invalid')
  }
  if (!input.signature.trim()) throw new OtaArtifactValidationError('signature_missing')

  return {
    artifactUrl: input.artifactUrl.trim(),
    expectedAppName,
    expectedPlatform,
    expectedArch,
    expectedBytes: input.expectedBytes,
    maxBytes: input.maxBytes,
    expectedSha256,
    signature: input.signature.trim(),
    expectedVersion,
  }
}

function assertArtifactLocation(input: OtaArtifactValidationInput, artifactBaseUrl: string): void {
  let base: URL
  let artifact: URL
  try {
    base = new URL(artifactBaseUrl)
    artifact = new URL(input.artifactUrl)
  } catch (error) {
    throw new OtaArtifactValidationError('url_policy_rejected', {}, { cause: error })
  }

  if (
    !['http:', 'https:'].includes(base.protocol) ||
    !base.hostname ||
    base.username ||
    base.password ||
    base.pathname !== OTA_ARTIFACT_PATH ||
    base.search ||
    base.hash ||
    artifact.origin !== base.origin ||
    artifact.username ||
    artifact.password ||
    artifact.search ||
    artifact.hash
  ) {
    throw new OtaArtifactValidationError('url_policy_rejected')
  }

  // The NSIS launcher is a PE32 process even for the x64 desktop payload. The filename
  // therefore proves only the signed release dimension; it is not an assertion about the
  // architecture of the executable embedded in the installer.
  const filename = `${input.expectedAppName}_${input.expectedVersion}_x64-setup.exe`
  const expectedPath = new URL(encodeURIComponent(filename), base).pathname
  if (artifact.pathname !== expectedPath) {
    throw new OtaArtifactValidationError('url_policy_rejected')
  }
}

function createSignatureVerifier(
  publicKeyBase64: string | null,
  releaseSignatureBase64: string,
): TauriUpdaterSignatureVerifier {
  if (!publicKeyBase64?.trim()) {
    throw new OtaArtifactValidationError('signature_key_missing')
  }
  try {
    return createTauriUpdaterSignatureVerifier({
      publicKeyBase64: publicKeyBase64.trim(),
      releaseSignatureBase64,
    })
  } catch (error) {
    throw signatureValidationError(error)
  }
}

function signatureValidationError(error: unknown): OtaArtifactValidationError {
  return new OtaArtifactValidationError(
    'signature_invalid',
    {},
    error instanceof TauriUpdaterSignatureError ? { cause: error } : {},
  )
}

function parsedContentLength(value: string | null): number | null {
  if (value === null) return null
  if (!/^(0|[1-9]\d*)$/.test(value.trim())) {
    throw new OtaArtifactValidationError('content_length_invalid')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new OtaArtifactValidationError('content_length_invalid')
  }
  return length
}

function normalizedVersionFacts(result: OtaArtifactInspectorResult): OtaArtifactInspectorResult {
  const artifactType = result.artifactType.trim()
  const entries = Object.entries(result.versions)
  if (!artifactType || artifactType.length > 64 || !entries.length) {
    throw new OtaArtifactValidationError('version_facts_invalid')
  }

  const versions: Record<string, string> = {}
  for (const [name, value] of entries) {
    const normalizedValue = value.trim().replace(/^v/i, '')
    if (!VERSION_FACT_NAME_PATTERN.test(name) || !VERSION_PATTERN.test(normalizedValue)) {
      throw new OtaArtifactValidationError('version_facts_invalid')
    }
    versions[name] = normalizedValue
  }
  return { artifactType, versions }
}

function strictVersionMatch(
  expectedVersion: string,
  facts: Readonly<Record<string, string>>,
): boolean {
  const values = Object.values(facts)
  return values.length > 0 && values.every((value) => value === expectedVersion)
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}
