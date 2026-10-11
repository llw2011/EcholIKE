import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
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

  it('uses the shared fourteen-segment recording meter', () => {
    renderSettings()
    openTab('麦克风')

    const meter = screen.getByRole('meter', { name: '实时输入电平' })
    expect(meter.children).toHaveLength(14)
    expect(meter.querySelectorAll('.is-active')).toHaveLength(0)

    act(() => {
      useAppStore.getState().setPipelineState('recording')
      useAppStore.getState().setAudioVolume(0.5)
    })

    expect(meter.querySelectorAll('.is-active')).toHaveLength(7)
  })

  it('renders the control tabs', () => {
    renderSettings()

    expect(screen.getByRole('tab', { name: /快捷键/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /麦克风/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^AI$/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /系统/ })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /诊断/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /状态/ })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /关于/ })).toBeInTheDocument()
    expect(screen.queryByText('业务能力来源')).not.toBeInTheDocument()
  })

  it('opens the about tab from the settings hash', () => {
    renderSettings()

    window.location.hash = '#/settings/about'
    fireEvent(window, new HashChangeEvent('hashchange'))

    expect(screen.getByRole('tab', { name: /关于/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: '关于' })).toBeInTheDocument()
  })

  it('starts a settings notice timeout only when its owning panel is first visible', () => {
    vi.useFakeTimers()
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })
    renderSettings()

    act(() => {
      useAppStore
        .getState()
        .publishSettingsNotice('backend-auth', 'error', '后台账号或密码不正确。')
      vi.advanceTimersByTime(20_000)
    })
    expect(useAppStore.getState().settingsNotices['backend-auth']?.seenAt).toBeNull()

    openTab('AI')
    expect(screen.getByText('后台账号或密码不正确。')).toBeInTheDocument()
    expect(useAppStore.getState().settingsNotices['backend-auth']?.seenAt).not.toBeNull()

    act(() => vi.advanceTimersByTime(7_999))
    expect(screen.getByText('后台账号或密码不正确。')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByText('后台账号或密码不正确。')).not.toBeInTheDocument()
  })

  it('does not consume a notice while its local or backend panel branch is absent', () => {
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })
    useAppStore.getState().publishSettingsNotice('stt', 'error', '本机 STT 失败。')
    renderSettings()
    openTab('麦克风')
    expect(screen.queryByText('本机 STT 失败。')).not.toBeInTheDocument()
    expect(useAppStore.getState().settingsNotices.stt?.seenAt).toBeNull()

    cleanup()
    resetStore()
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'local' },
    })
    useAppStore.getState().publishSettingsNotice('tts', 'error', '后台 TTS 失败。')
    renderSettings()
    openTab('AI')
    expect(screen.queryByText('后台 TTS 失败。')).not.toBeInTheDocument()
    expect(useAppStore.getState().settingsNotices.tts?.seenAt).toBeNull()
  })

  it('starts hotkey capture and updates the shortcut', async () => {
    const savedConfig = {
      ...useAppStore.getState().config,
      close_to_tray: false,
    }
    useAppStore.setState({
      savedConfig,
      config: { ...savedConfig, close_to_tray: true },
    })
    renderSettings()

    const inputRow = screen.getByText('快速输入键').closest('.echo-setting-line')
    if (!inputRow) throw new Error('Input hotkey row not found')
    fireEvent.click(within(inputRow as HTMLElement).getByRole('button', { name: '更改' }))
    expect(tauriMocks.pauseHotkey).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      expect(tauriMocks.updateHotkey).toHaveBeenCalledWith('Ctrl+Shift+K')
    })
    expect(screen.getByText('Ctrl+Shift+K')).toBeInTheDocument()
    await waitFor(() => {
      expect(useAppStore.getState().savedConfig).toEqual(
        expect.objectContaining({
          hotkey: 'Ctrl+Shift+K',
          close_to_tray: false,
        }),
      )
    })
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('reports shortcut conflicts and registration failures in the trigger-key panel', async () => {
    renderSettings()

    const triggerPanel = screen
      .getByRole('heading', { name: '触发键' })
      .closest('.echo-settings-panel')
    const inputRow = screen.getByText('快速输入键').closest('.echo-setting-line')
    if (!triggerPanel || !inputRow) throw new Error('Trigger-key panel not found')

    fireEvent.click(within(inputRow as HTMLElement).getByRole('button', { name: '更改' }))
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true, shiftKey: true })
    expect(triggerPanel.querySelector('.echo-panel-alert')).toHaveTextContent(
      '看窗口快捷键和快速输入键不能相同。',
    )
    expect(toastMocks.toast).not.toHaveBeenCalled()

    tauriMocks.updateHotkey.mockRejectedValueOnce(new Error('native shortcut conflict'))
    fireEvent.click(within(inputRow as HTMLElement).getByRole('button', { name: '更改' }))
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      expect(triggerPanel.querySelector('.echo-panel-alert')).toHaveTextContent('快捷键注册失败。')
    })
    expect(triggerPanel).not.toHaveTextContent('native shortcut conflict')
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('captures and updates the window OCR shortcut independently', async () => {
    renderSettings()

    expect(screen.getByText('Ctrl+Shift+O')).toBeInTheDocument()
    const readWindowRow = screen.getByText('看窗口快捷键').closest('.echo-setting-line')
    if (!readWindowRow) throw new Error('Read-window hotkey row not found')
    fireEvent.click(within(readWindowRow as HTMLElement).getByRole('button', { name: '更改' }))

    fireEvent.keyDown(window, { key: 'o', altKey: true, shiftKey: true })

    await waitFor(() => {
      expect(tauriMocks.updateScreenOcrHotkey).toHaveBeenCalledWith('Alt+Shift+O')
    })
    expect(tauriMocks.updateHotkey).not.toHaveBeenCalled()
  })

  it('updates real theme profile and capsule style settings', () => {
    renderSettings()

    openTab('系统')
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.className.includes('echo-capsule-style-card')),
    ).toHaveLength(8)
    expect(document.querySelectorAll('.echo-capsule-skin--preview')).toHaveLength(9)
    expect(document.querySelector('.echo-capsule-skin--preview-current')).toHaveAttribute(
      'data-capsule-style',
      'classic',
    )

    fireEvent.click(screen.getByRole('button', { name: /Linear/ }))
    fireEvent.click(screen.getByRole('button', { name: /Pulse/ }))
    expect(useAppStore.getState().config.capsule_style).toBe('pulse')
    expect(document.querySelector('.echo-capsule-skin--preview-current')).toHaveAttribute(
      'data-capsule-style',
      'pulse',
    )
    fireEvent.click(screen.getByRole('button', { name: /Orbit/ }))
    expect(useAppStore.getState().config.capsule_style).toBe('orbit')
    fireEvent.click(screen.getByRole('button', { name: /Ink/ }))

    expect(useAppStore.getState().config.theme_profile).toBe('linear')
    expect(useAppStore.getState().config.capsule_style).toBe('ink')
    expect(document.body.textContent).not.toMatch(/待补全/)
  })

  it('keeps the about page focused on summary, updates, and license', () => {
    renderSettings()

    openTab('关于')
    expect(screen.getByRole('heading', { name: '关于' })).toBeInTheDocument()
    expect(screen.getByText(/EcholIKE 用快捷键完成语音输入/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'OTA 更新检测' })).not.toBeInTheDocument()
    expect(screen.getByText('版本更新')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /检查更新/ })).toHaveLength(1)
    const updateCard = document.querySelector('.echo-about-update-card')
    expect(updateCard).toBeTruthy()
    expect(within(updateCard as HTMLElement).getByText('版本更新')).toBeInTheDocument()
    expect(updateCard?.querySelector('.echo-about-update-result')).toBeNull()
    const aboutCard = document.querySelector('.echo-about-card')
    expect(aboutCard?.querySelector('.echo-about-mark')).toBeNull()
    expect(aboutCard?.querySelector('strong')).toBeNull()
    expect(screen.queryByText('EcholIKE')).not.toBeInTheDocument()
    expect(screen.queryByText(/灾后重建版本/)).not.toBeInTheDocument()
    expect(screen.queryByText('更新检测地址')).not.toBeInTheDocument()
    expect(screen.queryByText('版权与许可')).not.toBeInTheDocument()
    expect(screen.queryByText('版权归属')).not.toBeInTheDocument()
    expect(screen.queryByText('🐉 with Codex')).not.toBeInTheDocument()
    expect(screen.queryByText('禁止')).not.toBeInTheDocument()
    expect(screen.queryByText(/不得出售、转售、托管收费/)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Copyright © 2026 EcholIKE Rebuild Contributors. AGPL-3.0-only；第三方许可见 NOTICE。',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('版权属性')).not.toBeInTheDocument()
    expect(screen.queryByText('使用范围')).not.toBeInTheDocument()
  })

  it('does not expose realtime translation until the runtime chain exists', () => {
    renderSettings()

    openTab('AI')

    expect(screen.getByText('结束后翻译')).toBeInTheDocument()
    expect(screen.queryByText('实时翻译')).not.toBeInTheDocument()
  })

  it('does not surface the removed login/upgrade flow', () => {
    renderSettings()
    expect(document.body.textContent).not.toMatch(/登录|验证|升级|Pro/)
  })
})
