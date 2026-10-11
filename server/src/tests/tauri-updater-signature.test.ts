import { describe, expect, it } from 'vitest'
import {
  createTauriUpdaterSignatureVerifier,
  TauriUpdaterSignatureError,
  type TauriUpdaterSignatureInput,
} from '../services/security/tauri-updater-signature.js'

const PUBLIC_KEY_TEXT = [
  'untrusted comment: minisign public key E7620F1842B4E81F',
  'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
].join('\n')

const RELEASE_SIGNATURE_TEXT = [
  'untrusted comment: signature from minisign secret key',
  'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=',
  'trusted comment: timestamp:1556193335\tfile:test',
  'y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==',
].join('\n')

const KNOWN_VECTOR: TauriUpdaterSignatureInput = {
  publicKeyBase64: wrapMinisignText(`${PUBLIC_KEY_TEXT}\n`),
  releaseSignatureBase64: wrapMinisignText(`${RELEASE_SIGNATURE_TEXT}\n`),
}

describe('Tauri updater minisign verifier', () => {
  it('verifies the minisign-verify 0.2.5 prehashed test vector', () => {
    const verifier = createTauriUpdaterSignatureVerifier(KNOWN_VECTOR)
    verifier.update(Buffer.from('test'))

    expect(() => verifier.finalize()).not.toThrow()
  })

  it('produces the same verification result across arbitrary chunk boundaries', () => {
    const whole = createTauriUpdaterSignatureVerifier(KNOWN_VECTOR)
    whole.update(Buffer.from('test'))

    const chunked = createTauriUpdaterSignatureVerifier(KNOWN_VECTOR)
    chunked.update(Buffer.from('t'))
    chunked.update(new Uint8Array())
    chunked.update(Buffer.from('es'))
    chunked.update(Buffer.from('t'))

    expect(() => whole.finalize()).not.toThrow()
    expect(() => chunked.finalize()).not.toThrow()
  })

  it('rejects content that does not match the payload signature', () => {
    const verifier = createTauriUpdaterSignatureVerifier(KNOWN_VECTOR)
    verifier.update(Buffer.from('tesu'))

    expectSignatureError(() => verifier.finalize(), 'signature_invalid')
  })

  it('rejects a signature carrying another key id before accepting bytes', () => {
    const releaseSignatureBase64 = mutateSignaturePayload((payload) => {
      payload[2] = (payload[2] ?? 0) ^ 0xff
    })

    expectSignatureError(
      () =>
        createTauriUpdaterSignatureVerifier({
          ...KNOWN_VECTOR,
          releaseSignatureBase64,
        }),
      'key_id_mismatch',
    )
  })

  it('verifies the trusted-comment global signature independently', () => {
    const releaseSignatureBase64 = mutateGlobalSignature((signature) => {
      signature[0] = (signature[0] ?? 0) ^ 0xff
    })
    const verifier = createTauriUpdaterSignatureVerifier({
      ...KNOWN_VECTOR,
      releaseSignatureBase64,
    })
    verifier.update(Buffer.from('test'))

    expectSignatureError(() => verifier.finalize(), 'signature_invalid')
  })

  it('accepts minisign CRLF text with exactly one terminal line ending', () => {
    const verifier = createTauriUpdaterSignatureVerifier({
      publicKeyBase64: wrapMinisignText(`${PUBLIC_KEY_TEXT.replaceAll('\n', '\r\n')}\r\n`),
      releaseSignatureBase64: wrapMinisignText(
        `${RELEASE_SIGNATURE_TEXT.replaceAll('\n', '\r\n')}\r\n`,
      ),
    })
    verifier.update(Buffer.from('test'))

    expect(() => verifier.finalize()).not.toThrow()
  })

  it.each([
    {
      name: 'non-canonical outer key base64',
      input: { ...KNOWN_VECTOR, publicKeyBase64: `${KNOWN_VECTOR.publicKeyBase64}\n` },
      code: 'invalid_public_key_encoding' as const,
    },
    {
      name: 'invalid UTF-8 in the outer key envelope',
      input: { ...KNOWN_VECTOR, publicKeyBase64: Buffer.from([0xff]).toString('base64') },
      code: 'invalid_public_key_encoding' as const,
    },
    {
      name: 'a BOM before the public-key comment',
      input: {
        ...KNOWN_VECTOR,
        publicKeyBase64: wrapMinisignText(`\uFEFF${PUBLIC_KEY_TEXT}`),
      },
      code: 'invalid_public_key_format' as const,
    },
    {
      name: 'an extra public-key tail line',
      input: {
        ...KNOWN_VECTOR,
        publicKeyBase64: wrapMinisignText(`${PUBLIC_KEY_TEXT}\n\n`),
      },
      code: 'invalid_public_key_format' as const,
    },
    {
      name: 'a public-key payload with the wrong length',
      input: {
        ...KNOWN_VECTOR,
        publicKeyBase64: wrapMinisignText(
          `untrusted comment: key\n${Buffer.alloc(41).toString('base64')}`,
        ),
      },
      code: 'invalid_public_key_format' as const,
    },
    {
      name: 'an unsupported public-key algorithm',
      input: {
        ...KNOWN_VECTOR,
        publicKeyBase64: mutatePublicKeyPayload((payload) => {
          payload[1] = 'X'.charCodeAt(0)
        }),
      },
      code: 'unsupported_public_key_algorithm' as const,
    },
    {
      name: 'a truncated four-line signature',
      input: {
        ...KNOWN_VECTOR,
        releaseSignatureBase64: wrapMinisignText(
          RELEASE_SIGNATURE_TEXT.split('\n').slice(0, 3).join('\n'),
        ),
      },
      code: 'invalid_release_signature_format' as const,
    },
    {
      name: 'an extra signature tail line',
      input: {
        ...KNOWN_VECTOR,
        releaseSignatureBase64: wrapMinisignText(`${RELEASE_SIGNATURE_TEXT}\n\n`),
      },
      code: 'invalid_release_signature_format' as const,
    },
    {
      name: 'a signature payload with the wrong length',
      input: {
        ...KNOWN_VECTOR,
        releaseSignatureBase64: replaceReleaseSignatureLine(1, Buffer.alloc(73)),
      },
      code: 'invalid_release_signature_format' as const,
    },
    {
      name: 'a global signature with the wrong length',
      input: {
        ...KNOWN_VECTOR,
        releaseSignatureBase64: replaceReleaseSignatureLine(3, Buffer.alloc(63)),
      },
      code: 'invalid_release_signature_format' as const,
    },
    {
      name: 'non-canonical inner signature base64',
      input: {
        ...KNOWN_VECTOR,
        releaseSignatureBase64: wrapMinisignText(
          RELEASE_SIGNATURE_TEXT.replace('RUQf6LRC', 'RUQf6LRC '),
        ),
      },
      code: 'invalid_release_signature_format' as const,
    },
    {
      name: 'a legacy non-prehashed signature algorithm',
      input: {
        ...KNOWN_VECTOR,
        releaseSignatureBase64: mutateSignaturePayload((payload) => {
          payload[1] = 'd'.charCodeAt(0)
        }),
      },
      code: 'unsupported_signature_algorithm' as const,
    },
  ])('rejects malformed input: $name', ({ input, code }) => {
    expectSignatureError(() => createTauriUpdaterSignatureVerifier(input), code)
  })

  it('closes terminally and never includes key or signature input in errors', () => {
    const verifier = createTauriUpdaterSignatureVerifier(KNOWN_VECTOR)
    verifier.update(Buffer.from('test'))
    verifier.finalize()

    expectSignatureError(() => verifier.update(Buffer.from('again')), 'verifier_closed')
    expectSignatureError(() => verifier.finalize(), 'verifier_closed')

    const marker = 'DO_NOT_LEAK_THIS_INPUT'
    try {
      createTauriUpdaterSignatureVerifier({
        ...KNOWN_VECTOR,
        publicKeyBase64: marker,
      })
      throw new Error('expected malformed key to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(TauriUpdaterSignatureError)
      expect((error as Error).message).not.toContain(marker)
      expect((error as Error).message).not.toContain(KNOWN_VECTOR.releaseSignatureBase64)
    }
  })
})

function wrapMinisignText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function mutateSignaturePayload(mutate: (payload: Buffer) => void): string {
  return mutateReleaseSignatureLine(1, mutate)
}

function mutatePublicKeyPayload(mutate: (payload: Buffer) => void): string {
  const lines = PUBLIC_KEY_TEXT.split('\n')
  const encoded = lines[1]
  if (!encoded) throw new Error('invalid test vector')
  const payload = Buffer.from(encoded, 'base64')
  mutate(payload)
  lines[1] = payload.toString('base64')
  return wrapMinisignText(`${lines.join('\n')}\n`)
}

function mutateGlobalSignature(mutate: (payload: Buffer) => void): string {
  return mutateReleaseSignatureLine(3, mutate)
}

function mutateReleaseSignatureLine(index: number, mutate: (payload: Buffer) => void): string {
  const lines = RELEASE_SIGNATURE_TEXT.split('\n')
  const encoded = lines[index]
  if (!encoded) throw new Error('invalid test vector')
  const payload = Buffer.from(encoded, 'base64')
  mutate(payload)
  lines[index] = payload.toString('base64')
  return wrapMinisignText(`${lines.join('\n')}\n`)
}

function replaceReleaseSignatureLine(index: number, payload: Buffer): string {
  const lines = RELEASE_SIGNATURE_TEXT.split('\n')
  if (!lines[index]) throw new Error('invalid test vector')
  lines[index] = payload.toString('base64')
  return wrapMinisignText(`${lines.join('\n')}\n`)
}

function expectSignatureError(
  action: () => unknown,
  code: TauriUpdaterSignatureError['code'],
): void {
  try {
    action()
    throw new Error(`expected signature error: ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(TauriUpdaterSignatureError)
    expect(error).toMatchObject({ code })
  }
}
