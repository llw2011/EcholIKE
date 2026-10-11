import { describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useAppStore } from '../../../stores/appStore'
import {
  installControlPanelTestHarness,
  tauriMocks,
  toastMocks,
  renderSettings,
  openTab,
} from './controlPanelTestHarness'

describe('ControlPanel', () => {
  installControlPanelTestHarness()

  it('persists system settings immediately without a footer save button', async () => {
    renderSettings()

    openTab('系统')
    expect(screen.queryByRole('button', { name: /保存设置/ })).not.toBeInTheDocument()

    const trayRow = screen.getByText('系统托盘').closest('.echo-setting-line')
    if (!trayRow) throw new Error('System tray setting row not found')
    expect(trayRow).toHaveClass('echo-setting-line--tail-control')
    fireEvent.click(within(trayRow as HTMLElement).getByRole('button'))

    await waitFor(() => {
      expect(tauriMocks.updateConfig).toHaveBeenCalled()
    })
  })

  it('persists app-level network proxy settings from the system tab', async () => {
    renderSettings()

    openTab('系统')
    const proxyRow = screen.getByText('应用内代理').closest('.echo-setting-line')
    if (!proxyRow) throw new Error('Network proxy row not found')

    fireEvent.click(within(proxyRow as HTMLElement).getByRole('button'))
    fireEvent.change(screen.getByRole('combobox', { name: '代理类型' }), {
      target: { value: 'socks5' },
    })
    fireEvent.change(screen.getByLabelText('代理地址'), { target: { value: '127.0.0.1' } })
    fireEvent.change(screen.getByLabelText('代理端口'), { target: { value: '1080' } })
    fireEvent.change(screen.getByPlaceholderText('localhost,127.0.0.1,10.0.0.0/8'), {
      target: { value: 'localhost,127.0.0.1,internal.example.com' },
    })

    await waitFor(() => {
      expect(useAppStore.getState().config).toEqual(
        expect.objectContaining({
          network_proxy_enabled: true,
          network_proxy_url: 'socks5://127.0.0.1:1080',
          network_proxy_bypass: 'localhost,127.0.0.1,internal.example.com',
        }),
      )
      expect(tauriMocks.updateConfig).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          network_proxy_enabled: true,
          network_proxy_url: 'socks5://127.0.0.1:1080',
          network_proxy_bypass: 'localhost,127.0.0.1,internal.example.com',
        }),
      )
    })
  })

  it('routes delayed config persistence failures back to the owning panel without a toast', async () => {
    let rejectPersist!: (reason: Error) => void
    tauriMocks.updateConfig.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectPersist = reject
      }),
    )
    renderSettings()
    openTab('系统')

    const trayRow = screen.getByText('系统托盘').closest('.echo-setting-line')
    if (!trayRow) throw new Error('System tray row not found')
    fireEvent.click(within(trayRow as HTMLElement).getByRole('button'))
    openTab('关于')
    await act(async () => rejectPersist(new Error('config file is read only')))

    expect(useAppStore.getState().settingsNotices['startup-tray']).toMatchObject({
      phase: 'error',
      text: '设置保存失败。',
      seenAt: null,
    })
    expect(toastMocks.toast).not.toHaveBeenCalled()

    openTab('系统')
    const startupPanel = screen
      .getByRole('heading', { name: '启动与托盘' })
      .closest('.echo-settings-panel')
    expect(startupPanel?.querySelector('.echo-panel-alert')).toHaveTextContent('设置保存失败。')
    expect(startupPanel).not.toHaveTextContent('config file is read only')
  })

  it('commits only a command-backed patch while a queued config write survives remount', async () => {
    const baseConfig = {
      ...useAppStore.getState().config,
      auto_start: false,
      close_to_tray: false,
    }
    useAppStore.setState({ config: baseConfig, savedConfig: baseConfig })

    let resolvePersist!: (value: typeof baseConfig) => void
    tauriMocks.updateConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePersist = resolve
      }),
    )

    const first = renderSettings()
    openTab('系统')
    const firstTrayRow = screen.getByText('系统托盘').closest('.echo-setting-line')
    if (!firstTrayRow) throw new Error('System tray row not found')
    fireEvent.click(within(firstTrayRow as HTMLElement).getByRole('button'))
    await waitFor(() => expect(tauriMocks.updateConfig).toHaveBeenCalledTimes(1))
    first.unmount()

    renderSettings()
    openTab('系统')
    const autoStartRow = screen.getByText('开机启动').closest('.echo-setting-line')
    if (!autoStartRow) throw new Error('Auto-start row not found after remount')
    fireEvent.click(within(autoStartRow as HTMLElement).getByRole('button'))

    await waitFor(() => {
      expect(tauriMocks.setAutoStart).toHaveBeenCalledWith(true)
      expect(useAppStore.getState().savedConfig).toEqual(
        expect.objectContaining({ auto_start: true, close_to_tray: false }),
      )
    })
    expect(useAppStore.getState().config).toEqual(
      expect.objectContaining({ auto_start: true, close_to_tray: true }),
    )

    await act(async () => resolvePersist({ ...baseConfig, auto_start: true, close_to_tray: true }))
    await waitFor(() => {
      expect(useAppStore.getState().savedConfig).toEqual(
        expect.objectContaining({ auto_start: true, close_to_tray: true }),
      )
    })
  })

  it('serializes config persistence across a Settings remount and only commits the latest baseline', async () => {
    const baseConfig = {
      ...useAppStore.getState().config,
      close_to_tray: false,
    }
    useAppStore.setState({ config: baseConfig, savedConfig: baseConfig })

    let resolveFirst!: (value: typeof baseConfig) => void
    let resolveSecond!: (value: typeof baseConfig) => void
    tauriMocks.updateConfig
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
      )

    const first = renderSettings()
    openTab('系统')
    const firstTrayRow = screen.getByText('系统托盘').closest('.echo-setting-line')
    if (!firstTrayRow) throw new Error('System tray row not found')
    fireEvent.click(within(firstTrayRow as HTMLElement).getByRole('button'))
    await waitFor(() => expect(tauriMocks.updateConfig).toHaveBeenCalledTimes(1))
    first.unmount()

    renderSettings()
    openTab('系统')
    const secondTrayRow = screen.getByText('系统托盘').closest('.echo-setting-line')
    if (!secondTrayRow) throw new Error('System tray row not found after remount')
    fireEvent.click(within(secondTrayRow as HTMLElement).getByRole('button'))

    await act(async () => Promise.resolve())
    expect(tauriMocks.updateConfig).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().savedConfig?.close_to_tray).toBe(false)

    await act(async () => resolveFirst({ ...baseConfig, close_to_tray: true }))
    await waitFor(() => expect(tauriMocks.updateConfig).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().savedConfig?.close_to_tray).toBe(false)

    await act(async () => resolveSecond({ ...baseConfig, close_to_tray: false }))
    await waitFor(() => {
      expect(useAppStore.getState().savedConfig?.close_to_tray).toBe(false)
      expect(useAppStore.getState().config.close_to_tray).toBe(false)
    })
  })

  it('suppresses a superseded persistence failure after remount when the newer write succeeds', async () => {
    const baseConfig = {
      ...useAppStore.getState().config,
      close_to_tray: false,
    }
    useAppStore.setState({ config: baseConfig, savedConfig: baseConfig })

    let rejectFirst!: (reason: Error) => void
    tauriMocks.updateConfig
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectFirst = reject
        }),
      )
      .mockImplementationOnce(async (_base, next) => next)

    const first = renderSettings()
    openTab('系统')
    const firstTrayRow = screen.getByText('系统托盘').closest('.echo-setting-line')
    if (!firstTrayRow) throw new Error('System tray row not found')
    fireEvent.click(within(firstTrayRow as HTMLElement).getByRole('button'))
    await waitFor(() => expect(tauriMocks.updateConfig).toHaveBeenCalledTimes(1))
    first.unmount()

    renderSettings()
    openTab('系统')
    const secondTrayRow = screen.getByText('系统托盘').closest('.echo-setting-line')
    if (!secondTrayRow) throw new Error('System tray row not found after remount')
    fireEvent.click(within(secondTrayRow as HTMLElement).getByRole('button'))

    await act(async () => rejectFirst(new Error('obsolete config write failed')))
    await waitFor(() => expect(tauriMocks.updateConfig).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useAppStore.getState().savedConfig?.close_to_tray).toBe(false))

    expect(useAppStore.getState().settingsNotices['startup-tray']).toBeUndefined()
    expect(screen.queryByText('obsolete config write failed')).not.toBeInTheDocument()
  })

  it('routes command-backed setting failures to the same owning panel', async () => {
    tauriMocks.setAutoStart.mockRejectedValueOnce(new Error('startup permission denied'))
    renderSettings()
    openTab('系统')

    const autoStartRow = screen.getByText('开机启动').closest('.echo-setting-line')
    if (!autoStartRow) throw new Error('Auto-start row not found')
    fireEvent.click(within(autoStartRow as HTMLElement).getByRole('button'))

    await waitFor(() => {
      expect(useAppStore.getState().settingsNotices['startup-tray']).toMatchObject({
        phase: 'error',
        text: '当前账号没有使用该功能的权限，请联系管理员确认授权。',
      })
    })
    const startupPanel = screen
      .getByRole('heading', { name: '启动与托盘' })
      .closest('.echo-settings-panel')
    expect(startupPanel?.querySelector('.echo-panel-alert')).toHaveTextContent(
      '当前账号没有使用该功能的权限，请联系管理员确认授权。',
    )
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('can fill the app proxy from the current system HTTP proxy', async () => {
    tauriMocks.detectSystemHttpProxy.mockResolvedValueOnce('http://10.0.0.2:7897')
    renderSettings()

    openTab('系统')
    fireEvent.click(screen.getByRole('button', { name: /使用当前系统 HTTP 代理/ }))

    await waitFor(() => {
      expect(tauriMocks.detectSystemHttpProxy).toHaveBeenCalled()
      expect(useAppStore.getState().config).toEqual(
        expect.objectContaining({
          network_proxy_enabled: true,
          network_proxy_url: 'http://10.0.0.2:7897',
        }),
      )
      expect(tauriMocks.updateConfig).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          network_proxy_enabled: true,
          network_proxy_url: 'http://10.0.0.2:7897',
        }),
      )
    })
    const proxyPanel = screen
      .getByRole('heading', { name: '网络代理' })
      .closest('.echo-settings-panel')
    expect(proxyPanel?.querySelectorAll('.echo-panel-alert')).toHaveLength(1)
    expect(proxyPanel?.querySelector('.echo-panel-alert')).toHaveTextContent(
      '已使用系统代理：http://10.0.0.2:7897',
    )
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('已使用系统代理'),
      expect.anything(),
      expect.anything(),
    )
  })

  it('does not report system-proxy success before the detected proxy is persisted', async () => {
    let rejectPersist!: (reason: Error) => void
    tauriMocks.detectSystemHttpProxy.mockResolvedValueOnce('http://10.0.0.2:7897')
    tauriMocks.updateConfig.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectPersist = reject
      }),
    )

    renderSettings()
    openTab('系统')
    toastMocks.toast.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /使用当前系统 HTTP 代理/ }))

    await waitFor(() => expect(tauriMocks.updateConfig).toHaveBeenCalled())
    expect(useAppStore.getState().settingsOperation?.kind).toBe('system-proxy')
    expect(useAppStore.getState().settingsNotices['network-proxy']).toBeUndefined()
    expect(screen.queryByText(/已使用系统代理/)).not.toBeInTheDocument()

    await act(async () => rejectPersist(new Error('proxy config persistence failed')))
    await waitFor(() => {
      expect(useAppStore.getState().settingsOperation).toBeNull()
      expect(useAppStore.getState().settingsNotices['network-proxy']?.phase).toBe('error')
    })

    const panel = screen.getByRole('heading', { name: '网络代理' }).closest('.echo-settings-panel')
    expect(panel?.querySelector('.echo-panel-alert')).toHaveClass('echo-panel-alert--warn')
    expect(panel).not.toHaveTextContent('已使用系统代理：')
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('restores pending system proxy detection across remount and applies it once', async () => {
    let resolveProxy!: (proxy: string) => void
    tauriMocks.detectSystemHttpProxy.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProxy = resolve
      }),
    )
    const first = renderSettings()
    openTab('系统')
    fireEvent.click(screen.getByRole('button', { name: /使用当前系统 HTTP 代理/ }))
    await waitFor(() => expect(tauriMocks.detectSystemHttpProxy).toHaveBeenCalledTimes(1))
    first.unmount()

    renderSettings()
    openTab('系统')
    const button = screen.getByRole('button', { name: /使用当前系统 HTTP 代理/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(tauriMocks.detectSystemHttpProxy).toHaveBeenCalledTimes(1)
    resolveProxy('http://10.0.0.9:7897')
    await screen.findByText('已使用系统代理：http://10.0.0.9:7897')
    expect(useAppStore.getState().config).toEqual(
      expect.objectContaining({
        network_proxy_enabled: true,
        network_proxy_url: 'http://10.0.0.9:7897',
      }),
    )
  })
})
