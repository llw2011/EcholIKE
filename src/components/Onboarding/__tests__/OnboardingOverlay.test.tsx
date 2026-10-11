import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { useAppStore } from '../../../stores/appStore'
import type { AppConfig } from '../../../stores/appStore'
import { OnboardingOverlay } from '../OnboardingOverlay'

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...useAppStore.getInitialState().config,
    config_source: 'local',
    onboarding_version: 0,
    ...overrides,
  }
}

function renderOverlay(overrides: Partial<ComponentProps<typeof OnboardingOverlay>> = {}) {
  const onVoiceTrigger = vi.fn()
  const props = {
    session: { kind: 'full' as const, source: 'local' as const },
    config: config(),
    route: 'home' as const,
    desktopBootstrap: null,
    hasDesktopToken: false,
    refreshingNetwork: false,
    modeChoiceSavingSource: null,
    modeChoiceMessage: null,
    onChooseMode: vi.fn(),
    onFinish: vi.fn(),
    onSkip: vi.fn(),
    onNavigate: vi.fn(),
    onRefreshNetwork: vi.fn().mockResolvedValue(null),
    onSwitchToLocal: vi.fn(),
    onSimulationStateChange: vi.fn(),
    ...overrides,
  }
  const view = render(
    <>
      <main className="echo-content">
        <button data-onboarding-target="voice-trigger" onClick={onVoiceTrigger}>
          开始说话
        </button>
        <section data-onboarding-target="voice-result">结果</section>
        <section data-onboarding-target="local-stt-config">本地语音配置</section>
      </main>
      <button data-onboarding-target="settings-nav">设置</button>
      <OnboardingOverlay {...props} />
    </>,
  )
  return { ...view, props, onVoiceTrigger }
}

