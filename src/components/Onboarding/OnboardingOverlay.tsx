import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  KeyRound,
  Laptop,
  Mic,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import type { AppConfig, ConfigSource } from '../../stores/appStore'
import type { Route } from '../../lib/router'
import type { DesktopBootstrap } from '../../lib/tauri'
import type { OnboardingSession } from '../../lib/onboarding'
import {
  backendSttAvailability,
  hotkeyMatchesKeyboardEvent,
  isLocalSttConfigured,
} from '../../lib/onboarding'

type SimulationState = 'idle' | 'recording' | 'result'
type TourStep = 'hotkey' | 'result' | 'settings' | 'activation' | 'real-test'

type TargetRect = {
  top: number
  left: number
  width: number
  height: number
}

type Props = {
  session: OnboardingSession
  config: AppConfig
  route: Route
  desktopBootstrap: DesktopBootstrap | null
  hasDesktopToken: boolean
  refreshingNetwork: boolean
  modeChoiceSavingSource: ConfigSource | null
  modeChoiceMessage: string | null
  onChooseMode: (source: ConfigSource) => void
  onFinish: (source: ConfigSource) => void
  onSkip: (source: ConfigSource) => void
  onNavigate: (route: Route, section?: string) => void
  onRefreshNetwork: () => Promise<string | null>
  onSwitchToLocal: () => void
  onSimulationStateChange: (state: SimulationState) => void
}

function initialStep(session: OnboardingSession): TourStep {
  return session.kind === 'mode' ? 'activation' : 'hotkey'
}

function selectorForStep(
  step: TourStep,
  source: ConfigSource,
  networkAvailability: ReturnType<typeof backendSttAvailability>,
) {
  if (step === 'hotkey' || step === 'real-test') return '[data-onboarding-target="voice-trigger"]'
  if (step === 'result') return '[data-onboarding-target="voice-result"]'
  if (step === 'settings') return '[data-onboarding-target="settings-nav"]'
  if (source === 'local') return '[data-onboarding-target="local-stt-config"]'
  if (networkAvailability === 'signed-out') return '[data-onboarding-target="network-auth"]'
  if (networkAvailability === 'unavailable') {
    return '[data-onboarding-target="network-quota-refresh"]'
  }
  return '[data-onboarding-target="network-auth"]'
}

function activeTarget(selector: string | null) {
  return selector ? document.querySelector<HTMLElement>(selector) : null
}

function isFocusable(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    !element.hasAttribute('disabled') &&
    element.getAttribute('aria-hidden') !== 'true'
  )
}

function focusableChildren(root: HTMLElement | null) {
  if (!root) return []
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return [
    ...(root.matches(selector) && isFocusable(root) ? [root] : []),
    ...Array.from(root.querySelectorAll(selector)).filter(isFocusable),
  ]
}

function stepProgress(session: OnboardingSession, step: TourStep) {
  if (session.kind === 'mode') return { current: 1, total: 1 }
  const order: TourStep[] = ['hotkey', 'result', 'settings', 'activation', 'real-test']
  return { current: Math.max(1, order.indexOf(step) + 1), total: order.length }
}

