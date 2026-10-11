import { describe, expect, it } from 'vitest'
import { operationFingerprint } from '../services/quota/operation-fingerprint.js'

describe('operation fingerprint', () => {
  it('is stable for the same canonical operation', () => {
    expect(operationFingerprint('proxy_llm', ['hello', new Uint8Array([1, 2, 3])])).toBe(
      operationFingerprint('proxy_llm', ['hello', new Uint8Array([1, 2, 3])]),
    )
  })

  it('separates scopes, field boundaries, and binary payloads', () => {
    const baseline = operationFingerprint('proxy_llm', ['ab', 'c'])
    expect(operationFingerprint('proxy_llm', ['a', 'bc'])).not.toBe(baseline)
    expect(operationFingerprint('proxy_ocr', ['ab', 'c'])).not.toBe(baseline)
    expect(operationFingerprint('proxy_llm', ['ab', new Uint8Array([100])])).not.toBe(baseline)
  })
})
