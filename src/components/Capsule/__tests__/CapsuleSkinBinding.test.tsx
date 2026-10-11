import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../stores/appStore'
import { capsuleStyleOptions } from '../capsuleSkin'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('../../../hooks/useRecording', () => ({
  useRecording: () => ({
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    isRecording: false,
    isProcessing: false,
  }),
}))

vi.mock('../../../hooks/useCapsuleResize', () => ({
  getCapsuleVisibility: () => true,
  useCapsuleResize: () => ({ width: 36, height: 36 }),
}))

import { Capsule } from '../index'

describe('Capsule skin binding', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState())
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('binds the live capsule surface directly to the configured capsule style', () => {
    const { container } = render(<Capsule />)
    const skin = container.querySelector('.echo-capsule-skin--runtime')

    expect(skin).toHaveAttribute('data-capsule-style', 'classic')
    expect(skin?.querySelector('.echo-capsule-surface--idle')).not.toBeNull()
    expect(skin?.querySelector('.echo-capsule-frame')).not.toBeNull()
    expect(skin?.querySelector('[data-capsule-content-state="idle"]')).not.toBeNull()
    expect(skin?.querySelector('.jelly-capsule')).toBeNull()

    act(() => {
      useAppStore.getState().updateConfig({ capsule_style: 'orbit' })
    })

    expect(skin).toHaveAttribute('data-capsule-style', 'orbit')
    expect(skin?.querySelector('.echo-capsule-glyph--orbit')).not.toBeNull()
  })

  it('keeps the selected runtime identity while recording and hot-switches without leaving it', () => {
    act(() => {
      useAppStore.setState((state) => ({
        pipelineState: 'recording',
        config: { ...state.config, capsule_style: 'pulse' },
      }))
    })

    const { container } = render(<Capsule />)
    const skin = container.querySelector('.echo-capsule-skin--runtime')
    const runtimeState = container.querySelector('[data-capsule-content-state="recording"]')

    expect(skin).toHaveAttribute('data-capsule-style', 'pulse')
    expect(runtimeState?.querySelector('.echo-capsule-waveform')).not.toBeNull()
    expect(runtimeState?.querySelector('.echo-capsule-waveform')).toHaveAttribute(
      'data-capsule-waveform-style',
      'pulse',
    )
    expect(runtimeState?.querySelector('.echo-capsule-status-dot')).toHaveAttribute(
      'data-capsule-indicator-style',
      'pulse',
    )
    expect(runtimeState?.querySelectorAll('.echo-capsule-waveform-bar')).toHaveLength(7)
    expect(runtimeState?.querySelector('.echo-capsule-duration')).not.toBeNull()
    expect(runtimeState?.querySelector('[data-capsule-cancel="recording"]')).not.toBeNull()

    act(() => {
      useAppStore.getState().updateConfig({ capsule_style: 'orbit' })
    })

    expect(useAppStore.getState().pipelineState).toBe('recording')
    expect(skin).toHaveAttribute('data-capsule-style', 'orbit')
    expect(runtimeState?.querySelector('.echo-capsule-waveform')).toHaveAttribute(
      'data-capsule-waveform-style',
      'orbit',
    )
    expect(runtimeState?.querySelector('.echo-capsule-status-dot')).toHaveAttribute(
      'data-capsule-indicator-style',
      'orbit',
    )
    expect(runtimeState?.querySelectorAll('.echo-capsule-waveform-bar')).toHaveLength(6)
  })

  it('keeps output completion Rust-owned while retaining error reset timing', () => {
    vi.useFakeTimers()

    useAppStore.setState({ pipelineState: 'outputting' })
    render(<Capsule />)

    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(useAppStore.getState().pipelineState).toBe('outputting')

    act(() => useAppStore.getState().setPipelineState('idle'))
    expect(useAppStore.getState().pipelineState).toBe('idle')

    cleanup()
    useAppStore.setState({ pipelineError: '服务暂不可用' })
    render(<Capsule />)

    act(() => {
      vi.advanceTimersByTime(2499)
    })
    expect(useAppStore.getState().pipelineError).toBe('服务暂不可用')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(useAppStore.getState().pipelineError).toBeNull()
  })

  it('renders a pipeline fallback notice as a non-error completion state', () => {
    useAppStore.setState({ pipelineState: 'idle', pipelineNotice: '已复制' })

    const { container } = render(<Capsule />)

    expect(container.querySelector('[data-capsule-content-state="outputting"]')).not.toBeNull()
    expect(container.querySelector('.echo-capsule-content--complete')).toHaveTextContent('已复制')
    expect(
      container.querySelector('[data-capsule-notice-tone="success"] .lucide-check'),
    ).not.toBeNull()
    expect(container.querySelector('.echo-capsule-surface--error')).toBeNull()
  })

  it('does not present an informational pipeline notice as a success check', () => {
    useAppStore.setState({
      pipelineState: 'idle',
      pipelineNotice: '后台暂不可用，已保留原始文本',
    })

    const { container } = render(<Capsule />)
    const notice = container.querySelector('[data-capsule-notice-tone="notice"]')

    expect(notice).toHaveClass('echo-capsule-content--notice')
    expect(notice?.querySelector('.lucide-info')).not.toBeNull()
    expect(notice?.querySelector('.lucide-check')).toBeNull()
    expect(container.querySelector('.echo-capsule-surface--error')).toBeNull()
  })

  it('renders and clears a recording command rejection in the capsule that owns it', () => {
    vi.useFakeTimers()
    useAppStore.setState({
      pipelineState: 'idle',
      recordingTransition: {
        kind: 'start',
        status: 'error',
        leaseId: 42,
        startedAt: '2026-07-20T00:00:00.000Z',
        error: '麦克风启动失败',
      },
    })

    const { container } = render(<Capsule />)

    expect(container.querySelector('.echo-capsule-surface--error')).not.toBeNull()
    expect(container.querySelector('.echo-capsule-content--error')).toHaveTextContent(
      '麦克风启动失败',
    )

    act(() => vi.advanceTimersByTime(2500))

    expect(useAppStore.getState().recordingTransition).toMatchObject({
      status: 'idle',
      leaseId: null,
      error: null,
    })
  })

  it.each(capsuleStyleOptions)('binds the $id error identity without recording UI', (style) => {
    useAppStore.setState((state) => ({
      pipelineState: 'idle',
      pipelineError: '请重新登录授权',
      config: { ...state.config, capsule_style: style.id },
    }))

    const { container } = render(<Capsule />)
    const skin = container.querySelector('.echo-capsule-skin--runtime')
    const error = container.querySelector('[data-capsule-content-state="error"]')

    expect(skin).toHaveAttribute('data-capsule-style', style.id)
    expect(error?.querySelector(`[data-capsule-error-style="${style.id}"]`)).not.toBeNull()
    expect(error?.querySelector(`.echo-capsule-glyph--${style.id}`)).not.toBeNull()
    expect(error).toHaveTextContent('请重新登录授权')
    expect(error?.querySelector('.echo-capsule-status-dot')).toBeNull()
    expect(error?.querySelector('.echo-capsule-waveform')).toBeNull()
    expect(error?.querySelector('.echo-capsule-duration')).toBeNull()
    expect(error?.querySelector('.echo-capsule-loader')).toBeNull()
    expect(error?.querySelector('.echo-capsule-progress')).toBeNull()
    expect(error?.querySelector('[data-capsule-cancel]')).toBeNull()
  })

  it('keeps an authorization error on the selected skin and hot-switches its identity', () => {
    vi.useFakeTimers()
    useAppStore.setState((state) => ({
      pipelineState: 'idle',
      pipelineError: '请重新登录授权',
      config: { ...state.config, capsule_style: 'pulse' },
    }))

    const { container } = render(<Capsule />)
    const skin = container.querySelector('.echo-capsule-skin--runtime')
    const error = container.querySelector('[data-capsule-content-state="error"]')

    expect(useAppStore.getState().pipelineState).toBe('idle')
    expect(skin).toHaveAttribute('data-capsule-style', 'pulse')
    expect(error?.querySelector('[data-capsule-error-style="pulse"]')).not.toBeNull()
    expect(error?.querySelector('.echo-capsule-glyph--pulse')).not.toBeNull()
    expect(error).toHaveTextContent('请重新登录授权')
    expect(error?.querySelector('.echo-capsule-waveform')).toBeNull()
    expect(error?.querySelector('.echo-capsule-duration')).toBeNull()
    expect(error?.querySelector('[data-capsule-cancel]')).toBeNull()

    act(() => vi.advanceTimersByTime(1000))

    act(() => {
      useAppStore.getState().updateConfig({ capsule_style: 'orbit' })
    })

    const switchedSkin = container.querySelector('.echo-capsule-skin--runtime')
    const switchedError = container.querySelector('[data-capsule-content-state="error"]')

    expect(useAppStore.getState().pipelineState).toBe('idle')
    expect(useAppStore.getState().pipelineError).toBe('请重新登录授权')
    expect(switchedSkin).toHaveAttribute('data-capsule-style', 'orbit')
    expect(switchedError?.querySelector('[data-capsule-error-style="orbit"]')).not.toBeNull()
    expect(switchedError?.querySelector('.echo-capsule-glyph--orbit')).not.toBeNull()
    expect(switchedError?.querySelector('.echo-capsule-glyph--pulse')).toBeNull()

    act(() => vi.advanceTimersByTime(1499))
    expect(useAppStore.getState().pipelineError).toBe('请重新登录授权')

    act(() => vi.advanceTimersByTime(1))
    expect(useAppStore.getState().pipelineError).toBeNull()
  })
})