describe('OnboardingOverlay', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('offers the recommended local configuration mode to a fresh installation', () => {
    const onChooseMode = vi.fn()
    renderOverlay({
      session: { kind: 'mode-choice', source: 'backend' },
      onChooseMode,
    })

    fireEvent.click(screen.getByRole('button', { name: /本地配置版/ }))
    expect(onChooseMode).toHaveBeenCalledWith('local')
    expect(
      screen.getByText('无需 EcholIKE 账号；本地模型或第三方 API 可稍后配置'),
    ).toBeInTheDocument()
  })

  it('does not run shortcut simulation before a usage mode is selected', () => {
    const onSimulationStateChange = vi.fn()
    renderOverlay({
      session: { kind: 'mode-choice', source: 'backend' },
      onSimulationStateChange,
    })

    fireEvent.keyDown(document, { key: '/', ctrlKey: true })
    window.dispatchEvent(new CustomEvent('echolike:onboarding-shortcut', { detail: 'input' }))

    expect(onSimulationStateChange).not.toHaveBeenCalled()
  })

  it('shows mode persistence failures inside the chooser without bypassing the choice', () => {
    renderOverlay({
      session: { kind: 'mode-choice', source: 'backend' },
      modeChoiceMessage: '无法原子替换本地配置。',
    })

    expect(screen.getByRole('alert')).toHaveTextContent('无法原子替换本地配置。')
    expect(screen.getByRole('button', { name: /本地配置版/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /网络版/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /暂时跳过/ })).not.toBeInTheDocument()
  })

  it('keeps the real mode-save state visible and blocks duplicate choices', () => {
    renderOverlay({
      session: { kind: 'mode-choice', source: 'backend' },
      modeChoiceSavingSource: 'local',
    })

    expect(screen.getByRole('status')).toHaveTextContent('正在保存本地配置版选择')
    expect(screen.getByRole('button', { name: /本地配置版/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /网络版/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /暂时跳过/ })).not.toBeInTheDocument()
  })

  it('turns the configured shortcut into a local simulation instead of a real recording', () => {
    const onSimulationStateChange = vi.fn()
    renderOverlay({ onSimulationStateChange })

    fireEvent.keyDown(document, { key: '/', ctrlKey: true })

    expect(onSimulationStateChange).toHaveBeenCalledWith('recording')
    expect(screen.getByRole('heading', { name: '文字会回到当前工作台' })).toBeInTheDocument()
  })

  it('turns a click on the highlighted start button into the same safe simulation', () => {
    const onSimulationStateChange = vi.fn()
    const { onVoiceTrigger } = renderOverlay({ onSimulationStateChange })

    expect(screen.getByText(/也可以点击高亮的“开始说话”按钮/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开始说话' }))

    expect(onSimulationStateChange).toHaveBeenCalledWith('recording')
    expect(onVoiceTrigger).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: '文字会回到当前工作台' })).toBeInTheDocument()
  })

  it('counts configuration and the optional real test as separate steps', () => {
    const { container } = renderOverlay()
    const progress = container.querySelector('.echo-onboarding-callout-foot > span')

    expect(progress).toHaveTextContent('1 / 5')
    fireEvent.keyDown(document, { key: '/', ctrlKey: true })
    expect(progress).toHaveTextContent('2 / 5')
  })

  it('lets Escape skip the tour through the explicit exit path', () => {
    const onSkip = vi.fn()
    renderOverlay({ onSkip })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onSkip).toHaveBeenCalledWith('local')
  })

  it('locks the real content scroller and blocks background wheel or touch scrolling', () => {
    const { container, unmount } = renderOverlay()
    const content = container.querySelector<HTMLElement>('.echo-content')
    expect(content).not.toBeNull()
    expect(document.documentElement).toHaveClass('echo-onboarding-scroll-locked')

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true })
    content?.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)

    const touchMove = new Event('touchmove', { bubbles: true, cancelable: true })
    content?.dispatchEvent(touchMove)
    expect(touchMove.defaultPrevented).toBe(true)

    unmount()
    expect(document.documentElement).not.toHaveClass('echo-onboarding-scroll-locked')
  })

  it('blocks background scroll keys without swallowing tutorial button activation keys', () => {
    renderOverlay()
    const backgroundButton = screen.getByRole('button', { name: '开始说话' })
    const pageDown = new KeyboardEvent('keydown', {
      key: 'PageDown',
      bubbles: true,
      cancelable: true,
    })
    backgroundButton.dispatchEvent(pageDown)
    expect(pageDown.defaultPrevented).toBe(true)

    const skipButton = screen.getByRole('button', { name: '跳过教程' })
    skipButton.focus()
    const space = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    })
    skipButton.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(false)
  })

  it('scrolls the current target into view and never pins an offscreen spotlight to the titlebar', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.onboardingTarget === 'voice-trigger') {
        return {
          top: -80,
          bottom: -40,
          left: 20,
          right: 140,
          width: 120,
          height: 40,
          x: 20,
          y: -80,
          toJSON: () => ({}),
        } as DOMRect
      }
      return {
        top: 80,
        bottom: 700,
        left: 0,
        right: 900,
        width: 900,
        height: 620,
        x: 0,
        y: 80,
        toJSON: () => ({}),
      } as DOMRect
    })

    try {
      const { container } = renderOverlay()
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
      expect(container.querySelector('.echo-onboarding-spotlight')).not.toBeInTheDocument()
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScrollIntoView,
        })
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      }
    }
  })

  it('lets local users finish without a model or third-party API', () => {
    const onSkip = vi.fn()
    renderOverlay({
      session: { kind: 'mode', source: 'local' },
      config: config({ stt_provider: 'glm-asr', stt_api_key: '' }),
      onSkip,
    })

    expect(screen.getByText(/手头没有本地模型或第三方 API 也没关系/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '稍后配置，结束教程' }))
    expect(onSkip).toHaveBeenCalledWith('local')
  })

  it('lets network users finish without an account or switch to local mode', () => {
    const onSkip = vi.fn()
    const onSwitchToLocal = vi.fn()
    renderOverlay({
      session: { kind: 'mode', source: 'backend' },
      config: config({ config_source: 'backend' }),
      hasDesktopToken: false,
      onSkip,
      onSwitchToLocal,
    })

    expect(screen.getByText(/没有网络版账号也可以先结束教程/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '稍后登录，结束教程' }))
    expect(onSkip).toHaveBeenCalledWith('backend')
    fireEvent.click(screen.getByRole('button', { name: '改用本地配置版' }))
    expect(onSwitchToLocal).toHaveBeenCalledTimes(1)
  })

  it('keeps refresh and local fallback while allowing unavailable network service to defer', () => {
    const onSkip = vi.fn()
    const onRefreshNetwork = vi.fn()
    renderOverlay({
      session: { kind: 'mode', source: 'backend' },
      config: config({ config_source: 'backend' }),
      hasDesktopToken: true,
      desktopBootstrap: null,
      onSkip,
      onRefreshNetwork,
    })

    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }))
    expect(onRefreshNetwork).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '稍后处理，结束教程' }))
    expect(onSkip).toHaveBeenCalledWith('backend')
  })

  it('keeps a network refresh failure inside the tutorial callout', async () => {
    const onRefreshNetwork = vi.fn().mockResolvedValue('额度服务暂时不可用，请稍后重试。')
    renderOverlay({
      session: { kind: 'mode', source: 'backend' },
      config: config({ config_source: 'backend' }),
      hasDesktopToken: true,
      desktopBootstrap: null,
      onRefreshNetwork,
    })

    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('额度服务暂时不可用，请稍后重试。')
    expect(onRefreshNetwork).toHaveBeenCalledTimes(1)
  })

  it('does not require a real microphone test after the selected service is ready', () => {
    const onSkip = vi.fn()
    renderOverlay({
      session: { kind: 'mode', source: 'local' },
      config: config({ stt_provider: 'glm-asr', stt_api_key: 'configured' }),
      onSkip,
    })

    expect(screen.getByRole('button', { name: '进入真实测试' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '暂不测试，完成教程' }))
    expect(onSkip).toHaveBeenCalledWith('local')
  })

  it('ends the protected tutorial before asking the user to start a real recording', () => {
    const onFinish = vi.fn()
    renderOverlay({
      session: { kind: 'mode', source: 'local' },
      config: config({ stt_provider: 'glm-asr', stt_api_key: 'configured' }),
      onFinish,
    })

    fireEvent.click(screen.getByRole('button', { name: '进入真实测试' }))
    expect(screen.getByText(/遮罩关闭后，再由你点击“开始说话”/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开始说话' }))
    expect(onFinish).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '结束教程，准备实测' }))
    expect(onFinish).toHaveBeenCalledWith('local')
  })
})
