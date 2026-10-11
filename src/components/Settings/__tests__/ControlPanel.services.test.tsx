import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { localOcrConfigurationKey, useAppStore } from '../../../stores/appStore'
import {
  installControlPanelTestHarness,
  availableLocalOcrCapabilities,
  unavailableLocalOcrCapabilities,
  imageOnlyLocalOcrCapabilities,
  tauriMocks,
  toastMocks,
  renderSettings,
  openTab,
} from './controlPanelTestHarness'

describe('ControlPanel', () => {
  installControlPanelTestHarness()

  it('runs real STT and text AI checks from the control panel', async () => {
    renderSettings()

    openTab('麦克风')
    fireEvent.click(screen.getByRole('button', { name: /测试识别/ }))

    await waitFor(() => {
      expect(tauriMocks.benchSttConnection).toHaveBeenCalled()
    })

    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /测试文本 AI/ }))

    await waitFor(() => {
      expect(tauriMocks.benchLlmConnection).toHaveBeenCalled()
    })
    await screen.findByText(/最近测试 456ms/)
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      '文本 AI 连接正常：456ms',
      expect.anything(),
      expect.anything(),
    )

    fireEvent.click(screen.getByRole('button', { name: /读取模型/ }))

    await waitFor(() => {
      expect(tauriMocks.fetchLlmModels).toHaveBeenCalledWith(
        'llm-key',
        'openrouter',
        'https://api.deepseek.com/v1',
      )
    })
    await screen.findByText(/已读取 2 个模型/)
    const textAiPanel = screen
      .getByRole('heading', { name: '文本 AI 模型' })
      .closest('.echo-settings-panel')
    expect(textAiPanel?.querySelectorAll('.echo-panel-alert')).toHaveLength(0)
    expect(textAiPanel).not.toHaveTextContent('文本 AI 连接正常：456ms')
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      '读取到 2 个模型。',
      expect.anything(),
      expect.anything(),
    )
  })

  it('allows only one of two different Settings operations to start', async () => {
    let finishLlm!: (latency: number) => void
    tauriMocks.benchLlmConnection.mockImplementationOnce(
      () => new Promise<number>((resolve) => (finishLlm = resolve)),
    )
    renderSettings()
    openTab('AI')

    fireEvent.click(screen.getByRole('button', { name: /测试文本 AI/ }))

    await waitFor(() => expect(tauriMocks.benchLlmConnection).toHaveBeenCalledTimes(1))
    const modelsButton = screen.getByRole('button', { name: /读取模型/ })
    expect(modelsButton).toBeDisabled()
    fireEvent.click(modelsButton)
    expect(tauriMocks.fetchLlmModels).not.toHaveBeenCalled()
    expect(useAppStore.getState().settingsOperation?.kind).toBe('llm-test')

    finishLlm(25)
    await waitFor(() => expect(useAppStore.getState().settingsOperation).toBeNull())
  })

  it('restores pending model loading across remount and applies the matched result once', async () => {
    let resolveModels!: (models: string[]) => void
    tauriMocks.fetchLlmModels.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveModels = resolve
      }),
    )
    useAppStore.setState({ config: { ...useAppStore.getState().config, llm_model: '' } })
    const first = renderSettings()
    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /读取模型/ }))
    await waitFor(() => expect(tauriMocks.fetchLlmModels).toHaveBeenCalledTimes(1))
    first.unmount()

    renderSettings()
    openTab('AI')
    const button = screen.getByRole('button', { name: /读取模型/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(tauriMocks.fetchLlmModels).toHaveBeenCalledTimes(1)
    resolveModels(['matched-model'])
    await screen.findByText(/已读取 1 个模型/)
    expect(useAppStore.getState().config.llm_model).toBe('matched-model')
    expect(useAppStore.getState().llmModels).toEqual(['matched-model'])
  })

  it('does not report model-load success before the selected model is persisted', async () => {
    let rejectPersist!: (reason: Error) => void
    tauriMocks.fetchLlmModels.mockResolvedValueOnce(['persisted-model'])
    tauriMocks.updateConfig.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectPersist = reject
      }),
    )
    useAppStore.setState({ config: { ...useAppStore.getState().config, llm_model: '' } })

    renderSettings()
    openTab('AI')
    toastMocks.toast.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /读取模型/ }))

    await waitFor(() => expect(tauriMocks.updateConfig).toHaveBeenCalled())
    expect(useAppStore.getState().settingsOperation?.kind).toBe('models-load')
    expect(useAppStore.getState().settingsNotices['text-ai']).toBeUndefined()
    expect(screen.queryByText('读取到 1 个模型。')).not.toBeInTheDocument()

    await act(async () => rejectPersist(new Error('model config persistence failed')))

    await waitFor(() => {
      expect(useAppStore.getState().settingsOperation).toBeNull()
      expect(useAppStore.getState().settingsNotices['text-ai']?.phase).toBe('error')
    })
    expect(useAppStore.getState().settingsNotices['text-ai']?.text).not.toBe('读取到 1 个模型。')
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('keeps service test actions outside configuration rows', () => {
    renderSettings()

    openTab('麦克风')
    const sttPanel = screen
      .getByRole('heading', { name: '语音识别' })
      .closest('.echo-settings-panel')
    if (!sttPanel) throw new Error('STT panel not found')
    const sttRow = screen.getByText('识别服务').closest('.echo-setting-line')
    if (!sttRow) throw new Error('STT setting row not found')
    expect(sttPanel.querySelector('.echo-settings-panel-header .echo-service-status')).toBeTruthy()
    expect(
      [...sttPanel.children].some((child) => child.classList.contains('echo-service-status')),
    ).toBe(false)
    expect(
      within(sttPanel as HTMLElement)
        .getByRole('button', { name: /测试识别/ })
        .closest('.echo-settings-panel-actions'),
    ).toBeTruthy()
    expect(within(sttRow as HTMLElement).queryByRole('button', { name: /测试识别/ })).toBeNull()
    expect(screen.queryByText('连接测试')).not.toBeInTheDocument()

    openTab('AI')
    const ocrPanel = screen
      .getByRole('heading', { name: '截图与附件识别' })
      .closest('.echo-settings-panel')
    if (!ocrPanel) throw new Error('OCR panel not found')
    const ocrModelRow = screen.getByText('本机识别模型').closest('.echo-setting-line')
    if (!ocrModelRow) throw new Error('OCR model setting row not found')
    expect(
      within(ocrPanel as HTMLElement)
        .getByRole('button', { name: /测试本机识别/ })
        .closest('.echo-settings-panel-actions'),
    ).toBeTruthy()
    expect(
      within(ocrModelRow as HTMLElement).queryByRole('button', { name: /测试本机识别/ }),
    ).toBeNull()

    const llmPanel = screen
      .getByRole('heading', { name: '文本 AI 模型' })
      .closest('.echo-settings-panel')
    if (!llmPanel) throw new Error('LLM panel not found')
    const llmModelRow = screen.getByText('处理模型').closest('.echo-setting-line')
    if (!llmModelRow) throw new Error('LLM model setting row not found')
    expect(llmPanel.querySelector('.echo-settings-panel-header .echo-service-status')).toBeTruthy()
    expect(
      [...llmPanel.children].some((child) => child.classList.contains('echo-service-status')),
    ).toBe(false)
    expect(
      within(llmPanel as HTMLElement)
        .getByRole('button', { name: /测试文本 AI/ })
        .closest('.echo-settings-panel-actions'),
    ).toBeTruthy()
    expect(
      within(llmPanel as HTMLElement)
        .getByRole('button', { name: /读取模型/ })
        .closest('.echo-settings-panel-actions'),
    ).toBeTruthy()
    expect(
      within(llmModelRow as HTMLElement).queryByRole('button', { name: /测试文本 AI/ }),
    ).toBeNull()
    expect(
      within(llmModelRow as HTMLElement).queryByRole('button', { name: /读取模型/ }),
    ).toBeNull()
  })

  it('configures local SenseVoice on port 9001 and tests it without an API key', async () => {
    renderSettings()

    openTab('麦克风')
    fireEvent.change(screen.getByDisplayValue('智谱 GLM ASR'), {
      target: { value: 'sensevoice-local' },
    })

    expect(useAppStore.getState().config.stt_provider).toBe('sensevoice-local')
    expect(useAppStore.getState().config.stt_custom_base_url).toBe('http://127.0.0.1:9001')

    fireEvent.click(screen.getByRole('button', { name: /测试识别/ }))

    await waitFor(() => {
      expect(tauriMocks.benchSttConnection).toHaveBeenCalledWith(
        '',
        'sensevoice-local',
        'http://127.0.0.1:9001',
        'SenseVoiceSmall',
      )
    })
  })

  it('masks provider API keys on readback and accepts manual replacement', () => {
    renderSettings()

    openTab('AI')
    const maskedLlmKey = screen.getByDisplayValue('ll****ey')
    fireEvent.focus(maskedLlmKey)
    fireEvent.change(maskedLlmKey, { target: { value: 'user-llm-key' } })
    expect(useAppStore.getState().config.llm_api_key).toBe('user-llm-key')

    fireEvent.blur(maskedLlmKey)
    expect(screen.getByDisplayValue('user****-key')).toBeInTheDocument()
  })

  it('surfaces backend-enabled TTS and plays through the proxy without exposing URLs', async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    const revokeObjectURL = vi.fn()
    const createObjectURL = vi.fn().mockReturnValue('blob:tts-preview')
    tauriMocks.proxyTtsOnce.mockResolvedValueOnce({ audioBytes: [1, 2, 3], mimeType: 'audio/mpeg' })
    class MockAudio {
      static instances: MockAudio[] = []
      onended: (() => void) | null = null
      onerror: (() => void) | null = null

      constructor(public src: string) {
        MockAudio.instances.push(this)
      }

      play = play
    }
    vi.stubGlobal('Audio', MockAudio)
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-06-29T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        services: {
          tts: {
            mode: 'proxy',
            providerId: 'openai',
            displayName: 'OpenAI TTS',
            defaultVoice: 'alloy',
          },
        },
      },
    })

    try {
      const first = renderSettings()
      openTab('AI')
      fireEvent.click(screen.getByRole('button', { name: /朗读测试/ }))

      await waitFor(() => {
        expect(tauriMocks.proxyTtsOnce).toHaveBeenCalledWith(
          'http://127.0.0.1:8787/echo-api',
          'desktop-token',
          'EcholIKE TTS preview',
          'alloy',
          92,
        )
        expect(play).toHaveBeenCalled()
      })
      expect(useAppStore.getState().ttsPlaybackBusy).toBe('preview')
      expect(screen.getByRole('button', { name: /朗读测试/ })).toBeDisabled()
      expect(tauriMocks.releaseTtsPlaybackOwner).not.toHaveBeenCalled()
      expect(revokeObjectURL).not.toHaveBeenCalled()

      first.unmount()
      renderSettings()
      openTab('AI')
      expect(screen.getByRole('button', { name: /朗读测试/ })).toBeDisabled()
      expect(tauriMocks.proxyTtsOnce).toHaveBeenCalledTimes(1)

      act(() => MockAudio.instances[0].onended?.())
      await waitFor(() => expect(useAppStore.getState().ttsPlaybackBusy).toBeNull())
      expect(tauriMocks.releaseTtsPlaybackOwner).toHaveBeenCalledWith(92)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:tts-preview')
      expect(screen.getByRole('button', { name: /朗读测试/ })).toBeEnabled()
      expect(document.body.textContent).not.toContain('audio/speech')
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      vi.unstubAllGlobals()
    }
  })

  it('reports an existing cross-window playback owner in the TTS panel', async () => {
    tauriMocks.acquireTtsPlaybackOwner.mockResolvedValueOnce(null)
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: { ...useAppStore.getState().config, config_source: 'backend' },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-06-29T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        services: { tts: { mode: 'proxy', defaultVoice: 'alloy' } },
      },
    })

    renderSettings()
    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /朗读测试/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('已有朗读任务正在进行，请稍后再试。')
    expect(tauriMocks.proxyTtsOnce).not.toHaveBeenCalled()
    expect(tauriMocks.releaseTtsPlaybackOwner).not.toHaveBeenCalled()
    expect(useAppStore.getState().ttsPlaybackBusy).toBeNull()
  })

  it.each(['error', 'rejection'] as const)(
    'releases preview ownership and revokes audio after %s',
    async (failureKind) => {
      const revokeObjectURL = vi.fn()
      const play =
        failureKind === 'rejection'
          ? vi.fn().mockRejectedValue(new Error('blocked'))
          : vi.fn().mockResolvedValue(undefined)
      class MockAudio {
        static instance: MockAudio
        onended: (() => void) | null = null
        onerror: (() => void) | null = null
        play = play
        constructor() {
          MockAudio.instance = this
        }
      }
      vi.stubGlobal('Audio', MockAudio)
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:failed-preview')
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL)
      localStorage.setItem('echolike.v2.authToken', 'desktop-token')
      useAppStore.setState({
        config: { ...useAppStore.getState().config, config_source: 'backend' },
        desktopBootstrap: {
          schemaVersion: 1,
          generatedAt: '2026-06-29T00:00:00.000Z',
          apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
          services: { tts: { mode: 'proxy', defaultVoice: 'alloy' } },
        },
      })

      renderSettings()
      openTab('AI')
      fireEvent.click(screen.getByRole('button', { name: /朗读测试/ }))
      await waitFor(() => expect(play).toHaveBeenCalled())
      if (failureKind === 'error') act(() => MockAudio.instance.onerror?.())

      await waitFor(() => expect(useAppStore.getState().ttsPlaybackBusy).toBeNull())
      expect(tauriMocks.releaseTtsPlaybackOwner).toHaveBeenCalledWith(92)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed-preview')
      expect(screen.getByRole('button', { name: /朗读测试/ })).toBeEnabled()
      expect(screen.getByRole('alert')).toHaveTextContent(
        failureKind === 'error' ? '朗读播放中断，请重试。' : '朗读播放被系统拦截，请重试。',
      )
    },
  )

  it('auto-dismisses backend TTS quota warnings from the panel', async () => {
    vi.useFakeTimers()
    const ttsQuotaMessage = '额度不足，请充值。'
    tauriMocks.proxyTtsOnce.mockRejectedValueOnce(new Error('quota exceeded'))
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-06-29T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        services: {
          tts: {
            mode: 'proxy',
            providerId: 'openai',
            displayName: 'OpenAI TTS',
            defaultVoice: 'alloy',
          },
        },
      },
    })

    try {
      renderSettings()
      openTab('AI')
      fireEvent.click(screen.getByRole('button', { name: /朗读测试/ }))

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(tauriMocks.proxyTtsOnce).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api',
        'desktop-token',
        'EcholIKE TTS preview',
        'alloy',
        92,
      )
      expect(toastMocks.toast).not.toHaveBeenCalledWith(
        ttsQuotaMessage,
        expect.anything(),
        expect.anything(),
      )
      const alert = screen.getByText(ttsQuotaMessage).closest('.echo-panel-alert')
      expect(alert).toHaveAttribute('role', 'alert')
      expect(alert?.closest('.echo-settings-panel')).toBeTruthy()
      expect(alert?.closest('.echo-settings-panel-header')).toBeTruthy()
      expect(alert?.closest('.echo-setting-line')).toBeNull()
      expect(screen.queryByText('TTS quota exceeded')).not.toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(7999)
      })
      expect(screen.getByText(ttsQuotaMessage)).toBeInTheDocument()

      openTab('系统')
      act(() => {
        vi.advanceTimersByTime(1)
      })
      openTab('AI')
      expect(screen.queryByText(ttsQuotaMessage)).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('configures and tests local Ollama OCR from the AI tab', async () => {
    renderSettings()

    openTab('AI')
    expect(screen.getByDisplayValue('http://127.0.0.1:11434')).toBeInTheDocument()
    expect(screen.getByDisplayValue('glm-ocr:latest')).toBeInTheDocument()
    expect(screen.getByText('截图与附件识别')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /读取窗口/ })).not.toBeInTheDocument()
    expect(screen.getByText('待测试')).toBeInTheDocument()
    expect(screen.queryByText('组件就绪')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /测试本机识别/ }))

    await waitFor(() => {
      expect(tauriMocks.testOcrConnection).toHaveBeenCalledWith(
        'http://127.0.0.1:11434',
        'glm-ocr:latest',
      )
    })
    expect(screen.getByText('组件就绪')).toBeInTheDocument()
    expect(useAppStore.getState().localOcrAvailability.status).toBe('available')
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringMatching(/OCR 服务可用/),
      expect.anything(),
      expect.anything(),
    )
    const ocrPanel = screen
      .getByRole('heading', { name: '截图与附件识别' })
      .closest('.echo-settings-panel')
    expect(ocrPanel?.querySelector('.echo-panel-alert')).toBeNull()

    fireEvent.change(screen.getByDisplayValue('glm-ocr:latest'), {
      target: { value: 'another-ocr-model' },
    })
    expect(useAppStore.getState().localOcrAvailability.status).toBe('idle')
    expect(screen.getByText('待测试')).toBeInTheDocument()
    expect(screen.queryByText('组件就绪')).not.toBeInTheDocument()
  })

  it('marks local OCR unavailable when the configured model cannot be reached', async () => {
    tauriMocks.testOcrConnection.mockResolvedValueOnce(unavailableLocalOcrCapabilities)
    renderSettings()

    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /测试本机识别/ }))

    await screen.findByText(
      '没有找到当前 OCR 模型，请在设置里换一个可用模型，或先在本机拉取该模型。',
    )
    expect(screen.getByText('不可用')).toBeInTheDocument()
    expect(useAppStore.getState().localOcrAvailability.status).toBe('unavailable')
    expect(screen.queryByText('组件就绪')).not.toBeInTheDocument()
  })

  it('reports image-only readiness without presenting the whole OCR chain as available', async () => {
    tauriMocks.testOcrConnection.mockResolvedValueOnce(imageOnlyLocalOcrCapabilities)
    renderSettings()

    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /测试本机识别/ }))

    await screen.findByText('图片就绪')
    const ocrPanel = screen
      .getByRole('heading', { name: '截图与附件识别' })
      .closest('.echo-settings-panel')
    expect(ocrPanel?.querySelector('.echo-panel-alert')).toHaveTextContent(
      /图片识别可用，PDF 文档组件不可用/,
    )
    expect(useAppStore.getState().settingsNotices.ocr?.phase).toBe('info')
    expect(useAppStore.getState().localOcrAvailability.capabilities).toMatchObject({
      imageAvailable: true,
      pdfAvailable: false,
    })
    expect(screen.queryByText('组件就绪')).not.toBeInTheDocument()
  })

  it('does not publish a stale OCR success after an A-to-B-to-A configuration change', async () => {
    let resolveProbe!: (capabilities: typeof availableLocalOcrCapabilities) => void
    tauriMocks.testOcrConnection.mockReturnValueOnce(
      new Promise<typeof availableLocalOcrCapabilities>((resolve) => {
        resolveProbe = resolve
      }),
    )
    renderSettings()
    openTab('AI')

    fireEvent.click(screen.getByRole('button', { name: /测试本机识别/ }))
    await waitFor(() => expect(tauriMocks.testOcrConnection).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByDisplayValue('glm-ocr:latest'), {
      target: { value: 'new-ocr-model' },
    })
    fireEvent.change(screen.getByDisplayValue('new-ocr-model'), {
      target: { value: 'glm-ocr:latest' },
    })

    await act(async () => resolveProbe(availableLocalOcrCapabilities))

    await screen.findByText('OCR 配置已变化，请重新测试。')
    expect(useAppStore.getState().localOcrAvailability.status).toBe('idle')
    expect(screen.getByText('待测试')).toBeInTheDocument()
    expect(screen.queryByText('组件就绪')).not.toBeInTheDocument()
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringMatching(/OCR 服务可用/),
      'success',
      expect.anything(),
    )
  })

  it('does not start a second local OCR probe while the current target is checking', () => {
    const configurationKey = localOcrConfigurationKey(useAppStore.getState().config)
    if (!configurationKey) throw new Error('Expected a complete local OCR configuration')
    expect(useAppStore.getState().beginLocalOcrProbe(configurationKey)).not.toBeNull()

    renderSettings()
    openTab('AI')

    expect(screen.getByText('测试中')).toBeInTheDocument()
    const testButton = screen.getByRole('button', { name: /测试本机识别/ })
    expect(testButton).toBeDisabled()
    fireEvent.click(testButton)
    expect(tauriMocks.testOcrConnection).not.toHaveBeenCalled()
  })

  it('keeps connection check results for the app session', async () => {
    const view = renderSettings()

    openTab('麦克风')
    fireEvent.click(screen.getByRole('button', { name: /测试识别/ }))
    await waitFor(() => {
      expect(tauriMocks.benchSttConnection).toHaveBeenCalled()
    })
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      'STT 连接正常：123ms',
      expect.anything(),
      expect.anything(),
    )
    expect(screen.getByText(/最近测试 123ms/)).toBeInTheDocument()
    const sttPanel = screen
      .getByRole('heading', { name: '语音识别' })
      .closest('.echo-settings-panel')
    expect(sttPanel?.querySelector('.echo-panel-alert')).toBeNull()

    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /测试文本 AI/ }))
    await waitFor(() => {
      expect(tauriMocks.benchLlmConnection).toHaveBeenCalled()
    })
    expect(screen.getByText(/最近测试 456ms/)).toBeInTheDocument()

    view.unmount()
    renderSettings()

    openTab('麦克风')
    expect(screen.getByText(/最近测试 123ms/)).toBeInTheDocument()
    openTab('AI')
    expect(screen.getByText(/最近测试 456ms/)).toBeInTheDocument()
  })

  it('keeps a pending connection test locked across remount and restores its result', async () => {
    let resolveStt!: (latency: number) => void
    tauriMocks.benchSttConnection.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStt = resolve
      }),
    )
    const first = renderSettings()
    openTab('麦克风')
    fireEvent.click(screen.getByRole('button', { name: /测试识别/ }))
    await waitFor(() => expect(tauriMocks.benchSttConnection).toHaveBeenCalledTimes(1))
    first.unmount()

    renderSettings()
    openTab('麦克风')
    expect(screen.getByRole('button', { name: /测试识别/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /测试识别/ }))
    expect(tauriMocks.benchSttConnection).toHaveBeenCalledTimes(1)
    resolveStt(321)
    await screen.findByText(/最近测试 321ms/)
    expect(screen.getByText(/最近测试 321ms/)).toBeInTheDocument()
  })

  it('silently drops stale connection, model, and proxy callbacks before side effects', async () => {
    let resolveStt!: (latency: number) => void
    tauriMocks.benchSttConnection.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStt = resolve
      }),
    )
    renderSettings()
    openTab('麦克风')
    fireEvent.click(screen.getByRole('button', { name: /测试识别/ }))
    const staleLease = useAppStore.getState().settingsOperation?.leaseId ?? -1
    useAppStore.getState().finishSettingsOperation(staleLease)
    useAppStore.getState().tryStartSettingsOperation('quota-refresh')
    toastMocks.toast.mockClear()
    resolveStt(999)
    await act(async () => undefined)
    expect(localStorage.getItem('echolike.connectionTests')).toBeNull()
    expect(toastMocks.toast).not.toHaveBeenCalled()

    useAppStore.setState({
      settingsOperation: null,
      config: {
        ...useAppStore.getState().config,
        llm_model: 'original-model',
        network_proxy_enabled: false,
        network_proxy_url: '',
      },
    })
    let resolveModels!: (models: string[]) => void
    tauriMocks.fetchLlmModels.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveModels = resolve
      }),
    )
    openTab('AI')
    fireEvent.click(screen.getByRole('button', { name: /读取模型/ }))
    const modelLease = useAppStore.getState().settingsOperation?.leaseId ?? -1
    useAppStore.getState().finishSettingsOperation(modelLease)
    useAppStore.getState().tryStartSettingsOperation('quota-refresh')
    resolveModels(['stale-model'])
    await act(async () => undefined)
    expect(useAppStore.getState().config.llm_model).toBe('original-model')
    expect(useAppStore.getState().llmModels).not.toContain('stale-model')

    useAppStore.setState({ settingsOperation: null })
    let resolveProxy!: (proxy: string) => void
    tauriMocks.detectSystemHttpProxy.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProxy = resolve
      }),
    )
    openTab('系统')
    fireEvent.click(screen.getByRole('button', { name: /使用当前系统 HTTP 代理/ }))
    const proxyLease = useAppStore.getState().settingsOperation?.leaseId ?? -1
    useAppStore.getState().finishSettingsOperation(proxyLease)
    useAppStore.getState().tryStartSettingsOperation('quota-refresh')
    resolveProxy('http://stale.example:7890')
    await act(async () => undefined)
    expect(useAppStore.getState().config.network_proxy_enabled).toBe(false)
    expect(useAppStore.getState().config.network_proxy_url).toBe('')
  })
})
