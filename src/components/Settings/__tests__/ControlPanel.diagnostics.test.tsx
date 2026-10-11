import { describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { useAppStore } from '../../../stores/appStore'
import {
  installControlPanelTestHarness,
  tauriMocks,
  renderSettings,
  openTab,
} from './controlPanelTestHarness'

describe('ControlPanel', () => {
  installControlPanelTestHarness()

  it('runs backend TTS diagnostics from the diagnostics tab', async () => {
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
        user: {
          email: 'owner@example.com',
          name: null,
          plan: 'pro',
          subscriptionEnd: null,
          quotaLevel: 1,
          quotaMultiplier: 1,
          adminRole: 'owner',
        },
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

    renderSettings()
    openTab('诊断')
    expect(screen.getByRole('heading', { name: '诊断' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /检查朗读服务/ }))

    await waitFor(() => {
      expect(tauriMocks.diagnoseTtsProxy).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api',
        'desktop-token',
        'EcholIKE TTS diagnostic',
        'alloy',
      )
    })
    expect(screen.getByText('朗读服务检查通过，已收到可播放音频。')).toBeInTheDocument()
    expect(screen.queryByText('TTS 代理返回了可播放音频。')).not.toBeInTheDocument()
    expect(screen.getByText(/tts\.ok=true/)).toBeInTheDocument()
    expect(tauriMocks.acknowledgeIdempotentOperation).toHaveBeenCalledWith(
      'tts-diagnostic-operation',
    )
    expect(document.body.textContent).not.toContain('desktop-token')
  })

  it('restores a selected PDF diagnostic that finishes after remount', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-06-29T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          email: 'owner@example.com',
          plan: 'pro',
          subscriptionEnd: null,
          quotaLevel: 1,
          quotaMultiplier: 1,
          adminRole: 'owner',
        },
      },
    })
    let resolvePdf!: (value: Awaited<ReturnType<typeof tauriMocks.diagnosePdfUpload>>) => void
    tauriMocks.diagnosePdfUpload.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePdf = resolve
      }),
    )
    const first = renderSettings()
    openTab('诊断')
    const file = new File([new Uint8Array([1, 2, 3])], 'pending.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('选择 PDF 诊断文件'), { target: { files: [file] } })
    await waitFor(() => expect(tauriMocks.diagnosePdfUpload).toHaveBeenCalledTimes(1))
    first.unmount()

    renderSettings()
    openTab('诊断')
    expect(screen.getAllByText(/pending\.pdf/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: /选择 PDF/ })).toBeDisabled()
    resolvePdf({
      ok: true,
      stage: 'complete',
      message: 'PDF 解析正常，共 2 页。',
      pageCount: 2,
      inputBytes: 3,
      elapsedMs: 9,
    })
    await screen.findByText('PDF 文件读取和页面解析正常，共 2 页。')
    expect(screen.queryByText('PDF 解析正常，共 2 页。')).not.toBeInTheDocument()
    expect(screen.getByText(/pdf\.pageCount=2/)).toBeInTheDocument()
    expect(tauriMocks.diagnosePdfUpload).toHaveBeenCalledTimes(1)
  })

  it('restores resolved TTS and PDF failures in their result rows without duplicate headers', async () => {
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-06-29T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          email: 'owner@example.com',
          plan: 'pro',
          subscriptionEnd: null,
          quotaLevel: 1,
          quotaMultiplier: 1,
          adminRole: 'owner',
        },
      },
    })
    tauriMocks.diagnoseTtsProxy.mockResolvedValueOnce({
      ok: false,
      stage: 'http',
      httpStatus: 502,
      code: 'upstream',
      message: 'TTS 上游失败。',
      requestId: 'req-fail',
      mimeType: null,
      audioBytes: null,
      elapsedMs: 12,
    })
    const first = renderSettings()
    openTab('诊断')
    fireEvent.click(screen.getByRole('button', { name: /检查朗读服务/ }))
    await screen.findByText('后台朗读服务暂时不可用，请稍后重试。')
    expect(tauriMocks.acknowledgeIdempotentOperation).not.toHaveBeenCalled()
    expect(screen.queryByText('TTS 上游失败。')).not.toBeInTheDocument()
    first.unmount()

    renderSettings()
    openTab('诊断')
    const panel = screen.getByRole('heading', { name: '诊断' }).closest('.echo-settings-panel')
    expect(panel?.querySelector('.echo-panel-alert')).toBeNull()
    expect(screen.getByText(/tts\.ok=false/)).toBeInTheDocument()
    expect(screen.getByText(/tts\.requestId=req-fail/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('TTS 上游失败。')

    tauriMocks.diagnosePdfUpload.mockResolvedValueOnce({
      ok: false,
      stage: 'parse',
      message: 'C:\\Users\\TestUser\\AppData\\Local\\Temp\\pdf-diagnostic.ps1:12 RuntimeException',
      pageCount: null,
      inputBytes: 3,
      elapsedMs: 4,
    })
    fireEvent.change(screen.getByLabelText('选择 PDF 诊断文件'), {
      target: {
        files: [new File([new Uint8Array([1, 2, 3])], 'broken.pdf', { type: 'application/pdf' })],
      },
    })
    await screen.findByText('PDF 文件检查未通过，请重新选择文件后重试。')
    expect(document.body.textContent).not.toMatch(/RuntimeException|\.ps1|C:\\Users/i)
    expect(panel?.querySelector('.echo-panel-alert')).toBeNull()
    expect(screen.getByText(/pdf\.ok=false/)).toBeInTheDocument()
  })

  it('clears only a stale TTS result when a new TTS diagnostic later throws', async () => {
    const staleTts = {
      ok: true,
      stage: 'audio' as const,
      httpStatus: 200,
      code: null,
      message: '旧 TTS 结果',
      requestId: null,
      mimeType: 'audio/mpeg',
      audioBytes: 3,
      elapsedMs: 10,
    }
    const stalePdf = {
      ok: true,
      stage: 'render' as const,
      message: '旧 PDF 结果',
      pageCount: 1,
      inputBytes: 3,
      elapsedMs: 20,
      fileName: 'previous.pdf',
    }
    const pdfFile = {
      fileName: 'previous.pdf',
      mimeType: 'application/pdf',
      fileBase64: 'cGRm',
      inputBytes: 3,
    }
    let rejectDiagnostic!: (reason: Error) => void
    tauriMocks.diagnoseTtsProxy.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectDiagnostic = reject
      }),
    )
    localStorage.setItem('echolike.v2.authToken', 'desktop-token')
    useAppStore.setState({
      desktopBootstrap: {
        schemaVersion: 1,
        generatedAt: '2026-07-17T00:00:00.000Z',
        apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
        user: {
          email: 'owner@example.com',
          plan: 'pro',
          subscriptionEnd: null,
          quotaLevel: 1,
          quotaMultiplier: 1,
          adminRole: 'owner',
        },
      },
      settingsDiagnosticsOutcome: {
        kind: 'combined',
        tts: staleTts,
        pdf: stalePdf,
        pdfFile,
      },
    })

    renderSettings()
    openTab('诊断')
    fireEvent.click(screen.getByRole('button', { name: /检查朗读服务/ }))
    await waitFor(() => expect(tauriMocks.diagnoseTtsProxy).toHaveBeenCalled())

    expect(useAppStore.getState().settingsDiagnosticsOutcome).toMatchObject({
      tts: null,
      pdf: stalePdf,
      pdfFile,
    })
    expect(useAppStore.getState().settingsOperation?.kind).toBe('tts-diagnostic')

    await act(async () => rejectDiagnostic(new Error('fresh TTS diagnostic failed')))
    await waitFor(() => {
      expect(useAppStore.getState().settingsNotices.diagnostics?.phase).toBe('error')
    })

    expect(useAppStore.getState().settingsDiagnosticsOutcome).toMatchObject({
      tts: null,
      pdf: stalePdf,
      pdfFile,
    })
    expect(screen.queryByText('旧 TTS 结果')).not.toBeInTheDocument()
    expect(screen.getByText(/pdf\.ok=true/)).toBeInTheDocument()
  })
})
