import { describe } from 'vitest'
import { expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { workbenchTestHarness } from './workbenchTestHarness'

const {
  ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
  homePageFixture: HomePage,
  backendAiBootstrap,
  backendTtsBootstrap,
  installTtsBrowserMocks,
  parseMarkdownDraft,
  tauriMocks,
  toastMocks,
  useAppStore,
} = workbenchTestHarness

describe('HomePage Speech 与 TTS', () => {
  it('never renders a stale input level while the pipeline is idle', () => {
    useAppStore.setState({ pipelineState: 'idle', audioVolume: 0.8 })

    render(<HomePage />)

    const meter = screen.getByRole('meter', { name: '实时输入电平' })
    expect(meter.children).toHaveLength(24)
    expect(meter.querySelectorAll('.is-active')).toHaveLength(0)
  })

  it('does not render internal transcript state words in the output box', () => {
    useAppStore.setState({
      partialTranscript: '实时识别文本',
    })

    render(<HomePage />)

    expect(screen.getByText('实时识别文本')).toBeInTheDocument()
    expect(screen.queryByText('ready')).not.toBeInTheDocument()
    expect(screen.queryByText(/STT partial|STT final|LLM streaming/)).not.toBeInTheDocument()
  })

  it('keeps a pending start lease across remount, deduplicates clicks, and only resets after Rust acquires', async () => {
    let resolveStart!: (acquired: boolean) => void
    tauriMocks.startRecording.mockReturnValue(new Promise((resolve) => (resolveStart = resolve)))
    useAppStore.setState({ partialTranscript: 'keep me' })

    const first = render(<HomePage />)
    const button = screen.getByRole('button', { name: /开始说话/ })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(tauriMocks.startRecording).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    expect(useAppStore.getState().partialTranscript).toBe('keep me')

    first.unmount()
    render(<HomePage />)
    expect(screen.getByRole('button', { name: /开始说话/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /开始说话/ }))
    expect(tauriMocks.startRecording).toHaveBeenCalledTimes(1)

    resolveStart(false)
    await waitFor(() => expect(useAppStore.getState().recordingTransition.status).toBe('idle'))
    expect(useAppStore.getState().partialTranscript).toBe('keep me')
    expect(useAppStore.getState().pipelineState).toBe('idle')
  })

  it('does not start recording while the native config source transaction is pending', async () => {
    const leaseId = useAppStore.getState().tryStartSettingsOperation('config-source')
    expect(leaseId).not.toBeNull()

    render(<HomePage />)
    const button = screen.getByRole('button', { name: /开始说话/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(tauriMocks.startRecording).not.toHaveBeenCalled()
    expect(useAppStore.getState().recordingTransition.status).toBe('idle')

    act(() => useAppStore.getState().finishSettingsOperation(leaseId!))
    await waitFor(() => expect(button).toBeEnabled())
  })

  it.each([
    ['start', 'idle', /开始说话/, 'startRecording', '录音命令执行失败。'],
    ['stop', 'recording', /停止并输出/, 'stopRecording', '录音命令执行失败。'],
    ['abort', 'recording', '取消', 'abortRecording', '取消录音失败。'],
  ] as const)(
    'deduplicates pending %s across remount and preserves a readable rejection',
    async (_kind, state, label, mockName, expectedMessage) => {
      let reject!: (error: unknown) => void
      tauriMocks[mockName].mockReturnValue(
        new Promise((_resolve, rejectPromise) => (reject = rejectPromise)),
      )
      useAppStore.setState({ pipelineState: state })

      const first = render(<HomePage />)
      fireEvent.click(screen.getByRole('button', { name: label }))
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(tauriMocks[mockName]).toHaveBeenCalledTimes(1)
      first.unmount()
      render(<HomePage />)
      expect(screen.getByRole('button', { name: label })).toBeDisabled()

      reject(new Error('recording transition rejected'))
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(expectedMessage))
      expect(screen.queryByText('recording transition rejected')).not.toBeInTheDocument()
      expect(useAppStore.getState().pipelineState).toBe(state)
      expect(toastMocks.toast).not.toHaveBeenCalledWith('recording transition rejected', 'error')
    },
  )

  it('does not create a transition or command while outputting', () => {
    useAppStore.setState({ pipelineState: 'outputting' })
    render(<HomePage />)
    const button = screen.getByRole('button', { name: /开始说话/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(tauriMocks.startRecording).not.toHaveBeenCalled()
    expect(useAppStore.getState().recordingTransition.status).toBe('idle')
  })

  it('hides main TTS actions when backend TTS is not enabled', () => {
    render(<HomePage />)

    expect(screen.queryByRole('button', { name: /朗读结果/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /朗读回答/ })).not.toBeInTheDocument()
  })

  it('shows main TTS actions when backend proxy TTS is enabled', () => {
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      finalTranscript: '原始识别文本',
    })

    render(<HomePage />)

    expect(screen.getByRole('button', { name: /朗读结果/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /朗读回答/ })).toBeDisabled()
  })

  it('keeps Home speech actions disabled while a preview playback owns the Store lease', () => {
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    const askLeaseId = useAppStore.getState().tryStartAskTask('已有回答', null)
    if (askLeaseId === null) throw new Error('Expected Ask lease')
    useAppStore.getState().finishAskTask(askLeaseId, '回答正文')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      finalTranscript: '本次语音结果',
      ttsPlaybackBusy: 'preview',
      ttsPlaybackLeaseId: 77,
    })

    render(<HomePage />)

    expect(screen.getByRole('button', { name: /朗读结果/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /朗读回答/ })).toBeDisabled()
  })

  it('keeps the result card scoped to the latest completed voice result and can send it to Markdown', async () => {
    useAppStore.setState({
      finalTranscript: '旧的累积识别文本',
      polishedText: '旧的累积润色文本',
      completedVoiceText: '本次识别结果',
      completedVoiceTextVersion: 1,
    })

    render(<HomePage />)

    expect(screen.getByRole('region', { name: '本次结果操作' })).toHaveTextContent('本次识别结果')
    expect(screen.queryByText('旧的累积润色文本')).not.toBeInTheDocument()

    toastMocks.toast.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '插入 Markdown 编辑器' }))

    await waitFor(() => {
      expect(
        parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))?.text,
      ).toBe('本次识别结果')
    })
    expect(toastMocks.toast).not.toHaveBeenCalledWith('已放入 Markdown 编辑器。', 'success')
  })

  it('plays an answer through the backend TTS proxy without client provider fields', async () => {
    const { fetchMock, playMock } = installTtsBrowserMocks()
    tauriMocks.askProxyLlmOnce.mockResolvedValueOnce({
      text: 'ok',
      operationId: 'ask-operation-tts',
    })
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      void input
      return Promise.resolve(
        new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
      )
    })
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: {
        ...backendAiBootstrap,
        services: {
          ...backendAiBootstrap.services,
          tts: backendTtsBootstrap.services?.tts,
        },
      },
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
      expect(screen.getByText('ok')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /朗读回答/ }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api/proxy/tts',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    const ttsCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/proxy/tts'))
    expect(ttsCall).toBeTruthy()
    const [, init] = ttsCall ?? []
    const headers = init?.headers as Record<string, string>
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(headers.authorization).toBe('Bearer valid-pro-token')
    expect(headers['content-type']).toBe('application/json')
    expect(body).toEqual({ text: 'ok', voice: 'alloy' })
    expect(body).not.toHaveProperty('apiKey')
    expect(body).not.toHaveProperty('providerApiKey')
    expect(body).not.toHaveProperty('provider')
    expect(body).not.toHaveProperty('baseUrl')
    expect(body).not.toHaveProperty('model')
    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(1)
    })
  })

  it('splits long answers into bounded backend TTS chunks', async () => {
    const { fetchMock, playMock, revokeObjectURLMock } = installTtsBrowserMocks()
    const longAnswer = '甲'.repeat(2600)
    tauriMocks.askProxyLlmOnce.mockResolvedValueOnce({
      text: longAnswer,
      operationId: 'ask-operation-long',
    })
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      void input
      return Promise.resolve(
        new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
      )
    })
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: {
        ...backendAiBootstrap,
        services: {
          ...backendAiBootstrap.services,
          tts: backendTtsBootstrap.services?.tts,
        },
      },
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
      expect(screen.getByRole('button', { name: /朗读回答/ })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: /朗读回答/ }))

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/proxy/tts')),
      ).toHaveLength(3)
    })
    const ttsBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/proxy/tts'))
      .map(([, init]) => JSON.parse(String(init?.body)) as { text: string; voice: string })
    expect(ttsBodies.map((body) => body.text.length)).toEqual([1200, 1200, 200])
    expect(ttsBodies.map((body) => body.text).join('')).toBe(longAnswer)
    expect(ttsBodies.every((body) => body.voice === 'alloy')).toBe(true)
    expect(playMock).toHaveBeenCalledTimes(3)
    await waitFor(() => {
      expect(revokeObjectURLMock).toHaveBeenCalledTimes(3)
    })
    expect(useAppStore.getState().workbenchFeedback.workspace).toBeNull()
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('朗读已开始'),
      'success',
    )
  })

  it('freezes token, voice and one native lease across a remounted multi-chunk playback', async () => {
    const { audioInstances, fetchMock } = installTtsBrowserMocks({ autoEnd: false })
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
      ),
    )
    const longResult = '甲'.repeat(1300)
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      completedVoiceText: longResult,
      completedVoiceTextVersion: 1,
    })

    const first = render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /朗读结果/ }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(audioInstances).toHaveLength(1)
      expect(useAppStore.getState().ttsPlaybackBusy).toBe('result')
    })

    const authenticatedBootstrap = useAppStore.getState().desktopBootstrap
    localStorage.setItem('echolike.v2.authToken', 'rotated-token')
    act(() => {
      useAppStore.setState({
        desktopAuthToken: 'rotated-token',
        desktopAuthStatus: 'authenticated',
        desktopBootstrapAuthToken: 'rotated-token',
        desktopBootstrap: authenticatedBootstrap
          ? {
              ...authenticatedBootstrap,
              services: {
                ...authenticatedBootstrap.services,
                tts: {
                  ...authenticatedBootstrap.services?.tts,
                  mode: 'proxy',
                  defaultVoice: 'nova',
                },
              },
            }
          : null,
      })
    })
    first.unmount()
    render(<HomePage />)
    expect(screen.getByRole('button', { name: /朗读结果/ })).toBeDisabled()
    expect(tauriMocks.releaseTtsPlaybackOwner).not.toHaveBeenCalled()

    act(() => audioInstances[0]?.onended?.())
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(audioInstances).toHaveLength(2)
    })
    expect(tauriMocks.acquireTtsPlaybackOwner).toHaveBeenCalledTimes(1)
    expect(
      tauriMocks.proxyTtsOnce.mock.calls.map((call) => ({
        token: call[1],
        textLength: String(call[2]).length,
        voice: call[3],
        leaseId: call[4],
      })),
    ).toEqual([
      { token: 'valid-pro-token', textLength: 1200, voice: 'alloy', leaseId: 91 },
      { token: 'valid-pro-token', textLength: 100, voice: 'alloy', leaseId: 91 },
    ])
    expect(tauriMocks.releaseTtsPlaybackOwner).not.toHaveBeenCalled()
    expect(useAppStore.getState().ttsPlaybackBusy).toBe('result')

    act(() => audioInstances[1]?.onended?.())
    await waitFor(() => {
      expect(tauriMocks.releaseTtsPlaybackOwner).toHaveBeenCalledWith(91)
      expect(useAppStore.getState().ttsPlaybackBusy).toBeNull()
    })
  })

  it('plays the polished transcript through the backend TTS proxy', async () => {
    const { fetchMock } = installTtsBrowserMocks()
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      finalTranscript: '原始识别文本',
      polishedText: '润色后的文本',
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /朗读结果/ }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({ text: '润色后的文本', voice: 'alloy' })
  })

  it('keeps a result playback locked after navigating away and back', async () => {
    const { audioInstances, fetchMock } = installTtsBrowserMocks({ autoEnd: false })
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      finalTranscript: '仍在后台朗读的文本',
    })

    const firstMount = render(<HomePage />)
    const firstButton = screen.getByRole('button', { name: /朗读结果/ })
    fireEvent.click(firstButton)
    fireEvent.click(firstButton)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().ttsPlaybackBusy).toBe('result')
    })

    firstMount.unmount()
    expect(useAppStore.getState().ttsPlaybackBusy).toBe('result')
    render(<HomePage />)

    const returnedButton = screen.getByRole('button', { name: /朗读结果/ })
    expect(returnedButton).toBeDisabled()
    fireEvent.click(returnedButton)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    act(() => {
      audioInstances[0]?.onended?.()
    })

    await waitFor(() => {
      expect(returnedButton).toBeEnabled()
      expect(useAppStore.getState().ttsPlaybackBusy).toBeNull()
    })
  })

  it('keeps a late backend TTS error on the owning result surface across a Home remount', async () => {
    const { fetchMock, playMock } = installTtsBrowserMocks()
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      finalTranscript: '原始识别文本',
    })

    const first = render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /朗读结果/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    first.unmount()
    toastMocks.toast.mockClear()

    resolveFetch(
      new Response(JSON.stringify({ code: 'tts_quota_exceeded', error: 'TTS quota exceeded' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await waitFor(() => {
      expect(useAppStore.getState().workbenchFeedback.voice?.message).toBe('额度不足，请充值。')
    })

    render(<HomePage />)
    const resultCard = screen.getByRole('region', { name: '本次结果操作' })
    expect(await within(resultCard).findByRole('alert')).toHaveTextContent('额度不足，请充值。')
    expect(toastMocks.toast).not.toHaveBeenCalled()
    expect(playMock).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('TTS quota exceeded')
  })

  it('suppresses a late result TTS failure after a newer voice resource replaces its owner', async () => {
    const { fetchMock } = installTtsBrowserMocks()
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      completedVoiceText: '旧语音结果',
      completedVoiceTextVersion: 1,
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /朗读结果/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    act(() => useAppStore.getState().setCompletedVoiceText('新语音结果'))
    resolveFetch(
      new Response(JSON.stringify({ code: 'tts_quota_exceeded', error: 'TTS quota exceeded' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await waitFor(() => expect(useAppStore.getState().ttsPlaybackBusy).toBeNull())
    expect(useAppStore.getState().workbenchFeedback.voice).toBeNull()
    const resultCard = screen.getByRole('region', { name: '本次结果操作' })
    expect(resultCard).toHaveTextContent('新语音结果')
    expect(within(resultCard).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('suppresses a late answer TTS failure after a newer Ask lease replaces its owner', async () => {
    const { fetchMock } = installTtsBrowserMocks()
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    const oldAskLease = useAppStore.getState().tryStartAskTask('旧问题', null)
    if (oldAskLease === null) throw new Error('Expected old Ask lease')
    useAppStore.getState().finishAskTask(oldAskLease, '旧回答')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /朗读回答/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    act(() => {
      const newAskLease = useAppStore.getState().tryStartAskTask('新问题', null)
      if (newAskLease === null) throw new Error('Expected replacement Ask lease')
    })
    resolveFetch(
      new Response(JSON.stringify({ code: 'tts_quota_exceeded', error: 'TTS quota exceeded' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await waitFor(() => expect(useAppStore.getState().ttsPlaybackBusy).toBeNull())
    expect(useAppStore.getState().workbenchFeedback.workspace).toBeNull()
    expect(screen.getByText('新问题')).toBeInTheDocument()
    expect(screen.queryByText('额度不足，请充值。')).not.toBeInTheDocument()
  })

  it('reports a process-wide playback owner conflict on the result surface', async () => {
    installTtsBrowserMocks()
    tauriMocks.acquireTtsPlaybackOwner.mockResolvedValueOnce(null)
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendTtsBootstrap,
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      finalTranscript: '等待朗读的结果',
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /朗读结果/ }))

    const resultCard = screen.getByRole('region', { name: '本次结果操作' })
    expect(await within(resultCard).findByRole('alert')).toHaveTextContent(
      '已有朗读任务正在进行，请稍后再试。',
    )
    expect(useAppStore.getState().ttsPlaybackBusy).toBeNull()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('keeps clipboard feedback inside the voice result card', async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    useAppStore.setState({ finalTranscript: '复制这段结果' })

    try {
      render(<HomePage />)
      fireEvent.click(screen.getByRole('button', { name: '复制本次结果' }))

      const resultCard = screen.getByRole('region', { name: '本次结果操作' })
      expect(await within(resultCard).findByRole('status')).toHaveTextContent('本次结果已复制。')
      expect(toastMocks.toast).not.toHaveBeenCalled()
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      } else {
        Reflect.deleteProperty(navigator, 'clipboard')
      }
    }
  })
})
