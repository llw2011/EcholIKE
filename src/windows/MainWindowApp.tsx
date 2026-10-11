import { useTauriEvents } from '../hooks/useTauriEvents'
import { useTheme } from '../hooks/useTheme'
import { useAppStore } from '../stores/appStore'
import { useRoute } from '../lib/router'
import { isDesktopAuthSessionAuthenticated } from '../lib/desktopAuth'
import { Settings } from '../components/Settings'
import { MainLayout } from '../components/MainLayout'
import { HomePage } from '../components/HomePage'
import { StartupUpdatePrompt } from '../components/StartupUpdatePrompt'
import { ToastContainer } from '../components/Toast'
import { OnboardingOverlay } from '../components/Onboarding/OnboardingOverlay'
import { useMainStartup } from './useMainStartup'
import { useMainUsageMode } from './useMainUsageMode'

export function MainWindowApp() {
  useTauriEvents()
  useTheme()

  const config = useAppStore((s) => s.config)
  const setConfig = useAppStore((s) => s.setConfig)
  const setSavedConfig = useAppStore((s) => s.setSavedConfig)
  const desktopBootstrap = useAppStore((s) => s.desktopBootstrap)
  const desktopAuthToken = useAppStore((s) => s.desktopAuthToken)
  const desktopAuthStatus = useAppStore((s) => s.desktopAuthStatus)
  const desktopBootstrapAuthToken = useAppStore((s) => s.desktopBootstrapAuthToken)
  const desktopAuthenticated = isDesktopAuthSessionAuthenticated(
    desktopBootstrap,
    desktopAuthToken,
    desktopAuthStatus,
    desktopBootstrapAuthToken,
  )
  const {
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
  } = useMainStartup({ config, setConfig, setSavedConfig })
  const { route } = useRoute()
  const {
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
  } = useMainUsageMode({
    loaded,
    startupConfigOrigin,
    startupOnboardingCandidate,
    runtimeAppVersion,
    mainAppMounted,
    setConfig,
    setSavedConfig,
  })

  if (!loaded) return <div className="echo-startup-update-gate" aria-hidden="true" />

  if (loadError)
    return (
      <div className="echo-boot-screen echo-boot-screen--error">
        <span>本地数据加载失败。</span>
        <button
          type="button"
          className="echo-button echo-button--primary"
          onClick={() => window.location.reload()}
        >
          重新载入
        </button>
      </div>
    )

  if (
    startupUpdateGate.status === 'available' ||
    startupUpdateGate.status === 'installing' ||
    startupUpdateGate.status === 'failed'
  ) {
    return (
      <StartupUpdatePrompt
        update={startupUpdateGate.update}
        installing={startupUpdateGate.status === 'installing'}
        progress={startupUpdateProgress}
        errorMessage={startupUpdateGate.status === 'failed' ? startupUpdateGate.message : null}
        onInstall={() => void installStartupUpdate(startupUpdateGate.update)}
        onDismiss={dismissStartupUpdate}
      />
    )
  }

  if (!onboardingRuntimeReady && !onboardingGuardError) {
    return (
      <div className="echo-boot-screen" role="status">
        <span>正在初始化快捷键保护…</span>
      </div>
    )
  }

  return (
    <>
      {startupConfigOrigin === 'unavailable' && (
        <div className="echo-config-storage-warning" role="alert">
          本地设置暂时无法读取，本次使用临时配置且不会启动首次使用向导；快捷键和录音也会暂时停用。请重启重试或检查数据目录权限。
        </div>
      )}
      {onboardingGuardError && (
        <div className="echo-config-storage-warning" role="alert">
          {onboardingGuardError}
        </div>
      )}
      <MainLayout onOpenQuickStart={openQuickStart}>
        {route === 'home' && (
          <HomePage
            onboardingSimulation={onboardingSimulation}
            onOpenNetworkLogin={() => navigateOnboarding('settings', 'ai?focus=network-auth')}
            onRefreshNetwork={() => void refreshNetworkAccess('home')}
            onSwitchToLocal={switchHomeToLocal}
            networkRefreshBusy={networkRefreshBusy}
            networkRefreshError={homeNetworkFeedback}
            networkSwitchBusy={homeModeSwitchBusy}
          />
        )}
        {route === 'settings' && <Settings />}
        <ToastContainer />
      </MainLayout>
      {onboardingSession && (
        <OnboardingOverlay
          session={onboardingSession}
          config={config}
          route={route}
          desktopBootstrap={desktopBootstrap}
          hasDesktopToken={desktopAuthenticated}
          refreshingNetwork={networkRefreshBusy}
          modeChoiceSavingSource={modeChoiceSavingSource}
          modeChoiceMessage={modeChoiceMessage}
          onChooseMode={chooseOnboardingMode}
          onFinish={closeOnboarding}
          onSkip={closeOnboarding}
          onNavigate={navigateOnboarding}
          onRefreshNetwork={() => refreshNetworkAccess('inline')}
          onSwitchToLocal={switchToLocalInsideOnboarding}
          onSimulationStateChange={setOnboardingSimulation}
        />
      )}
    </>
  )
}
