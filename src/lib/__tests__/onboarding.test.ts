import { describe, expect, it } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import type { AppConfig } from '../../stores/appStore'
import type { DesktopBootstrap } from '../tauri'
import {
  backendSttAvailability,
  firstRunOnboardingSession,
  hotkeyMatchesKeyboardEvent,
} from '../onboarding'

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...useAppStore.getInitialState().config,
    onboarding_version: 1,
    ...overrides,
  }
}

describe('onboarding session policy', () => {
  it('asks a confirmed fresh installation to choose a mode', () => {
    expect(firstRunOnboardingSession(config({ onboarding_version: 0 }), true)).toEqual({
      kind: 'mode-choice',
      source: 'backend',
    })
  })

  it('never treats an unavailable config as a fresh installation', () => {
    expect(firstRunOnboardingSession(config({ onboarding_version: 0 }), false)).toBeNull()
  })

  it('does not reopen after the single monotonic checkpoint is complete', () => {
    expect(firstRunOnboardingSession(config(), true)).toBeNull()
  })

  it('does not auto-open a second tutorial when an existing user switches modes', () => {
    expect(firstRunOnboardingSession(config({ config_source: 'local' }), true)).toBeNull()
  })
})

describe('onboarding service guards', () => {
  it('keeps network voice unavailable until both authorization and STT are ready', () => {
    expect(backendSttAvailability(null, false)).toBe('signed-out')
    expect(backendSttAvailability(null, true)).toBe('unavailable')

    const bootstrap = {
      services: { stt: { mode: 'proxy', configured: true } },
      quotas: { stt: { remaining: 12 } },
    } as DesktopBootstrap
    expect(backendSttAvailability(bootstrap, true)).toBe('ready')
  })

  it('recognizes the configured keyboard shortcut without allowing other modifiers', () => {
    expect(
      hotkeyMatchesKeyboardEvent(
        new KeyboardEvent('keydown', { key: '/', ctrlKey: true }),
        'Ctrl+/',
      ),
    ).toBe(true)
    expect(
      hotkeyMatchesKeyboardEvent(
        new KeyboardEvent('keydown', { key: '/', ctrlKey: true, shiftKey: true }),
        'Ctrl+/',
      ),
    ).toBe(false)
  })
})
