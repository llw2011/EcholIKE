import { createHash, createHmac } from 'node:crypto'

export type FingerprintPart = string | Uint8Array

/**
 * Hashes canonical request fields with explicit byte-length framing so that
 * different field boundaries cannot produce the same operation fingerprint.
 */
export function operationFingerprint(
  scope: string,
  parts: readonly FingerprintPart[],
  hmacKey?: string,
): string {
  const hash = hmacKey ? createHmac('sha256', hmacKey) : createHash('sha256')
  append(hash, new TextEncoder().encode(scope))
  for (const part of parts) {
    append(hash, typeof part === 'string' ? new TextEncoder().encode(part) : part)
  }
  return hash.digest('hex')
}

function append(
  hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>,
  bytes: Uint8Array,
): void {
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.byteLength)
  hash.update(length)
  hash.update(bytes)
}
