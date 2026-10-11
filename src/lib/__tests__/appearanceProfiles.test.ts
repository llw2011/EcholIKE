import { describe, expect, it } from 'vitest'
import { getCapsuleSize, type CapsuleVisualState } from '../../components/Capsule/capsuleSkin'
import {
  CAPSULE_STYLE_IDS,
  CAPSULE_STYLE_OPTIONS,
  FIXED_DARK_THEME_PROFILES,
  THEME_PROFILE_IDS,
  THEME_PROFILE_OPTIONS,
  isDarkThemeAppearance,
} from '../appearanceProfiles'

const capsuleStates: readonly CapsuleVisualState[] = [
  'idle',
  'recording',
  'transcribing',
  'polishing',
  'outputting',
  'error',
]

describe('appearance profile catalogs', () => {
  it('keeps the nine theme ids, options, and fixed-dark behavior in one-to-one order', () => {
    expect(THEME_PROFILE_IDS).toHaveLength(9)
    expect(THEME_PROFILE_OPTIONS.map(({ id }) => id)).toEqual(THEME_PROFILE_IDS)
    expect(new Set(THEME_PROFILE_IDS).size).toBe(THEME_PROFILE_IDS.length)
    expect(new Set(THEME_PROFILE_OPTIONS.map(({ name }) => name)).size).toBe(
      THEME_PROFILE_OPTIONS.length,
    )

    for (const option of THEME_PROFILE_OPTIONS) {
      expect(option.name.trim()).not.toBe('')
      expect(option.note.trim()).not.toBe('')
      expect(option.swatches).toHaveLength(3)
      expect(option.swatches.every((color) => /^#[\da-f]{6}$/i.test(color))).toBe(true)
      expect(Object.values(option.preview).every((color) => /^#[\da-f]{6}$/i.test(color))).toBe(
        true,
      )
    }

    const adaptiveProfiles = THEME_PROFILE_OPTIONS.filter(
      ({ appearance }) => appearance === 'adaptive',
    ).map(({ id }) => id)
    const fixedDarkProfiles = THEME_PROFILE_OPTIONS.filter(
      ({ appearance }) => appearance === 'fixed-dark',
    ).map(({ id }) => id)

    expect(adaptiveProfiles).toHaveLength(4)
    expect(fixedDarkProfiles).toHaveLength(5)
    expect([...FIXED_DARK_THEME_PROFILES]).toEqual(fixedDarkProfiles)
    expect(THEME_PROFILE_IDS.filter((profile) => isDarkThemeAppearance(false, profile))).toEqual([
      ...fixedDarkProfiles,
    ])
    expect(THEME_PROFILE_IDS.every((profile) => isDarkThemeAppearance(true, profile))).toBe(true)
  })

  it('keeps every capsule option backed by complete positive geometry for all visual states', () => {
    expect(CAPSULE_STYLE_IDS).toHaveLength(8)
    expect(CAPSULE_STYLE_OPTIONS.map(({ id }) => id)).toEqual(CAPSULE_STYLE_IDS)
    expect(new Set(CAPSULE_STYLE_IDS).size).toBe(CAPSULE_STYLE_IDS.length)
    expect(new Set(CAPSULE_STYLE_OPTIONS.map(({ name }) => name)).size).toBe(
      CAPSULE_STYLE_OPTIONS.length,
    )

    for (const option of CAPSULE_STYLE_OPTIONS) {
      expect(option.name.trim()).not.toBe('')
      expect(option.note.trim()).not.toBe('')

      const idle = getCapsuleSize(option.id, 'idle')
      for (const state of capsuleStates) {
        const size = getCapsuleSize(option.id, state)
        expect(Number.isInteger(size.width)).toBe(true)
        expect(Number.isInteger(size.height)).toBe(true)
        expect(size.width).toBeGreaterThan(0)
        expect(size.height).toBeGreaterThan(0)
        expect(size.width).toBeGreaterThanOrEqual(size.height)
      }

      expect(getCapsuleSize(option.id, 'recording').width).toBeGreaterThan(idle.width)
      expect(getCapsuleSize(option.id, 'transcribing').width).toBeGreaterThanOrEqual(
        getCapsuleSize(option.id, 'recording').width,
      )
    }
  })
})
