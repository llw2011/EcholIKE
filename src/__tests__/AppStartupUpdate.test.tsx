import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { useAppStore, type AppConfig } from '../stores/appStore'

const mocks = vi.hoisted(() => ({
  checkSignedOtaUpdate: vi.fn(),
  getConfigSnapshot: vi.fn(),
  chooseUsageMode: vi.fn(),
  resolveOnboardingStartup: vi.fn(),
  acquireOnboardingGuard: vi.fn(),
  releaseOnboardingGuard: vi.fn(),
  startupWindowMode: vi.fn(),
  fetchDesktopBootstrap: vi.fn(),
  loadDesktopAuthSnapshot: vi.fn(),
  beginDesktopAuthCandidate: vi.fn(),
  commitDesktopAuthCandidate: vi.fn(),
  clearDesktopAuthAuthority: vi.fn(),
  confirmDesktopAuthRuntime: vi.fn(),
  invalidateDesktopAuthRuntime: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../hooks/useTauriEvents', () => ({ useTauriEvents: vi.fn() }))
vi.mock('../hooks/useTheme', () => ({ useTheme: vi.fn() }))
vi.mock('../hooks/useStartupUpdateWindow', () => ({
  useStartupUpdateWindow: mocks.startupWindowMode,
}))
vi.mock('../components/MainLayout', () => ({
  MainLayout: ({
    children,
    onOpenQuickStart,
  }: {
    children: React.ReactNode
    onOpenQuickStart: () => void
  }) => (
    <main className="echo-shell">
      <button type="button" onClick={onOpenQuickStart}>
        open quick start
      </button>
      {children}
    </main>
  ),
}))
vi.mock('../components/HomePage', () => ({
  HomePage: ({
    onOpenNetworkLogin,
    onRefreshNetwork,
    onSwitchToLocal,
    networkRefreshError,
    networkSwitchBusy,
  }: {
    onOpenNetworkLogin: () => void
    onRefreshNetwork: () => void
    onSwitchToLocal: () => void
    networkRefreshError?: string | null
    networkSwitchBusy: boolean
  }) => (
    <div>
      Home ready
      <button type="button" onClick={onOpenNetworkLogin}>
        home network login
      </button>
      <button type="button" onClick={onRefreshNetwork}>
        home refresh network
      </button>
      <button type="button" onClick={onSwitchToLocal} disabled={networkSwitchBusy}>
        home switch local
      </button>
      {networkRefreshError && <span role="alert">{networkRefreshError}</span>}
    </div>
  ),
}))
vi.mock('../components/Settings', () => ({ Settings: () => <div>Settings ready</div> }))
vi.mock('../components/StartupUpdatePrompt', () => ({
  StartupUpdatePrompt: ({ onDismiss }: { onDismiss: () => void }) => (
    <section data-testid="startup-update-card">
      Update ready
      <button type="button" onClick={onDismiss}>
        dismiss update
      </button>
    </section>
  ),
}))
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }))
vi.mock('../components/Onboarding/OnboardingOverlay', () => ({
  OnboardingOverlay: ({
    session,
    modeChoiceSavingSource,
    modeChoiceMessage,
    onChooseMode,
    onRefreshNetwork,
    onSkip,
  }: {
    session: { kind: string; source: string }
    modeChoiceSavingSource: 'local' | 'backend' | null
    modeChoiceMessage: string | null
    onChooseMode: (source: 'local' | 'backend') => void
    onRefreshNetwork: () => void
    onSkip: () => void
  }) => (
    <section data-testid="onboarding" data-kind={session.kind} data-source={session.source}>
      <span data-testid="mode-saving">{modeChoiceSavingSource ?? 'idle'}</span>
      {modeChoiceMessage && <span role="alert">{modeChoiceMessage}</span>}
      <button type="button" onClick={() => onChooseMode('local')}>
        choose local
      </button>
      <button type="button" onClick={onSkip}>
        close tutorial
      </button>
      <button type="button" onClick={onRefreshNetwork}>
        tutorial refresh network
      </button>
    </section>
  ),
}))
vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>()
  return {
    ...actual,
    getConfigSnapshot: mocks.getConfigSnapshot,
    chooseUsageMode: mocks.chooseUsageMode,
    resolveOnboardingStartup: mocks.resolveOnboardingStartup,
    acquireOnboardingGuard: mocks.acquireOnboardingGuard,
    releaseOnboardingGuard: mocks.releaseOnboardingGuard,
    getHistory: vi.fn().mockResolvedValue([]),
    getDictionary: vi.fn().mockResolvedValue([]),
    getRuntimeAppVersion: vi.fn().mockResolvedValue('0.1.82'),
    checkSignedOtaUpdate: mocks.checkSignedOtaUpdate,
    fetchDesktopBootstrap: mocks.fetchDesktopBootstrap,
    loadDesktopAuthSnapshot: mocks.loadDesktopAuthSnapshot,
    beginDesktopAuthCandidate: mocks.beginDesktopAuthCandidate,
    commitDesktopAuthCandidate: mocks.commitDesktopAuthCandidate,
    clearDesktopAuthAuthority: mocks.clearDesktopAuthAuthority,
    confirmDesktopAuthRuntime: mocks.confirmDesktopAuthRuntime,
    invalidateDesktopAuthRuntime: mocks.invalidateDesktopAuthRuntime,
  }
})
vi.mock('../lib/toast', () => ({ toast: mocks.toast }))

