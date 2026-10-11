import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXED_DARK_THEME_PROFILES, THEME_PROFILE_IDS } from '../../lib/appearanceProfiles'
import { useAppStore } from '../../stores/appStore'
import { useTheme } from '../useTheme'

function createSystemTheme(initialMatches: boolean) {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    get matches() {
      return matches
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    }),
  } as unknown as MediaQueryList

  return {
    mediaQuery,
    setMatches(nextMatches: boolean) {
      matches = nextMatches
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent
      listeners.forEach((listener) => listener(event))
    },
  }
}

describe('useTheme native color scheme', () => {
  beforeEach(() => {
    cleanup()
    useAppStore.setState(useAppStore.getInitialState())
    document.documentElement.classList.remove('dark')
    document.documentElement.style.removeProperty('color-scheme')
    delete document.documentElement.dataset.themeProfile
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('reports every fixed-dark profile as dark without changing the selected light theme class', () => {
    const systemTheme = createSystemTheme(false)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => systemTheme.mediaQuery),
    )
    useAppStore.setState((state) => ({
      config: { ...state.config, theme: 'light', theme_profile: 'echo' },
    }))
    renderHook(() => useTheme())

    for (const themeProfile of FIXED_DARK_THEME_PROFILES) {
      act(() => useAppStore.getState().updateConfig({ theme_profile: themeProfile }))
      expect(document.documentElement).not.toHaveClass('dark')
      expect(document.documentElement.style.colorScheme).toBe('dark')
    }

    act(() => useAppStore.getState().updateConfig({ theme_profile: 'echo' }))
    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('applies all nine profile identities in the same layout commit as their native color scheme', () => {
    const systemTheme = createSystemTheme(false)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => systemTheme.mediaQuery),
    )
    useAppStore.setState((state) => ({
      config: { ...state.config, theme: 'light', theme_profile: 'echo' },
    }))
    renderHook(() => useTheme())

    for (const profile of THEME_PROFILE_IDS) {
      act(() => useAppStore.getState().updateConfig({ theme_profile: profile }))
      expect(document.documentElement.dataset.themeProfile).toBe(profile)
      expect(document.documentElement.style.colorScheme).toBe(
        FIXED_DARK_THEME_PROFILES.has(profile) ? 'dark' : 'light',
      )
    }
  })

  it('keeps the dark class tied to system changes while a fixed-dark profile stays natively dark', () => {
    const systemTheme = createSystemTheme(false)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => systemTheme.mediaQuery),
    )
    useAppStore.setState((state) => ({
      config: { ...state.config, theme: 'system', theme_profile: 'echo' },
    }))
    renderHook(() => useTheme())

    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('light')

    act(() => systemTheme.setMatches(true))
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    act(() => systemTheme.setMatches(false))
    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('light')

    act(() => useAppStore.getState().updateConfig({ theme_profile: 'carbon' }))
    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    act(() => systemTheme.setMatches(true))
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    act(() => systemTheme.setMatches(false))
    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})
