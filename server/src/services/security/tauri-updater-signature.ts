import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type Hash,
  type KeyObject,
} from 'node:crypto'

export type TauriUpdaterSignatureErrorCode =
  | 'invalid_public_key_encoding'
  | 'invalid_release_signature_encoding'
  | 'invalid_public_key_format'
  | 'invalid_release_signature_format'
  | 'unsupported_public_key_algorithm'
  | 'unsupported_signature_algorithm'
  | 'key_id_mismatch'
  | 'signature_invalid'
  | 'verifier_closed'

export class TauriUpdaterSignatureError extends Error {
  constructor(readonly code: TauriUpdaterSignatureErrorCode) {
    super(`Tauri updater signature verification failed: ${code}`)
    this.name = 'TauriUpdaterSignatureError'
  }
}

export interface TauriUpdaterSignatureInput {
  /** Base64-wrapped two-line minisign public-key text, as stored in Tauri config. */
  publicKeyBase64: string
  /** Base64-wrapped four-line minisign signature text, as returned by the update manifest. */
  releaseSignatureBase64: string
}

export interface TauriUpdaterSignatureVerifier {
  update(chunk: Uint8Array): void
  finalize(): void
}

interface ParsedPublicKey {
  keyId: Buffer
  key: Buffer
}

interface ParsedReleaseSignature {
  keyId: Buffer
  signature: Buffer
  trustedComment: Buffer
  globalSignature: Buffer
}

const PUBLIC_KEY_PAYLOAD_BYTES = 42
const SIGNATURE_PAYLOAD_BYTES = 74
const ED25519_SIGNATURE_BYTES = 64
const KEY_ID_BYTES = 8
const PUBLIC_KEY_BYTES = 32
const PUBLIC_KEY_HEADER_BYTES = 2
const SIGNATURE_HEADER_BYTES = 2
const UNTRUSTED_COMMENT_PREFIX = 'untrusted comment: '
const TRUSTED_COMMENT_PREFIX = 'trusted comment: '
const PREHASHED_SIGNATURE_ALGORITHM = Buffer.from('ED', 'ascii')
const SUPPORTED_PUBLIC_KEY_ALGORITHMS = [Buffer.from('Ed', 'ascii'), Buffer.from('ED', 'ascii')]
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Creates a terminal streaming verifier for the exact signature envelope consumed by
 * tauri-plugin-updater 2.10.1. Only modern prehashed (`ED`) signatures are accepted.
 */
export function createTauriUpdaterSignatureVerifier(
  input: TauriUpdaterSignatureInput,
): TauriUpdaterSignatureVerifier {
  const publicKey = parsePublicKey(input.publicKeyBase64)
  const signature = parseReleaseSignature(input.releaseSignatureBase64)

  if (!timingSafeEqual(publicKey.keyId, signature.keyId)) {
    throw new TauriUpdaterSignatureError('key_id_mismatch')
  }

  let keyObject: KeyObject
  try {
    keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.key]),
      format: 'der',
      type: 'spki',
    })
  } catch {
    throw new TauriUpdaterSignatureError('invalid_public_key_format')
  }

  return new NodeTauriUpdaterSignatureVerifier(keyObject, signature)
}

class NodeTauriUpdaterSignatureVerifier implements TauriUpdaterSignatureVerifier {
  readonly #hash: Hash = createHash('blake2b512')
  readonly #key: KeyObject
  readonly #signature: ParsedReleaseSignature
  #closed = false

  constructor(key: KeyObject, signature: ParsedReleaseSignature) {
    this.#key = key
    this.#signature = signature
  }

  update(chunk: Uint8Array): void {
    this.#assertOpen()
    this.#hash.update(chunk)
  }

