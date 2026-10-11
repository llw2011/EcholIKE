import { updateConfig as persistConfig } from '../../lib/tauri'
import { useAppStore, type AppConfig, type SettingsNoticeScope } from '../../stores/appStore'

const configPersistenceCoordinator = (() => {
  let tail: Promise<void> = Promise.resolve()
  let latestWriteId = 0

  return {
    enqueue(run: (writeId: number) => Promise<void>) {
      const writeId = ++latestWriteId
      const promise = tail.then(() => run(writeId))
      tail = promise.catch(() => undefined)
      return { writeId, promise }
    },
    isLatest(writeId: number) {
      return writeId === latestWriteId
    },
  }
})()

type AppStoreState = ReturnType<typeof useAppStore.getState>

type ConfigPersistenceBindings = {
  updateStoreConfig: AppStoreState['updateConfig']
  applyPersistedConfigPatch: AppStoreState['applyPersistedConfigPatch']
  setSavedConfig: AppStoreState['setSavedConfig']
  publishSettingsNotice: AppStoreState['publishSettingsNotice']
  settingsErrorMessage: (error: unknown, fallback: string) => string
}

export function createConfigPersistenceActions({
  updateStoreConfig,
  applyPersistedConfigPatch,
  setSavedConfig,
  publishSettingsNotice,
  settingsErrorMessage,
}: ConfigPersistenceBindings) {
  function updateConfig(
    patch: Partial<AppConfig>,
    scope: SettingsNoticeScope,
    options: { reportFailure?: boolean } = {},
  ): Promise<void> {
    updateStoreConfig(patch)
    const persistenceRequest = configPersistenceCoordinator.enqueue(async (writeId) => {
      const latestConfig = useAppStore.getState().config
      const baseConfig = useAppStore.getState().savedConfig ?? latestConfig
      const savedConfig = await persistConfig(baseConfig, latestConfig)
      if (configPersistenceCoordinator.isLatest(writeId)) {
        setSavedConfig(savedConfig ?? latestConfig)
      }
    })

    if (options.reportFailure !== false) {
      void persistenceRequest.promise.catch((error) => {
        if (configPersistenceCoordinator.isLatest(persistenceRequest.writeId)) {
          publishSettingsNotice(scope, 'error', settingsErrorMessage(error, '设置保存失败。'))
        }
      })
    }
    return persistenceRequest.promise
  }

  function updateConfigViaCommand(
    patch: Partial<AppConfig>,
    command: () => Promise<void>,
    failureMessage: string,
    scope: SettingsNoticeScope,
  ) {
    updateStoreConfig(patch)
    command()
      .then(() => {
        applyPersistedConfigPatch(patch)
      })
      .catch((error) => {
        publishSettingsNotice(scope, 'error', settingsErrorMessage(error, failureMessage))
      })
  }

  return { updateConfig, updateConfigViaCommand }
}
