import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  validateOtaArtifact,
  otaArtifactBaseUrlFromPublicApiBaseUrl,
  type OtaArtifactInspectorSession,
  type OtaArtifactVersionInspector,
  type OtaArtifactValidationInput,
} from '../services/desktop/ota-artifact-validator.js'
import type {
  ProviderAddressResolver,
  ProviderEgressRequestOptions,
  ProviderEgressTransport,
} from '../services/security/provider-egress-policy.js'

const ARTIFACT_BASE_URL = 'https://artifact.test/echo-panel/ota/'
const ARTIFACT_URL = `${ARTIFACT_BASE_URL}EcholIKE_1.2.3_x64-setup.exe`
const ARTIFACT_VERSION = '1.2.3'
const PUBLIC_ADDRESS = '93.184.216.34'
const encoder = new TextEncoder()
const signing = signingFixture()
const signatureDependencies = {
  updaterPublicKeyBase64: signing.publicKeyBase64,
  artifactBaseUrl: ARTIFACT_BASE_URL,
}

describe('OTA artifact validator', () => {
  it('streams a bounded artifact through hash, length, signature, and version checks', async () => {
    const artifact = encoder.encode('signed installer fixture')
    const response = streamedResponse([artifact.slice(0, 7), artifact.slice(7)], {
      'content-length': String(artifact.byteLength),
    })
    const egress = egressFixture(response)
    const inspection = inspectorFixture({
      installerVersion: ARTIFACT_VERSION,
      executableProductVersion: ARTIFACT_VERSION,
    })

    const result = await validateOtaArtifact(validInput(artifact), {
      ...signatureDependencies,
      egress,
      inspector: inspection.inspector,
    })

    expect(result).toMatchObject({
      valid: true,
      bytes: artifact.byteLength,
      sha256: sha256(artifact),
      contentLength: artifact.byteLength,
      redirects: 0,
      network: 'public',
      signaturePresent: true,
      artifactType: 'windows-installer',
      expectedVersion: ARTIFACT_VERSION,
      versionFacts: {
        installerVersion: ARTIFACT_VERSION,
        executableProductVersion: ARTIFACT_VERSION,
      },
    })
    expect(inspection.bytes()).toEqual(artifact)
    expect(inspection.finish).toHaveBeenCalledTimes(1)
    expect(inspection.abort).not.toHaveBeenCalled()
  })

  it('rejects a missing signature before any DNS or artifact request', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(
        { ...validInput(artifact), signature: '   ' },
        { ...signatureDependencies, egress, inspector: inspection.inspector },
      ),
    ).rejects.toMatchObject({ code: 'signature_missing' })
    expect(egress.transport.request).not.toHaveBeenCalled()
  })

  it('fails closed on a missing updater public key before DNS or download', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(validInput(artifact), {
        ...signatureDependencies,
        updaterPublicKeyBase64: null,
        egress,
        inspector: inspection.inspector,
      }),
    ).rejects.toMatchObject({ code: 'signature_key_missing' })
    expect(egress.resolver.resolve).not.toHaveBeenCalled()
    expect(egress.transport.request).not.toHaveBeenCalled()
  })

  it('fails closed on an invalid configured updater key before DNS or download', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(validInput(artifact), {
        ...signatureDependencies,
        updaterPublicKeyBase64: 'not-a-minisign-key',
        egress,
        inspector: inspection.inspector,
      }),
    ).rejects.toMatchObject({ code: 'signature_invalid' })
    expect(egress.resolver.resolve).not.toHaveBeenCalled()
    expect(egress.transport.request).not.toHaveBeenCalled()
  })

  it('rejects a valid signature belonging to another artifact', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(
        { ...validInput(artifact), signature: signing.sign(encoder.encode('another artifact')) },
        { ...signatureDependencies, egress, inspector: inspection.inspector },
      ),
    ).rejects.toMatchObject({ code: 'signature_invalid' })
    expect(inspection.finish).not.toHaveBeenCalled()
    expect(inspection.abort).toHaveBeenCalledWith('signature_invalid')
  })

  it('derives the fixed artifact prefix from the configured public API origin', () => {
    expect(
      otaArtifactBaseUrlFromPublicApiBaseUrl('https://api.example.com:9443/custom/echo-api'),
    ).toBe('https://api.example.com:9443/echo-panel/ota/')
  })

  it.each([
    'https://elsewhere.test/echo-panel/ota/EcholIKE_1.2.3_x64-setup.exe',
    'https://artifact.test/other/EcholIKE_1.2.3_x64-setup.exe',
    'https://artifact.test/echo-panel/ota/EcholIKE_1.2.3_x64-setup.exe?download=1',
    'https://artifact.test/echo-panel/ota/Other_1.2.3_x64-setup.exe',
    'https://artifact.test/echo-panel/ota/EcholIKE_1.2.3_arm64-setup.exe',
  ])('rejects an artifact URL outside the exact release path: %s', async (artifactUrl) => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(
        { ...validInput(artifact), artifactUrl },
        { ...signatureDependencies, egress, inspector: inspection.inspector },
      ),
    ).rejects.toMatchObject({ code: 'url_policy_rejected' })
    expect(egress.resolver.resolve).not.toHaveBeenCalled()
    expect(egress.transport.request).not.toHaveBeenCalled()
  })

  it('rejects unsupported release dimensions before DNS', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(
        { ...validInput(artifact), expectedArch: 'arm64' },
        { ...signatureDependencies, egress, inspector: inspection.inspector },
      ),
    ).rejects.toMatchObject({ code: 'input_invalid' })
    expect(egress.resolver.resolve).not.toHaveBeenCalled()
  })

  it('does not follow redirects even when they stay on the configured origin', async () => {
    const artifact = encoder.encode('artifact')
    const redirect = new Response(null, {
      status: 302,
      headers: { location: ARTIFACT_URL },
    })
    const egress = egressFixture(redirect)
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(validInput(artifact), {
        ...signatureDependencies,
        egress,
        inspector: inspection.inspector,
      }),
    ).rejects.toMatchObject({ code: 'url_policy_rejected' })
    expect(egress.transport.request).toHaveBeenCalledTimes(1)
    expect(inspection.inspector.open).not.toHaveBeenCalled()
  })

  it('applies the egress URL policy before requesting an artifact', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(
        { ...validInput(artifact), artifactUrl: 'http://127.0.0.1/release.exe' },
        { ...signatureDependencies, egress, inspector: inspection.inspector },
      ),
    ).rejects.toMatchObject({ code: 'url_policy_rejected' })
    expect(egress.transport.request).not.toHaveBeenCalled()
  })

  it('rejects a mismatched declared content length before opening the inspector', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(
      streamedResponse([artifact], { 'content-length': String(artifact.byteLength + 1) }),
    )
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(
        { ...validInput(artifact), maxBytes: artifact.byteLength + 10 },
        {
          ...signatureDependencies,
          egress,
          inspector: inspection.inspector,
        },
      ),
    ).rejects.toMatchObject({
      code: 'content_length_mismatch',
      facts: { expected: artifact.byteLength, actual: artifact.byteLength + 1 },
    })
    expect(inspection.inspector.open).not.toHaveBeenCalled()
  })

  it('rejects a malformed content-length before opening the inspector', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact], { 'content-length': 'invalid' }))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(validInput(artifact), {
        ...signatureDependencies,
        egress,
        inspector: inspection.inspector,
      }),
    ).rejects.toMatchObject({ code: 'content_length_invalid' })
    expect(inspection.inspector.open).not.toHaveBeenCalled()
  })

  it('enforces the streaming ceiling even when content-length is absent', async () => {
    const expected = encoder.encode('abc')
    const actual = encoder.encode('abcd')
    const egress = egressFixture(streamedResponse([actual]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(validInput(expected), {
        ...signatureDependencies,
        egress,
        inspector: inspection.inspector,
      }),
    ).rejects.toMatchObject({ code: 'artifact_too_large' })
    expect(inspection.abort).toHaveBeenCalledWith('artifact_too_large')
    expect(inspection.finish).not.toHaveBeenCalled()
  })

  it('checks the actual streamed length when the server omits content-length', async () => {
    const expected = encoder.encode('expected')
    const actual = encoder.encode('short')
    const egress = egressFixture(streamedResponse([actual]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(
        { ...validInput(expected), maxBytes: expected.byteLength + 10 },
        { ...signatureDependencies, egress, inspector: inspection.inspector },
      ),
    ).rejects.toMatchObject({
      code: 'artifact_length_mismatch',
      facts: { expected: expected.byteLength, actual: actual.byteLength },
    })
  })

  it('rejects a hash mismatch after the complete bounded stream is read', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(
        { ...validInput(artifact), expectedSha256: '0'.repeat(64) },
        { ...signatureDependencies, egress, inspector: inspection.inspector },
      ),
    ).rejects.toMatchObject({ code: 'artifact_sha256_mismatch' })
    expect(inspection.abort).toHaveBeenCalledWith('artifact_sha256_mismatch')
  })

  it('rejects encoded transfer bodies so validation hashes the published bytes', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact], { 'content-encoding': 'gzip' }))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })

    await expect(
      validateOtaArtifact(validInput(artifact), {
        ...signatureDependencies,
        egress,
        inspector: inspection.inspector,
      }),
    ).rejects.toMatchObject({ code: 'artifact_encoding_forbidden' })
    expect(inspection.inspector.open).not.toHaveBeenCalled()
  })

  it('aborts the inspector if an incremental inspection write fails', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: ARTIFACT_VERSION })
    inspection.write.mockRejectedValueOnce(new Error('fixture inspection failure'))

    await expect(
      validateOtaArtifact(validInput(artifact), {
        ...signatureDependencies,
        egress,
        inspector: inspection.inspector,
      }),
    ).rejects.toMatchObject({ code: 'version_inspector_failed' })
    expect(inspection.abort).toHaveBeenCalledWith('version_inspector_failed')
  })

  it('rejects valid bytes when the inspected version facts do not match', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ installerVersion: '1.2.4' })

    await expect(
      validateOtaArtifact(validInput(artifact), {
        ...signatureDependencies,
        egress,
        inspector: inspection.inspector,
      }),
    ).rejects.toMatchObject({
      code: 'artifact_version_mismatch',
      facts: { expected: ARTIFACT_VERSION },
    })
  })

  it('allows the caller to inject a product-specific version matcher', async () => {
    const artifact = encoder.encode('artifact')
    const egress = egressFixture(streamedResponse([artifact]))
    const inspection = inspectorFixture({ executableProductVersion: '1.2.3.0' })

    const result = await validateOtaArtifact(validInput(artifact), {
      ...signatureDependencies,
      egress,
      inspector: inspection.inspector,
      versionMatches: (expected, facts) => facts.executableProductVersion === `${expected}.0`,
    })

    expect(result.valid).toBe(true)
    expect(result.versionFacts.executableProductVersion).toBe('1.2.3.0')
  })
})

