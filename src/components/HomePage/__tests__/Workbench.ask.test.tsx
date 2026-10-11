import { describe } from 'vitest'
import { expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { workbenchTestHarness } from './workbenchTestHarness'

const {
  homePageFixture: HomePage,
  backendAiBootstrap,
  ocrResult,
  tauriMocks,
  toastMocks,
  useAppStore,
} = workbenchTestHarness

describe('HomePage Ask', () => {
  it('adds selected scene preset instructions to local ask requests', async () => {
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
    })

    render(<HomePage />)

    fireEvent.change(screen.getByLabelText('预设'), {
      target: { value: 'offline:meeting-notes' },
    })
    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: '整理这段讨论' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    await waitFor(() => {
      expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          question: '整理这段讨论',
          context: expect.stringContaining('预设：会议纪要'),
        }),
      )
    })
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('处理要求：'),
      }),
    )
  })

  it('selects the whole ask input when it receives focus with existing text', () => {
    render(<HomePage />)

    const input = screen.getByPlaceholderText(
      '例如：帮我判断当前窗口可能在做什么',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: '你是谁' } })
    fireEvent.focus(input)

    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('你是谁'.length)
  })

  it('uses OCR text as context when asking a follow-up question', async () => {
    const prompt = '请基于刚才识别到的屏幕内容，帮我总结重点并指出需要处理的事项。'
    tauriMocks.readScreenOcrSelection.mockResolvedValue({ status: 'success', result: ocrResult })
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '屏幕文字识别结果' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '基于此内容提问' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么')).toHaveValue(prompt)

    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    await waitFor(() => {
      expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          question: prompt,
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'qwen3.5',
          context: expect.stringContaining('订单号 12345'),
        }),
      )
    })
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('当前窗口: Chrome / 订单页面'),
      }),
    )
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('屏幕 OCR:'),
      }),
    )
  })

  it('asks through backend LLM proxy when cloud LLM is enabled', async () => {
    tauriMocks.askProxyLlmOnce.mockResolvedValueOnce({
      text: 'cloud answer',
      operationId: 'ask-operation-1',
    })
    tauriMocks.readScreenOcrSelectionProxy.mockResolvedValue({
      status: 'success',
      result: ocrResult,
    })
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendAiBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '屏幕文字识别结果' })).toBeInTheDocument()
    })
    const closeButtons = screen.getAllByRole('button', { name: '关闭' })
    fireEvent.click(closeButtons[closeButtons.length - 1])

    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: '说重点' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    await waitFor(() => {
      expect(tauriMocks.askProxyLlmOnce).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api',
        'valid-pro-token',
        '说重点',
        expect.stringContaining('屏幕 OCR:'),
      )
    })
    expect(tauriMocks.askLlmOnce).not.toHaveBeenCalled()
    expect(screen.getByText('Q：')).toBeInTheDocument()
    expect(screen.getByText('说重点')).toBeInTheDocument()
    expect(screen.getByText('A：')).toBeInTheDocument()
    expect(await screen.findByText('cloud answer')).toBeInTheDocument()
    expect(tauriMocks.acknowledgeIdempotentOperation).toHaveBeenCalledWith('ask-operation-1')
  })

  it('unlocks a completed backend Ask when native acknowledgement persistence fails', async () => {
    tauriMocks.askProxyLlmOnce.mockResolvedValueOnce({
      text: 'answer survives ACK failure',
      operationId: 'ask-operation-failed-ack',
    })
    tauriMocks.acknowledgeIdempotentOperation.mockRejectedValueOnce(new Error('database busy'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendAiBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    render(<HomePage />)
    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: 'ACK 失败也要保留结果' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    expect(await screen.findByText('answer survives ACK failure')).toBeInTheDocument()
    await waitFor(() => expect(useAppStore.getState().askTask.ackPending).toBe(false))
    expect(screen.getByRole('button', { name: '提问' })).toBeEnabled()
    expect(warn).toHaveBeenCalledWith('Ask operation ACK deferred:', expect.any(Error))
  })

  it('keeps an accepted backend Ask locked across remount until acknowledgement finishes', async () => {
    let resolveAcknowledgement!: () => void
    tauriMocks.askProxyLlmOnce.mockResolvedValueOnce({
      text: 'answer awaiting ACK',
      operationId: 'ask-operation-pending-ack',
    })
    tauriMocks.acknowledgeIdempotentOperation.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveAcknowledgement = resolve
      }),
    )
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendAiBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    const first = render(<HomePage />)
    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: '等待 ACK 的问题' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    expect(await screen.findByText('answer awaiting ACK')).toBeInTheDocument()
    await waitFor(() => expect(useAppStore.getState().askTask.ackPending).toBe(true))
    expect(screen.getByRole('button', { name: /思考中/ })).toBeDisabled()

    first.unmount()
    render(<HomePage />)
    const remountedButton = screen.getByRole('button', { name: /思考中/ })
    expect(remountedButton).toBeDisabled()
    fireEvent.click(remountedButton)
    expect(tauriMocks.askProxyLlmOnce).toHaveBeenCalledTimes(1)

    act(() => resolveAcknowledgement())
    await waitFor(() => {
      expect(useAppStore.getState().askTask.ackPending).toBe(false)
      expect(screen.getByRole('button', { name: '提问' })).toBeEnabled()
    })
    expect(screen.getByText('answer awaiting ACK')).toBeInTheDocument()
  })

  it('does not fall back to local LLM when backend proxy ask fails', async () => {
    tauriMocks.askProxyLlmOnce.mockRejectedValueOnce(new Error('Cloud LLM provider request failed'))
    tauriMocks.askLlmOnce.mockResolvedValue('local answer')
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendAiBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
    })

    render(<HomePage />)

    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: '说重点' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    await waitFor(() => {
      expect(screen.getByText(/文本 AI 服务暂时不可用/)).toBeInTheDocument()
    })
    expect(document.body.textContent).not.toContain('请求失败：')
    expect(document.body.textContent).not.toContain('Cloud LLM provider request failed')
    expect(tauriMocks.askLlmOnce).not.toHaveBeenCalled()
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('后台托管文本 AI 请求失败'),
      'error',
    )
  })

  it('translates backend LLM quota errors into an actionable Chinese message', async () => {
    tauriMocks.askProxyLlmOnce.mockRejectedValueOnce(new Error('quota exceeded'))
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendAiBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    render(<HomePage />)

    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: '说重点' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    await waitFor(() => {
      expect(screen.getByText('额度不足，请充值。')).toBeInTheDocument()
    })
    expect(document.body.textContent).not.toContain('请求失败：')
    expect(toastMocks.toast).not.toHaveBeenCalledWith('额度不足，请充值。', 'error')
    expect(screen.queryByText(/LLM quota exceeded/)).not.toBeInTheDocument()
  })

  it('shows an active asking state while waiting for the LLM answer', async () => {
    let resolveAsk: (answer: string) => void = () => {}
    tauriMocks.askLlmOnce.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveAsk = resolve
      }),
    )
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
    })

    render(<HomePage />)

    const input = screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么')
    fireEvent.change(input, { target: { value: '帮我看下这个表格' } })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    expect(screen.getByRole('button', { name: /思考中/ })).toBeDisabled()
    expect(input).toHaveAttribute('readonly')
    expect(screen.getByText('正在整理回答')).toBeInTheDocument()
    expect(screen.getByText('帮我看下这个表格')).toBeInTheDocument()

    resolveAsk('最终回答')

    await waitFor(() => {
      expect(screen.getByText('最终回答')).toBeInTheDocument()
    })
  })

  it('keeps one pending Ask across unmount and remount, then restores its result', async () => {
    let resolveAsk: (answer: string) => void = () => {}
    tauriMocks.askLlmOnce.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveAsk = resolve
      }),
    )
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
    })

    const first = render(<HomePage />)
    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: 'frozen question' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))
    fireEvent.click(screen.getByRole('button', { name: /思考中/ }))
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledTimes(1)

    first.unmount()
    render(<HomePage />)
    expect(screen.getByRole('button', { name: /思考中/ })).toBeDisabled()
    expect(screen.getByText('frozen question')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /思考中/ }))
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledTimes(1)

    resolveAsk('restored answer')
    expect(await screen.findByText('restored answer')).toBeInTheDocument()
  })

  it('keeps a late Ask failure in the task result instead of toasting the page opened meanwhile', async () => {
    let rejectAsk!: (error: unknown) => void
    tauriMocks.askLlmOnce.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectAsk = reject
      }),
    )
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
    })

    const first = render(<HomePage />)
    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: '切页后失败的问题' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))
    await waitFor(() => expect(tauriMocks.askLlmOnce).toHaveBeenCalledTimes(1))
    first.unmount()
    toastMocks.toast.mockClear()

    rejectAsk(new Error('late ask failure'))

    await waitFor(() => expect(useAppStore.getState().askTask.error).toBe('问答请求失败。'))
    expect(toastMocks.toast).not.toHaveBeenCalled()
    render(<HomePage />)
    const failure = await screen.findByText('问答请求失败。')
    expect(screen.queryByText('late ask failure')).not.toBeInTheDocument()
    expect(failure.closest('[role="alert"]')).not.toBeNull()
  })

  it('keeps answer clipboard feedback inside the workspace result surface', async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
    })

    try {
      render(<HomePage />)
      fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
        target: { value: '复制这个回答' },
      })
      fireEvent.click(screen.getByRole('button', { name: '提问' }))
      await screen.findByText('ok')
      fireEvent.click(screen.getByRole('button', { name: '复制回答' }))

      const answerBox = document.querySelector('.echo-ai-workspace .echo-answer-box')
      if (!answerBox) throw new Error('Answer surface not found')
      expect(await within(answerBox as HTMLElement).findByRole('status')).toHaveTextContent(
        '回答已复制。',
      )
      expect(toastMocks.toast).not.toHaveBeenCalled()
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      } else {
        Reflect.deleteProperty(navigator, 'clipboard')
      }
    }
  })

  it('freezes the submitted question and full request context while inputs later change', async () => {
    let resolveAsk: (answer: string) => void = () => {}
    tauriMocks.askLlmOnce.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveAsk = resolve
      }),
    )
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
      ocrTask: {
        ...useAppStore.getState().ocrTask,
        status: 'success',
        result: { ...ocrResult, text: 'original OCR text' },
      },
    })

    render(<HomePage />)
    const input = screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么')
    fireEvent.change(input, { target: { value: 'original question' } })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    const frozen = useAppStore.getState().askTask
    expect(frozen.question).toBe('original question')
    expect(frozen.context).toContain('original OCR text')
    useAppStore.setState({
      ocrTask: {
        ...useAppStore.getState().ocrTask,
        result: { ...ocrResult, text: 'later OCR text' },
      },
    })
    expect(useAppStore.getState().askTask).toMatchObject({
      question: 'original question',
      context: frozen.context,
    })

    resolveAsk('answer for original')
    expect(await screen.findByText('answer for original')).toBeInTheDocument()
    expect(screen.getByText('original question')).toBeInTheDocument()
  })

  it('restores a readable Ask error after unmount and remount', async () => {
    tauriMocks.askLlmOnce.mockRejectedValue('model "missing" not found')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11440',
        llm_model: 'missing',
      },
    })

    const first = render(<HomePage />)
    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: 'error question' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))
    expect(await screen.findByText(/没有找到当前文本 AI 模型/)).toBeInTheDocument()

    first.unmount()
    render(<HomePage />)
    expect(screen.getByText('error question')).toBeInTheDocument()
    expect(screen.getByText(/没有找到当前文本 AI 模型/)).toBeInTheDocument()
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledTimes(1)
  })

  it('animates a long Ask answer monotonically to completion', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList))
    const longAnswer = Array.from({ length: 180 }, (_, index) => String(index % 10)).join('')

    render(<HomePage />)
    act(() => {
      const leaseId = useAppStore.getState().tryStartAskTask('long question', null) ?? -1
      useAppStore.getState().finishAskTask(leaseId, longAnswer)
    })

    act(() => vi.advanceTimersByTime(18))
    const firstFrame = document.querySelectorAll('.echo-answer-thread p')[1]?.textContent ?? ''
    expect(firstFrame.length).toBeGreaterThan(0)
    act(() => vi.advanceTimersByTime(18))
    const secondFrame = document.querySelectorAll('.echo-answer-thread p')[1]?.textContent ?? ''
    expect(secondFrame.length).toBeGreaterThan(firstFrame.length)

    act(() => vi.runAllTimers())
    expect(screen.getByText(longAnswer)).toBeInTheDocument()
  })

  it('finishes animating a restored long Ask answer after remount', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList))
    const longAnswer = '恢复后的长回答内容。'.repeat(20)
    const leaseId = useAppStore.getState().tryStartAskTask('restored long question', null) ?? -1
    useAppStore.getState().finishAskTask(leaseId, longAnswer)

    const first = render(<HomePage />)
    first.unmount()
    render(<HomePage />)
    act(() => vi.runAllTimers())

    expect(screen.getByText(longAnswer)).toBeInTheDocument()
    expect(useAppStore.getState().askTask.answer).toBe(longAnswer)
  })

  it('surfaces string errors from local LLM asks', async () => {
    tauriMocks.askLlmOnce.mockRejectedValue('model "llama3.2" not found')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11440',
        llm_model: 'llama3.2',
      },
    })

    render(<HomePage />)

    fireEvent.change(screen.getByPlaceholderText('例如：帮我判断当前窗口可能在做什么'), {
      target: { value: '说重点' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提问' }))

    const failure = await screen.findByText(/没有找到当前文本 AI 模型/)
    expect(failure).toHaveTextContent('glm-ocr 仅支持屏幕/附件 OCR')
    expect(failure).toHaveTextContent('http://127.0.0.1:11440')
    expect(failure).not.toHaveTextContent('。。')
    expect(screen.queryByText(/model "llama3\.2" not found/)).not.toBeInTheDocument()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })
})
