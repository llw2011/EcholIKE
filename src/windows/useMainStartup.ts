import { useEffect, useRef, useState } from 'react'
import { useStartupUpdateWindow } from '../hooks/useStartupUpdateWindow'
import { useAppStore, type AppConfig } from '../stores/appStore'
import {
  checkAccessibilityPermission,
  checkSignedOtaUpdate,
  downloadAndInstallOtaUpdate,
  getConfigSnapshot,
  getDictionary,
  getHistory,
  getRuntimeAppVersion,
  updaterProxyUrl,
  type OtaInstallProgress,
} from '../lib/tauri'
import { syncDesktopAuthAtStartup } from '../lib/desktopAuthRuntime'
import { loadStartupData, type StartupConfigOrigin } from '../lib/startupData'
import { checkStartupUpdate, type StartupUpdateInfo } from '../lib/startupUpdate'
import { userFacingErrorMessage } from '../lib/userErrors'
import { firstRunOnboardingSession, type OnboardingSession } from '../lib/onboarding'
import { APP_VERSION, DESKTOP_BOOTSTRAP_URL, UPDATE_CHECK_URL } from '../lib/branding'

const STARTUP_OTA_TIMEOUT_MS = 3500

type StartupUpdateGate =
  | { status: 'checking' }
  | { status: 'skipped' }
  | { status: 'dismissed' }
  | { status: 'available'; update: StartupUpdateInfo }
  | { status: 'installing'; update: StartupUpdateInfo }
  | { status: 'failed'; update: StartupUpdateInfo; message: string }

interface UseMainStartupOptions {
  config: AppConfig
  setConfig: (config: AppConfig) => void
  setSavedConfig: (config: AppConfig) => void
}

export function useMainStartup({ config, setConfig, setSavedConfig }: UseMainStartupOptions) {
  const setHistory = useAppStore((s) => s.setHistory)
  const setDictionary = useAppStore((s) => s.setDictionary)
  const setAccessibilityTrusted = useAppStore((s) => s.setAccessibilityTrusted)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [startupConfigOrigin, setStartupConfigOrigin] = useState<StartupConfigOrigin>('unavailable')
  const [startupOnboardingCandidate, setStartupOnboardingCandidate] = useState<
    OnboardingSession | null | undefined
  >(undefined)
  const [runtimeAppVersion, setRuntimeAppVersion] = useState(APP_VERSION)
  const [startupUpdateGate, setStartupUpdateGate] = useState<StartupUpdateGate>({
    status: 'checking',
  })
  const [startupUpdateProgress, setStartupUpdateProgress] = useState<OtaInstallProgress | null>(
    null,
  )
  useStartupUpdateWindow(
    startupUpdateGate.status === 'checking' ||
      startupUpdateGate.status === 'available' ||
      startupUpdateGate.status === 'installing' ||
      startupUpdateGate.status === 'failed'
      ? startupUpdateGate.status
      : null,
    loaded && !config.start_minimized,
  )
  const mainAppMounted = useRef(false)

  useEffect(() => {
    mainAppMounted.current = true
    return () => {
      mainAppMounted.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadInitialData() {
      try {
        const startupData = await loadStartupData(
          {
            getConfig: getConfigSnapshot,
            getHistory: () => getHistory(200, 0),
            getDictionary,
            getRuntimeAppVersion: () => getRuntimeAppVersion(APP_VERSION),
          },
          {
            config: useAppStore.getState().config,
            runtimeAppVersion: APP_VERSION,
          },
        )

        if (cancelled) return

        setConfig(startupData.config)
        setSavedConfig(startupData.config)
        setHistory(startupData.history)
        setDictionary(startupData.dictionary)
        setRuntimeAppVersion(startupData.runtimeAppVersion)
        setStartupConfigOrigin(startupData.configOrigin)
        setStartupOnboardingCandidate(
          firstRunOnboardingSession(startupData.config, startupData.configOrigin !== 'unavailable'),
        )

        void syncDesktopAuthAtStartup({
          bootstrapUrl: DESKTOP_BOOTSTRAP_URL,
          currentVersion: startupData.runtimeAppVersion,
          allowPublic: startupData.config.config_source === 'backend',
          isCancelled: () => cancelled,
        })
          .then((result) => {
            if (result.kind === 'failed') {
              console.warn('Desktop auth startup synchronization skipped:', result.error)
            }
          })
          .catch((error) => {
            console.warn('Desktop auth startup synchronization failed:', error)
          })

        const startupUpdate = await checkStartupUpdate(
          {
            checkSignedOtaUpdate: (timeoutMs) =>
              checkSignedOtaUpdate(timeoutMs, updaterProxyUrl(startupData.config)),
          },
          { timeoutMs: STARTUP_OTA_TIMEOUT_MS },
          (reason, error) => {
            console.warn('Startup OTA check skipped:', reason, error)
          },
        )
        if (cancelled) return
        setStartupUpdateGate(
          startupUpdate.status === 'available'
            ? { status: 'available', update: startupUpdate.update }
            : { status: 'skipped' },
        )

        if (navigator.platform.toUpperCase().includes('MAC')) {
          checkAccessibilityPermission()
            .then((trusted) => {
              if (!cancelled) setAccessibilityTrusted(trusted)
            })
            .catch(() => {
              if (!cancelled) setAccessibilityTrusted(false)
            })
        }
      } catch (e) {
        console.error('Failed to load initial data:', e)
        if (!cancelled) {
          setLoadError(true)
          setStartupConfigOrigin('unavailable')
          setStartupOnboardingCandidate(null)
          setStartupUpdateGate({ status: 'skipped' })
        }
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }

    loadInitialData()

    return () => {
      cancelled = true
    }
  }, [setConfig, setSavedConfig, setHistory, setDictionary, setAccessibilityTrusted])

  async function installStartupUpdate(update: StartupUpdateInfo) {
    setStartupUpdateGate({ status: 'installing', update })
    setStartupUpdateProgress({
      phase: 'checking',
      downloadedBytes: 0,
      totalBytes: null,
      percent: null,
    })
    try {
      await downloadAndInstallOtaUpdate(
        UPDATE_CHECK_URL,
        runtimeAppVersion,
        updaterProxyUrl(config),
        setStartupUpdateProgress,
      )
    } catch (error) {
      setStartupUpdateProgress(null)
      setStartupUpdateGate({
        status: 'failed',
        update,
        message: userFacingErrorMessage(error, '更新安装失败，请稍后重试。', 'update'),
      })
    }
  }

  function dismissStartupUpdate() {
    setStartupUpdateProgress(null)
    setStartupUpdateGate({ status: 'dismissed' })
  }

  return {
    loaded,
    loadError,
    startupConfigOrigin,
    startupOnboardingCandidate,
    runtimeAppVersion,
    startupUpdateGate,
    startupUpdateProgress,
    mainAppMounted,
    installStartupUpdate,
    dismissStartupUpdate,
  }
}