function validInput(artifact: Uint8Array): OtaArtifactValidationInput {
  return {
    artifactUrl: ARTIFACT_URL,
    expectedAppName: 'EcholIKE',
    expectedPlatform: 'windows',
    expectedArch: 'x86_64',
    expectedBytes: artifact.byteLength,
    maxBytes: artifact.byteLength,
    expectedSha256: sha256(artifact),
    signature: signing.sign(artifact),
    expectedVersion: ARTIFACT_VERSION,
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function streamedResponse(chunks: Uint8Array[], headers: HeadersInit = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    { status: 200, headers },
  )
}

function egressFixture(response: Response): ProviderEgressRequestOptions & {
  resolver: ProviderAddressResolver & { resolve: ReturnType<typeof vi.fn> }
  transport: ProviderEgressTransport & { request: ReturnType<typeof vi.fn> }
} {
  const resolver = {
    resolve: vi.fn(async () => [{ address: PUBLIC_ADDRESS, family: 4 as const }]),
  }
  const transport = {
    request: vi.fn(async () => response),
  }
  return { resolver, transport }
}

function inspectorFixture(versions: Record<string, string>): {
  inspector: OtaArtifactVersionInspector & { open: ReturnType<typeof vi.fn> }
  write: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  bytes(): Uint8Array
} {
  const chunks: Uint8Array[] = []
  const write = vi.fn(async (chunk: Uint8Array) => {
    chunks.push(chunk.slice())
  })
  const finish = vi.fn(async () => ({ artifactType: 'windows-installer', versions }))
  const abort = vi.fn(async () => undefined)
  const session: OtaArtifactInspectorSession = { write, finish, abort }
  const open = vi.fn(async () => session)
  return {
    inspector: { open },
    write,
    finish,
    abort,
    bytes() {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      const result = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
      }
      return result
    },
  }
}

