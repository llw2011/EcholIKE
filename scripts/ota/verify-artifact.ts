import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createTauriUpdaterSignatureVerifier } from '../../server/src/services/security/tauri-updater-signature.ts'

interface Arguments {
  artifact: string
  signature: string
  config: string
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !['--artifact', '--signature', '--config'].includes(name)) {
      throw new Error(
        'usage: verify-artifact.ts --artifact <path> --signature <path> --config <path>',
      )
    }
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`)
    values.set(name, value)
  }
  if (values.size !== 3) {
    throw new Error(
      'usage: verify-artifact.ts --artifact <path> --signature <path> --config <path>',
    )
  }
  return {
    artifact: values.get('--artifact')!,
    signature: values.get('--signature')!,
    config: values.get('--config')!,
  }
}

function requireRegularFile(input: string, maxBytes: number): { path: string; bytes: number } {
  const resolved = path.resolve(input)
  const file = fs.lstatSync(resolved)
  if (!file.isFile() || file.isSymbolicLink() || file.size <= 0 || file.size > maxBytes) {
    throw new Error(`expected a regular non-symlink file: ${resolved}`)
  }
  return { path: resolved, bytes: file.size }
}

const input = parseArguments(process.argv.slice(2))
const artifact = requireRegularFile(input.artifact, 512 * 1024 * 1024)
const signatureFile = requireRegularFile(input.signature, 16 * 1024)
const configFile = requireRegularFile(input.config, 1024 * 1024)
const config = JSON.parse(
  new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(configFile.path)),
) as {
  plugins?: { updater?: { pubkey?: unknown } }
}
const configuredPublicKey = config.plugins?.updater?.pubkey
const publicKeyBase64 = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim() || configuredPublicKey
if (typeof publicKeyBase64 !== 'string' || !publicKeyBase64) {
  throw new Error('Tauri updater public key is missing')
}
if (publicKeyBase64 === 'TAURI_UPDATER_PUBLIC_KEY') {
  throw new Error('TAURI_UPDATER_PUBLIC_KEY must be supplied for artifact verification')
}
const signatureBytes = fs.readFileSync(signatureFile.path)
if (signatureBytes.length !== signatureFile.bytes) throw new Error('updater signature changed')
const signature = signatureBytes.toString('utf8')
if (!signature || signature.trim() !== signature) {
  throw new Error('updater signature has surrounding whitespace or is empty')
}

const verifier = createTauriUpdaterSignatureVerifier({
  publicKeyBase64,
  releaseSignatureBase64: signature,
})
const artifactDigest = createHash('sha256')
let artifactBytes = 0
for await (const chunk of fs.createReadStream(artifact.path)) {
  verifier.update(chunk)
  artifactDigest.update(chunk)
  artifactBytes += chunk.length
  if (artifactBytes > artifact.bytes) throw new Error('updater artifact grew while reading')
}
if (artifactBytes !== artifact.bytes) throw new Error('updater artifact changed while reading')
verifier.finalize()

console.log(
  JSON.stringify({
    valid: true,
    artifactBytes,
    artifactSha256: artifactDigest.digest('hex'),
    signatureBytes: signatureBytes.length,
    signatureSha256: createHash('sha256').update(signatureBytes).digest('hex'),
  }),
)
