// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currentMarkdownEditorWindowBackgroundColor,
  markdownEditorWindowGeneration,
} from '../markdownWindowLifecycle'

afterEach(() => vi.restoreAllMocks())

const themeStyles = readFileSync('src/styles/themes.css', 'utf8')

describe('Markdown editor native window metadata', () => {
  it('keeps every authored theme surface compatible with the native RGB backing parser', () => {
    const surfaces = [...themeStyles.matchAll(/--echo-surface:\s*([^;]+);/g)].map((match) =>
      match[1].trim(),
    )

    expect(surfaces.length).toBeGreaterThanOrEqual(13)
    expect(surfaces.every((surface) => /^#[\da-f]{6}$/i.test(surface))).toBe(true)
  })

  it.each([
    ['Echo light', '#ffffff', [255, 255, 255, 0]],
    ['Pearl light', '#ffffff', [255, 255, 255, 0]],
    ['Mint light', '#fbfffd', [251, 255, 253, 0]],
    ['Graphite light', '#ffffff', [255, 255, 255, 0]],
    ['Ray', '#121318', [18, 19, 24, 0]],
    ['Linear', '#181b24', [24, 27, 36, 0]],
    ['Command', '#101111', [16, 17, 17, 0]],
    ['Ember', '#151011', [21, 16, 17, 0]],
    ['Carbon', '#151a1f', [21, 26, 31, 0]],
    ['Echo dark', '#1b2638', [27, 38, 56, 0]],
    ['Pearl dark', '#24262b', [36, 38, 43, 0]],
    ['Mint dark', '#1a2d22', [26, 45, 34, 0]],
    ['Graphite dark', '#20252d', [32, 37, 45, 0]],
  ])('keeps the %s backing RGB while preserving transparent corners', (_name, value, expected) => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => value,
    } as unknown as CSSStyleDeclaration)

    expect(currentMarkdownEditorWindowBackgroundColor()).toEqual(expected)
  })

  it('falls back to a non-black surface when a theme token is invalid', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => 'rgba(0, 0, 0, 0)',
    } as unknown as CSSStyleDeclaration)

    expect(currentMarkdownEditorWindowBackgroundColor()).toEqual([255, 255, 255, 0])
  })

  it('accepts only an immutable positive generation from the child URL', () => {
    expect(markdownEditorWindowGeneration('?markdownWindowGeneration=42')).toBe(42)
    expect(markdownEditorWindowGeneration('?markdownWindowGeneration=0')).toBeNull()
    expect(markdownEditorWindowGeneration('?markdownWindowGeneration=1.5')).toBeNull()
    expect(markdownEditorWindowGeneration('?markdownWindowGeneration=stale')).toBeNull()
  })
})
