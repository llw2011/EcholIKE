import { describe } from 'vitest'
import { expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import type {
  FileCommandOwnerKey,
  FileCommandSnapshot,
  OcrReadResult,
  ScreenOcrSelectionOutcome,
} from '../../../lib/tauri'
import { workbenchTestHarness } from './workbenchTestHarness'

const {
  homePageFixture: HomePage,
  availableLocalOcrCapabilities,
  backendAiBootstrap,
  backendServerPipelineBootstrap,
  imageOnlyLocalOcrCapabilities,
  ocrResult,
  tauriMocks,
  toastMocks,
  unavailableLocalOcrCapabilities,
  useAppStore,
  useBackendServerPipeline,
  useFileCommandDomain,
} = workbenchTestHarness

describe('HomePage OCR', () => {
  it('surfaces the current attachment export capabilities on the AI workspace', () => {
    render(<HomePage />)

    expect(screen.getByRole('heading', { name: 'AI 工作台' })).toBeInTheDocument()
    expect(screen.getByLabelText('预设')).toHaveValue('default')
    expect(screen.getByText('Markdown')).toBeInTheDocument()
    expect(screen.getByText('Word')).toBeInTheDocument()
    expect(screen.getByText('PDF 图片')).toBeInTheDocument()
    expect(screen.getByText('表格结构')).toBeInTheDocument()
  })

  it('keeps default local OCR unavailable when the configured service and model probe fails', async () => {
    useAppStore.setState({
      localOcrAvailability: {
        configurationKey: null,
        status: 'idle',
        leaseId: null,
        capabilities: null,
      },
    })
    tauriMocks.testOcrConnection.mockResolvedValueOnce(unavailableLocalOcrCapabilities)

    render(<HomePage />)

    await waitFor(() => {
      expect(tauriMocks.testOcrConnection).toHaveBeenCalledWith(
        'http://127.0.0.1:11434',
        'glm-ocr:latest',
      )
    })
    expect(screen.getByLabelText(/AI 服务状态：OCR：本机不可用/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeDisabled()
    expect(tauriMocks.readScreenOcrSelection).not.toHaveBeenCalled()
  })

  it('enables local OCR actions only after the current service and model probe succeeds', async () => {
    useAppStore.setState({
      localOcrAvailability: {
        configurationKey: null,
        status: 'idle',
        leaseId: null,
        capabilities: null,
      },
    })
    tauriMocks.testOcrConnection.mockResolvedValueOnce(availableLocalOcrCapabilities)

    render(
      <StrictMode>
        <HomePage />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(screen.getByLabelText(/AI 服务状态：OCR：本机组件就绪/)).toBeInTheDocument()
    })
    expect(tauriMocks.testOcrConnection).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeEnabled()
  })

  it('keeps image OCR usable while rejecting PDF locally when only the router is ready', async () => {
    useAppStore.setState({
      localOcrAvailability: {
        configurationKey: null,
        status: 'idle',
        leaseId: null,
        capabilities: null,
      },
    })
    tauriMocks.testOcrConnection.mockResolvedValueOnce(imageOnlyLocalOcrCapabilities)

    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByLabelText(/AI 服务状态：OCR：本机图片就绪/)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeEnabled()

    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    expect(fileInput.accept).not.toContain('application/pdf')
    fireEvent.change(fileInput, {
      target: { files: [new File(['pdf'], 'document.pdf', { type: 'application/pdf' })] },
    })

    const dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(within(dialog).getByText(/本机 PDF 文档组件不可用/)).toBeInTheDocument()
    expect(tauriMocks.readUploadedOcr).not.toHaveBeenCalled()
  })

  it('does not probe or enable local OCR when its endpoint or model is blank', async () => {
    useAppStore.getState().updateConfig({ ocr_base_url: '', ocr_model: '' })

    render(<HomePage />)

    await Promise.resolve()
    expect(tauriMocks.testOcrConnection).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/AI 服务状态：OCR：缺配置/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeDisabled()
  })

  it('keeps local OCR unavailable when its automatic probe rejects', async () => {
    useAppStore.setState({
      localOcrAvailability: {
        configurationKey: null,
        status: 'idle',
        leaseId: null,
        capabilities: null,
      },
    })
    tauriMocks.testOcrConnection.mockRejectedValueOnce(new Error('native probe failed'))

    render(<HomePage />)

    await waitFor(() => {
      expect(useAppStore.getState().localOcrAvailability.status).toBe('unavailable')
    })
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('shows a progress dialog while screenshot OCR is running and then renders the result', async () => {
    let resolveOcr: (result: ScreenOcrSelectionOutcome) => void = () => {}
    tauriMocks.readScreenOcrSelection.mockReturnValue(
      new Promise<ScreenOcrSelectionOutcome>((resolve) => {
        resolveOcr = resolve
      }),
    )

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    expect(tauriMocks.readScreenOcrSelection).toHaveBeenCalledWith(
      'http://127.0.0.1:11434',
      'glm-ocr:latest',
    )
    const progressDialog = screen.getByRole('dialog', { name: '正在识别内容' })
    expect(progressDialog.querySelector('.echo-dialog-titlebar')).toHaveClass(
      'echo-dialog-titlebar--inline',
    )
    expect(
      screen.getByText(
        '正在打开系统截图工具。请框选要识别的区域，截图完成后 EcholIKE 会自动 OCR。',
      ),
    ).toBeInTheDocument()

    resolveOcr({ status: 'success', result: ocrResult })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '屏幕文字识别结果' })).toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: '订单' })).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByText('订单号 12345')).toBeInTheDocument()
    expect(screen.getByText('需要确认收货地址')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '字段' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '待确认' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'A | B' })).toBeInTheDocument()
    expect(screen.getByText('复制码 ABC')).toBeInTheDocument()
    expect(screen.queryByText('# 订单')).not.toBeInTheDocument()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('labels a pipeline fallback as degraded direct recognition without a duplicate toast', async () => {
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'dense-table.png',
      source_kind: 'upload',
      source_name: 'dense-table.png',
      page_count: 1,
      route: 'direct',
      processing_reason: 'pipeline-fallback:dense-layout',
      warnings: [
        '完整文档管线未完成，当前展示快速识别的降级结果。',
        'C:\\Temp\\ocr-job.ps1:12 RuntimeException',
        'Pipeline provider failed while preparing a fallback',
      ],
      degraded: true,
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['fake-image'], 'dense-table.png', { type: 'image/png' })] },
    })

    const dialog = await screen.findByRole('dialog', { name: '附件处理结果' })
    const warning = within(dialog).getByRole('alert')
    expect(warning).toHaveTextContent('完整文档识别未完成')
    expect(warning).toHaveTextContent('部分内容采用兼容方式识别，结果可能不完整。')
    expect(warning).not.toHaveTextContent(/Pipeline|RuntimeException|\.ps1|C:\\/i)
    expect(warning).not.toHaveTextContent('OCR 服务暂时不可用')
    expect(dialog).toHaveTextContent('直接识别')
    expect(toastMocks.toast).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getAllByRole('button', { name: '关闭' })[0])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      document.querySelector('.echo-ai-workspace .echo-ai-result-head span'),
    ).toHaveTextContent('直接识别 · 降级结果')
    expect(screen.getByRole('alert')).toHaveTextContent('完整文档识别未完成')
  })

  it('keeps a non-degraded document warning visible after the result dialog closes', async () => {
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'three-pages.pdf',
      source_kind: 'upload',
      source_name: 'three-pages.pdf',
      page_count: 3,
      route: 'pipeline',
      processing_reason: 'pdf-document',
      warnings: ['第 2 页未提取到文字，可能是空白页或该页识别不完整。'],
      degraded: false,
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['%PDF-1.7'], 'three-pages.pdf', { type: 'application/pdf' })] },
    })

    const dialog = await screen.findByRole('dialog', { name: '附件处理结果' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: '关闭' })[0])

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      document.querySelector('.echo-ai-workspace .echo-ai-result-head span'),
    ).toHaveTextContent('文档识别 · 有提示')
    expect(screen.getByRole('alert')).toHaveTextContent('第 2 页未提取到文字')
    expect(useAppStore.getState().ocrTask.pdfExportFile).toBeNull()
  })

  it('silently releases the OCR lease when the system screenshot is cancelled', async () => {
    tauriMocks.readScreenOcrSelection.mockResolvedValue({ status: 'cancelled' })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await waitFor(() => expect(useAppStore.getState().ocrTask.status).toBe('idle'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeEnabled()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('rejects unsupported image MIME types before invoking native OCR', async () => {
    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement

    fireEvent.change(fileInput, {
      target: { files: [new File(['GIF89a'], 'animation.gif', { type: 'image/gif' })] },
    })

    const dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(within(dialog).getByText('暂只支持 PNG、JPG、WebP、BMP 和 PDF。')).toBeInTheDocument()
    expect(tauriMocks.readUploadedOcr).not.toHaveBeenCalled()
    expect(tauriMocks.testOcrConnection).not.toHaveBeenCalled()
  })

  it('keeps background-continue semantics while still unlocking on native cancellation', async () => {
    let resolveOcr: (result: ScreenOcrSelectionOutcome) => void = () => {}
    tauriMocks.readScreenOcrSelection.mockReturnValue(
      new Promise<ScreenOcrSelectionOutcome>((resolve) => {
        resolveOcr = resolve
      }),
    )

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))
    fireEvent.click(screen.getByRole('button', { name: '后台继续' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useAppStore.getState().ocrTask.status).toBe('running')
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()

    await act(async () => resolveOcr({ status: 'cancelled' }))
    await waitFor(() => expect(useAppStore.getState().ocrTask.status).toBe('idle'))
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeEnabled()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('keeps one screenshot OCR lease across remount and restores its result', async () => {
    let resolveOcr: (result: ScreenOcrSelectionOutcome) => void = () => {}
    let resolveAcknowledgement: () => void = () => {}
    tauriMocks.readScreenOcrSelection.mockReturnValue(
      new Promise<ScreenOcrSelectionOutcome>((resolve) => {
        resolveOcr = resolve
      }),
    )
    tauriMocks.acknowledgeIdempotentOperation.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveAcknowledgement = resolve
      }),
    )
    const first = render(<HomePage />)
    const button = screen.getByRole('button', { name: /系统截图识别/ })

    fireEvent.click(button)
    fireEvent.click(button)
    expect(tauriMocks.readScreenOcrSelection).toHaveBeenCalledTimes(1)
    first.unmount()

    render(<HomePage />)
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()
    expect(screen.getByRole('dialog', { name: '正在识别内容' })).toBeInTheDocument()
    resolveOcr({
      status: 'success',
      result: { ...ocrResult, operation_id: 'ocr-operation-remount' },
    })

    expect(await screen.findByRole('dialog', { name: '屏幕文字识别结果' })).toBeInTheDocument()
    expect(tauriMocks.acknowledgeIdempotentOperation).toHaveBeenCalledWith('ocr-operation-remount')
    expect(useAppStore.getState().ocrTask.ackPending).toBe(true)
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()
    expect(useAppStore.getState().tryStartOcrTask('upload', 'blocked.png')).toBeNull()

    resolveAcknowledgement()
    await waitFor(() => expect(useAppStore.getState().ocrTask.ackPending).toBe(false))
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeEnabled()
  })

  it('deduplicates repeated shortcut requests while OCR is pending', async () => {
    tauriMocks.readScreenOcrSelection.mockReturnValue(
      new Promise<ScreenOcrSelectionOutcome>(() => undefined),
    )
    render(<HomePage />)

    act(() => useAppStore.getState().triggerScreenOcrShortcut())
    act(() => useAppStore.getState().triggerScreenOcrShortcut())

    await waitFor(() => expect(tauriMocks.readScreenOcrSelection).toHaveBeenCalledTimes(1))
  })

  it('consumes a shortcut requested before Home mounts exactly once across remounts', async () => {
    tauriMocks.readScreenOcrSelection.mockReturnValue(
      new Promise<ScreenOcrSelectionOutcome>(() => undefined),
    )
    act(() => useAppStore.getState().triggerScreenOcrShortcut())

    const first = render(<HomePage />)
    await waitFor(() => expect(tauriMocks.readScreenOcrSelection).toHaveBeenCalledTimes(1))
    first.unmount()
    render(<HomePage />)

    await waitFor(() => expect(tauriMocks.readScreenOcrSelection).toHaveBeenCalledTimes(1))
  })

  it('restores an OCR error that arrives after unmount', async () => {
    let rejectOcr: (error: Error) => void = () => {}
    tauriMocks.readScreenOcrSelection.mockReturnValue(
      new Promise<ScreenOcrSelectionOutcome>((_resolve, reject) => {
        rejectOcr = reject
      }),
    )
    const first = render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))
    first.unmount()
    rejectOcr(new Error('glm-ocr 模型不可用'))

    render(<HomePage />)
    const errorDialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(errorDialog.querySelector('.echo-dialog-titlebar')).toHaveClass(
      'echo-dialog-titlebar--inline',
    )
    expect(screen.getByText('glm-ocr 模型不可用')).toBeInTheDocument()
  })

  it('sends OCR Markdown into the editor without keeping the OCR dialog open', async () => {
    tauriMocks.readScreenOcrSelection.mockResolvedValue({ status: 'success', result: ocrResult })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '屏幕文字识别结果' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: '发送 OCR 到编辑器' }))

    expect(screen.queryByRole('dialog', { name: '屏幕文字识别结果' })).not.toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('订单页面')).toBeInTheDocument()
    expect(await screen.findByRole('textbox', { name: 'Markdown 源文' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '订单' })).toBeInTheDocument()
  })

  it('hides trailing empty OCR Markdown artifacts from GLM OCR output', async () => {
    tauriMocks.readScreenOcrSelection.mockResolvedValue({
      status: 'success',
      result: {
        ...ocrResult,
        text: ['Visible OCR text', '', '```', '```', '', '|', '|'].join('\n'),
      },
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await waitFor(() => {
      expect(screen.getByText('Visible OCR text')).toBeInTheDocument()
    })
    expect(document.querySelectorAll('.echo-markdown-code')).toHaveLength(0)

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:clean-docx'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    fireEvent.click(screen.getByRole('button', { name: /导出 Word/ }))

    await waitFor(() => {
      expect(tauriMocks.runExportMarkdownDocx).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ text: 'Visible OCR text' }),
        expect.any(String),
        true,
      )
    })
  })

  it('uploads an image attachment for OCR and renders Markdown', async () => {
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'table.png',
      source_kind: 'upload',
      source_name: 'table.png',
      page_count: 1,
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    const file = new File(['fake-image'], 'table.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(tauriMocks.readUploadedOcr).toHaveBeenCalledWith(
        'http://127.0.0.1:11434',
        'glm-ocr:latest',
        expect.objectContaining({
          fileName: 'table.png',
          mimeType: 'image/png',
          imageBase64: expect.any(String),
        }),
      )
    })
    expect(tauriMocks.readScreenOcr).not.toHaveBeenCalled()
    expect(tauriMocks.readScreenOcrSelection).not.toHaveBeenCalled()

    const resultDialog = await screen.findByRole('dialog', { name: '附件处理结果' })
    expect(resultDialog.querySelector('.echo-dialog-titlebar')).toHaveClass(
      'echo-dialog-titlebar--inline',
    )
    expect(screen.getByRole('button', { name: /下载 \.md/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /导出 Word/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /导出图片/ })).not.toBeInTheDocument()
  })

  it('keeps long uploaded OCR content inside scroll-contained result surfaces', async () => {
    const longText = Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 行识别内容`).join(
      '\n',
    )
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      text: longText,
      app_name: '上传附件',
      window_title: 'long-report.png',
      source_kind: 'upload',
      source_name: 'long-report.png',
      page_count: 1,
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['fake-image'], 'long-report.png', { type: 'image/png' })] },
    })

    const resultDialog = await screen.findByRole('dialog', { name: '附件处理结果' })
    expect(resultDialog.querySelector('.echo-screen-text-panel')).toHaveClass(
      'echo-screen-text-panel--scrollable',
    )
    expect(resultDialog).toHaveTextContent('第 200 行识别内容')

    fireEvent.click(within(resultDialog).getAllByRole('button', { name: '关闭' })[0])
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '附件处理结果' })).not.toBeInTheDocument()
    })

    const resultSurface = document.querySelector('.echo-ai-workspace .echo-answer-box')
    expect(resultSurface).toHaveClass('echo-answer-box--scrollable')
    expect(resultSurface).toHaveTextContent('第 200 行识别内容')
  })

  it('exports OCR Markdown as a Word document from the result dialog', async () => {
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'table.png',
      source_kind: 'upload',
      source_name: 'table.png',
      page_count: 1,
    })

    const view = render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    const file = new File(['fake-image'], 'table.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '附件处理结果' })).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: /下载 \.md/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /导出 Word/ }))

    await waitFor(() => {
      expect(tauriMocks.runExportMarkdownDocx).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          text: ocrResult.text,
          source_name: 'table.png',
        }),
        expect.any(String),
        true,
      )
    })
    const resultDialog = screen.getByRole('dialog', { name: '附件处理结果' })
    expect(await within(resultDialog).findByRole('status')).toHaveTextContent(
      'Word 已保存到：C:\\Users\\TestUser\\Downloads\\report.docx',
    )
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('Word 已保存到'),
      'success',
    )
    expect(useFileCommandDomain.getState().ocrFeedback?.message).toContain('Word 已保存到')

    view.unmount()
    render(<HomePage />)
    const restoredDialog = await screen.findByRole('dialog', { name: '附件处理结果' })
    expect(within(restoredDialog).getByRole('status')).toHaveTextContent('Word 已保存到')
  })

  it('keeps OCR copy feedback inside the result dialog instead of the global toast layer', async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    tauriMocks.readScreenOcrSelection.mockResolvedValue({ status: 'success', result: ocrResult })

    try {
      render(<HomePage />)
      fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))
      const resultDialog = await screen.findByRole('dialog', { name: '屏幕文字识别结果' })
      toastMocks.toast.mockClear()

      fireEvent.click(within(resultDialog).getByRole('button', { name: '复制 Markdown' }))

      expect(await within(resultDialog).findByRole('status')).toHaveTextContent('结果已复制。')
      expect(writeText).toHaveBeenCalledWith(ocrResult.text)
      expect(toastMocks.toast).not.toHaveBeenCalled()
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      } else {
        Reflect.deleteProperty(navigator, 'clipboard')
      }
    }
  })

  it('keeps same-source OCR runs isolated from an older pending export and feedback', async () => {
    tauriMocks.readScreenOcrSelection.mockResolvedValue({ status: 'success', result: ocrResult })
    let resolveOldExport!: () => void
    let oldExportKey!: FileCommandOwnerKey
    let oldRequestFingerprint = ''
    tauriMocks.runExportMarkdownDocx.mockImplementationOnce(
      (key, _result, requestFingerprint) =>
        new Promise<FileCommandSnapshot>((resolve) => {
          oldExportKey = key
          oldRequestFingerprint = requestFingerprint
          resolveOldExport = () =>
            resolve({
              key,
              ownerWindow: 'main',
              requestFingerprint,
              outcome: {
                status: 'success',
                leaseId: 501,
                path: 'C:\\Users\\TestUser\\Downloads\\old-report.docx',
                message: 'saved',
              },
            })
        }),
    )

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))
    const firstDialog = await screen.findByRole('dialog', { name: '屏幕文字识别结果' })
    const firstRunId = useAppStore.getState().ocrTask.runId
    fireEvent.click(within(firstDialog).getByRole('button', { name: /导出 Word/ }))
    await waitFor(() => {
      expect(tauriMocks.runExportMarkdownDocx).toHaveBeenCalledTimes(1)
    })
    act(() => {
      useFileCommandDomain.getState().accept({
        key: oldExportKey,
        ownerWindow: 'main',
        requestFingerprint: oldRequestFingerprint,
        outcome: { status: 'running', leaseId: 501 },
      })
    })
    await waitFor(() => {
      expect(within(firstDialog).getByRole('button', { name: /导出中/ })).toBeDisabled()
    })

    fireEvent.click(within(firstDialog).getAllByRole('button', { name: '关闭' })[0])
    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    const secondDialog = await screen.findByRole('dialog', { name: '屏幕文字识别结果' })
    const secondRunId = useAppStore.getState().ocrTask.runId
    expect(secondRunId).not.toBe(firstRunId)
    expect(within(secondDialog).getByRole('button', { name: /导出 Word/ })).toBeEnabled()
    expect(within(secondDialog).queryByText(/old-report\.docx/)).not.toBeInTheDocument()

    resolveOldExport()
    await waitFor(() => {
      expect(useFileCommandDomain.getState().ocrFeedback?.resourceId).toBe(`ocr:${firstRunId}`)
    })
    expect(within(secondDialog).queryByText(/old-report\.docx/)).not.toBeInTheDocument()
  })

  it('sanitizes Markdown download file names before saving', async () => {
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'CON?.png',
      source_kind: 'upload',
      source_name: 'CON?.png',
      page_count: 1,
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    const file = new File(['fake-image'], 'CON?.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '附件处理结果' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /下载 \.md/ }))

    await waitFor(() => {
      expect(tauriMocks.runExportMarkdownFile).toHaveBeenCalledWith(
        expect.objectContaining({ commandKind: 'exportMarkdown' }),
        'CON-file.md',
        ocrResult.text,
        expect.any(String),
      )
    })
    const resultDialog = screen.getByRole('dialog', { name: '附件处理结果' })
    expect(await within(resultDialog).findByRole('status')).toHaveTextContent(
      'Markdown 已保存到：C:\\Users\\TestUser\\Downloads\\CON-file.md',
    )
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('Markdown 已保存到'),
      'success',
    )
  })

  it('silently closes a cancelled native Markdown save dialog', async () => {
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'report.pdf',
      source_kind: 'upload',
      source_name: 'report.pdf',
      page_count: 2,
    })
    tauriMocks.runExportMarkdownFile.mockImplementationOnce(
      async (key, _name, _text, requestFingerprint) => ({
        key,
        requestFingerprint,
        outcome: { status: 'cancelled', leaseId: 41 },
      }),
    )

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File([new Uint8Array([37, 80, 68, 70])], 'report.pdf', {
            type: 'application/pdf',
          }),
        ],
      },
    })
    await screen.findByRole('dialog', { name: '附件处理结果' })
    toastMocks.toast.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /下载 \.md/ }))

    await waitFor(() => expect(tauriMocks.consumeFileCommandTask).toHaveBeenCalled())
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('does not report success when a binary export returns an empty file', async () => {
    tauriMocks.runExportMarkdownDocx.mockImplementationOnce(
      async (key, _result, requestFingerprint) => ({
        key,
        requestFingerprint,
        outcome: { status: 'error', leaseId: 41, error: '导出文件为空，已取消保存。' },
      }),
    )
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'table.png',
      source_kind: 'upload',
      source_name: 'table.png',
      page_count: 1,
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    const file = new File(['fake-image'], 'table.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '附件处理结果' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /导出 Word/ }))

    await waitFor(() => {
      expect(tauriMocks.runExportMarkdownDocx).toHaveBeenCalled()
    })
    const resultDialog = screen.getByRole('dialog', { name: '附件处理结果' })
    expect(await within(resultDialog).findByRole('alert')).toHaveTextContent(
      '导出文件为空，已取消保存。',
    )
    expect(toastMocks.toast).not.toHaveBeenCalledWith('导出文件为空，已取消保存。', 'error')
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('Word 已保存到：'),
      'success',
    )
  })

  it('exports uploaded PDF pages as images from the attachment result', async () => {
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'report.pdf',
      source_kind: 'upload',
      source_name: 'report.pdf',
      page_count: 2,
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'report.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '附件处理结果' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /导出图片/ }))

    await waitFor(() => {
      expect(tauriMocks.runExportPdfImages).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          fileBase64: expect.any(String),
        }),
        expect.any(String),
      )
    })
    const resultDialog = screen.getByRole('dialog', { name: '附件处理结果' })
    expect(await within(resultDialog).findByRole('status')).toHaveTextContent(
      '已导出 2 页图片包：C:\\Users\\TestUser\\Downloads\\report-pages.zip',
    )
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('keeps Word available while PDF images are exporting', async () => {
    let resolveExport: (value: unknown) => void = () => {}
    tauriMocks.runExportPdfImages.mockReturnValue(
      new Promise((resolve) => {
        resolveExport = resolve
      }),
    )
    tauriMocks.readUploadedOcr.mockResolvedValue({
      ...ocrResult,
      app_name: '上传附件',
      window_title: 'report.pdf',
      source_kind: 'upload',
      source_name: 'report.pdf',
      page_count: 2,
    })

    const view = render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /上传附件处理/ }))
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'report.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '附件处理结果' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /导出图片/ }))
    await waitFor(() => expect(tauriMocks.runExportPdfImages).toHaveBeenCalledTimes(1))
    const commandKey = tauriMocks.runExportPdfImages.mock.calls[0][0]
    const resourceId = commandKey.resourceId
    act(() => {
      useFileCommandDomain.getState().accept({
        key: commandKey,
        requestFingerprint: 'pdf',
        outcome: { status: 'running', leaseId: 77 },
      })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /导出中/ })).toBeDisabled()
    })
    expect(screen.getByRole('button', { name: /导出 Word/ })).toBeEnabled()
    view.unmount()
    render(<HomePage />)
    expect(screen.getByRole('button', { name: /导出中/ })).toBeDisabled()
    expect(tauriMocks.runExportPdfImages).toHaveBeenCalledTimes(1)

    resolveExport({
      key: { resourceId, commandKind: 'exportPdf' },
      requestFingerprint: 'pdf',
      outcome: {
        status: 'success',
        leaseId: 77,
        path: 'C:\\Users\\TestUser\\Downloads\\report-pages.zip',
        message: '已导出 2 页图片包',
      },
    })

    const restoredDialog = screen.getByRole('dialog', { name: '附件处理结果' })
    expect(await within(restoredDialog).findByRole('status')).toHaveTextContent(
      '已导出 2 页图片包：C:\\Users\\TestUser\\Downloads\\report-pages.zip',
    )
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('keeps a failure dialog visible without replacing it with a shallow component reprobe', async () => {
    tauriMocks.readScreenOcrSelection.mockRejectedValue(new Error('glm-ocr 模型不可用'))

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '识别未完成' })).toBeInTheDocument()
    })
    expect(screen.getByText('glm-ocr 模型不可用')).toBeInTheDocument()
    expect(useAppStore.getState().localOcrAvailability.status).toBe('available')
    expect(tauriMocks.testOcrConnection).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeEnabled()
  })

  it('keeps local OCR available when only the screenshot helper fails', async () => {
    tauriMocks.readScreenOcrSelection.mockRejectedValue(new Error('截图工具启动失败'))

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await screen.findByRole('dialog', { name: '识别未完成' })
    expect(tauriMocks.testOcrConnection).not.toHaveBeenCalled()
    expect(useAppStore.getState().localOcrAvailability.status).toBe('available')
  })

  it('uses backend OCR proxy when cloud OCR is enabled and authenticated', async () => {
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
      expect(tauriMocks.readScreenOcrSelectionProxy).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/echo-api',
        'valid-pro-token',
      )
    })
    expect(tauriMocks.readScreenOcr).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '屏幕文字识别结果' })).toBeInTheDocument()
    })
  })

  it('honors an explicit image-only backend OCR capability', async () => {
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: {
        ...backendAiBootstrap,
        services: {
          ...backendAiBootstrap.services,
          ocr: {
            ...backendAiBootstrap.services?.ocr,
            mode: 'proxy',
            capabilities: {
              imageAvailable: true,
              pdfAvailable: false,
              acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
              maxInputBytes: 25 * 1024 * 1024,
              maxPdfPages: 0,
              processingRoutes: ['direct'],
              pdfMode: 'unsupported',
            },
          },
        },
      },
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    render(<HomePage />)

    expect(screen.getByLabelText(/AI 服务状态：OCR：后台图片就绪/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeEnabled()

    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    expect(fileInput.accept).toContain('image/png')
    expect(fileInput.accept).not.toContain('application/pdf')
    expect(fileInput.accept).not.toContain('image/bmp')
    fireEvent.change(fileInput, {
      target: { files: [new File(['%PDF-1.7'], 'document.pdf', { type: 'application/pdf' })] },
    })

    const dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(within(dialog).getByText(/后台托管 PDF 识别不可用/)).toBeInTheDocument()
    expect(tauriMocks.readUploadedOcrProxy).not.toHaveBeenCalled()
  })

  it('allows backend PDF upload without enabling screenshots when only PDF is available', async () => {
    tauriMocks.readUploadedOcrProxy.mockResolvedValueOnce({
      ...ocrResult,
      source_kind: 'upload',
      source_name: 'document.pdf',
      page_count: 1,
    })
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: {
        ...backendAiBootstrap,
        services: {
          ...backendAiBootstrap.services,
          ocr: {
            ...backendAiBootstrap.services?.ocr,
            mode: 'proxy',
            capabilities: {
              imageAvailable: false,
              pdfAvailable: true,
              acceptedMimeTypes: ['application/pdf'],
              maxInputBytes: 25 * 1024 * 1024,
              maxPdfPages: 20,
              processingRoutes: ['direct'],
              pdfMode: 'client-rasterized',
            },
          },
        },
      },
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    render(<HomePage />)

    expect(screen.getByLabelText(/AI 服务状态：OCR：后台 PDF 就绪/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeEnabled()

    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    expect(fileInput.accept).toContain('application/pdf')
    expect(fileInput.accept).not.toContain('image/png')
    fireEvent.change(fileInput, {
      target: { files: [new File(['%PDF-1.7'], 'document.pdf', { type: 'application/pdf' })] },
    })

    await waitFor(() => expect(tauriMocks.readUploadedOcrProxy).toHaveBeenCalledTimes(1))
    expect(tauriMocks.readUploadedPdfProxy).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: '附件处理结果' })).toBeInTheDocument()
  })

  it('keeps legacy bootstrap PDF uploads usable when capabilities are absent', async () => {
    tauriMocks.readUploadedOcrProxy.mockResolvedValueOnce({
      ...ocrResult,
      source_kind: 'upload',
      source_name: 'legacy.pdf',
      page_count: 1,
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
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement
    expect(fileInput.accept).toContain('application/pdf')
    fireEvent.change(fileInput, {
      target: { files: [new File(['%PDF-1.7'], 'legacy.pdf', { type: 'application/pdf' })] },
    })

    await waitFor(() => expect(tauriMocks.readUploadedOcrProxy).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('dialog', { name: '附件处理结果' })).toBeInTheDocument()
  })

  it('shows a readable PDF page-limit error without marking the backend service unhealthy', async () => {
    const raw = [
      '后台托管 OCR 请求失败：PDF has 68 pages; the current OCR upload limit is 20 pages.',
      'C:\\Users\\TestUser\\AppData\\Local\\Temp\\echolike-ocr.ps1:51 字符: 3',
      'CategoryInfo : OperationStopped: (PDF has 68 pages:String) [], RuntimeException',
    ].join('\n')
    tauriMocks.readUploadedOcrProxy.mockRejectedValueOnce(new Error(raw))
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendAiBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    render(<HomePage />)
    fireEvent.change(screen.getByLabelText('上传图片或 PDF 处理'), {
      target: {
        files: [new File(['%PDF-1.7'], 'large.pdf', { type: 'application/pdf' })],
      },
    })

    const dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(
      within(dialog).getByText('这份 PDF 共 68 页，当前一次最多处理 20 页。请拆分后重试。'),
    ).toBeInTheDocument()
    expect(dialog).not.toHaveTextContent(/CategoryInfo|RuntimeException|\.ps1|C:\\/i)
    expect(useAppStore.getState().ocrTask.diagnostic).toBeNull()
    expect(document.body.textContent).not.toContain('后台托管异常')
  })

  it('uploads original PDF content through the negotiated server pipeline command', async () => {
    tauriMocks.readUploadedPdfProxy.mockResolvedValueOnce({
      ...ocrResult,
      source_kind: 'upload',
      source_name: 'document.pdf',
      page_count: 1,
      route: 'pipeline',
      processing_reason: 'server-pdf-pipeline',
    })
    useBackendServerPipeline()

    render(<HomePage />)

    expect(screen.getByRole('button', { name: /系统截图识别/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeEnabled()

    const document = new File(['%PDF-1.7 original bytes'], 'document.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(screen.getByLabelText('上传图片或 PDF 处理'), {
      target: { files: [document] },
    })

    await waitFor(() => expect(tauriMocks.readUploadedPdfProxy).toHaveBeenCalledTimes(1))
    expect(tauriMocks.readUploadedPdfProxy).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/echo-api',
      'valid-pro-token',
      expect.objectContaining({
        fileName: 'document.pdf',
        mimeType: 'application/pdf',
        fileBase64: expect.any(String),
      }),
    )
    expect(tauriMocks.readUploadedOcrProxy).not.toHaveBeenCalled()
    expect(tauriMocks.readUploadedOcr).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: '附件处理结果' })).toHaveTextContent(
      '文档识别',
    )
  })

  it('rejects an uncontracted server-pipeline PDF capability', () => {
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    const bootstrap = backendServerPipelineBootstrap()
    useAppStore.setState({
      desktopBootstrap: {
        ...bootstrap,
        services: {
          ...bootstrap.services,
          ocr: {
            ...bootstrap.services?.ocr,
            mode: 'proxy',
            configured: true,
            capabilities: {
              ...bootstrap.services?.ocr?.capabilities,
              documentContract: undefined,
            },
          },
        },
      },
      config: { ...useAppStore.getState().config, config_source: 'backend' },
    })

    render(<HomePage />)

    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeDisabled()
    expect((screen.getByLabelText('上传图片或 PDF 处理') as HTMLInputElement).accept).not.toContain(
      'application/pdf',
    )
    expect(tauriMocks.readUploadedPdfProxy).not.toHaveBeenCalled()
  })

  it('keeps structured document 4xx errors on the OCR result without poisoning service health', async () => {
    tauriMocks.readUploadedPdfProxy.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          service: 'ocr',
          status: 422,
          code: 'ocr_document_page_limit',
          message: 'PDF has 21 pages',
          requestId: 'req-pdf-page-limit',
        }),
      ),
    )
    useBackendServerPipeline()

    render(<HomePage />)
    fireEvent.change(screen.getByLabelText('上传图片或 PDF 处理'), {
      target: {
        files: [new File(['%PDF-1.7'], 'too-many-pages.pdf', { type: 'application/pdf' })],
      },
    })

    const dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(dialog).toHaveTextContent('请求 ID：req-pdf-page-limit')
    expect(useAppStore.getState().ocrTask.diagnostic).toMatchObject({
      status: 422,
      code: 'ocr_document_page_limit',
    })
    expect(document.body.textContent).not.toContain('后台托管异常')
    expect(tauriMocks.readUploadedOcrProxy).not.toHaveBeenCalled()
  })

  it('marks a negotiated PDF pipeline 5xx without letting a later document 4xx clear it', async () => {
    tauriMocks.readUploadedPdfProxy.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          service: 'ocr',
          status: 503,
          code: 'ocr_pipeline_unavailable',
          message: 'Document pipeline unavailable',
          requestId: 'req-pdf-pipeline-down',
        }),
      ),
    )
    useBackendServerPipeline()

    render(<HomePage />)
    fireEvent.change(screen.getByLabelText('上传图片或 PDF 处理'), {
      target: { files: [new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' })] },
    })

    const dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(dialog).toHaveTextContent('请求 ID：req-pdf-pipeline-down')
    expect(screen.getByLabelText(/AI 服务状态：OCR：后台托管异常/)).toBeInTheDocument()
    expect(tauriMocks.readUploadedOcrProxy).not.toHaveBeenCalled()
    expect(tauriMocks.readUploadedOcr).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getAllByRole('button', { name: '关闭' })[1])
    tauriMocks.readUploadedPdfProxy.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          service: 'ocr',
          status: 422,
          code: 'ocr_document_invalid',
          message: 'Invalid PDF',
          requestId: 'req-pdf-invalid-after-503',
        }),
      ),
    )
    fireEvent.change(screen.getByLabelText('上传图片或 PDF 处理'), {
      target: { files: [new File(['%PDF-1.7'], 'invalid.pdf', { type: 'application/pdf' })] },
    })

    expect(await screen.findByText('请求 ID：req-pdf-invalid-after-503')).toBeInTheDocument()
    expect(screen.getByLabelText(/AI 服务状态：OCR：后台托管异常/)).toBeInTheDocument()
    expect(tauriMocks.readUploadedOcrProxy).not.toHaveBeenCalled()
  })

  it('keeps one negotiated PDF pipeline lease across Home remounts', async () => {
    let resolvePdf: (result: OcrReadResult) => void = () => {}
    tauriMocks.readUploadedPdfProxy.mockReturnValueOnce(
      new Promise<OcrReadResult>((resolve) => {
        resolvePdf = resolve
      }),
    )
    useBackendServerPipeline()

    const first = render(<HomePage />)
    fireEvent.change(screen.getByLabelText('上传图片或 PDF 处理'), {
      target: { files: [new File(['%PDF-1.7'], 'pending.pdf', { type: 'application/pdf' })] },
    })
    await waitFor(() => expect(tauriMocks.readUploadedPdfProxy).toHaveBeenCalledTimes(1))
    first.unmount()

    render(<HomePage />)
    expect(screen.getByRole('button', { name: /上传附件处理/ })).toBeDisabled()
    expect(screen.getByRole('dialog', { name: '正在识别内容' })).toBeInTheDocument()
    resolvePdf({
      ...ocrResult,
      source_kind: 'upload',
      source_name: 'pending.pdf',
      page_count: 1,
      route: 'pipeline',
      processing_reason: 'server-pdf-pipeline',
    })

    expect(await screen.findByRole('dialog', { name: '附件处理结果' })).toBeInTheDocument()
    expect(tauriMocks.readUploadedPdfProxy).toHaveBeenCalledTimes(1)
  })

  it('does not expose a PDF transport endpoint from structured OCR failures', async () => {
    tauriMocks.readUploadedPdfProxy.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          service: 'ocr',
          status: 502,
          code: 'ocr_failed',
          message: 'connect error https://private.example.test/proxy/ocr/document',
        }),
      ),
    )
    useBackendServerPipeline()

    render(<HomePage />)
    fireEvent.change(screen.getByLabelText('上传图片或 PDF 处理'), {
      target: { files: [new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' })] },
    })

    const dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(dialog).toHaveTextContent('后台 OCR 服务暂时不可用')
    expect(dialog).not.toHaveTextContent('private.example.test')
    expect(dialog).not.toHaveTextContent('/proxy/ocr/document')
    expect(screen.getByLabelText(/AI 服务状态：OCR：后台托管异常/)).toBeInTheDocument()
  })

  it('enforces backend OCR MIME and byte limits before invoking the proxy', async () => {
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: {
        ...backendAiBootstrap,
        services: {
          ...backendAiBootstrap.services,
          ocr: {
            ...backendAiBootstrap.services?.ocr,
            mode: 'proxy',
            capabilities: {
              imageAvailable: true,
              pdfAvailable: false,
              acceptedMimeTypes: ['image/png'],
              maxInputBytes: 3,
              maxPdfPages: 0,
              processingRoutes: ['direct'],
              pdfMode: 'unsupported',
            },
          },
        },
      },
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
      },
    })

    render(<HomePage />)
    const fileInput = document.querySelector(
      'input[aria-label="上传图片或 PDF 处理"]',
    ) as HTMLInputElement

    fireEvent.change(fileInput, {
      target: { files: [new File(['bmp'], 'image.bmp', { type: 'image/bmp' })] },
    })
    let dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(within(dialog).getByText('后台托管 OCR 不支持该附件格式。')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByText('关闭'))

    fireEvent.change(fileInput, {
      target: { files: [new File(['four'], 'image.png', { type: 'image/png' })] },
    })
    dialog = await screen.findByRole('dialog', { name: '识别未完成' })
    expect(within(dialog).getByText('上传附件不能超过 3 B。')).toBeInTheDocument()
    expect(tauriMocks.readUploadedOcrProxy).not.toHaveBeenCalled()
  })

  it('treats a cancelled backend screenshot as a clean local UI cancellation', async () => {
    tauriMocks.readScreenOcrSelectionProxy.mockResolvedValue({ status: 'cancelled' })
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendAiBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
        ocr_base_url: 'http://127.0.0.1:11434',
        ocr_model: 'glm-ocr:latest',
      },
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await waitFor(() => expect(useAppStore.getState().ocrTask.status).toBe('idle'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tauriMocks.readScreenOcrSelection).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('后台托管异常')
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })

  it('does not fall back to local OCR when backend OCR proxy fails', async () => {
    tauriMocks.readScreenOcrSelectionProxy.mockRejectedValue(
      new Error(
        JSON.stringify({
          service: 'ocr',
          status: 504,
          code: 'ocr_timeout',
          message: 'Cloud OCR timed out',
          requestId: 'req-ocr-timeout',
        }),
      ),
    )
    tauriMocks.readScreenOcrSelection.mockResolvedValue({ status: 'success', result: ocrResult })
    localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
    useAppStore.setState({
      desktopBootstrap: backendAiBootstrap,
      config: {
        ...useAppStore.getState().config,
        config_source: 'backend',
        ocr_base_url: 'http://127.0.0.1:11434',
        ocr_model: 'glm-ocr:latest',
      },
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: /系统截图识别/ }))

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '识别未完成' })).toBeInTheDocument()
    })
    expect(screen.getByText(/OCR 服务响应超时/)).toBeInTheDocument()
    expect(screen.getByText('请求 ID：req-ocr-timeout')).toBeInTheDocument()
    expect(useAppStore.getState().ocrTask.diagnostic).toEqual({
      service: 'ocr',
      status: 504,
      code: 'ocr_timeout',
      requestId: 'req-ocr-timeout',
      stage: null,
    })
    expect(tauriMocks.readScreenOcrSelection).not.toHaveBeenCalled()
  })
})