function signingFixture(): {
  publicKeyBase64: string
  sign(bytes: Uint8Array): string
} {
  const keyId = Buffer.from('0102030405060708', 'hex')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' })
  if (!Buffer.isBuffer(publicKeyDer) || publicKeyDer.byteLength < 32) {
    throw new Error('test signing key export failed')
  }
  const rawPublicKey = publicKeyDer.subarray(publicKeyDer.byteLength - 32)
  const publicPayload = Buffer.concat([Buffer.from('Ed', 'ascii'), keyId, rawPublicKey])
  const publicKeyText = [
    'untrusted comment: EcholIKE OTA test public key',
    publicPayload.toString('base64'),
  ].join('\n')

  return {
    publicKeyBase64: wrapMinisignText(`${publicKeyText}\n`),
    sign(bytes) {
      return releaseSignature(privateKey, keyId, bytes)
    },
  }
}

function releaseSignature(privateKey: KeyObject, keyId: Buffer, bytes: Uint8Array): string {
  const digest = createHash('blake2b512').update(bytes).digest()
  const payloadSignature = sign(null, digest, privateKey)
  const trustedComment = Buffer.from('timestamp:0\tfile:EcholIKE-test-artifact', 'utf8')
  const globalSignature = sign(null, Buffer.concat([payloadSignature, trustedComment]), privateKey)
  const signaturePayload = Buffer.concat([Buffer.from('ED', 'ascii'), keyId, payloadSignature])
  const signatureText = [
    'untrusted comment: signature from EcholIKE OTA test key',
    signaturePayload.toString('base64'),
    `trusted comment: ${trustedComment.toString('utf8')}`,
    globalSignature.toString('base64'),
  ].join('\n')
  return wrapMinisignText(`${signatureText}\n`)
}

function wrapMinisignText(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}
