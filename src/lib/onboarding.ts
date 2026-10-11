import type { AppConfig, ConfigSource } from '../stores/appStore'
import type { DesktopBootstrap } from './tauri'

export type OnboardingSessionKind = 'mode-choice' | 'full' | 'mode' | 'manual'

export type OnboardingSession = {
  kind: OnboardingSessionKind
  source: ConfigSource
}

export function firstRunOnboardingSession(
  config: AppConfig,
  configAvailable: boolean,
): OnboardingSession | null {
  if (!configAvailable || config.onboarding_version !== 0) return null
  return { kind: 'mode-choice', source: config.config_source }
}

export function isLocalSttConfigured(config: AppConfig) {
  if (config.stt_provider === 'sensevoice-local') {
    return Boolean(config.stt_custom_base_url.trim())
  }
  if (config.stt_provider === 'custom-whisper') {
    return Boolean(config.stt_custom_base_url.trim())
  }
  return Boolean(config.stt_api_key.trim())
}

export type BackendSttAvailability = 'signed-out' | 'ready' | 'unavailable'

export function backendSttAvailability(
  bootstrap: DesktopBootstrap | null,
  hasDesktopToken: boolean,
): BackendSttAvailability {
  if (!hasDesktopToken) return 'signed-out'

  const stt = bootstrap?.services?.stt
  if (!stt || stt.mode !== 'proxy' || stt.configured === false) return 'unavailable'

  const remaining = bootstrap?.quotas?.stt?.remaining
  if (typeof remaining === 'number' && remaining <= 0) return 'unavailable'

  return 'ready'
}

export function hotkeyMatchesKeyboardEvent(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  const key = parts[parts.length - 1]
  if (!key) return false

  const modifierParts = new Set(parts.slice(0, -1))
  const expectsCtrl = modifierParts.has('ctrl') || modifierParts.has('control')
  const expectsAlt = modifierParts.has('alt') || modifierParts.has('option')
  const expectsShift = modifierParts.has('shift')
  const expectsMeta =
    modifierParts.has('meta') ||
    modifierParts.has('super') ||
    modifierParts.has('win') ||
    modifierParts.has('cmd')

  if (
    event.ctrlKey !== expectsCtrl ||
    event.altKey !== expectsAlt ||
    event.shiftKey !== expectsShift ||
    event.metaKey !== expectsMeta
  ) {
    return false
  }

  const eventKey = event.key.toLowerCase()
  const normalizedKey = key === 'slash' ? '/' : key === 'space' ? ' ' : key
  return eventKey === normalizedKey
}
