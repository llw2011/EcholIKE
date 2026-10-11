import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditorShell } from '../MarkdownEditorShell'
import type { MarkdownDraft } from '../markdownDraft'
import { markdownDraftRevision, useMarkdownAiDomain } from '../markdownAiTask'

const windowMocks = vi.hoisted(() => ({
  label: 'main',
  startDragging: vi.fn().mockResolvedValue(undefined),
}))
const aiMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue([]),
  consume: vi.fn().mockResolvedValue(true),
}))
const speechMocks = vi.hoisted(() => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
  getState: vi.fn().mockImplementation(async (key) => ({
    key,
    task: null,
    currentAsset: null,
    latestAsset: null,
    directoryPath: 'C:\\Users\\TestUser\\Documents\\EcholIKE\\朗读音频',
  })),
  start: vi.fn(),
  read: vi.fn(),
  openDirectory: vi.fn().mockResolvedValue(undefined),
  reveal: vi.fn().mockResolvedValue(undefined),
  acquire: vi.fn().mockResolvedValue({ leaseId: 90, ownerWindow: 'main' }),
  release: vi.fn().mockResolvedValue(true),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMocks,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: speechMocks.listen }))
vi.mock('../../../lib/tauri', () => ({
  getMarkdownAiTasks: aiMocks.get,
  consumeMarkdownAiTask: aiMocks.consume,
  getMarkdownSpeechState: speechMocks.getState,
  startMarkdownSpeechGeneration: speechMocks.start,
  readMarkdownSpeechAudio: speechMocks.read,
  openMarkdownSpeechDirectory: speechMocks.openDirectory,
  revealMarkdownSpeechAsset: speechMocks.reveal,
  acquireTtsPlaybackOwner: speechMocks.acquire,
  releaseTtsPlaybackOwner: speechMocks.release,
}))

function makeDraft(overrides: Partial<MarkdownDraft> = {}): MarkdownDraft {
  return {
    id: 'draft-1',
    title: '整理结果',
    text: [
      '# 订单',
      '',
      '- 订单号 12345',
      '',
      '| 字段 | 值 |',
      '| --- | --- |',
      '| 状态 | 待确认 |',
    ].join('\n'),
    source: 'screen_ocr',
    sourceName: '订单页面',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    dirty: false,
    ...overrides,
  }
}

function snapshot(draft: MarkdownDraft, revision: string, status: 'running' | 'success' | 'error') {
  return {
    key: {
      draftId: draft.id,
      request: {
        action: 'polish' as const,
        target: { kind: 'fullDocument' as const },
        draftRevision: revision,
        semanticFingerprint: 'scope',
      },
    },
    outcome:
      status === 'running'
        ? ({ status, leaseId: 41 } as const)
        : status === 'success'
          ? ({ status, leaseId: 41, output: 'AI result' } as const)
          : ({ status, leaseId: 41, error: 'AI failed' } as const),
    applyContext: { fullText: draft.text, text: draft.text, title: draft.title },
  }
}

function testRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  }
}

