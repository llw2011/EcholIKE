import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useAppStore, type AppConfig } from '../stores/appStore'
import {
  acquireOnboardingGuard,
  chooseUsageMode,
  fetchDesktopBootstrap,
  releaseOnboardingGuard,
  resolveOnboardingStartup,
} from '../lib/tauri'
import {
  applyDesktopBootstrapResponse,
  beginDesktopAuthRequest,
  handleDesktopBootstrapFailure,
} from '../lib/desktopAuthRuntime'
import type { StartupConfigOrigin } from '../lib/startupData'
import { userFacingErrorMessage, type ErrorContext } from '../lib/userErrors'
import { DESKTOP_BOOTSTRAP_URL } from '../lib/branding'
import { toast } from '../lib/toast'
import type { OnboardingSession } from '../lib/onboarding'
import type { SimulationState } from '../components/Onboarding/OnboardingOverlay'

function errorMessage(error: unknown, fallback: string, context: ErrorContext = 'general') {
  return userFacingErrorMessage(error, fallback, context)
}

function localConfigSaveMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error ?? '')
  console.warn('Failed to persist usage mode:', error)
  if (/access.*denied|permission.*denied|os error 5/i.test(detail)) {
    return 'Windows 拒绝写入本地设置。请检查当前用户对 EcholIKE 数据目录的权限后重试。'
  }
  if (/sharing violation|used by another process|os error 32/i.test(detail)) {
    return '本地设置文件正被其他程序占用。请暂时关闭同步或安全软件扫描后重试。'
  }
  if (/disk.*full|not enough space|os error 112/i.test(detail)) {
    return '本地磁盘空间不足，无法保存使用方式。请释放空间后重试。'
  }
  return '本地状态保存失败。请重试；若持续出现，请检查本地数据目录是否可写。'
}

interface UseMainUsageModeOptions {
  loaded: boolean
  startupConfigOrigin: StartupConfigOrigin
  startupOnboardingCandidate: OnboardingSession | null | undefined
  runtimeAppVersion: string
  mainAppMounted: RefObject<boolean>
  setConfig: (config: AppConfig) => void
  setSavedConfig: (config: AppConfig) => void
}