import App from '../App'

afterEach(cleanup)

describe('main App startup update gate and v2 first run', () => {
  beforeEach(() => {
    window.location.hash = '#/'
    localStorage.clear()
    useAppStore.setState(useAppStore.getInitialState())
    const config = {
      ...useAppStore.getState().config,
      config_source: 'local' as const,
      onboarding_version: 1,
    }
    useAppStore.setState({ config })
    mocks.getConfigSnapshot.mockReset().mockResolvedValue({ config, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockReset()
    mocks.startupWindowMode.mockClear()
    mocks.resolveOnboardingStartup
      .mockReset()
      .mockImplementation(async (showTour: boolean) => (showTour ? 41 : null))
    mocks.acquireOnboardingGuard.mockReset().mockResolvedValue(42)
    mocks.releaseOnboardingGuard.mockReset().mockResolvedValue(true)
    mocks.fetchDesktopBootstrap.mockReset().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '2026-07-20T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'fixture@example.com',
        name: null,
        plan: 'pro',
        subscriptionEnd: null,
      },
    })
    mocks.loadDesktopAuthSnapshot.mockReset().mockImplementation(async () => {
      const token = localStorage.getItem('echolike.v2.authToken')?.trim() || null
      return {
        generation: 0,
        authorityToken: token,
        rawCachedAuthToken: null,
        cache: null,
      }
    })
    mocks.beginDesktopAuthCandidate
      .mockReset()
      .mockImplementation(async (generation, authority) => {
        const cachedBootstrap = useAppStore.getState().desktopBootstrap
        return {
          generation: generation + 1,
          authorityToken: authority,
          rawCachedAuthToken: cachedBootstrap ? authority : null,
          cache: cachedBootstrap
            ? {
                packageVersion: '0.1.82',
                bootstrap: cachedBootstrap,
                authToken: authority,
                cachedAt: '2026-07-30T00:00:00.000Z',
              }
            : null,
        }
      })
    mocks.confirmDesktopAuthRuntime.mockReset().mockResolvedValue(true)
    mocks.invalidateDesktopAuthRuntime.mockReset().mockResolvedValue(false)
    mocks.commitDesktopAuthCandidate
      .mockReset()
      .mockImplementation(async (generation, authority, _raw, bootstrap) => ({
        generation: generation + 1,
        authorityToken: authority,
        rawCachedAuthToken: authority,
        cache: {
          packageVersion: '0.1.82',
          bootstrap,
          authToken: authority,
          cachedAt: '2026-07-30T00:00:00.000Z',
        },
      }))
    mocks.clearDesktopAuthAuthority.mockReset().mockImplementation(async (generation) => ({
      generation: generation + 1,
      authorityToken: null,
      rawCachedAuthToken: null,
      cache: null,
    }))
    mocks.toast.mockReset()
    mocks.chooseUsageMode.mockReset().mockImplementation(async (source: 'local' | 'backend') => ({
      ...useAppStore.getState().config,
      config_source: source,
      onboarding_version: 1,
    }))
  })

  it('stays visually transparent until an available OTA card can be shown', async () => {
    let finishCheck!: (value: {
      currentVersion: string
      latestVersion: string
      releaseNotes: string
      checkedAt: string
    }) => void
    mocks.checkSignedOtaUpdate.mockReturnValue(
      new Promise((resolve) => {
        finishCheck = resolve
      }),
    )

    const view = render(<App />)

    expect(view.container.querySelector('.echo-startup-update-gate')).toBeInTheDocument()
    expect(view.container.querySelector('.echo-shell')).not.toBeInTheDocument()
    expect(mocks.startupWindowMode).toHaveBeenLastCalledWith('checking', false)

    act(() => {
      finishCheck({
        currentVersion: '0.1.81',
        latestVersion: '0.1.82',
        releaseNotes: '修复启动显示。',
        checkedAt: '2026-07-15T08:00:00.000Z',
      })
    })

    expect(await screen.findByTestId('startup-update-card')).toBeInTheDocument()
    expect(view.container.querySelector('.echo-shell')).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.startupWindowMode).toHaveBeenLastCalledWith('available', true))
  })

  it('keeps a configured start-minimized window hidden after startup data loads', async () => {
    const minimizedConfig = {
      ...useAppStore.getState().config,
      config_source: 'local' as const,
      onboarding_version: 1,
      start_minimized: true,
    }
    mocks.getConfigSnapshot.mockResolvedValue({ config: minimizedConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)

    expect(mocks.startupWindowMode).toHaveBeenLastCalledWith('checking', false)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    await waitFor(() => expect(mocks.startupWindowMode).toHaveBeenLastCalledWith(null, false))
    expect(mocks.resolveOnboardingStartup).toHaveBeenCalledWith(false, true)
  })

  it('uses the native mode command and checkpoints a confirmed new install once', async () => {
    const freshConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 0,
    }
    const saved = { ...freshConfig, config_source: 'local' as const, onboarding_version: 1 }
    mocks.getConfigSnapshot.mockResolvedValue({ config: freshConfig, origin: 'created_new' })
    mocks.chooseUsageMode.mockResolvedValue(saved)
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    const first = render(<App />)
    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'mode-choice')
    fireEvent.click(screen.getByRole('button', { name: 'choose local' }))

    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledWith('local'))
    await waitFor(() =>
      expect(screen.getByTestId('onboarding')).toHaveAttribute('data-kind', 'full'),
    )

    first.unmount()
    useAppStore.setState(useAppStore.getInitialState())
    mocks.getConfigSnapshot.mockResolvedValue({ config: saved, origin: 'persisted' })
    mocks.chooseUsageMode.mockClear()

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument())
    expect(mocks.chooseUsageMode).not.toHaveBeenCalled()
  })

  it('switches an existing Home session to local mode without opening an unguarded tutorial', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'home switch local' }))

    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledWith('local'))
    await waitFor(() => expect(useAppStore.getState().config.config_source).toBe('local'))
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument()
    expect(mocks.acquireOnboardingGuard).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalledWith(
      '已切换到本地配置版；服务参数可稍后在设置中配置。',
      'success',
    )
  })

  it('carries a one-shot network-login focus request into the AI settings route', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'home network login' }))

    expect(await screen.findByText('Settings ready')).toBeInTheDocument()
    expect(window.location.hash).toBe('#/settings/ai?focus=network-auth')
  })

  it('deduplicates a pending Home mode switch and exposes its busy state', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    let finishSwitch!: (config: AppConfig) => void
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)
    mocks.chooseUsageMode.mockReturnValue(
      new Promise((resolve) => {
        finishSwitch = resolve
      }),
    )

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'home switch local' })
    fireEvent.click(trigger)

    await waitFor(() => expect(trigger).toBeDisabled())
    fireEvent.click(trigger)
    expect(mocks.chooseUsageMode).toHaveBeenCalledTimes(1)
    act(() => finishSwitch({ ...backendConfig, config_source: 'local' }))
    await waitFor(() => expect(useAppStore.getState().config.config_source).toBe('local'))
  })

  it('preserves the latest current and saved settings when a pending mode switch commits', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    let finishSwitch!: (config: AppConfig) => void
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)
    mocks.chooseUsageMode.mockReturnValue(
      new Promise((resolve) => {
        finishSwitch = resolve
      }),
    )

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'home switch local' }))
    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledTimes(1))

    act(() => {
      const current = useAppStore.getState().config
      const savedConfig = useAppStore.getState().savedConfig ?? current
      useAppStore.setState({
        config: { ...current, hotkey: 'Ctrl+Alt+1' },
        savedConfig: { ...savedConfig, hotkey: 'Ctrl+Alt+2' },
      })
    })
    act(() =>
      finishSwitch({
        ...backendConfig,
        config_source: 'local',
        onboarding_version: 1,
      }),
    )

    await waitFor(() => expect(useAppStore.getState().config.config_source).toBe('local'))
    expect(useAppStore.getState().config.hotkey).toBe('Ctrl+Alt+1')
    expect(useAppStore.getState().savedConfig).toMatchObject({
      config_source: 'local',
      onboarding_version: 1,
      hotkey: 'Ctrl+Alt+2',
    })
  })

  it('allows a failed Home mode switch to be retried without opening onboarding', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)
    mocks.chooseUsageMode.mockRejectedValueOnce(new Error('write denied'))

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'home switch local' })
    fireEvent.click(trigger)
    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('本地状态保存失败')
    expect(mocks.toast).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toBeEnabled())
    fireEvent.click(trigger)

    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('keeps a late Home mode-switch failure out of Settings and restores it on Home', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    let rejectSwitch!: (error: Error) => void
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)
    mocks.chooseUsageMode.mockReturnValue(
      new Promise((_, reject) => {
        rejectSwitch = reject
      }),
    )

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'home switch local' }))
    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'home network login' }))
    expect(await screen.findByText('Settings ready')).toBeInTheDocument()
    act(() => rejectSwitch(new Error('write denied')))

    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mocks.toast).not.toHaveBeenCalled()

    act(() => {
      window.location.hash = '#/'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('本地状态保存失败')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('resumes a pending first run from the persisted v2 config on restart', async () => {
    const pendingConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 0,
    }
    mocks.getConfigSnapshot.mockResolvedValue({ config: pendingConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)

    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'mode-choice')
    expect(mocks.resolveOnboardingStartup).toHaveBeenCalledWith(true, true)
  })

  it('never turns a config IPC failure into a first-use chooser', async () => {
    mocks.getConfigSnapshot.mockRejectedValue(new Error('config IPC unavailable'))
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)

    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument()
    expect(mocks.chooseUsageMode).not.toHaveBeenCalled()
    await waitFor(() => expect(mocks.resolveOnboardingStartup).toHaveBeenCalledWith(false, false))
    expect(screen.getByRole('alert')).toHaveTextContent('不会启动首次使用向导')
    expect(screen.getByRole('alert')).toHaveTextContent('快捷键和录音也会暂时停用')
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))
    fireEvent.click(screen.getByRole('button', { name: 'home switch local' }))
    expect(mocks.acquireOnboardingGuard).not.toHaveBeenCalled()
    expect(mocks.chooseUsageMode).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('lets the fixed guard warning own blocked quick-start and local-switch feedback', async () => {
    mocks.resolveOnboardingStartup.mockReset().mockRejectedValue(new Error('guard unavailable'))
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)

    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('快捷键暂时停用')
    mocks.toast.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))
    fireEvent.click(screen.getByRole('button', { name: 'home switch local' }))

    expect(mocks.acquireOnboardingGuard).not.toHaveBeenCalled()
    expect(mocks.chooseUsageMode).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('returns tutorial refresh failures to the callout without using the global toast', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    mocks.fetchDesktopBootstrap
      .mockReset()
      .mockRejectedValue(new Error('quota refresh unavailable'))
    mocks.toast.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))
    expect(await screen.findByTestId('onboarding')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'tutorial refresh network' }))

    await waitFor(() => expect(mocks.fetchDesktopBootstrap).toHaveBeenCalledTimes(1))
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('keeps ordinary Home refresh failures in the visible Home feedback layer', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    mocks.fetchDesktopBootstrap
      .mockReset()
      .mockRejectedValue(new Error('quota refresh unavailable'))
    mocks.toast.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'home refresh network' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('刷新网络服务额度失败。')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('repairs a stale browser mirror from the native authority before cross-package validation', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    localStorage.setItem('echolike.v2.authToken', 'newer-token')
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)
    mocks.loadDesktopAuthSnapshot.mockResolvedValue({
      generation: 7,
      authorityToken: 'older-token',
      rawCachedAuthToken: 'older-token',
      cache: null,
    })
    mocks.fetchDesktopBootstrap.mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '2026-07-21T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'new@example.com',
        name: null,
        plan: 'pro',
        subscriptionEnd: null,
      },
    })

    render(<App />)

    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.fetchDesktopBootstrap).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api/desktop/bootstrap',
        '0.1.82',
        'older-token',
      ),
    )
    await waitFor(() => expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated'))
    expect(localStorage.getItem('echolike.v2.authToken')).toBe('older-token')
    expect(mocks.beginDesktopAuthCandidate).toHaveBeenCalledWith(7, 'older-token')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
  })

  it('recovers and fully revalidates an old-package login after the WebView mirror is missing', async () => {
    const establishedBootstrap = {
      schemaVersion: 1,
      generatedAt: '2026-07-20T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'persisted@example.com',
        name: null,
        plan: 'pro' as const,
        subscriptionEnd: null,
      },
    }
    const established = {
      generation: 7,
      authorityToken: 'persisted-token',
      rawCachedAuthToken: 'persisted-token',
      cache: null,
    }
    const candidate = { ...established, generation: 8 }
    mocks.loadDesktopAuthSnapshot.mockResolvedValue(established)
    mocks.beginDesktopAuthCandidate.mockResolvedValue(candidate)
    mocks.fetchDesktopBootstrap.mockResolvedValue(establishedBootstrap)
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(<App />)

    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    await waitFor(() =>
      expect(localStorage.getItem('echolike.v2.authToken')).toBe('persisted-token'),
    )
    expect(mocks.beginDesktopAuthCandidate).toHaveBeenCalledWith(7, 'persisted-token')
    expect(mocks.fetchDesktopBootstrap).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/echo-api/desktop/bootstrap',
      '0.1.82',
      'persisted-token',
    )
    await waitFor(() => expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated'))
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('persisted@example.com')
  })

  it('does not roll back to an older native identity when current-token refresh fails', async () => {
    const backendConfig = {
      ...useAppStore.getState().config,
      config_source: 'backend' as const,
      onboarding_version: 1,
    }
    localStorage.setItem('echolike.v2.authToken', 'newer-token')
    mocks.getConfigSnapshot.mockResolvedValue({ config: backendConfig, origin: 'persisted' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)
    mocks.loadDesktopAuthSnapshot.mockResolvedValue({
      generation: 7,
      authorityToken: 'newer-token',
      rawCachedAuthToken: 'newer-token',
      cache: {
        packageVersion: '0.1.82',
        cachedAt: '2026-07-20T00:00:00.000Z',
        authToken: 'newer-token',
        bootstrap: {
          schemaVersion: 1,
          generatedAt: '2026-07-20T00:00:00.000Z',
          apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
          user: {
            email: 'old@example.com',
            name: null,
            plan: 'pro',
            subscriptionEnd: null,
          },
        },
      },
    })
    mocks.beginDesktopAuthCandidate.mockResolvedValue({
      generation: 8,
      authorityToken: 'newer-token',
      rawCachedAuthToken: 'newer-token',
      cache: {
        packageVersion: '0.1.82',
        cachedAt: '2026-07-20T00:00:00.000Z',
        authToken: 'newer-token',
        bootstrap: {
          schemaVersion: 1,
          generatedAt: '2026-07-20T00:00:00.000Z',
          apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
          user: {
            email: 'old@example.com',
            name: null,
            plan: 'pro',
            subscriptionEnd: null,
          },
        },
      },
    })
    mocks.fetchDesktopBootstrap.mockRejectedValue(new Error('backend unavailable'))

    render(<App />)

    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.beginDesktopAuthCandidate).toHaveBeenCalledWith(7, 'newer-token'),
    )
    expect(localStorage.getItem('echolike.v2.authToken')).toBe('newer-token')
    expect(useAppStore.getState().desktopAuthToken).toBe('newer-token')
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('old@example.com')
  })

  it('keeps a fresh-install lease while an OTA prompt temporarily covers the chooser', async () => {
    const freshConfig = {
      ...useAppStore.getState().config,
      onboarding_version: 0,
    }
    mocks.getConfigSnapshot.mockResolvedValue({ config: freshConfig, origin: 'created_new' })
    mocks.checkSignedOtaUpdate.mockResolvedValue({
      currentVersion: '0.1.81',
      latestVersion: '0.1.82',
      releaseNotes: '修复启动显示。',
      checkedAt: '2026-07-15T08:00:00.000Z',
    })

    render(<App />)

    expect(await screen.findByTestId('startup-update-card')).toBeInTheDocument()
    await waitFor(() => expect(mocks.resolveOnboardingStartup).toHaveBeenCalledWith(true, true))
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'dismiss update' }))
    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'mode-choice')
  })

  it('keeps a mode-save failure visible inside the chooser and allows retry', async () => {
    const freshConfig = {
      ...useAppStore.getState().config,
      onboarding_version: 0,
    }
    mocks.getConfigSnapshot.mockResolvedValue({ config: freshConfig, origin: 'created_new' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)
    mocks.chooseUsageMode.mockRejectedValueOnce(new Error('atomic replace denied'))

    render(<App />)
    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'mode-choice')
    fireEvent.click(screen.getByRole('button', { name: 'choose local' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('本地状态保存失败')
    fireEvent.click(screen.getByRole('button', { name: 'choose local' }))
    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledTimes(2))
  })

  it('shows an explicit saving state and deduplicates repeated mode choices', async () => {
    const freshConfig = {
      ...useAppStore.getState().config,
      onboarding_version: 0,
    }
    mocks.getConfigSnapshot.mockResolvedValue({ config: freshConfig, origin: 'created_new' })
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)
    mocks.chooseUsageMode.mockReturnValue(new Promise(() => undefined))

    render(<App />)
    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'mode-choice')
    fireEvent.click(screen.getByRole('button', { name: 'choose local' }))
    expect(await screen.findByTestId('mode-saving')).toHaveTextContent('local')

    fireEvent.click(screen.getByRole('button', { name: 'choose local' }))
    await waitFor(() => expect(mocks.chooseUsageMode).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('onboarding')).toBeInTheDocument()
  })

  it('acquires the native guard before showing a manually opened tutorial', async () => {
    let finishAcquire!: (lease: number) => void
    mocks.acquireOnboardingGuard.mockReturnValue(
      new Promise((resolve) => {
        finishAcquire = resolve
      }),
    )

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))

    expect(mocks.acquireOnboardingGuard).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument()
    act(() => finishAcquire(42))
    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'manual')
  })

  it('uses the latest config source when a pending manual guard acquisition resolves', async () => {
    let finishAcquire!: (lease: number) => void
    mocks.acquireOnboardingGuard.mockReturnValue(
      new Promise((resolve) => {
        finishAcquire = resolve
      }),
    )

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))
    act(() => useAppStore.getState().updateConfig({ config_source: 'backend' }))
    act(() => finishAcquire(42))

    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-source', 'backend')
  })

  it('deduplicates repeated manual tutorial clicks while guard acquisition is pending', async () => {
    mocks.acquireOnboardingGuard.mockReturnValue(new Promise(() => undefined))

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'open quick start' })
    fireEvent.click(trigger)
    fireEvent.click(trigger)

    expect(mocks.acquireOnboardingGuard).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument()
  })

  it('does not show a manual tutorial when native guard acquisition fails', async () => {
    mocks.acquireOnboardingGuard.mockRejectedValue(new Error('IPC unavailable'))

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))

    await waitFor(() => expect(mocks.acquireOnboardingGuard).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))
    await waitFor(() => expect(mocks.acquireOnboardingGuard).toHaveBeenCalledTimes(2))
  })

  it('releases a manual tutorial lease before hiding the overlay', async () => {
    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))
    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'manual')

    fireEvent.click(screen.getByRole('button', { name: 'close tutorial' }))

    await waitFor(() => expect(mocks.releaseOnboardingGuard).toHaveBeenCalledWith(42))
    await waitFor(() => expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument())
  })

  it('keeps a manual overlay visible while release is pending and allows retry after false', async () => {
    let finishRelease!: (released: boolean) => void
    mocks.releaseOnboardingGuard.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRelease = resolve
      }),
    )

    render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))
    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'manual')
    fireEvent.click(screen.getByRole('button', { name: 'close tutorial' }))

    expect(screen.getByTestId('onboarding')).toBeInTheDocument()
    act(() => finishRelease(false))
    expect(await screen.findByRole('alert')).toHaveTextContent('快捷键保护仍保持开启')

    mocks.releaseOnboardingGuard.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'close tutorial' }))
    await waitFor(() => expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument())
  })

  it('releases a manual lease that arrives after the app unmounts', async () => {
    let finishAcquire!: (lease: number) => void
    mocks.acquireOnboardingGuard.mockReturnValue(
      new Promise((resolve) => {
        finishAcquire = resolve
      }),
    )

    const view = render(<App />)
    expect(await screen.findByText('Home ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open quick start' }))
    view.unmount()
    act(() => finishAcquire(42))

    await waitFor(() => expect(mocks.releaseOnboardingGuard).toHaveBeenCalledWith(42))
  })

  it('does not resolve the native boot guard before StrictMode finishes config classification', async () => {
    const freshConfig = {
      ...useAppStore.getState().config,
      onboarding_version: 0,
    }
    let finishConfig!: (snapshot: { config: typeof freshConfig; origin: 'created_new' }) => void
    mocks.getConfigSnapshot.mockReturnValue(
      new Promise((resolve) => {
        finishConfig = resolve
      }),
    )
    mocks.checkSignedOtaUpdate.mockResolvedValue(null)

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    expect(mocks.resolveOnboardingStartup).not.toHaveBeenCalled()
    act(() => finishConfig({ config: freshConfig, origin: 'created_new' }))

    expect(await screen.findByTestId('onboarding')).toHaveAttribute('data-kind', 'mode-choice')
    expect(mocks.resolveOnboardingStartup).toHaveBeenCalledTimes(1)
    expect(
      mocks.resolveOnboardingStartup.mock.calls.every(
        ([showTour, configAvailable]) => showTour === true && configAvailable === true,
      ),
    ).toBe(true)
  })
})