describe('MarkdownEditorShell', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    speechMocks.getState.mockImplementation(async (key) => ({
      key,
      task: null,
      currentAsset: null,
      latestAsset: null,
      directoryPath: 'C:\\Users\\TestUser\\Documents\\EcholIKE\\朗读音频',
    }))
    speechMocks.start.mockReset()
    useMarkdownAiDomain.getState().reset()
    localStorage.removeItem('echolike.markdownEditor.scrollSync.v1')
    document.documentElement.className = ''
    delete document.documentElement.dataset.themeProfile
  })

  it('restores running across shell remount and receives terminal outcome without a second request', async () => {
    const draft = makeDraft()
    const revision = markdownDraftRevision(`${draft.title}\0${draft.text}`)
    const running = snapshot(draft, revision, 'running')
    useMarkdownAiDomain.getState().accept(running)
    const onAiRequest = vi.fn()
    const first = render(
      <MarkdownEditorShell draft={draft} onAiRequest={onAiRequest} aiAvailable />,
    )
    expect(screen.getByRole('button', { name: '润色中' })).toBeDisabled()
    first.unmount()
    render(<MarkdownEditorShell draft={draft} onAiRequest={onAiRequest} aiAvailable />)
    expect(screen.getByRole('button', { name: '润色中' })).toBeDisabled()
    useMarkdownAiDomain.getState().accept(snapshot(draft, revision, 'success'))
    expect(await screen.findByText('AI result')).toBeInTheDocument()
    expect(onAiRequest).not.toHaveBeenCalled()
  })

  it('keeps a recovered error visible when matched consume fails, then dismisses it for retry', async () => {
    const draft = makeDraft()
    useMarkdownAiDomain
      .getState()
      .accept(snapshot(draft, markdownDraftRevision(`${draft.title}\0${draft.text}`), 'error'))
    aiMocks.consume.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<MarkdownEditorShell draft={draft} onAiRequest={vi.fn()} aiAvailable />)
    expect(await screen.findByRole('alert')).toHaveTextContent('AI 处理未完成，请稍后重试。')
    expect(screen.queryByText('AI failed')).not.toBeInTheDocument()
    const dismiss = await screen.findByRole('button', { name: '关闭错误并重试' })
    fireEvent.click(dismiss)
    expect(await screen.findByText('AI 处理未完成，请稍后重试。')).toBeInTheDocument()
    fireEvent.click(dismiss)
    await waitFor(() =>
      expect(screen.queryByText('AI 处理未完成，请稍后重试。')).not.toBeInTheDocument(),
    )
  })

  it('keeps stale running read-only and only permits discarding its terminal outcome', async () => {
    const draft = makeDraft()
    const running = snapshot(
      draft,
      markdownDraftRevision(`${draft.title}\0${draft.text}`),
      'running',
    )
    useMarkdownAiDomain.getState().accept(running)
    render(
      <MarkdownEditorShell
        draft={{ ...draft, text: `${draft.text}\nchanged` }}
        aiAvailable
        onAiRequest={vi.fn()}
      />,
    )
    expect(await screen.findByText(/旧版草稿的 AI 任务仍在处理中/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '丢弃过期结果' })).not.toBeInTheDocument()
    useMarkdownAiDomain
      .getState()
      .accept({ ...running, outcome: { status: 'success', leaseId: 41, output: 'old' } })
    expect(await screen.findByRole('button', { name: '丢弃过期结果' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '替换选区' })).not.toBeInTheDocument()
  })

  it('locks every content mutation immediately and stays locked until the AI result is consumed', async () => {
    let finishAi!: (value: string) => void
    const onAiRequest = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishAi = resolve
        }),
    )
    const onDraftChange = vi.fn()
    const onVoiceAppendEnabledChange = vi.fn()
    const onOpenMarkdown = vi.fn()
    const onClearAndClose = vi.fn()
    const onCopyMarkdown = vi.fn()
    const onSaveMarkdown = vi.fn()
    const onExportDocx = vi.fn()

    render(
      <MarkdownEditorShell
        draft={makeDraft()}
        initialMode="split"
        onDraftChange={onDraftChange}
        onVoiceAppendEnabledChange={onVoiceAppendEnabledChange}
        onOpenMarkdown={onOpenMarkdown}
        onClearAndClose={onClearAndClose}
        onCopyMarkdown={onCopyMarkdown}
        onSaveMarkdown={onSaveMarkdown}
        onExportDocx={onExportDocx}
        onClose={vi.fn()}
        onAiRequest={onAiRequest}
        aiAvailable
      />,
    )

    const polish = screen.getByRole('button', { name: '润色' })
    await waitFor(() => expect(polish).toBeEnabled())
    fireEvent.click(polish)

    expect(onAiRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('文稿标题')).toHaveAttribute('readonly')
    expect(screen.getByRole('textbox', { name: 'Markdown 源文' })).toHaveAttribute(
      'aria-readonly',
      'true',
    )
    expect(screen.getByRole('button', { name: '加粗' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '预设' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '连续追加' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '打开 Markdown 文件' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '清空退出' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '翻译' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    expect(onAiRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tab', { name: /预览/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: '复制 Markdown' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '保存 .md' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '导出 Word' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '关闭编辑器' })).toBeEnabled()

    finishAi('AI 改写结果')
    expect(await screen.findByText('AI 改写结果')).toBeInTheDocument()
    expect(screen.getByLabelText('文稿标题')).toHaveAttribute('readonly')

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.getByLabelText('文稿标题')).not.toHaveAttribute('readonly'))
    expect(screen.getByRole('button', { name: '加粗' })).toBeEnabled()
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('does not let a delayed AI apply overwrite an externally replaced title or body', async () => {
    const draft = makeDraft({ text: '原始正文' })
    const success = snapshot(
      draft,
      markdownDraftRevision(`${draft.title}\0${draft.text}`),
      'success',
    )
    useMarkdownAiDomain.getState().accept(success)
    let finishConsume!: (consumed: boolean) => void
    aiMocks.consume.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishConsume = resolve
        }),
    )
    const onDraftChange = vi.fn()
    const { rerender } = render(
      <MarkdownEditorShell
        draft={draft}
        initialMode="preview"
        onDraftChange={onDraftChange}
        onAiRequest={vi.fn()}
        aiAvailable
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '替换选区' }))
    const replacement = { ...draft, title: '外部新标题', text: '外部新正文' }
    rerender(
      <MarkdownEditorShell
        draft={replacement}
        initialMode="preview"
        onDraftChange={onDraftChange}
        onAiRequest={vi.fn()}
        aiAvailable
      />,
    )
    finishConsume(true)

    await waitFor(() => expect(aiMocks.consume).toHaveBeenCalledTimes(1))
    expect(onDraftChange).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('外部新标题')).toBeInTheDocument()
  })

  it('renders the editor shell in split mode with CodeMirror input and preview', () => {
    render(<MarkdownEditorShell draft={makeDraft()} initialMode="split" />)

    expect(screen.getByRole('dialog', { name: 'Markdown 编辑器' })).toHaveAttribute(
      'data-view-mode',
      'split',
    )
    expect(screen.getByDisplayValue('整理结果')).toBeInTheDocument()
    expect(screen.getByText('来源：屏幕 OCR · 订单页面')).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Markdown 工具栏' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加粗' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '插入表格' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '任务列表' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '居中' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Markdown 源文' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Markdown 预览' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '订单' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '待确认' })).toBeInTheDocument()
  })

  it('syncs only a real side-by-side split and persists only the user preference', async () => {
    const resizeCallbacks = new Set<ResizeObserverCallback>()
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    let stacked = true
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const label = this.getAttribute('aria-label')
      if (this.tagName === 'SECTION' && label === 'Markdown 源文') {
        return testRect(0, 0, 400, 300)
      }
      if (this.tagName === 'SECTION' && label === 'Markdown 预览') {
        return stacked ? testRect(0, 312, 400, 300) : testRect(412, 0, 400, 300)
      }
      return originalRect.call(this)
    })

    const first = render(<MarkdownEditorShell draft={makeDraft()} initialMode="split" />)
    const syncToggle = screen.getByRole('button', { name: '同步滚动' })
    const grid = first.container.querySelector('.echo-markdown-editor-grid')

    expect(syncToggle).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(grid).toHaveAttribute('data-scroll-sync', 'paused'))
    expect(localStorage.getItem('echolike.markdownEditor.scrollSync.v1')).toBeNull()

    stacked = false
    act(() => {
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver)
    })
    await waitFor(() => expect(grid).toHaveAttribute('data-scroll-sync', 'active'))
    expect(localStorage.getItem('echolike.markdownEditor.scrollSync.v1')).toBeNull()

    fireEvent.click(syncToggle)
    expect(syncToggle).toHaveAttribute('aria-pressed', 'false')
    expect(grid).toHaveAttribute('data-scroll-sync', 'off')
    expect(localStorage.getItem('echolike.markdownEditor.scrollSync.v1')).toBe('false')

    first.unmount()
    const second = render(<MarkdownEditorShell draft={makeDraft()} initialMode="split" />)
    expect(screen.getByRole('button', { name: '同步滚动' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(second.container.querySelector('.echo-markdown-editor-grid')).toHaveAttribute(
      'data-scroll-sync',
      'off',
    )
  })

  it('reports renderer readiness once after both split scroll surfaces are constructed', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      testRect(0, 0, 800, 600),
    )
    let editorReadyAtAck = false
    let previewReadyAtAck = false
    const onRendererReady = vi.fn(() => {
      editorReadyAtAck = Boolean(screen.queryByRole('textbox', { name: 'Markdown 源文' }))
      previewReadyAtAck = Boolean(screen.queryByRole('region', { name: 'Markdown 预览' }))
    })
    const view = render(
      <MarkdownEditorShell
        draft={makeDraft()}
        initialMode="split"
        onRendererReady={onRendererReady}
      />,
    )

    await waitFor(() => expect(onRendererReady).toHaveBeenCalledTimes(1))
    expect(editorReadyAtAck).toBe(true)
    expect(previewReadyAtAck).toBe(true)

    view.rerender(
      <MarkdownEditorShell
        draft={makeDraft({ title: '更新标题' })}
        initialMode="split"
        onRendererReady={onRendererReady}
      />,
    )
    expect(onRendererReady).toHaveBeenCalledTimes(1)
  })

  it('does not report renderer readiness while its editor surfaces still have zero geometry', async () => {
    const resizeCallbacks = new Set<ResizeObserverCallback>()
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    let renderable = false
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
      renderable ? testRect(0, 0, 800, 600) : testRect(0, 0, 0, 0),
    )
    const onRendererReady = vi.fn()
    render(
      <MarkdownEditorShell
        draft={makeDraft()}
        initialMode="split"
        onRendererReady={onRendererReady}
      />,
    )

    await waitFor(() => expect(resizeCallbacks.size).toBeGreaterThan(0))
    expect(onRendererReady).not.toHaveBeenCalled()

    renderable = true
    act(() => {
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver)
    })
    await waitFor(() => expect(onRendererReady).toHaveBeenCalledTimes(1))
  })

  it('uses manual dragging for standalone editor windows without a native drag region', () => {
    render(<MarkdownEditorShell draft={makeDraft()} initialMode="preview" draggableTitlebar />)

    const titlebar = screen
      .getByRole('dialog', { name: 'Markdown 编辑器' })
      .querySelector('.echo-markdown-editor-titlebar')
    if (!titlebar) throw new Error('Markdown editor titlebar not found')

    expect(titlebar).toHaveClass('echo-dialog-titlebar--inline')
    expect(titlebar).not.toHaveAttribute('data-tauri-drag-region')
    fireEvent.mouseDown(titlebar, { button: 0, detail: 1 })
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1)

    windowMocks.startDragging.mockClear()
    fireEvent.mouseDown(titlebar, { button: 0, detail: 2 })
    expect(windowMocks.startDragging).not.toHaveBeenCalled()
  })

  it('uses the shared window-close interaction style for the editor close button', () => {
    const onClose = vi.fn()
    render(<MarkdownEditorShell draft={makeDraft()} initialMode="preview" onClose={onClose} />)

    const closeButton = screen.getByRole('button', { name: '关闭编辑器' })
    expect(closeButton).toHaveClass('echo-icon-button', 'echo-icon-button--window-close')
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lets the user pause automatic voice appends for the current writing flow', () => {
    const onVoiceAppendEnabledChange = vi.fn()
    render(
      <MarkdownEditorShell
        draft={makeDraft()}
        initialMode="preview"
        voiceAppendEnabled
        onVoiceAppendEnabledChange={onVoiceAppendEnabledChange}
      />,
    )

    const toggle = screen.getByRole('button', { name: '连续追加' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggle)
    expect(onVoiceAppendEnabledChange).toHaveBeenCalledWith(false)
  })

  it('switches between edit, preview, and split modes without remounting the shell', () => {
    render(<MarkdownEditorShell draft={makeDraft()} initialMode="split" />)

    fireEvent.click(screen.getByRole('tab', { name: /预览/ }))
    expect(screen.getByRole('dialog', { name: 'Markdown 编辑器' })).toHaveAttribute(
      'data-view-mode',
      'preview',
    )
    expect(screen.queryByRole('textbox', { name: 'Markdown 源文' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Markdown 预览' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /编辑/ }))
    expect(screen.getByRole('dialog', { name: 'Markdown 编辑器' })).toHaveAttribute(
      'data-view-mode',
      'edit',
    )
    expect(screen.getByRole('textbox', { name: 'Markdown 源文' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Markdown 预览' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /分屏/ }))
    expect(screen.getByRole('dialog', { name: 'Markdown 编辑器' })).toHaveAttribute(
      'data-view-mode',
      'split',
    )
  })

  it('remounts CodeMirror when switching draft identities', async () => {
    const firstDraft = makeDraft({ id: 'draft-first', text: '# First draft' })
    const secondDraft = makeDraft({ id: 'draft-second', text: '# Second draft' })
    const { rerender } = render(
      <MarkdownEditorShell draft={firstDraft} initialMode="edit" onDraftChange={vi.fn()} />,
    )
    const firstEditor = screen.getByRole('textbox', { name: 'Markdown 源文' })

    rerender(<MarkdownEditorShell draft={secondDraft} initialMode="edit" onDraftChange={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Markdown 源文' })).toHaveTextContent(
        '# Second draft',
      ),
    )
    const secondEditor = screen.getByRole('textbox', { name: 'Markdown 源文' })
    expect(secondEditor).not.toBe(firstEditor)

    fireEvent.keyDown(secondEditor, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(secondEditor).toHaveTextContent('# Second draft')
    expect(secondEditor).not.toHaveTextContent('# First draft')
  })

  it('marks title changes dirty and reports the draft update', () => {
    const onDraftChange = vi.fn()
    render(
      <MarkdownEditorShell
        draft={makeDraft()}
        initialMode="preview"
        onDraftChange={onDraftChange}
      />,
    )

    fireEvent.change(screen.getByLabelText('文稿标题'), { target: { value: '新标题' } })

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '新标题',
        dirty: true,
      }),
    )
    expect(screen.getByText('未保存')).toBeInTheDocument()
  })

  it('applies toolbar actions to the current draft text', () => {
    const onDraftChange = vi.fn()
    render(
      <MarkdownEditorShell
        draft={makeDraft({ text: '', dirty: false })}
        initialMode="edit"
        onDraftChange={onDraftChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '插入表格' }))

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        text: ['| 字段 | 值 |', '| --- | --- |', '| 名称 | 内容 |', ''].join('\n'),
        dirty: true,
      }),
    )
    expect(screen.getByText('未保存')).toBeInTheDocument()
  })

  it('exposes copy, save, and Word export actions for the current draft', () => {
    const onOpenMarkdown = vi.fn()
    const onCopyMarkdown = vi.fn()
    const onSaveMarkdown = vi.fn()
    const onExportDocx = vi.fn()
    const draft = makeDraft()

    render(
      <MarkdownEditorShell
        draft={draft}
        initialMode="preview"
        onOpenMarkdown={onOpenMarkdown}
        onCopyMarkdown={onCopyMarkdown}
        onSaveMarkdown={onSaveMarkdown}
        onExportDocx={onExportDocx}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开 Markdown 文件' }))
    fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }))
    fireEvent.click(screen.getByRole('button', { name: '保存 .md' }))
    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))

    expect(onOpenMarkdown).toHaveBeenCalledWith(draft)
    expect(onCopyMarkdown).toHaveBeenCalledWith(draft)
    expect(onSaveMarkdown).toHaveBeenCalledWith(draft)
    expect(onExportDocx).toHaveBeenCalledWith(draft)
  })

  it('confirms before replacing a draft with unsaved changes', async () => {
    let finishOpen!: () => void
    const pendingOpen = new Promise<void>((resolve) => {
      finishOpen = resolve
    })
    const draft = makeDraft({ dirty: true })
    const onOpenMarkdown = vi.fn(() => pendingOpen)

    render(
      <MarkdownEditorShell draft={draft} initialMode="preview" onOpenMarkdown={onOpenMarkdown} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开 Markdown 文件' }))

    expect(
      screen.getByRole('alertdialog', { name: '打开文件并替换当前文稿？' }),
    ).toBeInTheDocument()
    expect(onOpenMarkdown).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '继续打开' }))
    expect(onOpenMarkdown).toHaveBeenCalledWith(draft)
    expect(screen.getByRole('button', { name: '打开中' })).toBeDisabled()

    finishOpen()
    await waitFor(() => {
      expect(
        screen.queryByRole('alertdialog', { name: '打开文件并替换当前文稿？' }),
      ).not.toBeInTheDocument()
    })
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n\t'],
  ])('confirms before replacing a dirty %s draft', (_label, text) => {
    const onOpenMarkdown = vi.fn()
    render(
      <MarkdownEditorShell
        draft={makeDraft({ title: 'Unsaved title', text, dirty: true })}
        initialMode="edit"
        onOpenMarkdown={onOpenMarkdown}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开 Markdown 文件' }))

    expect(
      screen.getByRole('alertdialog', { name: '打开文件并替换当前文稿？' }),
    ).toBeInTheDocument()
    expect(onOpenMarkdown).not.toHaveBeenCalled()
  })

  it('keeps file-operation feedback inside the editor shell', () => {
    const onDismissFileFeedback = vi.fn()
    render(
      <MarkdownEditorShell
        draft={makeDraft()}
        fileFeedback={{ type: 'success', message: 'Markdown 已保存到：D:\\Docs\\note.md' }}
        onDismissFileFeedback={onDismissFileFeedback}
      />,
    )

    const editor = screen.getByRole('dialog', { name: 'Markdown 编辑器' })
    expect(within(editor).getByRole('status')).toHaveTextContent(
      'Markdown 已保存到：D:\\Docs\\note.md',
    )
    fireEvent.click(within(editor).getByRole('button', { name: '关闭文件操作提示' }))
    expect(onDismissFileFeedback).toHaveBeenCalledTimes(1)
  })

  it('keeps a generated speech asset after closing and reopens it without regenerating', async () => {
    const draft = makeDraft()
    const key = {
      draftId: draft.id,
      contentRevision: markdownDraftRevision(draft.text),
      voiceKey: 'alloy',
      speedMilli: 1000,
    }
    const asset = {
      id: 12,
      key,
      fileName: '整理结果_20260721.wav',
      directoryPath: 'C:\\Users\\TestUser\\Documents\\EcholIKE\\朗读音频',
      createdAt: '2026-07-21T00:00:00.000Z',
      byteLength: 4096,
      durationMs: 1200,
    }
    let generated = false
    speechMocks.getState.mockImplementation(async (requestKey) => ({
      key: requestKey,
      task: generated
        ? {
            key,
            ownerWindow: 'main',
            outcome: { status: 'success', leaseId: 44, asset },
          }
        : null,
      currentAsset: generated ? asset : null,
      latestAsset: generated ? asset : null,
      directoryPath: asset.directoryPath,
    }))
    speechMocks.start.mockImplementation(async () => {
      generated = true
      return {
        key,
        ownerWindow: 'main',
        outcome: { status: 'success', leaseId: 44, asset },
      }
    })

    render(
      <MarkdownEditorShell
        draft={draft}
        initialMode="preview"
        speechConfig={{
          available: true,
          apiBaseUrl: 'https://api.test',
          token: 'token',
          voiceKey: 'alloy',
        }}
      />,
    )

    const generate = await screen.findByRole('button', { name: '生成朗读' })
    await waitFor(() => expect(generate).toBeEnabled())
    expect(screen.getByRole('button', { name: '打开朗读音频文件夹' })).toBeInTheDocument()
    fireEvent.click(generate)
    expect(await screen.findByRole('dialog', { name: '朗读音频生成完毕' })).toBeInTheDocument()
    expect(speechMocks.start).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog', { name: '朗读音频生成完毕' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '生成完毕' }))

    expect(screen.getByRole('dialog', { name: '朗读音频生成完毕' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开朗读音频文件夹' })).toBeInTheDocument()
    expect(speechMocks.start).toHaveBeenCalledTimes(1)
  })

  it('uses a centered in-app dialog before clearing and closing the current draft', async () => {
    const onClearAndClose = vi.fn().mockResolvedValue(undefined)
    render(
      <MarkdownEditorShell
        draft={makeDraft()}
        initialMode="preview"
        onClearAndClose={onClearAndClose}
      />,
    )

    const clearButton = screen.getByRole('button', { name: '清空退出' })
    fireEvent.click(clearButton)

    const confirmation = screen.getByRole('alertdialog', { name: '清空并退出编辑器？' })
    expect(confirmation.parentElement).toHaveClass(
      'echo-dialog-backdrop',
      'echo-markdown-clear-backdrop',
    )
    expect(confirmation.querySelector('.echo-dialog-titlebar')).toHaveClass(
      'echo-dialog-titlebar--inline',
    )
    expect(screen.getByText('当前文稿会被永久清空')).toBeInTheDocument()
    expect(onClearAndClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog', { name: '清空并退出编辑器？' })).toBeNull()

    fireEvent.click(clearButton)
    fireEvent.click(screen.getByRole('button', { name: '清空并退出' }))

    await waitFor(() => {
      expect(onClearAndClose).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('alertdialog', { name: '清空并退出编辑器？' })).toBeNull()
    })
  })

  it('runs AI actions and can replace the target text with the result', async () => {
    const onDraftChange = vi.fn()
    const onAiRequest = vi.fn().mockResolvedValue('AI 改写结果')

    render(
      <MarkdownEditorShell
        draft={makeDraft({ text: '原始文本' })}
        initialMode="edit"
        onDraftChange={onDraftChange}
        onAiRequest={onAiRequest}
        aiAvailable
      />,
    )

    const polish = screen.getByRole('button', { name: '润色' })
    await waitFor(() => expect(polish).toBeEnabled())
    fireEvent.click(polish)

    await waitFor(() => {
      expect(onAiRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'polish',
          text: '原始文本',
          usedFullDocument: true,
        }),
      )
    })
    expect(await screen.findByText('AI 改写结果')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '替换选区' }))

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'AI 改写结果',
        dirty: true,
      }),
    )
  })

  it('does not mutate text until the user applies an AI insert result', async () => {
    const onDraftChange = vi.fn()
    const onAiRequest = vi.fn().mockResolvedValue('AI 增补')

    render(
      <MarkdownEditorShell
        draft={makeDraft({ text: '原始文本' })}
        initialMode="preview"
        onDraftChange={onDraftChange}
        onAiRequest={onAiRequest}
        aiAvailable
      />,
    )

    const summarize = screen.getByRole('button', { name: '总结' })
    await waitFor(() => expect(summarize).toBeEnabled())
    fireEvent.click(summarize)

    expect(await screen.findByText('AI 增补')).toBeInTheDocument()
    expect(onDraftChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '插入下方' }))

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '原始文本\n\nAI 增补',
        dirty: true,
      }),
    )
  })

  it('tracks the main application theme DOM state', async () => {
    document.documentElement.dataset.themeProfile = 'echo'

    render(<MarkdownEditorShell draft={makeDraft()} initialMode="preview" />)
    const dialog = screen.getByRole('dialog', { name: 'Markdown 编辑器' })

    expect(dialog).toHaveAttribute('data-theme-key', 'light:echo')

    document.documentElement.classList.add('dark')
    document.documentElement.dataset.themeProfile = 'ray'

    await waitFor(() => {
      expect(dialog).toHaveAttribute('data-theme-key', 'dark:ray')
    })
  })
})