export function useMainUsageMode({
  loaded,
  startupConfigOrigin,
  startupOnboardingCandidate,
  runtimeAppVersion,
  mainAppMounted,
  setConfig,
  setSavedConfig,
}: UseMainUsageModeOptions) {
  const [onboardingSession, setOnboardingSession] = useState<OnboardingSession | null>(null)
  const [onboardingSimulation, setOnboardingSimulation] = useState<SimulationState>('idle')
  const [modeChoiceSavingSource, setModeChoiceSavingSource] = useState<
    AppConfig['config_source'] | null
  >(null)
  const [modeChoiceMessage, setModeChoiceMessage] = useState<string | null>(null)
  const [onboardingRuntimeReady, setOnboardingRuntimeReady] = useState(false)
  const [onboardingGuardError, setOnboardingGuardError] = useState<string | null>(null)
  const [networkRefreshBusy, setNetworkRefreshBusy] = useState(false)
  const [homeNetworkFeedback, setHomeNetworkFeedback] = useState<string | null>(null)
  const [homeModeSwitchBusy, setHomeModeSwitchBusy] = useState(false)
  const homeNetworkFeedbackRun = useRef(0)
  const modeChoiceSavePending = useRef(false)
  const onboardingLease = useRef<number | null>(null)
  const startupGuardResolution = useRef<Promise<number | null> | null>(null)
  const manualOnboardingPending = useRef(false)
  const onboardingReleasePending = useRef(false)

  const navigateOnboarding = useCallback((nextRoute: 'home' | 'settings', section?: string) => {
    if (nextRoute === 'home') {
      window.location.hash = '#/'
      return
    }
    window.location.hash = section ? `#/settings/${section}` : '#/settings'
  }, [])

  const closeOnboarding = useCallback(() => {
    if (onboardingReleasePending.current) return
    setModeChoiceSavingSource(null)
    const lease = onboardingLease.current
    const finish = () => {
      setModeChoiceMessage(null)
      setOnboardingSession(null)
      setOnboardingSimulation('idle')
    }
    if (lease === null) {
      finish()
      return
    }

    onboardingReleasePending.current = true
    void releaseOnboardingGuard(lease)
      .then((released) => {
        if (!released) {
          throw new Error('native onboarding lease was not active')
        }
        if (onboardingLease.current === lease) onboardingLease.current = null
        finish()
      })
      .catch((error) => {
        console.warn('Failed to release onboarding runtime guard:', error)
        setModeChoiceMessage('结束教程失败，请重试。快捷键保护仍保持开启。')
      })
      .finally(() => {
        onboardingReleasePending.current = false
      })
  }, [])

  const applyPersistedUsageMode = useCallback(
    (saved: AppConfig) => {
      const current = useAppStore.getState().config
      const currentSaved = useAppStore.getState().savedConfig ?? current
      setConfig({
        ...current,
        config_source: saved.config_source,
        onboarding_version: saved.onboarding_version,
      })
      setSavedConfig({
        ...currentSaved,
        config_source: saved.config_source,
        onboarding_version: saved.onboarding_version,
      })
    },
    [setConfig, setSavedConfig],
  )

  const chooseOnboardingMode = useCallback(
    (source: AppConfig['config_source'], sessionKind: 'full' | 'mode' = 'full') => {
      if (modeChoiceSavePending.current) {
        setModeChoiceMessage('上一次使用方式仍在保存，请等待完成后再试。')
        return
      }
      modeChoiceSavePending.current = true
      setModeChoiceSavingSource(source)
      setModeChoiceMessage(null)

      void chooseUsageMode(source)
        .then((saved) => {
          applyPersistedUsageMode(saved)
          setOnboardingSession({ kind: sessionKind, source })
          setModeChoiceMessage(null)
        })
        .catch((error) => {
          setModeChoiceMessage(localConfigSaveMessage(error))
        })
        .finally(() => {
          modeChoiceSavePending.current = false
          setModeChoiceSavingSource(null)
        })
    },
    [applyPersistedUsageMode],
  )

  const openQuickStart = useCallback(() => {
    if (onboardingSession || manualOnboardingPending.current) return
    if (startupConfigOrigin === 'unavailable' || onboardingGuardError) return
    if (modeChoiceSavePending.current) {
      toast('使用方式仍在保存，请等待完成后再打开快速上手。', 'info')
      return
    }
    if (!onboardingRuntimeReady) {
      toast('快速上手仍在初始化，请稍后重试。', 'error')
      return
    }
    manualOnboardingPending.current = true
    void acquireOnboardingGuard()
      .then((lease) => {
        if (!mainAppMounted.current) {
          void releaseOnboardingGuard(lease).catch((error) => {
            console.warn('Failed to release a late onboarding lease after unmount:', error)
          })
          return
        }
        if (onboardingSession) {
          void releaseOnboardingGuard(lease).catch((error) => {
            console.warn('Failed to release an unused onboarding lease:', error)
          })
          return
        }
        onboardingLease.current = lease
        setModeChoiceMessage(null)
        setOnboardingSimulation('idle')
        setOnboardingSession({
          kind: 'manual',
          source: useAppStore.getState().config.config_source,
        })
      })
      .catch((error) => {
        if (!mainAppMounted.current) return
        console.warn('Failed to acquire onboarding runtime guard:', error)
        toast('快速上手安全状态初始化失败，请重试。', 'error')
      })
      .finally(() => {
        manualOnboardingPending.current = false
      })
  }, [
    mainAppMounted,
    onboardingGuardError,
    onboardingRuntimeReady,
    onboardingSession,
    startupConfigOrigin,
  ])

  const refreshNetworkAccess = useCallback(
    async (feedback: 'home' | 'inline' = 'home') => {
      if (networkRefreshBusy) return null
      let request: Awaited<ReturnType<typeof beginDesktopAuthRequest>>
      try {
        request = await beginDesktopAuthRequest()
      } catch (error) {
        const message = errorMessage(error, '本机授权状态读取失败。')
        if (feedback === 'home') setHomeNetworkFeedback(message)
        return message
      }
      if (!request?.token) {
        navigateOnboarding('settings', 'ai')
        return null
      }
      const feedbackRun = feedback === 'home' ? (homeNetworkFeedbackRun.current += 1) : null
      if (feedbackRun !== null) setHomeNetworkFeedback(null)
      setNetworkRefreshBusy(true)
      try {
        const bootstrap = await fetchDesktopBootstrap(
          DESKTOP_BOOTSTRAP_URL,
          runtimeAppVersion,
          request.token,
        )
        const result = await applyDesktopBootstrapResponse(bootstrap, request)
        if (result.kind === 'rejected') return '后台授权已失效，请重新登录。'
        if (result.kind === 'stale') return '后台授权已更新，请使用当前账号重试。'
        if (result.kind === 'cache-error') return '本机授权缓存保存失败，请重新登录。'
        return null
      } catch (error) {
        await handleDesktopBootstrapFailure(error, request)
        const message = errorMessage(error, '刷新网络服务额度失败。')
        if (feedbackRun !== null && homeNetworkFeedbackRun.current === feedbackRun) {
          setHomeNetworkFeedback(message)
        }
        return message
      } finally {
        setNetworkRefreshBusy(false)
      }
    },
    [navigateOnboarding, networkRefreshBusy, runtimeAppVersion],
  )

  const switchToLocalInsideOnboarding = useCallback(() => {
    chooseOnboardingMode('local', 'mode')
  }, [chooseOnboardingMode])

  const switchHomeToLocal = useCallback(() => {
    if (homeModeSwitchBusy) return
    if (startupConfigOrigin === 'unavailable' || onboardingGuardError) return
    if (manualOnboardingPending.current || modeChoiceSavePending.current) {
      toast('首次使用状态仍在处理中，请稍后再切换使用方式。', 'info')
      return
    }

    const feedbackRun = (homeNetworkFeedbackRun.current += 1)
    setHomeNetworkFeedback(null)
    setHomeModeSwitchBusy(true)
    void chooseUsageMode('local')
      .then((saved) => {
        applyPersistedUsageMode(saved)
      })
      .catch((error) => {
        if (homeNetworkFeedbackRun.current === feedbackRun) {
          setHomeNetworkFeedback(localConfigSaveMessage(error))
        }
      })
      .finally(() => {
        setHomeModeSwitchBusy(false)
      })
  }, [applyPersistedUsageMode, homeModeSwitchBusy, onboardingGuardError, startupConfigOrigin])

  useEffect(() => {
    if (!loaded || startupOnboardingCandidate === undefined) return
    let cancelled = false
    const showTour = startupOnboardingCandidate !== null

    if (startupGuardResolution.current === null) {
      startupGuardResolution.current = resolveOnboardingStartup(
        showTour,
        startupConfigOrigin !== 'unavailable',
      )
    }
    void startupGuardResolution.current
      .then((lease) => {
        if (cancelled) return
        if (showTour && lease === null) {
          throw new Error('native onboarding guard did not issue a startup lease')
        }
        onboardingLease.current = lease
        setOnboardingSession(startupOnboardingCandidate)
        setOnboardingGuardError(null)
        setOnboardingRuntimeReady(true)
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('Failed to resolve onboarding startup guard:', error)
        setOnboardingGuardError('首次使用状态初始化失败。为保护隐私，快捷键暂时停用，请重启应用。')
      })

    return () => {
      cancelled = true
    }
  }, [loaded, startupConfigOrigin, startupOnboardingCandidate])

  return {
    onboardingSession,
    onboardingSimulation,
    setOnboardingSimulation,
    modeChoiceSavingSource,
    modeChoiceMessage,
    onboardingRuntimeReady,
    onboardingGuardError,
    networkRefreshBusy,
    homeNetworkFeedback,
    homeModeSwitchBusy,
    navigateOnboarding,
    closeOnboarding,
    chooseOnboardingMode,
    openQuickStart,
    refreshNetworkAccess,
    switchToLocalInsideOnboarding,
    switchHomeToLocal,
  }
}
