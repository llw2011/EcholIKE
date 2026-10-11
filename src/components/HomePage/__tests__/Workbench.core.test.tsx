import { describe } from 'vitest'
import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { workbenchTestHarness } from './workbenchTestHarness'

const {
  homePageFixture: HomePage,
  rawWorkbenchHomePage: WorkbenchHomePage,
  backendAiBootstrap,
  tauriMocks,
  useAppStore,
} = workbenchTestHarness

describe('HomePage 核心编排', () => {
  it('does not surface account, subscription, upgrade, or backup copy', () => {
    render(<HomePage />)

    expect(document.body.textContent).not.toMatch(/登录|账户|订阅|备份|升级|Pro/)
  })

  it('shows a clear network activation entry without exposing registration', () => {
    const onOpenNetworkLogin = vi.fn()
    useAppStore.setState((state) => ({
      config: { ...state.config, config_source: 'backend' },
    }))

    render(<HomePage onOpenNetworkLogin={onOpenNetworkLogin} />)

    expect(screen.getByText('登录后启用网络服务')).toBeInTheDocument()
    expect(screen.getByText('暂未开放注册，请联系管理员获取账号。')).toBeInTheDocument()
    expect(screen.queryByText(/找回密码|注册账号/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '登录网络版' }))
    expect(onOpenNetworkLogin).toHaveBeenCalledTimes(1)
    expect(tauriMocks.testOcrConnection).not.toHaveBeenCalled()
  })

  it('does not enable managed services from a token and unpaired bootstrap alone', () => {
    localStorage.setItem('echolike.v2.authToken', 'unverified-token')
    useAppStore.setState((state) => ({
      config: { ...state.config, config_source: 'backend' },
      desktopAuthToken: 'unverified-token',
      desktopAuthStatus: 'unknown',
      desktopBootstrapAuthToken: null,
      desktopBootstrap: {
        ...backendAiBootstrap,
        user: {
          email: 'user@example.com',
          name: null,
          plan: 'pro',
          subscriptionEnd: null,
        },
      },
    }))

    render(<WorkbenchHomePage />)

    expect(screen.getByText('登录后启用网络服务')).toBeInTheDocument()
    expect(screen.queryByText('后台托管可用')).not.toBeInTheDocument()
  })

  it('renders OCR actions, answer surface, and composer in one workspace frame', () => {
    render(<HomePage />)

    const workspace = document.querySelector('.echo-ai-workspace')
    expect(workspace).toBeTruthy()
    expect(workspace?.querySelector('.echo-ai-toolbar')).toBeTruthy()
    expect(workspace?.querySelector('.echo-ai-result-panel')).toBeTruthy()
    expect(workspace?.querySelector('.echo-ai-composer')).toBeTruthy()
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeInTheDocument()
  })

  it('locks primary workflows when a forced OTA update is required', () => {
    useAppStore.setState({
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-06-29T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        ota: {
          enabled: true,
          autoUpdate: false,
          forceUpdate: true,
          currentVersion: '0.1.0',
          latestVersion: '0.2.0',
          minVersion: '0.2.0',
          updateAvailable: true,
          status: 'required',
          releaseNotes: '安全更新',
          downloadAvailable: true,
          checkedAt: '2026-06-29T00:00:00.000Z',
        },
      },
    })

    render(<HomePage />)

    expect(screen.queryByText('能力边界')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('必须安装新版本')
    expect(screen.getByRole('button', { name: /开始说话/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: '提问' })).toBeDisabled()
    expect(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /立即更新/ }))
    expect(window.location.hash).toBe('#/settings/about')

    fireEvent.click(screen.getByRole('button', { name: /退出/ }))
    expect(tauriMocks.quitApp).toHaveBeenCalledTimes(1)
    expect(tauriMocks.startRecording).not.toHaveBeenCalled()
    expect(tauriMocks.readScreenOcr).not.toHaveBeenCalled()
    expect(tauriMocks.readScreenOcrSelection).not.toHaveBeenCalled()
    expect(tauriMocks.askLlmOnce).not.toHaveBeenCalled()
  })
})