export function OnboardingOverlay({
  session,
  config,
  route,
  desktopBootstrap,
  hasDesktopToken,
  refreshingNetwork,
  modeChoiceSavingSource,
  modeChoiceMessage,
  onChooseMode,
  onFinish,
  onSkip,
  onNavigate,
  onRefreshNetwork,
  onSwitchToLocal,
  onSimulationStateChange,
}: Props) {
  const [step, setStep] = useState<TourStep>(() => initialStep(session))
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null)
  const [networkRefreshError, setNetworkRefreshError] = useState<string | null>(null)
  const skipButtonRef = useRef<HTMLButtonElement | null>(null)
  const simulationTimerRef = useRef<number | null>(null)
  const networkRefreshAttemptRef = useRef(0)
  const source = session.source
  const localReady = isLocalSttConfigured(config)
  const networkAvailability = backendSttAvailability(desktopBootstrap, hasDesktopToken)
  const modeReady = source === 'local' ? localReady : networkAvailability === 'ready'
  const selector =
    session.kind === 'mode-choice' ? null : selectorForStep(step, source, networkAvailability)
  const allowTargetInteraction = step === 'hotkey' || step === 'settings'
  const progress = stepProgress(session, step)

  useEffect(() => {
    setStep(initialStep(session))
    setTargetRect(null)
    networkRefreshAttemptRef.current += 1
    setNetworkRefreshError(null)
  }, [session])

  const refreshNetworkInsideCallout = useCallback(async () => {
    const attempt = networkRefreshAttemptRef.current + 1
    networkRefreshAttemptRef.current = attempt
    setNetworkRefreshError(null)
    try {
      const message = await onRefreshNetwork()
      if (networkRefreshAttemptRef.current === attempt) setNetworkRefreshError(message)
    } catch {
      if (networkRefreshAttemptRef.current === attempt) {
        setNetworkRefreshError('刷新网络服务额度失败，请稍后重试。')
      }
    }
  }, [onRefreshNetwork])

  useEffect(() => {
    if (step === 'hotkey' && route !== 'home') onNavigate('home')
    if (step === 'activation') {
      onNavigate('settings', source === 'local' ? 'speech' : 'ai')
    }
  }, [onNavigate, route, source, step])

  useEffect(() => {
    if (step !== 'settings' || route !== 'settings') return
    onNavigate('settings', source === 'local' ? 'speech' : 'ai')
    setStep('activation')
  }, [onNavigate, route, source, step])

  useEffect(() => {
    return () => {
      networkRefreshAttemptRef.current += 1
      if (simulationTimerRef.current !== null) {
        window.clearTimeout(simulationTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const preventBackgroundScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.echo-onboarding')) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }

    root.classList.add('echo-onboarding-scroll-locked')
    document.addEventListener('wheel', preventBackgroundScroll, {
      capture: true,
      passive: false,
    })
    document.addEventListener('touchmove', preventBackgroundScroll, {
      capture: true,
      passive: false,
    })
    return () => {
      root.classList.remove('echo-onboarding-scroll-locked')
      document.removeEventListener('wheel', preventBackgroundScroll, true)
      document.removeEventListener('touchmove', preventBackgroundScroll, true)
    }
  }, [])

  const triggerShortcutSimulation = useCallback(() => {
    if (session.kind === 'mode-choice' || step !== 'hotkey') return
    onSimulationStateChange('recording')
    setStep('result')
    if (simulationTimerRef.current !== null) window.clearTimeout(simulationTimerRef.current)
    simulationTimerRef.current = window.setTimeout(() => {
      onSimulationStateChange('result')
      simulationTimerRef.current = null
    }, 620)
  }, [onSimulationStateChange, session.kind, step])

  useEffect(() => {
    const onNativeShortcut = (event: Event) => {
      const shortcut = (event as CustomEvent<string>).detail
      if (shortcut === 'input') triggerShortcutSimulation()
    }
    window.addEventListener('echolike:onboarding-shortcut', onNativeShortcut)
    return () => window.removeEventListener('echolike:onboarding-shortcut', onNativeShortcut)
  }, [triggerShortcutSimulation])

  useLayoutEffect(() => {
    if (!selector) {
      setTargetRect(null)
      return
    }

    const initialTarget = activeTarget(selector)
    initialTarget?.scrollIntoView?.({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest',
    })

    let frame = 0
    const updateRect = () => {
      const target = activeTarget(selector)
      if (!target) {
        setTargetRect(null)
        return
      }
      const rect = target.getBoundingClientRect()
      const scrollContainer = target.closest<HTMLElement>('.echo-content')
      const scrollRect = scrollContainer?.getBoundingClientRect()
      const clipTop = Math.max(8, scrollRect?.top ?? 8)
      const clipLeft = Math.max(8, scrollRect?.left ?? 8)
      const clipRight = Math.min(window.innerWidth - 8, scrollRect?.right ?? window.innerWidth - 8)
      const clipBottom = Math.min(
        window.innerHeight - 8,
        scrollRect?.bottom ?? window.innerHeight - 8,
      )
      const top = Math.max(clipTop, rect.top - 8)
      const left = Math.max(clipLeft, rect.left - 8)
      const right = Math.min(clipRight, rect.right + 8)
      const bottom = Math.min(clipBottom, rect.bottom + 8)
      if (right <= left || bottom <= top) {
        setTargetRect(null)
        return
      }
      setTargetRect({
        top,
        left,
        width: right - left,
        height: bottom - top,
      })
    }
    const schedule = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateRect)
    }

    schedule()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [route, selector, step])

  const targetAllowsEvent = useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false
      if (target.closest('[data-onboarding-control]')) return true
      const currentTarget = activeTarget(selector)
      return Boolean(allowTargetInteraction && currentTarget?.contains(target))
    },
    [allowTargetInteraction, selector],
  )

  useEffect(() => {
    const guardPointer = (event: Event) => {
      if (targetAllowsEvent(event.target)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const guardClick = (event: MouseEvent) => {
      if (
        step === 'hotkey' &&
        event.target instanceof Element &&
        activeTarget(selector)?.contains(event.target)
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        triggerShortcutSimulation()
        return
      }
      if (!targetAllowsEvent(event.target)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
    }
    const guardKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (session.kind !== 'mode-choice') onSkip(source)
        return
      }
      if (step === 'hotkey' && hotkeyMatchesKeyboardEvent(event, config.hotkey)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        triggerShortcutSimulation()
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        event.stopImmediatePropagation()
        const target = activeTarget(selector)
        const overlayControls = Array.from(
          document.querySelectorAll<HTMLElement>('[data-onboarding-control]'),
        ).filter(isFocusable)
        const targets = allowTargetInteraction ? focusableChildren(target) : []
        const allowed = [...targets, ...overlayControls]
        if (!allowed.length) return
        const current = document.activeElement
        const currentIndex = allowed.indexOf(current as HTMLElement)
        const delta = event.shiftKey ? -1 : 1
        const nextIndex =
          currentIndex < 0 ? 0 : (currentIndex + delta + allowed.length) % allowed.length
        allowed[nextIndex]?.focus()
        return
      }
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        const eventTarget = event.target instanceof Element ? event.target : null
        const isEditable = Boolean(
          eventTarget?.closest('input, textarea, select, [contenteditable="true"]'),
        )
        const activatesAllowedButton = Boolean(
          event.key === ' ' &&
          eventTarget?.closest('button, [role="button"]') &&
          targetAllowsEvent(eventTarget),
        )
        if (!isEditable && !activatesAllowedButton) {
          event.preventDefault()
          event.stopImmediatePropagation()
          return
        }
      }
      if (targetAllowsEvent(document.activeElement)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const guardFocus = (event: FocusEvent) => {
      if (targetAllowsEvent(event.target)) return
      skipButtonRef.current?.focus()
    }

    document.addEventListener('pointerdown', guardPointer, true)
    document.addEventListener('click', guardClick, true)
    document.addEventListener('keydown', guardKeyboard, true)
    document.addEventListener('focusin', guardFocus, true)
    return () => {
      document.removeEventListener('pointerdown', guardPointer, true)
      document.removeEventListener('click', guardClick, true)
      document.removeEventListener('keydown', guardKeyboard, true)
      document.removeEventListener('focusin', guardFocus, true)
    }
  }, [
    allowTargetInteraction,
    config.hotkey,
    onFinish,
    onSkip,
    selector,
    session.kind,
    source,
    step,
    targetAllowsEvent,
    triggerShortcutSimulation,
  ])

  const content = useMemo(() => {
    if (session.kind === 'mode-choice') return null

    if (step === 'hotkey') {
      return {
        eyebrow: '第 1 步 / 核心操作',
        title: '按快捷键，或点击开始说话',
        text: `请按 ${config.hotkey}，也可以点击高亮的“开始说话”按钮。当前只进行安全模拟：不会请求麦克风，不会上传音频，也不会消耗额度。`,
        icon: Mic,
      }
    }
    if (step === 'result') {
      return {
        eyebrow: '第 2 步 / 结果回读',
        title: '文字会回到当前工作台',
        text: '刚才显示的是本地模拟结果。真实使用时，转写后的文字也会在这里显示并写入目标应用。',
        icon: Sparkles,
      }
    }
    if (step === 'settings') {
      return {
        eyebrow: '第 3 步 / 找到配置',
        title: '打开设置',
        text: '点击侧栏的“设置”。接下来只补充当前模式真正需要的激活步骤。',
        icon: ShieldCheck,
      }
    }
    if (step === 'real-test') {
      return {
        eyebrow: '第 5 步 / 可选实测',
        title: '准备好后再开始真实录音',
        text: '先结束教程；遮罩关闭后，再由你点击“开始说话”请求麦克风并执行真实转写。',
        icon: CheckCircle2,
      }
    }
    if (source === 'local') {
      return localReady
        ? {
            eyebrow: session.kind === 'mode' ? '本地配置版' : '第 4 步 / 可选配置',
            title: '语音转写已具备配置条件',
            text: '本地配置版先只需要语音转写服务。文本 AI、OCR 和朗读可在需要时再加。',
            icon: Laptop,
          }
        : {
            eyebrow: session.kind === 'mode' ? '本地配置版' : '第 4 步 / 可选配置',
            title: '语音转写可以稍后配置',
            text: '手头没有本地模型或第三方 API 也没关系。你可以先结束教程；配置并测试成功前，语音输入暂不可用。',
            icon: Laptop,
          }
    }
    if (networkAvailability === 'signed-out') {
      return {
        eyebrow: session.kind === 'mode' ? '网络版' : '第 4 步 / 可选登录',
        title: '有网络版账号时再登录',
        text: '没有网络版账号也可以先结束教程；登录前，网络托管功能暂不可用。',
        icon: KeyRound,
      }
    }
    if (networkAvailability === 'unavailable') {
      return {
        eyebrow: session.kind === 'mode' ? '网络版' : '第 4 步 / 检查服务',
        title: '账号已登录，但语音服务暂不可用',
        text: '登录成功不等于语音转写已就绪。可以刷新额度，或改用本地配置版。',
        icon: Cloud,
      }
    }
    return {
      eyebrow: session.kind === 'mode' ? '网络版' : '第 4 步 / 激活完成',
      title: '网络语音服务已就绪',
      text: '现在可以回到主页，由你主动发起一次真实语音测试。',
      icon: CheckCircle2,
    }
  }, [config.hotkey, localReady, networkAvailability, session.kind, source, step])

  if (session.kind === 'mode-choice') {
    const modeChoiceBusy = modeChoiceSavingSource !== null
    return (
      <div className="echo-onboarding echo-onboarding--chooser" role="dialog" aria-modal="true">
        <div className="echo-onboarding-choice-card">
          <span className="echo-onboarding-kicker">首次使用</span>
          <h2>选择你的使用方式</h2>
          <p>之后会按所选方式直接启动；你仍可随时在设置中切换。</p>
          <div className="echo-onboarding-mode-grid">
            <button
              type="button"
              className="echo-onboarding-mode-card echo-onboarding-mode-card--recommended"
              data-onboarding-control
              disabled={modeChoiceBusy}
              onClick={() => onChooseMode('local')}
            >
              <span className="echo-onboarding-mode-icon">
                <Laptop size={22} />
              </span>
              <span className="echo-onboarding-mode-copy">
                <strong>本地配置版</strong>
                <small>无需 EcholIKE 账号；本地模型或第三方 API 可稍后配置</small>
              </span>
              <em>推荐</em>
              <ArrowRight size={18} />
            </button>
            <button
              type="button"
              className="echo-onboarding-mode-card"
              data-onboarding-control
              disabled={modeChoiceBusy}
              onClick={() => onChooseMode('backend')}
            >
              <span className="echo-onboarding-mode-icon">
                <Cloud size={22} />
              </span>
              <span className="echo-onboarding-mode-copy">
                <strong>网络版</strong>
                <small>使用网络托管服务，需要管理员账号</small>
              </span>
              <ArrowRight size={18} />
            </button>
          </div>
          {modeChoiceBusy && (
            <p className="echo-onboarding-choice-status" role="status">
              正在保存{modeChoiceSavingSource === 'local' ? '本地配置版' : '网络版'}选择…
            </p>
          )}
          {modeChoiceMessage && (
            <p className="echo-onboarding-choice-error" role="alert">
              {modeChoiceMessage}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (!content) return null

  const Icon = content.icon
  const calloutActions =
    step === 'result' ? (
      <button
        type="button"
        className="echo-button echo-button--primary"
        data-onboarding-control
        onClick={() => setStep('settings')}
      >
        继续
        <ArrowRight size={16} />
      </button>
    ) : step === 'activation' && modeReady ? (
      <div className="echo-onboarding-callout-actions">
        <button
          type="button"
          className="echo-button echo-button--primary"
          data-onboarding-control
          onClick={() => {
            onNavigate('home')
            setStep('real-test')
          }}
        >
          进入真实测试
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="echo-button"
          data-onboarding-control
          onClick={() => onSkip(source)}
        >
          暂不测试，完成教程
        </button>
      </div>
    ) : step === 'activation' && source === 'local' ? (
      <button
        type="button"
        className="echo-button echo-button--primary"
        data-onboarding-control
        onClick={() => onSkip(source)}
      >
        稍后配置，结束教程
      </button>
    ) : step === 'activation' && networkAvailability === 'signed-out' ? (
      <div className="echo-onboarding-callout-actions">
        <button
          type="button"
          className="echo-button echo-button--primary"
          data-onboarding-control
          onClick={() => onSkip(source)}
        >
          稍后登录，结束教程
        </button>
        <button
          type="button"
          className="echo-button"
          data-onboarding-control
          onClick={onSwitchToLocal}
        >
          改用本地配置版
        </button>
      </div>
    ) : step === 'activation' && source === 'backend' && networkAvailability === 'unavailable' ? (
      <div className="echo-onboarding-callout-actions">
        <button
          type="button"
          className="echo-button echo-button--primary"
          data-onboarding-control
          onClick={() => void refreshNetworkInsideCallout()}
          disabled={refreshingNetwork}
        >
          <RefreshCw size={16} className={refreshingNetwork ? 'echo-spin' : undefined} />
          刷新额度
        </button>
        <button
          type="button"
          className="echo-button"
          data-onboarding-control
          onClick={onSwitchToLocal}
        >
          改用本地配置版
        </button>
        <button
          type="button"
          className="echo-button"
          data-onboarding-control
          onClick={() => onSkip(source)}
        >
          稍后处理，结束教程
        </button>
      </div>
    ) : step === 'real-test' ? (
      <div className="echo-onboarding-callout-actions">
        <button
          type="button"
          className="echo-button echo-button--primary"
          data-onboarding-control
          onClick={() => onFinish(source)}
        >
          结束教程，准备实测
        </button>
        <button
          type="button"
          className="echo-button"
          data-onboarding-control
          onClick={() => onSkip(source)}
        >
          结束教程，稍后再试
        </button>
      </div>
    ) : null

  return (
    <div className="echo-onboarding" role="dialog" aria-modal="true" aria-label="EcholIKE 快速上手">
      <div className="echo-onboarding-wash" aria-hidden="true" />
      {targetRect && (
        <div
          className="echo-onboarding-spotlight"
          aria-hidden="true"
          style={{
            top: targetRect.top,
            left: targetRect.left,
            width: targetRect.width,
            height: targetRect.height,
          }}
        />
      )}
      <section className="echo-onboarding-callout">
        <div className="echo-onboarding-callout-head">
          <span className="echo-onboarding-callout-icon">
            <Icon size={18} />
          </span>
          <span>{content.eyebrow}</span>
          <button
            ref={skipButtonRef}
            type="button"
            className="echo-onboarding-skip"
            data-onboarding-control
            onClick={() => onSkip(source)}
          >
            跳过教程
          </button>
        </div>
        <div className="echo-onboarding-callout-copy">
          <h2>{content.title}</h2>
          <p>{content.text}</p>
        </div>
        {modeChoiceSavingSource && (
          <p className="echo-onboarding-choice-status" role="status">
            正在保存使用方式…
          </p>
        )}
        {modeChoiceMessage && (
          <p className="echo-onboarding-choice-error" role="alert">
            {modeChoiceMessage}
          </p>
        )}
        {networkRefreshError && (
          <p className="echo-onboarding-choice-error" role="alert">
            {networkRefreshError}
          </p>
        )}
        <div className="echo-onboarding-callout-foot">
          <span>
            {progress.current} / {progress.total}
          </span>
          {calloutActions}
        </div>
      </section>
    </div>
  )
}

export type { SimulationState }
