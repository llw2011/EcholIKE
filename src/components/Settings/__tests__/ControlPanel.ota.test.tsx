import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { APP_VERSION } from '../../../lib/branding'
import { OTA_MANUAL_CHECK_COOLDOWN_MS, useAppStore } from '../../../stores/appStore'
import {
  installControlPanelTestHarness,
  tauriMocks,
  toastMocks,
  renderSettings,
  openTab,
} from './controlPanelTestHarness'

describe('ControlPanel', () => {
  installControlPanelTestHarness()

  it('runs one OTA check when the tray requests the About page update action', async () => {
    window.location.hash = '#/settings/about?check-update=1'
    renderSettings()

    await waitFor(() => {
      expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(1)
    })

    expect(window.location.hash).toBe('#/settings/about')
    expect(screen.getByRole('heading', { name: '关于' })).toBeInTheDocument()
  })

  it('blocks consecutive tray checks until the shared cooldown expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))
    tauriMocks.checkOtaUpdate
      .mockResolvedValueOnce({
        appName: 'EcholIKE',
        currentVersion: APP_VERSION,
        latestVersion: APP_VERSION,
        autoUpdate: true,
        updateAvailable: false,
        forceUpdate: false,
        downloadUrl: null,
        sha256: null,
        releaseNotes: null,
        message: 'You are on the latest version.',
        checkedAt: '2026-08-20T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        appName: 'EcholIKE',
        currentVersion: APP_VERSION,
        latestVersion: '9.9.9',
        autoUpdate: true,
        updateAvailable: true,
        forceUpdate: false,
        downloadUrl: null,
        sha256: null,
        releaseNotes: null,
        message: 'Update available.',
        checkedAt: '2026-08-20T00:01:00.000Z',
      })

    window.location.hash = '#/settings/about?check-update=1&request=first-tray-check'
    renderSettings()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /稍后可重试/ })).toBeDisabled()
    expect(window.location.hash).toBe('#/settings/about')

    act(() => {
      window.history.replaceState(
        window.history.state,
        '',
        '#/settings/about?check-update=1&request=second-tray-check',
      )
      fireEvent(window, new HashChangeEvent('hashchange'))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('#/settings/about')

    act(() => {
      vi.advanceTimersByTime(OTA_MANUAL_CHECK_COOLDOWN_MS - 1)
    })
    expect(screen.getByRole('button', { name: /稍后可重试/ })).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('button', { name: /重新检查/ })).toBeEnabled()

    act(() => {
      window.history.replaceState(
        window.history.state,
        '',
        '#/settings/about?check-update=1&request=third-tray-check',
      )
      fireEvent(window, new HashChangeEvent('hashchange'))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /立即重启更新/ })).toBeEnabled()
    expect(window.location.hash).toBe('#/settings/about')
  })

  it('checks OTA update policy from the backend', async () => {
    tauriMocks.downloadAndInstallOtaUpdate.mockImplementationOnce(
      async (
        _updateUrl: string,
        _currentVersion: string,
        _proxyUrl?: string,
        onProgress?: (progress: {
          phase: 'checking' | 'downloading' | 'installing' | 'relaunching'
          downloadedBytes: number
          totalBytes: number | null
          percent: number | null
        }) => void,
        beforeRelaunch?: (result: any) => Promise<boolean> | boolean,
      ) => {
        onProgress?.({
          phase: 'downloading',
          downloadedBytes: 50,
          totalBytes: 100,
          percent: 50,
        })
        const result = {
          filePath: 'tauri-updater',
          latestVersion: '0.2.0',
          sha256: null,
          sha256Verified: false,
        }
        await beforeRelaunch?.(result)
        return result
      },
    )
    renderSettings()
    openTab('关于')

    expect(screen.queryByRole('heading', { name: 'OTA 更新检测' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /检查更新/ }))

    await waitFor(() => {
      expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api/app/update',
        APP_VERSION,
      )
    })
    const updateCard = document.querySelector('.echo-about-update-card')
    expect(updateCard).toBeTruthy()
    expect(screen.queryByText('检测到必须安装的新版本。')).not.toBeInTheDocument()
    expect(within(updateCard as HTMLElement).getByText('自动开 · 强制开')).toBeInTheDocument()
    expect(
      within(updateCard as HTMLElement).getByText(`v${APP_VERSION} -> v0.2.0 · 强制`),
    ).toBeInTheDocument()
    expect(screen.queryByText('https://example.com/EcholIKE-0.2.0.exe')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /立即重启更新/ }))
    await waitFor(() => {
      expect(tauriMocks.downloadAndInstallOtaUpdate).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api/app/update',
        APP_VERSION,
        undefined,
        expect.any(Function),
        expect.any(Function),
      )
    })
    expect(
      within(updateCard as HTMLElement).getByText(`v${APP_VERSION} -> v0.2.0 · 待重启`),
    ).toBeInTheDocument()
    expect(within(updateCard as HTMLElement).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('keeps one updater transaction and restores progress and errors after remount', async () => {
    let progress: ((value: any) => void) | undefined
    let rejectDownload: ((reason: Error) => void) | undefined
    tauriMocks.downloadAndInstallOtaUpdate.mockImplementationOnce(
      async (_url: string, _version: string, _proxy: string | undefined, onProgress: any) => {
        progress = onProgress
        return await new Promise((_, reject) => {
          rejectDownload = reject
        })
      },
    )

    const first = renderSettings()
    openTab('关于')
    fireEvent.click(screen.getByRole('button', { name: /检查更新/ }))
    await screen.findByRole('button', { name: /立即重启更新/ })
    fireEvent.click(screen.getByRole('button', { name: /立即重启更新/ }))
    fireEvent.click(screen.getByRole('button', { name: /更新中/ }))
    await waitFor(() => expect(tauriMocks.downloadAndInstallOtaUpdate).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem('echolike.v2.pendingUpdate')).toBeNull()

    progress?.({
      phase: 'downloading',
      downloadedBytes: 40,
      totalBytes: 100,
      percent: 40,
    })
    first.unmount()
    renderSettings()
    openTab('关于')

    expect(screen.getByRole('button', { name: /更新中/ })).toBeDisabled()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    fireEvent.click(screen.getByRole('button', { name: /更新中/ }))
    expect(tauriMocks.downloadAndInstallOtaUpdate).toHaveBeenCalledTimes(1)

    rejectDownload?.(new Error('updater connection lost'))
    expect(await screen.findByText('更新下载失败。')).toBeInTheDocument()
    const updateCard = document.querySelector('.echo-about-update-card')
    const aboutHeader = screen
      .getByRole('heading', { name: '关于' })
      .closest('.echo-settings-panel-header')
    expect(within(updateCard as HTMLElement).getByText('更新下载失败。')).toBeInTheDocument()
    expect(aboutHeader).not.toHaveTextContent('更新下载失败。')
    expect(document.body.textContent).not.toContain('updater connection lost')
    expect(useAppStore.getState().otaTask).toMatchObject({
      status: 'error',
      leaseId: null,
      error: '更新下载失败。',
    })
  })

  it('keeps one pending update check across remount and restores its outcome', async () => {
    let resolveCheck: ((value: any) => void) | undefined
    tauriMocks.checkOtaUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve
        }),
    )
    const first = renderSettings()
    openTab('关于')
    const checking = screen.getByRole('button', { name: /检查更新/ })
    fireEvent.click(checking)
    fireEvent.click(checking)
    await waitFor(() => expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(1))
    first.unmount()

    renderSettings()
    openTab('关于')
    expect(screen.getByRole('button', { name: /检查中/ })).toBeDisabled()
    resolveCheck?.({
      appName: 'EcholIKE',
      currentVersion: APP_VERSION,
      latestVersion: '0.2.0',
      autoUpdate: true,
      updateAvailable: true,
      forceUpdate: false,
      downloadUrl: null,
      sha256: null,
      releaseNotes: null,
      message: 'available',
      checkedAt: '2026-07-12T00:00:00.000Z',
    })
    expect(await screen.findByRole('button', { name: /立即重启更新/ })).toBeEnabled()
    expect(screen.getByText(`v${APP_VERSION} -> v0.2.0 · 可更新`)).toBeInTheDocument()
  })

  it('keeps stale OTA progress, resolve and reject silent', async () => {
    let onProgress: ((value: any) => void) | undefined
    let beforeRelaunch: ((result: any) => Promise<boolean> | boolean) | undefined
    let rejectOld: ((reason: Error) => void) | undefined
    tauriMocks.downloadAndInstallOtaUpdate.mockImplementationOnce(
      async (
        _url: string,
        _version: string,
        _proxy: string | undefined,
        progress: any,
        ready: any,
      ) => {
        onProgress = progress
        beforeRelaunch = ready
        return await new Promise((_, reject) => {
          rejectOld = reject
        })
      },
    )
    renderSettings()
    openTab('关于')
    fireEvent.click(screen.getByRole('button', { name: /检查更新/ }))
    await screen.findByRole('button', { name: /立即重启更新/ })
    fireEvent.click(screen.getByRole('button', { name: /立即重启更新/ }))
    await waitFor(() => expect(tauriMocks.downloadAndInstallOtaUpdate).toHaveBeenCalledTimes(1))

    const oldLease = useAppStore.getState().otaTask.leaseId ?? -1
    useAppStore.getState().failOtaTask(oldLease, 'replaced')
    const newLease = useAppStore.getState().tryStartOtaTask('download', '0.2.0') ?? -1
    const toastCount = toastMocks.toast.mock.calls.length
    onProgress?.({ phase: 'downloading', downloadedBytes: 99, totalBytes: 100, percent: 99 })
    expect(await beforeRelaunch?.({ filePath: 'tauri-updater', latestVersion: '9.9.9' })).toBe(
      false,
    )
    rejectOld?.(new Error('late reject'))
    await Promise.resolve()

    expect(useAppStore.getState().otaTask).toMatchObject({
      status: 'running',
      leaseId: newLease,
      kind: 'download',
      progress: { phase: 'checking' },
      result: { latestVersion: '0.2.0' },
    })
    expect(localStorage.getItem('echolike.v2.pendingUpdate')).toBeNull()
    expect(toastMocks.toast).toHaveBeenCalledTimes(toastCount)
  })

  it('shows the verified ready-to-restart outcome in an already remounted Settings instance', async () => {
    let beforeRelaunch: ((result: any) => Promise<boolean> | boolean) | undefined
    let finishDownload: ((value: any) => void) | undefined
    tauriMocks.downloadAndInstallOtaUpdate.mockImplementationOnce(
      async (
        _url: string,
        _version: string,
        _proxy: string | undefined,
        _progress: any,
        ready: any,
      ) => {
        beforeRelaunch = ready
        return await new Promise((resolve) => {
          finishDownload = resolve
        })
      },
    )

    const first = renderSettings()
    openTab('关于')
    fireEvent.click(screen.getByRole('button', { name: /检查更新/ }))
    await screen.findByRole('button', { name: /立即重启更新/ })
    fireEvent.click(screen.getByRole('button', { name: /立即重启更新/ }))
    await waitFor(() => expect(tauriMocks.downloadAndInstallOtaUpdate).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem('echolike.v2.pendingUpdate')).toBeNull()
    first.unmount()

    renderSettings()
    openTab('关于')
    expect(screen.getByRole('button', { name: /更新中/ })).toBeDisabled()
    const result = { filePath: 'tauri-updater', latestVersion: '0.2.0' }
    expect(await beforeRelaunch?.(result)).toBe(true)
    finishDownload?.(result)

    expect(useAppStore.getState().otaTask).toMatchObject({
      status: 'success',
      leaseId: null,
      kind: 'download',
      targetVersion: '0.2.0',
    })
    expect(JSON.parse(localStorage.getItem('echolike.v2.pendingUpdate') ?? '{}')).toMatchObject({
      version: '0.2.0',
      status: 'readyToRestart',
    })
    expect(await screen.findByText(`v${APP_VERSION} -> v0.2.0 · 待重启`)).toBeInTheDocument()
    const updateCard = document.querySelector('.echo-about-update-card')
    expect(
      within(updateCard as HTMLElement).getByText('正在重启以完成 v0.2.0 更新。'),
    ).toBeInTheDocument()
    const restartButton = screen.getByRole('button', { name: /继续重启更新/ })
    expect(restartButton).toBeDisabled()
    fireEvent.click(restartButton)
    expect(tauriMocks.downloadAndInstallOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it('uses the runtime app version for OTA checks when package metadata drifts', async () => {
    tauriMocks.getRuntimeAppVersion.mockResolvedValueOnce('0.1.10')

    renderSettings()
    openTab('关于')

    await screen.findByText(`包版本 v${APP_VERSION}`)
    fireEvent.click(screen.getByRole('button', { name: /检查更新/ }))

    await waitFor(() => {
      expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api/app/update',
        '0.1.10',
      )
    })
  })

  it('blocks consecutive update buttons and retries once the cooldown timer expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))
    tauriMocks.checkOtaUpdate
      .mockResolvedValueOnce({
        appName: 'EcholIKE',
        currentVersion: '0.1.38',
        latestVersion: '0.1.38',
        autoUpdate: true,
        updateAvailable: false,
        forceUpdate: false,
        downloadUrl: null,
        sha256: null,
        releaseNotes: null,
        message: 'You are on the latest version.',
        checkedAt: '2026-06-30T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        appName: 'EcholIKE',
        currentVersion: '0.1.38',
        latestVersion: '0.1.39',
        autoUpdate: true,
        updateAvailable: true,
        forceUpdate: false,
        downloadUrl: null,
        sha256: null,
        releaseNotes: null,
        message: 'Update available.',
        checkedAt: '2026-06-30T00:05:00.000Z',
      })

    renderSettings()
    openTab('关于')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /检查更新/ }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(1)
    const cooldownButton = screen.getByRole('button', { name: /稍后可重试/ })
    expect(cooldownButton).toBeDisabled()
    fireEvent.click(cooldownButton)
    expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(OTA_MANUAL_CHECK_COOLDOWN_MS - 1)
    })
    expect(screen.getByRole('button', { name: /稍后可重试/ })).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    const latestButton = screen.getByRole('button', { name: /重新检查/ })
    expect(latestButton).toBeEnabled()

    await act(async () => {
      fireEvent.click(latestButton)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /立即重启更新/ })).toBeEnabled()
  })

  it('keeps the remaining OTA check cooldown across Settings remounts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))
    tauriMocks.checkOtaUpdate.mockResolvedValueOnce({
      appName: 'EcholIKE',
      currentVersion: APP_VERSION,
      latestVersion: APP_VERSION,
      autoUpdate: true,
      updateAvailable: false,
      forceUpdate: false,
      downloadUrl: null,
      sha256: null,
      releaseNotes: null,
      message: 'You are on the latest version.',
      checkedAt: '2026-08-20T00:00:00.000Z',
    })

    const first = renderSettings()
    openTab('关于')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /检查更新/ }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /稍后可重试/ })).toBeDisabled()
    first.unmount()

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    renderSettings()
    expect(screen.getByRole('button', { name: /稍后可重试/ })).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(29_999)
    })
    expect(screen.getByRole('button', { name: /稍后可重试/ })).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('button', { name: /重新检查/ })).toBeEnabled()
    expect(tauriMocks.checkOtaUpdate).toHaveBeenCalledTimes(1)
  })
})
