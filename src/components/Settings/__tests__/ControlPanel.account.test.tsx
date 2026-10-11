import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { APP_VERSION } from '../../../lib/branding'
import { useAppStore } from '../../../stores/appStore'
import {
  installControlPanelTestHarness,
  tauriMocks,
  toastMocks,
  resetStore,
  renderSettings,
  openTab,
} from './controlPanelTestHarness'

describe('ControlPanel', () => {
  installControlPanelTestHarness()

  it('shows diagnostics only for the owner backend account', () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-02T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          email: 'owner@example.com',
          name: null,
          plan: 'pro',
          subscriptionEnd: null,
          quotaLevel: 1,
          quotaMultiplier: 1,
          adminRole: 'owner',
        },
      },
    })

    renderSettings()

    expect(screen.getByRole('tab', { name: /诊断/ })).toBeInTheDocument()
  })

  it('scrolls a Home login request into view and focuses the backend account once', async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    )
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })
    window.location.hash = '#/settings/ai?focus=network-auth'

    try {
      renderSettings()
      const account = screen.getByLabelText('后台账号邮箱')

      await waitFor(() => expect(account).toHaveFocus())
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest',
      })
      expect(window.location.hash).toBe('#/settings/ai')
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      }
    }
  })

  it('does not move the page or steal focus during ordinary AI settings navigation', () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    )
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })
    window.location.hash = '#/settings/ai'

    try {
      renderSettings()
      expect(screen.getByLabelText('后台账号邮箱')).not.toHaveFocus()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      }
    }
  })

  it('switches between backend-managed and local config without clearing local values', async () => {
    renderSettings()
    openTab('AI')

    expect(screen.getByDisplayValue('https://api.deepseek.com/v1')).toBeInTheDocument()
    tauriMocks.fetchDesktopBootstrap.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '后台托管' }))

    await waitFor(() => {
      expect(useAppStore.getState().config.config_source).toBe('backend')
    })
    expect(tauriMocks.fetchDesktopBootstrap).not.toHaveBeenCalled()
    expect(useAppStore.getState().settingsOperation).toBeNull()
    expect(screen.queryByText('请先连接后台账号，再拉取托管配置。')).not.toBeInTheDocument()
    expect(
      screen.getByText('后台托管需先登录；暂未开放注册，请联系管理员获取账号。'),
    ).toBeInTheDocument()
    expect(document.querySelector('.echo-backend-auth-registration-note')).toBeNull()
    expect(screen.getAllByText(/暂未开放注册/)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /拉取托管配置/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刷新额度' })).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('https://api.deepseek.com/v1')).not.toBeInTheDocument()
    expect(screen.queryByText('文本 AI API Key')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '本机配置' }))

    await waitFor(() => {
      expect(useAppStore.getState().config.config_source).toBe('local')
    })
    expect(screen.getByDisplayValue('https://api.deepseek.com/v1')).toBeInTheDocument()
    expect(screen.getByDisplayValue('deepseek-chat')).toBeInTheDocument()
  })

  it('keeps the committed source visible while a native mode switch is pending', async () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      savedConfig: { ...useAppStore.getState().config, config_source: 'backend' },
    })
    let commitMode!: (config: ReturnType<typeof useAppStore.getState>['config']) => void
    tauriMocks.chooseUsageMode.mockReturnValueOnce(
      new Promise((resolve) => {
        commitMode = resolve
      }),
    )

    renderSettings()
    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: '本机配置' }))

    expect(useAppStore.getState().config.config_source).toBe('backend')
    expect(useAppStore.getState().settingsOperation?.kind).toBe('config-source')
    expect(screen.getByRole('button', { name: '本机配置' })).toBeDisabled()

    const persistedBeforeConcurrentPatch = {
      ...useAppStore.getState().config,
      config_source: 'local' as const,
    }
    act(() => useAppStore.getState().updateConfig({ llm_model: 'concurrent-window-model' }))
    commitMode(persistedBeforeConcurrentPatch)
    await waitFor(() => expect(useAppStore.getState().config.config_source).toBe('local'))
    expect(useAppStore.getState().config.llm_model).toBe('concurrent-window-model')
    expect(useAppStore.getState().settingsOperation).toBeNull()
  })

  it('keeps usage mode immutable while a recording generation is active', () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      savedConfig: { ...useAppStore.getState().config, config_source: 'backend' },
      pipelineState: 'recording',
    })
    renderSettings()
    openTab('AI')

    const localMode = screen.getByRole('button', { name: '本机配置' })
    expect(localMode).toBeDisabled()
    expect(screen.getByText('当前录音或文字处理结束后才能切换使用方式。')).toBeInTheDocument()
    fireEvent.click(localMode)
    expect(tauriMocks.chooseUsageMode).not.toHaveBeenCalled()
    expect(useAppStore.getState().config.config_source).toBe('backend')
  })

  it('does not fake a source change or sync when the native mode transaction fails', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    tauriMocks.chooseUsageMode.mockRejectedValueOnce(new Error('config source persistence failed'))

    renderSettings()
    openTab('AI')
    toastMocks.toast.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '后台托管' }))

    await waitFor(() => {
      expect(useAppStore.getState().settingsNotices['managed-config']?.phase).toBe('error')
    })
    expect(useAppStore.getState().config.config_source).toBe('local')
    expect(tauriMocks.fetchDesktopBootstrap).not.toHaveBeenCalled()
    expect(screen.queryByText('账号配置已同步。')).not.toBeInTheDocument()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('keeps the config source selector compact and right-aligned', () => {
    renderSettings()
    openTab('AI')

    const sourceRow = screen.getByText('业务能力来源').closest('.echo-setting-line')
    expect(sourceRow).toHaveClass('echo-setting-line--compact-control')
    expect(within(sourceRow as HTMLElement).getByRole('button', { name: '后台托管' })).toBeVisible()
    expect(within(sourceRow as HTMLElement).getByRole('button', { name: '本机配置' })).toBeVisible()
  })

  it('backend-managed mode shows service availability and hides endpoint fields', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-02T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        quotas: {
          llm: { used: 50, limit: 5000, remaining: 4950, unit: 'tokens' },
          stt: { used: 10, limit: 900, remaining: 890, unit: 'seconds' },
          tts: { used: 200, limit: 10000, remaining: 9800, unit: 'chars' },
          ocr: { used: 1, limit: 100, remaining: 99, unit: 'images' },
        },
        services: {
          llm: { mode: 'proxy', configured: true, displayName: '托管文本 AI' },
          stt: { mode: 'proxy', configured: true, displayName: '托管 STT' },
          tts: { mode: 'proxy', configured: true, displayName: '托管 TTS' },
          ocr: {
            mode: 'proxy',
            configured: true,
            displayName: '托管 OCR',
            capabilities: {
              imageAvailable: true,
              pdfAvailable: true,
              acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
              maxInputBytes: 25 * 1024 * 1024,
              maxPdfPages: 20,
              processingRoutes: ['direct', 'pipeline'],
              documentContract: 'ocr-document-v1',
              pdfMode: 'server-pipeline',
            },
          },
        },
      },
    })

    renderSettings()

    expect(screen.queryByText('业务能力来源')).not.toBeInTheDocument()
    openTab('AI')
    const llmQuota = screen.getByText('剩余 4,950 tokens')
    const llmRow = screen.getByText('文本 AI').closest('.echo-setting-line')
    if (!llmRow) throw new Error('Managed LLM setting row not found')
    const llmStatus = within(llmRow as HTMLElement).getByText('可用')
    expect(screen.getByText('业务能力来源')).toBeInTheDocument()
    expect(screen.getByText('托管文本 AI')).toBeInTheDocument()
    expect(screen.getByText(/托管 OCR；图片直接识别/)).toBeInTheDocument()
    expect(screen.getByText('图片/PDF 可用')).toBeInTheDocument()
    expect(screen.getByText(/PDF 由后台文档识别处理（最多 20 页）/)).toBeInTheDocument()
    expect(screen.getByText('剩余 4,950 tokens')).toBeInTheDocument()
    expect(llmStatus.closest('button')).toBeNull()
    expect(within(llmRow as HTMLElement).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: /同步.*剩余额度/ })).not.toBeInTheDocument()
    expect(
      Boolean(llmQuota.compareDocumentPosition(llmStatus) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true)
    expect(screen.getByText('剩余 99 次')).toBeInTheDocument()
    expect(screen.queryByText('文本 AI API Key')).not.toBeInTheDocument()
    expect(screen.queryByText('本机识别地址')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('https://api.deepseek.com/v1')).not.toBeInTheDocument()

    tauriMocks.fetchDesktopBootstrap.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-07-03T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'fixture@example.com',
        name: null,
        plan: 'pro',
        subscriptionEnd: null,
      },
      quotas: {
        llm: { used: 200, limit: 5000, remaining: 4800, unit: 'tokens' },
        stt: { used: 100, limit: 900, remaining: 800, unit: 'seconds' },
        tts: { used: 500, limit: 10000, remaining: 9500, unit: 'chars' },
        ocr: { used: 20, limit: 100, remaining: 80, unit: 'images' },
      },
      services: {
        llm: { mode: 'proxy', configured: true, displayName: '托管文本 AI' },
        stt: { mode: 'proxy', configured: true, displayName: '托管 STT' },
        tts: { mode: 'proxy', configured: true, displayName: '托管 TTS' },
        ocr: { mode: 'proxy', configured: true, displayName: '托管 OCR' },
      },
    })
    tauriMocks.fetchDesktopBootstrap.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }))
    await waitFor(() => {
      expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalled()
      expect(screen.getByText('剩余 4,800 tokens')).toBeInTheDocument()
    })
    expect(screen.getByText('剩余 800 秒')).toBeInTheDocument()
    expect(screen.getByText('剩余 9,500 字')).toBeInTheDocument()
    expect(screen.getByText('剩余 80 次')).toBeInTheDocument()
    expect(useAppStore.getState().desktopBootstrap?.quotas?.stt?.remaining).toBe(800)
    expect(useAppStore.getState().desktopBootstrap?.quotas?.tts?.remaining).toBe(9500)
    const authPanel = screen
      .getByRole('heading', { name: '后台授权' })
      .closest('.echo-settings-panel')
    const configPanel = screen
      .getByRole('heading', { name: '配置来源' })
      .closest('.echo-settings-panel')
    expect(authPanel?.querySelector('.echo-panel-alert')).toHaveTextContent('全部服务额度已刷新。')
    expect(configPanel).not.toHaveTextContent('全部服务额度已刷新。')
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      '全部服务额度已刷新。',
      expect.anything(),
      expect.anything(),
    )

    openTab('麦克风')
    expect(screen.queryByText('STT API Key')).not.toBeInTheDocument()
    expect(screen.queryByText('SenseVoice 地址')).not.toBeInTheDocument()
  })

  it('does not treat server-pipeline PDF as negotiated without the document contract', () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-21T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          plan: 'pro',
          subscriptionEnd: null,
          adminRole: 'owner',
        },
        services: {
          ocr: {
            mode: 'proxy',
            configured: true,
            displayName: '托管 OCR',
            capabilities: {
              imageAvailable: true,
              pdfAvailable: true,
              acceptedMimeTypes: ['image/png', 'application/pdf'],
              maxInputBytes: 25 * 1024 * 1024,
              maxPdfPages: 20,
              processingRoutes: ['direct', 'pipeline'],
              pdfMode: 'server-pipeline',
            },
          },
        },
      },
    })

    renderSettings()
    openTab('AI')

    expect(screen.getByText('仅图片可用')).toBeInTheDocument()
    expect(screen.queryByText(/PDF 由后台文档识别处理/)).not.toBeInTheDocument()
  })

  it('labels a capability-less backend as legacy-unknown in diagnostics', () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-21T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          plan: 'pro',
          subscriptionEnd: null,
          adminRole: 'owner',
        },
        services: {
          ocr: { mode: 'proxy', configured: true, displayName: '旧后台 OCR' },
        },
      },
    })

    renderSettings()
    openTab('AI')
    expect(screen.getByText(/旧后台兼容模式/)).toBeInTheDocument()
    openTab('诊断')
    const report = screen.getByText(/service\.ocr\.pdfMode=legacy-unknown/)
    expect(report).not.toHaveTextContent('service.ocr.pdfMode=client-rasterized')
  })

  it('places backend authorization state beside the aligned account action column', () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-04T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          email: 'owner@example.com',
          name: null,
          plan: 'pro',
          subscriptionEnd: null,
          quotaLevel: 3,
          quotaMultiplier: 3,
          adminRole: 'owner',
        },
      },
    })

    renderSettings()
    openTab('AI')

    const authRow = screen.getByText('账号连接').closest('.echo-setting-line')
    const authPanel = screen
      .getByRole('heading', { name: '后台授权' })
      .closest('.echo-settings-panel')
    if (!authRow || !authPanel) throw new Error('Backend authorization panel not found')
    const heading = authPanel.querySelector('.echo-settings-panel-heading')
    const status = authRow.querySelector('.echo-line-status')
    const actions = authPanel.querySelector('.echo-settings-panel-actions')
    const controls = authRow.querySelector('.echo-line-control')
    if (!heading || !status || !actions || !controls)
      throw new Error('Backend authorization layout is incomplete')

    expect(heading).not.toHaveTextContent('已授权')
    expect(status).toHaveTextContent('已授权')
    expect(controls).not.toHaveTextContent('已授权')
    expect(within(status as HTMLElement).getByText('已授权')).toBeInTheDocument()
    expect(status.querySelector('.echo-backend-auth-status')).toBeInTheDocument()
    expect(within(actions as HTMLElement).getByRole('button', { name: '刷新额度' })).toBeVisible()
    expect(within(controls as HTMLElement).queryByRole('button', { name: '刷新额度' })).toBeNull()
    expect(screen.getByLabelText('后台账号邮箱')).toHaveValue('owner@example.com')
    expect(screen.getByLabelText('后台账号邮箱')).toBeDisabled()
    expect(screen.getByLabelText('授权账号等级')).toHaveValue('Pro · Lv.3 · 3x 月额度')
    expect(screen.getByLabelText('授权账号等级')).toBeDisabled()
    const authForm = controls.querySelector('.echo-backend-auth-form')
    const authFields = authForm?.querySelector('.echo-backend-auth-fields')
    const authActions = authForm?.querySelector('.echo-backend-auth-actions')
    expect(authForm).toHaveClass('is-locked')
    expect(authFields?.querySelectorAll('.echo-field')).toHaveLength(2)
    expect(authActions).toContainElement(
      within(controls as HTMLElement).getByRole('button', { name: /取消授权/ }),
    )
    expect(within(controls as HTMLElement).queryByRole('button', { name: /重新连接/ })).toBeNull()
    expect(
      within(controls as HTMLElement).getByRole('button', { name: /取消授权/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('文本 AI').closest('.echo-setting-line')).toHaveClass(
      'echo-setting-line--tail-control',
    )
    expect(authRow).not.toHaveClass('echo-setting-line--tail-control')
  })

  it('keeps backend sync in the system tab and TTS preview outside setting rows', () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-02T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        services: {
          tts: { mode: 'proxy', configured: true, displayName: '托管 TTS' },
        },
      },
    })

    renderSettings()
    openTab('AI')

    const configPanel = screen
      .getByRole('heading', { name: '配置来源' })
      .closest('.echo-settings-panel')
    if (!configPanel) throw new Error('Config source panel not found')
    const sourceRow = screen.getByText('业务能力来源').closest('.echo-setting-line')
    if (!sourceRow) throw new Error('Config source setting row not found')
    expect(
      within(configPanel as HTMLElement).queryByRole('button', { name: /拉取托管配置/ }),
    ).toBeNull()
    expect(
      within(sourceRow as HTMLElement).queryByRole('button', { name: /拉取托管配置/ }),
    ).toBeNull()

    openTab('系统')
    const managedConfigPanel = screen
      .getByRole('heading', { name: '托管配置' })
      .closest('.echo-settings-panel')
    if (!managedConfigPanel) throw new Error('Managed config panel not found')
    expect(
      within(managedConfigPanel as HTMLElement).getByRole('button', {
        name: /拉取托管配置/,
      }),
    ).toBeInTheDocument()
    expect(within(managedConfigPanel as HTMLElement).getByText('账号配置已同步')).toHaveClass(
      'echo-badge--ok',
    )
    expect(within(managedConfigPanel as HTMLElement).getByText('后台托管可用')).toHaveClass(
      'echo-badge--ok',
    )

    openTab('AI')
    const ttsPanel = screen
      .getByRole('heading', { name: '回答与文本朗读' })
      .closest('.echo-settings-panel')
    if (!ttsPanel) throw new Error('TTS panel not found')
    const ttsRow = screen.getByText('朗读能力').closest('.echo-setting-line')
    if (!ttsRow) throw new Error('TTS setting row not found')
    expect(
      within(ttsPanel as HTMLElement)
        .getByRole('button', { name: /朗读测试/ })
        .closest('.echo-settings-panel-actions'),
    ).toBeTruthy()
    expect(within(ttsRow as HTMLElement).queryByRole('button', { name: /朗读测试/ })).toBeNull()
  })

  it('does not spam backend config sync requests while one is in flight', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })
    let resolveBootstrap: (
      value: Awaited<ReturnType<typeof tauriMocks.fetchDesktopBootstrap>>,
    ) => void
    const pendingBootstrap = new Promise<
      Awaited<ReturnType<typeof tauriMocks.fetchDesktopBootstrap>>
    >((resolve) => {
      resolveBootstrap = resolve
    })
    tauriMocks.fetchDesktopBootstrap.mockReturnValueOnce(pendingBootstrap)

    renderSettings()
    openTab('系统')
    expect(screen.getByText('授权待验证')).toBeInTheDocument()
    expect(screen.getByText('等待授权验证')).toBeInTheDocument()
    const syncButton = screen.getByRole('button', { name: /验证后台授权/ })
    fireEvent.click(syncButton)
    fireEvent.click(syncButton)
    await act(async () => undefined)

    expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalledTimes(1)
    resolveBootstrap!({
      schemaVersion: 1,
      generatedAt: '2026-07-04T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'fixture@example.com',
        name: null,
        plan: 'pro',
        subscriptionEnd: null,
      },
    } as Awaited<ReturnType<typeof tauriMocks.fetchDesktopBootstrap>>)

    await waitFor(() =>
      expect(useAppStore.getState().settingsNotices['managed-config']).toMatchObject({
        phase: 'success',
        text: '账号配置已同步。',
      }),
    )
    const managedConfigPanel = screen
      .getByRole('heading', { name: '托管配置' })
      .closest('.echo-settings-panel')
    const syncRow = screen.getByText('后台配置').closest('.echo-setting-line')
    if (!managedConfigPanel || !syncRow) throw new Error('Managed config layout not found')
    expect(managedConfigPanel.querySelector('.echo-panel-alert')).toHaveTextContent(
      '账号配置已同步。',
    )
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      '账号配置已同步。',
      expect.anything(),
      expect.anything(),
    )
    expect(syncRow.querySelector('.echo-panel-alert')).toBeNull()
    expect(syncRow).not.toHaveTextContent('账号配置已同步。')
  })

  it('revalidates a pending saved authorization from the authorization card without a password', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopAuthToken: 'desktop-token',
      desktopAuthStatus: 'unknown',
    })
    let resolveBootstrap!: (
      value: Awaited<ReturnType<typeof tauriMocks.fetchDesktopBootstrap>>,
    ) => void
    tauriMocks.fetchDesktopBootstrap.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBootstrap = resolve
      }),
    )

    renderSettings()
    openTab('AI')
    const authPanel = screen
      .getByRole('heading', { name: '后台授权' })
      .closest('.echo-settings-panel')
    if (!authPanel) throw new Error('Backend authorization panel not found')
    const verifyButton = within(authPanel as HTMLElement).getByRole('button', {
      name: '重新验证已保存授权',
    })
    fireEvent.click(verifyButton)
    fireEvent.click(verifyButton)

    await waitFor(() => expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalledTimes(1))
    expect(tauriMocks.backendAuthSignIn).not.toHaveBeenCalled()
    await act(async () =>
      resolveBootstrap({
        schemaVersion: 1,
        generatedAt: '2026-07-04T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          email: 'fixture@example.com',
          name: null,
          plan: 'pro',
          subscriptionEnd: null,
        },
      } as Awaited<ReturnType<typeof tauriMocks.fetchDesktopBootstrap>>),
    )

    expect(await within(authPanel as HTMLElement).findByText('已授权')).toBeInTheDocument()
    expect(
      within(authPanel as HTMLElement).getByText('已保存的后台授权已重新验证。'),
    ).toBeInTheDocument()
    expect(tauriMocks.backendAuthSignIn).not.toHaveBeenCalled()
  })

  it('accepts a same-session verification completed by a newer native generation', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopAuthToken: 'desktop-token',
      desktopAuthStatus: 'unknown',
    })
    const verifiedBootstrap = {
      schemaVersion: 1,
      generatedAt: '2026-07-04T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'winner@example.com',
        name: null,
        plan: 'pro' as const,
        subscriptionEnd: null,
      },
    }
    tauriMocks.loadDesktopAuthSnapshot
      .mockResolvedValueOnce({
        generation: 8,
        authorityToken: 'desktop-token',
        rawCachedAuthToken: 'desktop-token',
        cache: null,
      })
      .mockResolvedValueOnce({
        generation: 10,
        authorityToken: 'desktop-token',
        rawCachedAuthToken: 'desktop-token',
        cache: {
          packageVersion: APP_VERSION,
          bootstrap: verifiedBootstrap,
          authToken: 'desktop-token',
          cachedAt: '2026-07-30T00:00:00.000Z',
        },
      })
    tauriMocks.commitDesktopAuthCandidate.mockResolvedValueOnce(null)
    tauriMocks.fetchDesktopBootstrap.mockResolvedValueOnce(verifiedBootstrap)

    renderSettings()
    openTab('AI')
    const authPanel = screen
      .getByRole('heading', { name: '后台授权' })
      .closest('.echo-settings-panel')
    if (!authPanel) throw new Error('Backend authorization panel not found')
    fireEvent.click(
      within(authPanel as HTMLElement).getByRole('button', {
        name: '重新验证已保存授权',
      }),
    )

    expect(await within(authPanel as HTMLElement).findByText('已授权')).toBeInTheDocument()
    expect(
      within(authPanel as HTMLElement).getByText('已保存的后台授权已重新验证。'),
    ).toBeInTheDocument()
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('winner@example.com')
    expect(tauriMocks.backendAuthSignIn).not.toHaveBeenCalled()
  })

  it('accepts a same-session winner when the explicit verification lease is already stale', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopAuthToken: 'desktop-token',
      desktopAuthStatus: 'unknown',
    })
    const verifiedBootstrap = {
      schemaVersion: 1,
      generatedAt: '2026-07-04T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'winner@example.com',
        name: null,
        plan: 'pro' as const,
        subscriptionEnd: null,
      },
    }
    tauriMocks.loadDesktopAuthSnapshot
      .mockResolvedValueOnce({
        generation: 8,
        authorityToken: 'desktop-token',
        rawCachedAuthToken: 'desktop-token',
        cache: null,
      })
      .mockResolvedValueOnce({
        generation: 9,
        authorityToken: 'desktop-token',
        rawCachedAuthToken: 'desktop-token',
        cache: {
          packageVersion: APP_VERSION,
          bootstrap: verifiedBootstrap,
          authToken: 'desktop-token',
          cachedAt: '2026-07-30T00:00:00.000Z',
        },
      })
    tauriMocks.beginDesktopAuthCandidate.mockResolvedValueOnce(null)

    renderSettings()
    openTab('AI')
    const authPanel = screen
      .getByRole('heading', { name: '后台授权' })
      .closest('.echo-settings-panel')
    if (!authPanel) throw new Error('Backend authorization panel not found')
    fireEvent.click(
      within(authPanel as HTMLElement).getByRole('button', {
        name: '重新验证已保存授权',
      }),
    )

    expect(await within(authPanel as HTMLElement).findByText('已授权')).toBeInTheDocument()
    expect(
      within(authPanel as HTMLElement).getByText('已保存的后台授权已重新验证。'),
    ).toBeInTheDocument()
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('winner@example.com')
    expect(tauriMocks.fetchDesktopBootstrap).not.toHaveBeenCalled()
    expect(tauriMocks.backendAuthSignIn).not.toHaveBeenCalled()
  })

  it('restores a pending bootstrap sync and its outcome after remount', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    let resolveBootstrap!: (
      value: Awaited<ReturnType<typeof tauriMocks.fetchDesktopBootstrap>>,
    ) => void
    tauriMocks.fetchDesktopBootstrap.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBootstrap = resolve
      }),
    )

    const first = renderSettings()
    openTab('系统')
    fireEvent.click(screen.getByRole('button', { name: /刷新后台状态/ }))
    expect(useAppStore.getState().settingsOperation?.kind).toBe('bootstrap-sync')
    await act(async () => undefined)
    first.unmount()

    renderSettings()
    openTab('系统')
    expect(screen.getByRole('button', { name: /刷新后台状态/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /刷新后台状态/ }))
    expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalledTimes(1)

    resolveBootstrap({
      schemaVersion: 1,
      generatedAt: '2026-07-04T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'owner@example.com',
        plan: 'pro',
        quotaLevel: 3,
        quotaMultiplier: 3,
        adminRole: 'owner',
      },
      quotas: { tts: { remaining: 9000, unit: 'characters' } },
    })
    await screen.findByText('后台状态已刷新，本机配置仍生效。')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('owner@example.com')
    expect(useAppStore.getState().settingsOperation).toBeNull()
  })

  it('restores a bootstrap error after the pending request rejects across remount', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    let rejectBootstrap!: (reason: Error) => void
    tauriMocks.fetchDesktopBootstrap.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectBootstrap = reject
      }),
    )

    const first = renderSettings()
    openTab('系统')
    fireEvent.click(screen.getByRole('button', { name: /刷新后台状态/ }))
    first.unmount()
    renderSettings()
    openTab('系统')
    expect(screen.getByRole('button', { name: /刷新后台状态/ })).toBeDisabled()

    rejectBootstrap(new Error('backend unavailable'))
    await screen.findByText('后台配置同步失败。')
    expect(screen.queryByText('backend unavailable')).not.toBeInTheDocument()
    expect(useAppStore.getState().settingsOperation).toBeNull()
    expect(screen.getByRole('button', { name: /刷新后台状态/ })).toBeEnabled()
    expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalledTimes(1)
  })

  it('signs in to the backend and refreshes managed service status', async () => {
    tauriMocks.backendAuthSignIn.mockResolvedValueOnce({ token: 'signed-desktop-token' })
    tauriMocks.fetchDesktopBootstrap.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-07-04T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'admin@example.com',
        name: null,
        plan: 'pro',
        subscriptionEnd: null,
      },
      policy: {
        preferProxy: true,
        allowDirectProviderKeys: false,
        allowByok: true,
        allowLocalModels: true,
      },
      services: {
        llm: { mode: 'proxy', configured: true, displayName: '后台文本 AI' },
      },
    })
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    renderSettings()
    openTab('AI')

    fireEvent.change(screen.getByPlaceholderText('后台账号邮箱'), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('后台账号密码'), {
      target: { value: 'password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /登录授权/ }))

    await waitFor(() => {
      expect(tauriMocks.backendAuthSignIn).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api/auth/sign-in/email',
        'admin@example.com',
        'password',
      )
      expect(localStorage.getItem('echolike.v2.authToken')).toBe('signed-desktop-token')
      expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api/desktop/bootstrap',
        APP_VERSION,
        'signed-desktop-token',
      )
    })
    expect(screen.getByText('后台文本 AI')).toBeInTheDocument()
  })

  it('keeps login busy through remount and restores authorization outcome', async () => {
    let resolveSignIn!: (value: { token: string }) => void
    tauriMocks.backendAuthSignIn.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignIn = resolve
      }),
    )
    tauriMocks.fetchDesktopBootstrap.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-07-04T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'owner@example.com',
        plan: 'pro',
        quotaLevel: 3,
        quotaMultiplier: 3,
        adminRole: 'owner',
      },
    })
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })

    const first = renderSettings()
    openTab('AI')
    fireEvent.change(screen.getByPlaceholderText('后台账号邮箱'), {
      target: { value: 'owner@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('后台账号密码'), {
      target: { value: 'secret-never-stored' },
    })
    fireEvent.click(screen.getByRole('button', { name: /登录授权/ }))
    first.unmount()

    renderSettings()
    openTab('AI')
    expect(useAppStore.getState().settingsOperation?.kind).toBe('auth-login')
    expect(screen.getByRole('button', { name: /登录授权/ })).toBeDisabled()
    resolveSignIn({ token: 'signed-desktop-token' })

    await screen.findByText('后台授权已连接。')
    expect(tauriMocks.backendAuthSignIn).toHaveBeenCalledTimes(1)
    expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('后台账号邮箱')).toHaveValue('owner@example.com')
    expect(screen.getByLabelText('后台账号邮箱')).toBeDisabled()
    expect(screen.getByLabelText('授权账号等级')).toHaveValue('Pro · Lv.3 · 3x 月额度')
    expect(screen.getByLabelText('授权账号等级')).toBeDisabled()
    expect(screen.getByRole('tab', { name: /诊断/ })).toBeInTheDocument()
    expect(JSON.stringify(useAppStore.getState())).not.toContain('secret-never-stored')
  })

  it('cancels backend authorization and clears managed config cache', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-04T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        services: {
          llm: { mode: 'proxy', configured: true, displayName: '后台文本 AI' },
        },
      },
    })

    renderSettings()
    openTab('AI')
    expect(screen.getByText('后台文本 AI')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /取消授权/ }))

    await waitFor(() => {
      expect(localStorage.getItem('echolike.v2.authToken')).toBeNull()
      expect(tauriMocks.clearDesktopAuthAuthority).toHaveBeenCalledWith(0, 'desktop-token')
    })
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('后台授权已取消'),
      expect.anything(),
      expect.anything(),
    )
    expect(screen.getAllByText('需授权').length).toBeGreaterThan(0)
    expect(screen.getByText('后台授权已取消，托管配置缓存已清理。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /拉取托管配置/ })).not.toBeInTheDocument()
  })

  it('fails closed and remains retryable when native authorization cleanup fails', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    tauriMocks.clearDesktopAuthAuthority.mockRejectedValueOnce(new Error('cache is locked'))
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-04T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      },
    })

    renderSettings()
    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /取消授权/ }))

    await screen.findByText('本地授权状态清理失败，请重试。')
    expect(localStorage.getItem('echolike.v2.authToken')).toBe('desktop-token')
    expect(useAppStore.getState().desktopBootstrap).toBeNull()
    expect(useAppStore.getState().desktopAuthStatus).toBe('unknown')
    expect(screen.getByLabelText('后台账号邮箱')).toBeEnabled()
    expect(screen.getByRole('button', { name: /取消授权/ })).toBeEnabled()
    expect(screen.queryByText('后台授权已取消，托管配置缓存已清理。')).not.toBeInTheDocument()
    expect(toastMocks.toast).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /取消授权/ }))
    await screen.findByText('后台授权已取消，托管配置缓存已清理。')
    expect(tauriMocks.clearDesktopAuthAuthority).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('echolike.v2.authToken')).toBeNull()
    expect(useAppStore.getState().desktopBootstrap).toBeNull()
    expect(screen.queryByRole('button', { name: /取消授权/ })).not.toBeInTheDocument()
  })

  it('keeps managed-cache cleanup owned across a Settings remount', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    let resolveCleanup!: (value: {
      generation: number
      authorityToken: null
      rawCachedAuthToken: null
      cache: null
    }) => void
    tauriMocks.clearDesktopAuthAuthority.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCleanup = resolve
      }),
    )
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-04T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      },
    })

    const first = renderSettings()
    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /取消授权/ }))
    await waitFor(() => {
      expect(useAppStore.getState().settingsOperation?.kind).toBe('auth-cache-clear')
    })
    first.unmount()

    renderSettings()
    openTab('AI')
    expect(screen.getByRole('button', { name: /取消授权/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /取消授权/ }))
    expect(tauriMocks.clearDesktopAuthAuthority).toHaveBeenCalledTimes(1)

    await act(async () =>
      resolveCleanup({
        generation: 1,
        authorityToken: null,
        rawCachedAuthToken: null,
        cache: null,
      }),
    )
    await screen.findByText('后台授权已取消，托管配置缓存已清理。')
    expect(localStorage.getItem('echolike.v2.authToken')).toBeNull()
    expect(useAppStore.getState().desktopAuthToken).toBeNull()
    expect(screen.getByLabelText('后台账号邮箱')).toBeEnabled()
    expect(screen.queryByRole('button', { name: /取消授权/ })).not.toBeInTheDocument()
  })

  it('keeps the signed-in token unverified when managed bootstrap synchronization fails', async () => {
    tauriMocks.fetchDesktopBootstrap.mockRejectedValueOnce(new Error('backend unavailable'))
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })

    renderSettings()
    openTab('AI')
    fireEvent.change(screen.getByPlaceholderText('后台账号邮箱'), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('后台账号密码'), {
      target: { value: 'password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /登录授权/ }))

    await screen.findByText(/登录凭据已保存，托管身份待同步/)
    expect(localStorage.getItem('echolike.v2.authToken')).toBe('signed-desktop-token')
    expect(screen.queryByText('已授权')).not.toBeInTheDocument()
    expect(screen.getByText('待验证')).toBeInTheDocument()
    expect(screen.getByLabelText('后台账号邮箱')).toBeEnabled()
    expect(screen.getByRole('button', { name: /取消授权/ })).toBeInTheDocument()
    expect(screen.queryByText('后台授权失败。')).not.toBeInTheDocument()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('clears a newly rejected token when bootstrap returns a structured unauthorized error', async () => {
    tauriMocks.fetchDesktopBootstrap.mockRejectedValueOnce(
      new Error(
        JSON.stringify({ status: 401, code: 'unauthorized', message: 'Authentication required' }),
      ),
    )
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })

    renderSettings()
    openTab('AI')
    fireEvent.change(screen.getByPlaceholderText('后台账号邮箱'), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('后台账号密码'), {
      target: { value: 'password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /登录授权/ }))

    await screen.findByText('后台授权已失效，请重新登录。')
    expect(localStorage.getItem('echolike.v2.authToken')).toBeNull()
    expect(tauriMocks.clearDesktopAuthAuthority).toHaveBeenCalledWith(1, 'signed-desktop-token')
    expect(screen.getByLabelText('后台账号邮箱')).toBeEnabled()
    expect(screen.getByLabelText('后台账号密码')).toBeEnabled()
  })

  it('rejects an anonymous bootstrap returned for a bearer instead of reporting refreshed quota', async () => {
    localStorage.setItem('echolike.v2.authToken', 'expired-token')
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      desktopAuthToken: 'expired-token',
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-20T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          email: 'expired@example.com',
          name: null,
          plan: 'pro',
          subscriptionEnd: null,
        },
      },
    })
    tauriMocks.fetchDesktopBootstrap.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-07-21T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
    })

    renderSettings()
    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /刷新额度/ }))

    await screen.findByText('后台授权已失效，请重新登录。')
    const authRow = screen.getByText('账号连接').closest('.echo-setting-line')
    if (!authRow) throw new Error('Backend authorization row not found')
    expect(within(authRow as HTMLElement).getByText('授权过期')).toBeInTheDocument()
    expect(screen.queryByText('已授权')).not.toBeInTheDocument()
    expect(
      within(authRow as HTMLElement)
        .getByText('授权过期')
        .closest('.echo-line-status'),
    ).toBeInTheDocument()
    expect(
      within(authRow as HTMLElement)
        .getByText('授权过期')
        .closest('.echo-badge'),
    ).toHaveClass('echo-badge--warn')
    expect(screen.getByRole('button', { name: '登录授权' })).toBeVisible()
    expect(localStorage.getItem('echolike.v2.authToken')).toBeNull()
    expect(tauriMocks.commitDesktopAuthCandidate).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'expired-token',
    )
    expect(screen.queryByText('全部服务额度已刷新。')).not.toBeInTheDocument()

    openTab('系统')
    const managedConfigPanel = screen
      .getByRole('heading', { name: '托管配置' })
      .closest('.echo-settings-panel')
    if (!managedConfigPanel) throw new Error('Managed config panel not found')
    expect(within(managedConfigPanel as HTMLElement).getByText('授权过期')).toHaveClass(
      'echo-badge--warn',
    )
    expect(within(managedConfigPanel as HTMLElement).getByText('后台托管不可用')).toHaveClass(
      'echo-badge--warn',
    )
    expect(
      within(managedConfigPanel as HTMLElement).getByRole('button', { name: '登录后可拉取' }),
    ).toBeDisabled()
  })

  it('does not let a late bootstrap 401 clear a newer login identity', async () => {
    let rejectOldRefresh!: (reason: Error) => void
    localStorage.setItem('echolike.v2.authToken', 'old-token')
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      desktopBootstrap: {
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
    })
    tauriMocks.fetchDesktopBootstrap.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectOldRefresh = reject
      }),
    )

    renderSettings()
    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /刷新额度/ }))
    await waitFor(() => expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalledTimes(1))

    localStorage.setItem('echolike.v2.authToken', 'new-token')
    useAppStore.setState({
      desktopAuthToken: 'new-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'new-token',
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-21T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          email: 'new@example.com',
          name: null,
          plan: 'pro',
          subscriptionEnd: null,
        },
      },
    })
    await act(async () =>
      rejectOldRefresh(
        new Error(JSON.stringify({ status: 401, code: 'unauthorized', message: 'expired' })),
      ),
    )

    expect(localStorage.getItem('echolike.v2.authToken')).toBe('new-token')
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('new@example.com')
    expect(tauriMocks.clearDesktopAuthAuthority).not.toHaveBeenCalledWith(
      expect.anything(),
      'old-token',
    )
  })

  it('keeps a new login pending verification when its authoritative cache save fails', async () => {
    tauriMocks.fetchDesktopBootstrap.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-07-21T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'admin@example.com',
        name: null,
        plan: 'pro',
        subscriptionEnd: null,
      },
    })
    tauriMocks.commitDesktopAuthCandidate.mockRejectedValueOnce(new Error('native cache locked'))
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })

    renderSettings()
    openTab('AI')
    fireEvent.change(screen.getByPlaceholderText('后台账号邮箱'), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('后台账号密码'), {
      target: { value: 'password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /登录授权/ }))

    await screen.findByText(/登录凭据已保存，但本机授权缓存保存失败/)
    expect(localStorage.getItem('echolike.v2.authToken')).toBe('signed-desktop-token')
    expect(useAppStore.getState().desktopAuthStatus).toBe('unknown')
    expect(screen.getByText('待验证')).toBeInTheDocument()
    expect(screen.queryByText('已授权')).not.toBeInTheDocument()
  })

  it('does not let a stale sign-in rejection clear newer authorization state', async () => {
    let rejectSignIn!: (reason: Error) => void
    tauriMocks.backendAuthSignIn.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectSignIn = reject
      }),
    )
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })

    renderSettings()
    openTab('AI')
    fireEvent.change(screen.getByPlaceholderText('后台账号邮箱'), {
      target: { value: 'old-attempt@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('后台账号密码'), {
      target: { value: 'obsolete-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /登录授权/ }))
    await waitFor(() => expect(tauriMocks.backendAuthSignIn).toHaveBeenCalledTimes(1))

    const staleLease = useAppStore.getState().settingsOperation?.leaseId ?? -1
    useAppStore.getState().finishSettingsOperation(staleLease)
    const currentLease = useAppStore.getState().tryStartSettingsOperation('quota-refresh') ?? -1
    localStorage.setItem('echolike.v2.authToken', 'newer-token')
    useAppStore.setState({
      desktopAuthToken: 'newer-token',
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-20T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      },
    })

    await act(async () => rejectSignIn(new Error('obsolete credentials rejected')))

    expect(localStorage.getItem('echolike.v2.authToken')).toBe('newer-token')
    expect(useAppStore.getState().desktopAuthToken).toBe('newer-token')
    expect(useAppStore.getState().desktopBootstrap?.generatedAt).toBe('2026-07-20T00:00:00.000Z')
    expect(useAppStore.getState().settingsOperation?.leaseId).toBe(currentLease)
  })

  it('does not let an earlier late login overwrite a newer native authority', async () => {
    const initialSnapshot = {
      generation: 4,
      authorityToken: null,
      rawCachedAuthToken: null,
      cache: null,
    }
    const newerBootstrap = {
      schemaVersion: 1,
      generatedAt: '2026-07-30T03:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'newer@example.com',
        name: null,
        plan: 'pro' as const,
        subscriptionEnd: null,
      },
    }
    const newerSnapshot = {
      generation: 5,
      authorityToken: 'newer-token',
      rawCachedAuthToken: 'newer-token',
      cache: {
        packageVersion: APP_VERSION,
        authToken: 'newer-token',
        cachedAt: '2026-07-30T03:00:00.000Z',
        bootstrap: newerBootstrap,
      },
    }
    tauriMocks.loadDesktopAuthSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(newerSnapshot)
    let resolveSignIn!: (value: { token: string }) => void
    tauriMocks.backendAuthSignIn.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignIn = resolve
      }),
    )
    tauriMocks.beginDesktopAuthCandidateForLogin.mockResolvedValueOnce(null)
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })

    renderSettings()
    openTab('AI')
    fireEvent.change(screen.getByPlaceholderText('后台账号邮箱'), {
      target: { value: 'earlier@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('后台账号密码'), {
      target: { value: 'password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /登录授权/ }))
    await act(async () => undefined)
    expect(tauriMocks.backendAuthSignIn).toHaveBeenCalledTimes(1)
    expect(tauriMocks.loadDesktopAuthSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      tauriMocks.backendAuthSignIn.mock.invocationCallOrder[0],
    )

    localStorage.setItem('echolike.v2.authToken', 'newer-token')
    useAppStore.setState({
      desktopAuthToken: 'newer-token',
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: 'newer-token',
      desktopAuthSnapshot: newerSnapshot,
      desktopBootstrap: newerBootstrap,
    })
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = useAppStore.subscribe((state) => {
        if (
          state.settingsOperation === null &&
          state.settingsNotices['backend-auth']?.text === '登录状态已变化，请重试。'
        ) {
          unsubscribe()
          resolve()
        }
      })
    })
    await act(async () => {
      resolveSignIn({ token: 'earlier-late-token' })
      await settled
    })

    expect(tauriMocks.beginDesktopAuthCandidateForLogin).toHaveBeenCalledWith(
      4,
      null,
      'earlier-late-token',
    )
    expect(localStorage.getItem('echolike.v2.authToken')).toBe('newer-token')
    expect(useAppStore.getState().desktopAuthSnapshot?.generation).toBe(5)
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('newer@example.com')
  })

  it('localizes backend auth origin errors', async () => {
    tauriMocks.backendAuthSignIn.mockRejectedValueOnce(new Error('Invalid origin'))
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    renderSettings()
    openTab('AI')

    fireEvent.change(screen.getByPlaceholderText('后台账号邮箱'), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('后台账号密码'), {
      target: { value: 'password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /登录授权/ }))

    await screen.findByText('后台未允许当前客户端连接，请更新客户端或联系管理员。')
    const configPanel = screen
      .getByRole('heading', { name: '配置来源' })
      .closest('.echo-settings-panel')
    const authPanel = screen
      .getByRole('heading', { name: '后台授权' })
      .closest('.echo-settings-panel')
    if (!configPanel || !authPanel) throw new Error('Backend auth layout not found')
    expect(configPanel).not.toHaveTextContent(
      '后台未允许当前客户端连接，请更新客户端或联系管理员。',
    )
    expect(authPanel.querySelector('.echo-panel-alert')).toHaveTextContent(
      '后台未允许当前客户端连接，请更新客户端或联系管理员。',
    )
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      '后台未允许当前客户端连接，请更新客户端或联系管理员。',
      'error',
      { key: 'settings:auth' },
    )
    expect(tauriMocks.fetchDesktopBootstrap).not.toHaveBeenCalledWith(
      expect.stringContaining('/desktop/bootstrap'),
      expect.any(String),
      expect.any(String),
    )
    cleanup()
    renderSettings()
    openTab('AI')
    expect(
      screen.getByText('后台未允许当前客户端连接，请更新客户端或联系管理员。'),
    ).toBeInTheDocument()
  })

  it('replaces an obsolete managed-config error with the actionable auth error', () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })
    useAppStore
      .getState()
      .publishSettingsNotice('managed-config', 'error', '请先连接后台账号，再拉取托管配置。')
    const leaseId = useAppStore.getState().tryStartSettingsOperation('auth-login') ?? -1
    useAppStore.getState().failSettingsAuth(leaseId, '后台账号或密码不正确，请检查后重试。')

    renderSettings()
    openTab('AI')

    const configPanel = screen
      .getByRole('heading', { name: '配置来源' })
      .closest('.echo-settings-panel')
    const authPanel = screen
      .getByRole('heading', { name: '后台授权' })
      .closest('.echo-settings-panel')
    if (!configPanel || !authPanel) throw new Error('Backend auth panels not found')
    expect(configPanel.querySelector('.echo-panel-alert')).toBeNull()
    expect(authPanel.querySelector('.echo-panel-alert')).toHaveTextContent(
      '后台账号或密码不正确，请检查后重试。',
    )
    expect(configPanel).not.toHaveTextContent('请先连接后台账号，再拉取托管配置。')
  })

  it('manually syncs non-sensitive backend policy without a desktop token', async () => {
    tauriMocks.fetchDesktopBootstrap.mockResolvedValueOnce({
      schemaVersion: 1,
      generatedAt: '2026-07-04T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
    })
    renderSettings()

    openTab('系统')
    expect(screen.getByRole('heading', { name: '后台状态' })).toBeInTheDocument()
    expect(screen.getByText('本机配置生效')).toBeInTheDocument()
    expect(screen.getByText('未获取')).toBeInTheDocument()
    expect(screen.queryByText('后台服务优先')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /刷新后台状态/ }))

    await waitFor(() => {
      expect(tauriMocks.fetchDesktopBootstrap).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api/desktop/bootstrap',
        APP_VERSION,
        null,
      )
    })
    expect(tauriMocks.beginDesktopAuthCandidate).toHaveBeenCalledWith(0, null)
    expect(tauriMocks.commitDesktopAuthCandidate).toHaveBeenCalledWith(
      1,
      null,
      null,
      expect.anything(),
    )
    expect(screen.getByText('后台状态已获取')).toBeInTheDocument()
    expect(screen.getByText('后台状态已刷新，本机配置仍生效。')).toBeInTheDocument()
    expect(screen.queryByText('账号配置已同步。')).not.toBeInTheDocument()
    expect(useAppStore.getState().config.config_source).toBe('local')
  })

  it('never lets proxy entitlement masquerade as the selected config source', () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'local' },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-31T12:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        policy: {
          preferProxy: true,
          allowDirectProviderKeys: false,
          allowByok: true,
          allowLocalModels: true,
          remoteConfigDelivery: 'startup',
          activation: 'next_start',
          backgroundPolling: false,
        },
      },
    })
    renderSettings()
    openTab('系统')

    expect(screen.getByRole('heading', { name: '后台状态' })).toBeInTheDocument()
    expect(screen.getByText('本机配置生效')).toBeInTheDocument()
    expect(screen.getByText('后台状态已获取')).toBeInTheDocument()
    expect(screen.queryByText('后台服务优先')).not.toBeInTheDocument()

    cleanup()
    resetStore()
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-31T12:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        policy: {
          preferProxy: false,
          allowDirectProviderKeys: false,
          allowByok: true,
          allowLocalModels: true,
          remoteConfigDelivery: 'startup',
          activation: 'next_start',
          backgroundPolling: false,
        },
      },
    })
    renderSettings()
    openTab('系统')

    expect(screen.getByRole('heading', { name: '托管配置' })).toBeInTheDocument()
    const managedConfigPanel = screen
      .getByRole('heading', { name: '托管配置' })
      .closest('.echo-settings-panel')
    if (!managedConfigPanel) throw new Error('Managed config panel not found')
    expect(within(managedConfigPanel as HTMLElement).getByText('公共状态已获取')).toHaveClass(
      'echo-badge--neutral',
    )
    expect(within(managedConfigPanel as HTMLElement).getByText('等待登录授权')).toHaveClass(
      'echo-badge--neutral',
    )
    expect(
      within(managedConfigPanel as HTMLElement).getByRole('button', { name: '登录后可拉取' }),
    ).toBeDisabled()
    expect(within(managedConfigPanel as HTMLElement).queryByText('后台托管生效')).toBeNull()
    expect(within(managedConfigPanel as HTMLElement).queryByText('已同步')).toBeNull()
    expect(screen.queryByText('本机配置优先')).not.toBeInTheDocument()
  })
})
