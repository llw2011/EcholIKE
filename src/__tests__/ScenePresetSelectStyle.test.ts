// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/styles/globals.css', 'utf8')

describe('scene preset native select theme contract', () => {
  it('gives scene preset options the same theme surface and text colors as settings fields', () => {
    const optionRule = styles.match(
      /\.echo-field option,\s*\.echo-scene-preset-select option\s*\{([^}]*)\}/s,
    )?.[1]

    expect(optionRule).toMatch(/background:\s*var\(--echo-surface\)\s*;/)
    expect(optionRule).toMatch(/color:\s*var\(--echo-text\)\s*;/)
  })
})
