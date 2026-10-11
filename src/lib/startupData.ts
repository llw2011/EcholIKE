import type { AppConfig, DictionaryEntry, HistoryEntry } from '../stores/appStore'
import type { AppConfigOrigin, AppConfigSnapshot } from './tauri'

export type StartupConfigOrigin = AppConfigOrigin | 'unavailable'
type StartupConfigSnapshot = Omit<AppConfigSnapshot, 'origin'> & { origin: StartupConfigOrigin }

export interface StartupData {
  config: AppConfig
  configOrigin: StartupConfigOrigin
  history: HistoryEntry[]
  dictionary: DictionaryEntry[]
  runtimeAppVersion: string
}

export interface StartupDataLoaders {
  getConfig: () => Promise<AppConfigSnapshot>
  getHistory: () => Promise<HistoryEntry[]>
  getDictionary: () => Promise<DictionaryEntry[]>
  getRuntimeAppVersion: () => Promise<string>
}

export interface StartupDataFallbacks {
  config: AppConfig
  history?: HistoryEntry[]
  dictionary?: DictionaryEntry[]
  runtimeAppVersion: string
}

type StartupDataKey = 'config' | 'history' | 'dictionary' | 'runtimeAppVersion'

export async function loadStartupData(
  loaders: StartupDataLoaders,
  fallbacks: StartupDataFallbacks,
  warn: (label: StartupDataKey, error: unknown) => void = defaultStartupDataWarning,
): Promise<StartupData> {
  const [configSnapshot, history, dictionary, runtimeAppVersion] = await Promise.all([
    withStartupFallback<StartupConfigSnapshot>(
      'config',
      loaders.getConfig,
      { config: fallbacks.config, origin: 'unavailable' as const },
      warn,
    ),
    withStartupFallback('history', loaders.getHistory, fallbacks.history ?? [], warn),
    withStartupFallback('dictionary', loaders.getDictionary, fallbacks.dictionary ?? [], warn),
    withStartupFallback(
      'runtimeAppVersion',
      loaders.getRuntimeAppVersion,
      fallbacks.runtimeAppVersion,
      warn,
    ),
  ])

  return {
    config: configSnapshot.config,
    configOrigin: configSnapshot.origin,
    history,
    dictionary,
    runtimeAppVersion,
  }
}

async function withStartupFallback<T>(
  label: StartupDataKey,
  load: () => Promise<T>,
  fallback: T,
  warn: (label: StartupDataKey, error: unknown) => void,
) {
  try {
    return await load()
  } catch (error) {
    warn(label, error)
    return fallback
  }
}

function defaultStartupDataWarning(label: StartupDataKey, error: unknown) {
  console.warn(`Startup ${label} load failed; using fallback.`, error)
}