  finalize(): void {
    this.#assertOpen()
    this.#closed = true

    const digest = this.#hash.digest()
    const globalPayload = Buffer.concat([this.#signature.signature, this.#signature.trustedComment])
    const payloadValid = verifyEd25519(this.#key, digest, this.#signature.signature)
    const globalValid = verifyEd25519(this.#key, globalPayload, this.#signature.globalSignature)
    if (!payloadValid || !globalValid) {
      throw new TauriUpdaterSignatureError('signature_invalid')
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new TauriUpdaterSignatureError('verifier_closed')
  }
}

function parsePublicKey(encoded: string): ParsedPublicKey {
  const text = decodeWrappedText(encoded, 'invalid_public_key_encoding')
  const lines = splitMinisignLines(text, 2, 'invalid_public_key_format')
  if (!lines[0]?.startsWith(UNTRUSTED_COMMENT_PREFIX)) {
    throw new TauriUpdaterSignatureError('invalid_public_key_format')
  }

  const payload = decodeCanonicalBase64(lines[1] ?? '', 'invalid_public_key_format')
  if (payload.byteLength !== PUBLIC_KEY_PAYLOAD_BYTES) {
    throw new TauriUpdaterSignatureError('invalid_public_key_format')
  }

  const algorithm = payload.subarray(0, PUBLIC_KEY_HEADER_BYTES)
  if (!SUPPORTED_PUBLIC_KEY_ALGORITHMS.some((candidate) => candidate.equals(algorithm))) {
    throw new TauriUpdaterSignatureError('unsupported_public_key_algorithm')
  }

  const keyIdStart = PUBLIC_KEY_HEADER_BYTES
  const keyStart = keyIdStart + KEY_ID_BYTES
  return {
    keyId: Buffer.from(payload.subarray(keyIdStart, keyStart)),
    key: Buffer.from(payload.subarray(keyStart, keyStart + PUBLIC_KEY_BYTES)),
  }
}

function parseReleaseSignature(encoded: string): ParsedReleaseSignature {
  const text = decodeWrappedText(encoded, 'invalid_release_signature_encoding')
  const lines = splitMinisignLines(text, 4, 'invalid_release_signature_format')
  if (
    !lines[0]?.startsWith(UNTRUSTED_COMMENT_PREFIX) ||
    !lines[2]?.startsWith(TRUSTED_COMMENT_PREFIX)
  ) {
    throw new TauriUpdaterSignatureError('invalid_release_signature_format')
  }

  const payload = decodeCanonicalBase64(lines[1] ?? '', 'invalid_release_signature_format')
  const globalSignature = decodeCanonicalBase64(lines[3] ?? '', 'invalid_release_signature_format')
  if (
    payload.byteLength !== SIGNATURE_PAYLOAD_BYTES ||
    globalSignature.byteLength !== ED25519_SIGNATURE_BYTES
  ) {
    throw new TauriUpdaterSignatureError('invalid_release_signature_format')
  }

  const algorithm = payload.subarray(0, SIGNATURE_HEADER_BYTES)
  if (!algorithm.equals(PREHASHED_SIGNATURE_ALGORITHM)) {
    throw new TauriUpdaterSignatureError('unsupported_signature_algorithm')
  }

  const keyIdStart = SIGNATURE_HEADER_BYTES
  const signatureStart = keyIdStart + KEY_ID_BYTES
  return {
    keyId: Buffer.from(payload.subarray(keyIdStart, signatureStart)),
    signature: Buffer.from(
      payload.subarray(signatureStart, signatureStart + ED25519_SIGNATURE_BYTES),
    ),
    trustedComment: Buffer.from(lines[2].slice(TRUSTED_COMMENT_PREFIX.length), 'utf8'),
    globalSignature,
  }
}

function decodeWrappedText(
  encoded: string,
  errorCode: 'invalid_public_key_encoding' | 'invalid_release_signature_encoding',
): string {
  const bytes = decodeCanonicalBase64(encoded, errorCode)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new TauriUpdaterSignatureError(errorCode)
  }
}

function splitMinisignLines(
  text: string,
  expectedLines: number,
  errorCode: 'invalid_public_key_format' | 'invalid_release_signature_format',
): string[] {
  if (text.startsWith('\uFEFF') || text.includes('\0') || /\r(?!\n)/u.test(text)) {
    throw new TauriUpdaterSignatureError(errorCode)
  }

  let normalized = text.replaceAll('\r\n', '\n')
  if (normalized.endsWith('\n')) normalized = normalized.slice(0, -1)
  const lines = normalized.split('\n')
  if (lines.length !== expectedLines || lines.some((line) => line.length === 0)) {
    throw new TauriUpdaterSignatureError(errorCode)
  }
  return lines
}

function decodeCanonicalBase64(
  encoded: string,
  errorCode:
    | 'invalid_public_key_encoding'
    | 'invalid_release_signature_encoding'
    | 'invalid_public_key_format'
    | 'invalid_release_signature_format',
): Buffer {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(encoded)
  ) {
    throw new TauriUpdaterSignatureError(errorCode)
  }

  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) {
    throw new TauriUpdaterSignatureError(errorCode)
  }
  return decoded
}

function verifyEd25519(key: KeyObject, payload: Buffer, signature: Buffer): boolean {
  try {
    return verify(null, payload, key, signature)
  } catch {
    throw new TauriUpdaterSignatureError('signature_invalid')
  }
}
