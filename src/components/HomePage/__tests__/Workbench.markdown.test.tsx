import { describe } from 'vitest'
import { expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { workbenchTestHarness } from './workbenchTestHarness'

const {
  ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
  MARKDOWN_VOICE_APPEND_STORAGE_KEY,
  RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
  homePageFixture: HomePage,
  makeMarkdownDraft,
  markdownWindowMocks,
  parseMarkdownDraft,
  serializeRecentMarkdownDraft,
  tauriMocks,
  toastMocks,
  useAppStore,
  useFileCommandDomain,
  useMarkdownAiDomain,
} = workbenchTestHarness

describe('HomePage Markdown', () => {
  it('opens a blank Markdown editor from the AI toolbar', async () => {
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))

    expect(screen.queryByRole('button', { name: '继续编辑' })).not.toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('未命名文稿')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成朗读' })).toBeDisabled()
  })

  it('loads a supported local Markdown text file into the embedded editor', async () => {
    tauriMocks.openMarkdownFile.mockResolvedValue({
      fileName: 'agenda.md',
      text: '# Agenda\n\n1. Review',
    })
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(editor).getByRole('button', { name: '打开 Markdown 文件' }))

    await waitFor(() => expect(tauriMocks.openMarkdownFile).toHaveBeenCalledTimes(1))
    expect(await screen.findByDisplayValue('agenda')).toBeInTheDocument()
    expect(screen.getByText('来源：本地文件 · agenda.md')).toBeInTheDocument()
    expect(parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))).toEqual(
      expect.objectContaining({
        title: 'agenda',
        text: '# Agenda\n\n1. Review',
        source: 'file',
        dirty: false,
      }),
    )
  })

  it('does not replace an embedded draft that changes while the file picker is open', async () => {
    let finishOpen!: (file: { fileName: string; text: string }) => void
    tauriMocks.openMarkdownFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve
        }),
    )
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(editor).getByRole('button', { name: '打开 Markdown 文件' }))
    await waitFor(() => expect(tauriMocks.openMarkdownFile).toHaveBeenCalledTimes(1))

    fireEvent.change(within(editor).getByLabelText('文稿标题'), {
      target: { value: '选择期间更新的标题' },
    })
    act(() => finishOpen({ fileName: 'stale.md', text: '# Must not replace' }))

    expect(
      await within(editor).findByText(
        '选择文件期间文稿已更新，为避免覆盖当前修改，请重新打开文件。',
      ),
    ).toBeInTheDocument()
    expect(within(editor).getByDisplayValue('选择期间更新的标题')).toBeInTheDocument()
    expect(within(editor).queryByDisplayValue('stale')).not.toBeInTheDocument()
    expect(screen.queryByText('来源：本地文件 · stale.md')).not.toBeInTheDocument()
  })

  it('reports a file read failure after the same embedded draft changes', async () => {
    let failOpen!: (reason: Error) => void
    tauriMocks.openMarkdownFile.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failOpen = reject
        }),
    )
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(editor).getByRole('button', { name: '打开 Markdown 文件' }))
    await waitFor(() => expect(tauriMocks.openMarkdownFile).toHaveBeenCalledTimes(1))
    fireEvent.change(within(editor).getByLabelText('文稿标题'), {
      target: { value: '读取期间更新的标题' },
    })

    act(() => failOpen(new Error('测试文件读取失败。')))

    expect(await within(editor).findByText('测试文件读取失败。')).toBeInTheDocument()
    expect(within(editor).getByDisplayValue('读取期间更新的标题')).toBeInTheDocument()
  })

  it('delegates ready-window activation without bypassing the native lifecycle gate', async () => {
    tauriMocks.beginMarkdownEditorWindow.mockResolvedValueOnce({
      status: 'activated',
      generation: 4,
    })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    render(<HomePage />)
    toastMocks.toast.mockClear()

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))

    await waitFor(() => {
      expect(tauriMocks.beginMarkdownEditorWindow).toHaveBeenCalledTimes(1)
      expect(markdownWindowMocks.emitTo).toHaveBeenCalledWith(
        'markdown-editor',
        'markdown-editor:load-draft',
      )
    })
    expect(screen.queryByRole('dialog', { name: 'Markdown 编辑器' })).not.toBeInTheDocument()
  })

  it('asks native code to create a pending Mint window with a non-black backing', async () => {
    tauriMocks.beginMarkdownEditorWindow.mockResolvedValueOnce({
      status: 'create',
      generation: 5,
    })
    document.documentElement.style.setProperty('--echo-surface', '#fbfffd')
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))

    await waitFor(() => {
      expect(tauriMocks.beginMarkdownEditorWindow).toHaveBeenCalledWith({
        width: 1120,
        height: 780,
        minWidth: 720,
        minHeight: 520,
        backgroundColor: [251, 255, 253, 0],
      })
    })
  })

  it('does not construct or show a second window while the current generation is pending', async () => {
    tauriMocks.beginMarkdownEditorWindow.mockResolvedValueOnce({
      status: 'pending',
      generation: 6,
    })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))

    await waitFor(() => expect(tauriMocks.beginMarkdownEditorWindow).toHaveBeenCalledTimes(1))
    expect(markdownWindowMocks.emitTo).toHaveBeenCalledWith(
      'markdown-editor',
      'markdown-editor:load-draft',
    )
  })

  it('keeps one native begin request while the standalone window decision is pending', async () => {
    let finishBegin!: (decision: { status: 'create'; generation: number }) => void
    tauriMocks.beginMarkdownEditorWindow.mockReturnValueOnce(
      new Promise((resolve) => {
        finishBegin = resolve
      }),
    )
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    render(<HomePage />)

    const openButton = screen.getByRole('button', { name: '写文章' })
    fireEvent.click(openButton)
    await waitFor(() => expect(tauriMocks.beginMarkdownEditorWindow).toHaveBeenCalledTimes(1))
    expect(openButton).toBeDisabled()
    fireEvent.click(openButton)
    expect(tauriMocks.beginMarkdownEditorWindow).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)).toContain(
      '"title":"未命名文稿"',
    )
    expect(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)).toContain('"source":"manual"')

    act(() => finishBegin({ status: 'create', generation: 7 }))
    await waitFor(() => expect(openButton).toBeEnabled())
    expect(screen.queryByRole('dialog', { name: 'Markdown 编辑器' })).not.toBeInTheDocument()
  })

  it('falls back to the embedded editor when native standalone startup fails', async () => {
    tauriMocks.beginMarkdownEditorWindow.mockRejectedValueOnce(new Error('native create failed'))
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))

    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('未命名文稿')).toBeInTheDocument()
    expect(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)).toContain(
      '"title":"未命名文稿"',
    )
    expect(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)).toContain('"source":"manual"')
    expect(warn).toHaveBeenCalledWith(
      'Standalone Markdown editor window skipped:',
      expect.any(Error),
    )
  })

  it('applies active, recent and voice-toggle storage events to the embedded workspace', async () => {
    const recentDraft = makeMarkdownDraft({ id: 'recent-storage', title: 'Storage 恢复' })
    localStorage.setItem(
      RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
      serializeRecentMarkdownDraft(recentDraft),
    )
    render(<HomePage />)

    expect(screen.getByRole('dialog', { name: '恢复 Markdown 草稿' })).toBeVisible()
    localStorage.removeItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
          oldValue: serializeRecentMarkdownDraft(recentDraft),
          newValue: null,
        }),
      ),
    )
    expect(screen.queryByRole('dialog', { name: '恢复 Markdown 草稿' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    const voiceToggle = within(editor).getByRole('button', { name: '连续追加' })
    expect(voiceToggle).toHaveAttribute('aria-pressed', 'true')
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: MARKDOWN_VOICE_APPEND_STORAGE_KEY,
          oldValue: 'true',
          newValue: 'false',
        }),
      ),
    )
    expect(voiceToggle).toHaveAttribute('aria-pressed', 'false')
    act(() => useAppStore.getState().setCompletedVoiceText('不应追加'))
    expect(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)).toContain('"text":""')

    localStorage.removeItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
          oldValue: serializeRecentMarkdownDraft(recentDraft),
          newValue: null,
        }),
      ),
    )
    expect(screen.queryByRole('dialog', { name: 'Markdown 编辑器' })).not.toBeInTheDocument()
  })

  it('appends each new completed voice result only while the Markdown editor is open', async () => {
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))
    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()

    act(() => {
      useAppStore.getState().setCompletedVoiceText('第一段口述')
    })
    await waitFor(() => {
      expect(
        parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))?.text,
      ).toBe('第一段口述')
    })

    act(() => {
      useAppStore.getState().setCompletedVoiceText('第二段口述')
    })
    await waitFor(() => {
      expect(
        parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))?.text,
      ).toBe('第一段口述\n\n第二段口述')
    })
  })

  it('clears the active Markdown draft before exiting the editor', async () => {
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '写文章' }))
    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '清空退出' }))
    expect(screen.getByRole('alertdialog', { name: '清空并退出编辑器？' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清空并退出' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Markdown 编辑器' })).not.toBeInTheDocument()
    })
    expect(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)).toBeNull()
    expect(screen.queryByRole('button', { name: '继续编辑' })).not.toBeInTheDocument()
  })

  it('sends an AI answer into the Markdown editor', async () => {
    tauriMocks.askLlmOnce.mockResolvedValue('最终回答')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
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

    expect(await screen.findByText('最终回答')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '整理 AI 回答' }))

    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('AI 回答')).toBeInTheDocument()
    expect(screen.getAllByText('Q：说重点').length).toBeGreaterThan(0)
    expect(screen.getAllByText('A：最终回答').length).toBeGreaterThan(0)
  })

  it('uses the configured LLM for Markdown editor AI actions', async () => {
    tauriMocks.askLlmOnce.mockResolvedValue('Markdown AI 输出')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
      history: [
        {
          id: 9,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '原文',
          polished_text: '第一条整理文本',
          language: 'zh',
          duration_ms: 600,
        },
      ],
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))

    const dialog = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(dialog).getByRole('button', { name: '润色' }))

    await waitFor(() => {
      expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          question: expect.stringContaining('润色下面的 Markdown 文本'),
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'qwen3.5',
          context: 'Markdown 文稿: 第一条整理文本\n处理范围: 全文',
        }),
      )
    })
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('第一条整理文本'),
      }),
    )
    expect(await within(dialog).findByText('Markdown AI 输出')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '替换选区' }))

    expect(within(dialog).getAllByText('Markdown AI 输出').length).toBeGreaterThan(0)
  })

  it('restores one pending Markdown AI task across embedded shell close and reopen', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    tauriMocks.runLocalMarkdownAi.mockImplementationOnce(async (request) => {
      const running = {
        key: request.key,
        outcome: { status: 'running' as const, leaseId: 77 },
        applyContext: request.applyContext,
      }
      useMarkdownAiDomain.getState().accept(running)
      await pending
      return {
        ...running,
        outcome: { status: 'success' as const, leaseId: 77, output: 'restored Markdown result' },
      }
    })
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
      history: [
        {
          id: 91,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: 'text',
          polished_text: 'pending markdown',
          language: 'en',
          duration_ms: 10,
        },
      ],
    })
    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).getByRole('button', {
        name: '润色',
      }),
    )
    expect(await screen.findByRole('button', { name: '润色中' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑器' }))
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }))
    expect(await screen.findByRole('button', { name: '润色中' })).toBeDisabled()
    finish()
    expect(await screen.findByText('restored Markdown result')).toBeInTheDocument()
    expect(tauriMocks.runLocalMarkdownAi).toHaveBeenCalledTimes(1)
  })

  it('queues embedded-editor voice appends until the AI result is cancelled', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    tauriMocks.runLocalMarkdownAi.mockImplementationOnce(async (request) => {
      await pending
      return {
        key: request.key,
        outcome: { status: 'success' as const, leaseId: 79, output: '待确认结果' },
        applyContext: request.applyContext,
      }
    })
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
      history: [
        {
          id: 92,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: 'text',
          polished_text: 'AI 锁定正文',
          language: 'zh',
          duration_ms: 10,
        },
      ],
    })
    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))
    const dialog = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    const polish = within(dialog).getByRole('button', { name: '润色' })
    await waitFor(() => expect(polish).toBeEnabled())
    fireEvent.click(polish)

    act(() => {
      useAppStore.setState({ completedVoiceText: '排队追加内容', completedVoiceTextVersion: 1 })
    })
    expect(within(dialog).getByRole('textbox', { name: 'Markdown 源文' })).not.toHaveTextContent(
      '排队追加内容',
    )

    finish()
    expect(await within(dialog).findByText('待确认结果')).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'Markdown 源文' })).not.toHaveTextContent(
      '排队追加内容',
    )
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'Markdown 源文' })).toHaveTextContent(
        '排队追加内容',
      ),
    )
  })

  it('flushes queued voice appends only after an embedded AI result is applied', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    tauriMocks.runLocalMarkdownAi.mockImplementationOnce(async (request) => {
      await pending
      return {
        key: request.key,
        outcome: { status: 'success' as const, leaseId: 80, output: '已应用的 AI 正文' },
        applyContext: request.applyContext,
      }
    })
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
      history: [
        {
          id: 94,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: 'text',
          polished_text: '应用前正文',
          language: 'zh',
          duration_ms: 10,
        },
      ],
    })
    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))
    const dialog = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    const polish = within(dialog).getByRole('button', { name: '润色' })
    await waitFor(() => expect(polish).toBeEnabled())
    fireEvent.click(polish)

    act(() => useAppStore.getState().setCompletedVoiceText('应用后追加内容'))
    const source = within(dialog).getByRole('textbox', { name: 'Markdown 源文' })
    expect(source).not.toHaveTextContent('应用后追加内容')

    act(() => finish())
    expect(await within(dialog).findByText('已应用的 AI 正文')).toBeInTheDocument()
    expect(source).not.toHaveTextContent('应用后追加内容')
    fireEvent.click(within(dialog).getByRole('button', { name: '替换选区' }))

    await waitFor(() => {
      expect(source).toHaveTextContent('已应用的 AI 正文')
      expect(source).toHaveTextContent('应用后追加内容')
    })
  })

  it('retries an unchanged Ollama translation with a stricter prompt', async () => {
    const source = 'Please send the final report tomorrow.'
    tauriMocks.askLlmOnce
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce('请明天发送最终报告。')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
      history: [
        {
          id: 10,
          created_at: '2026-07-07T10:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: source,
          polished_text: source,
          language: 'en',
          duration_ms: 600,
        },
      ],
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))
    const dialog = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(dialog).getByRole('button', { name: '翻译' }))

    expect(await within(dialog).findByText('请明天发送最终报告。')).toBeInTheDocument()
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledTimes(2)
    expect(tauriMocks.askLlmOnce).toHaveBeenLastCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('上一次输出未通过翻译检查'),
      }),
    )
  })

  it('passes the Markdown editor preset into AI action context', async () => {
    tauriMocks.askLlmOnce.mockResolvedValue('Markdown AI 输出')
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
      history: [
        {
          id: 10,
          created_at: '2026-07-07T10:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '原文',
          polished_text: '# 标题\n\n正文',
          language: 'zh',
          duration_ms: 600,
        },
      ],
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))

    const dialog = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.change(within(dialog).getByLabelText('预设'), {
      target: { value: 'offline:markdown-cleanup' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '润色' }))

    await waitFor(() => {
      expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.stringContaining('预设：Markdown 清理'),
        }),
      )
    })
    expect(tauriMocks.askLlmOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('Markdown 文稿:'),
      }),
    )
  })

  it('restores or discards the last unsaved Markdown draft from local storage', async () => {
    localStorage.setItem(
      RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
      serializeRecentMarkdownDraft(makeMarkdownDraft()),
    )

    render(<HomePage />)

    const restoreDialog = screen.getByRole('dialog', { name: '恢复 Markdown 草稿' })
    expect(restoreDialog.querySelector('.echo-dialog-titlebar')).toHaveClass(
      'echo-dialog-titlebar--inline',
    )

    fireEvent.click(screen.getByRole('button', { name: '恢复草稿' }))

    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('未保存草稿')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '恢复标题' })).toBeInTheDocument()

    cleanup()
    localStorage.setItem(
      RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
      serializeRecentMarkdownDraft(makeMarkdownDraft({ title: '丢弃这个' })),
    )

    render(<HomePage />)
    const discardButton = screen.getByRole('button', { name: '丢弃草稿' })
    expect(discardButton).toHaveClass('echo-button--danger')
    fireEvent.click(discardButton)

    expect(screen.queryByRole('dialog', { name: '恢复 Markdown 草稿' })).not.toBeInTheDocument()
    expect(localStorage.getItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('dismisses the draft restore prompt without deleting the recoverable draft', () => {
    const serialized = serializeRecentMarkdownDraft(makeMarkdownDraft({ title: '下次再恢复' }))
    localStorage.setItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY, serialized)

    render(<HomePage />)
    const restoreDialog = screen.getByRole('dialog', { name: '恢复 Markdown 草稿' })
    fireEvent.click(within(restoreDialog).getByRole('button', { name: '关闭' }))

    expect(screen.queryByRole('dialog', { name: '恢复 Markdown 草稿' })).not.toBeInTheDocument()
    expect(localStorage.getItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)).toBe(serialized)
  })

  it('saves and exports the Markdown editor draft with the current editor text', async () => {
    useAppStore.setState({
      history: [
        {
          id: 3,
          created_at: '2026-07-07T03:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '# 草稿\n\n正文',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
      ],
    })

    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))

    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('文稿标题'), { target: { value: 'Notes edited' } })

    await waitFor(() => {
      expect(localStorage.getItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)).toContain('Notes edited')
    })

    fireEvent.click(screen.getByRole('button', { name: '保存 .md' }))

    await waitFor(() => {
      expect(tauriMocks.runSaveMarkdownFile).toHaveBeenCalledWith(
        expect.objectContaining({ commandKind: 'saveMarkdown' }),
        'Notes edited.md',
        '# 草稿\n\n正文',
        expect.any(String),
      )
    })
    expect(await screen.findByText('已同步')).toBeInTheDocument()
    expect(localStorage.getItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)).toBeNull()
    const editor = screen.getByRole('dialog', { name: 'Markdown 编辑器' })
    expect(within(editor).getByRole('status')).toHaveTextContent('Markdown 已保存到')
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('Markdown 已保存到'),
      'success',
    )

    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))

    await waitFor(() => {
      expect(tauriMocks.runExportMarkdownDocx).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          text: '# 草稿\n\n正文',
          source_kind: 'editor',
          source_name: 'Notes edited',
        }),
        expect.any(String),
        true,
      )
    })
    expect(within(editor).getByRole('status')).toHaveTextContent('Word 已保存到')
    expect(toastMocks.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('Word 已保存到'),
      'success',
    )

    tauriMocks.runSaveMarkdownFile.mockClear()
    tauriMocks.runSaveMarkdownFile.mockImplementationOnce((key, _name, _text, fingerprint) =>
      Promise.resolve({
        key,
        ownerWindow: 'main',
        requestFingerprint: fingerprint,
        outcome: { status: 'cancelled', leaseId: 41 },
      }),
    )
    fireEvent.change(screen.getByLabelText('文稿标题'), {
      target: { value: '取消保存后仍未保存' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 .md' }))
    await waitFor(() => expect(tauriMocks.runSaveMarkdownFile).toHaveBeenCalledTimes(1))
    expect(within(editor).queryByRole('status')).toBeNull()
    expect(within(editor).queryByRole('alert')).toBeNull()
    expect(screen.getByText('未保存')).toBeInTheDocument()
  })

  it('keeps a hidden editor file result recoverable until the editor reopens', async () => {
    useAppStore.setState({
      history: [
        {
          id: 4,
          created_at: '2026-07-07T04:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '等待导出的正文',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
      ],
    })
    let finish!: (value: unknown) => void
    tauriMocks.runExportMarkdownDocx.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))
    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '导出 Word' }))
    await waitFor(() => expect(tauriMocks.runExportMarkdownDocx).toHaveBeenCalledTimes(1))
    const [key, , requestFingerprint] = tauriMocks.runExportMarkdownDocx.mock.calls[0]
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑器' }))
    expect(screen.queryByRole('dialog', { name: 'Markdown 编辑器' })).not.toBeInTheDocument()

    tauriMocks.consumeFileCommandTask.mockClear()
    await act(async () => {
      finish({
        key,
        ownerWindow: 'main',
        requestFingerprint,
        outcome: {
          status: 'success',
          leaseId: 44,
          path: 'D:\\Docs\\hidden.docx',
          message: 'saved',
        },
      })
      await Promise.resolve()
    })

    expect(tauriMocks.consumeFileCommandTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    expect(await within(editor).findByRole('status')).toHaveTextContent(
      'Word 已保存到：D:\\Docs\\hidden.docx',
    )
    expect(tauriMocks.consumeFileCommandTask).toHaveBeenCalledWith(key, 44)
  })

  it('keeps consumed editor feedback across a Home unmount', async () => {
    useAppStore.setState({
      history: [
        {
          id: 6,
          created_at: '2026-07-07T06:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '切页期间导出的正文',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
      ],
    })
    let finishConsume!: (value: 'consumed') => void
    const pendingConsume = new Promise<'consumed'>((resolve) => {
      finishConsume = resolve
    })
    tauriMocks.consumeFileCommandTask.mockImplementation(() => pendingConsume)

    const view = render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.change(within(editor).getByLabelText('文稿标题'), {
      target: { value: '切页期间导出' },
    })
    await waitFor(() =>
      expect(localStorage.getItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)).toContain(
        '切页期间导出的正文',
      ),
    )

    fireEvent.click(within(editor).getByRole('button', { name: '导出 Word' }))
    await waitFor(() => expect(tauriMocks.consumeFileCommandTask).toHaveBeenCalled())
    view.unmount()

    await act(async () => {
      finishConsume('consumed')
      await pendingConsume
      await Promise.resolve()
    })
    expect(useFileCommandDomain.getState().markdownFeedback?.message).toContain('Word 已保存到')

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '恢复草稿' }))
    const restoredEditor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    expect(within(restoredEditor).getByRole('status')).toHaveTextContent('Word 已保存到')
  })

  it('does not show a late file result inside a different draft', async () => {
    useAppStore.setState({
      history: [
        {
          id: 7,
          created_at: '2026-07-07T07:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '旧草稿正文',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
        {
          id: 8,
          created_at: '2026-07-07T08:00:00.000Z',
          app_name: 'Code',
          app_type: 'Development',
          raw_text: '新草稿正文',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
      ],
    })
    let finishConsume!: (value: 'consumed') => void
    const pendingConsume = new Promise<'consumed'>((resolve) => {
      finishConsume = resolve
    })
    tauriMocks.consumeFileCommandTask.mockImplementation(() => pendingConsume)

    render(<HomePage />)
    fireEvent.click(screen.getAllByRole('button', { name: '发送到编辑器' })[0])
    const oldEditor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(oldEditor).getByRole('button', { name: '导出 Word' }))
    await waitFor(() => expect(tauriMocks.consumeFileCommandTask).toHaveBeenCalled())
    fireEvent.click(within(oldEditor).getByRole('button', { name: '关闭编辑器' }))

    fireEvent.click(screen.getAllByRole('button', { name: '发送到编辑器' })[1])
    const newEditor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    expect(within(newEditor).getByLabelText('文稿标题')).toHaveValue('新草稿正文')

    await act(async () => {
      finishConsume('consumed')
      await pendingConsume
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(useFileCommandDomain.getState().markdownFeedback?.message).toContain('report.docx'),
    )
    expect(within(newEditor).queryByText(/report\.docx/)).not.toBeInTheDocument()
  })

  it('does not consume a command terminal that returns after switching drafts', async () => {
    useAppStore.setState({
      history: [
        {
          id: 11,
          created_at: '2026-07-07T11:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '命令仍在运行的旧草稿',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
        {
          id: 12,
          created_at: '2026-07-07T12:00:00.000Z',
          app_name: 'Code',
          app_type: 'Development',
          raw_text: '命令返回时的新草稿',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
      ],
    })
    let finishCommand!: (value: unknown) => void
    tauriMocks.runExportMarkdownDocx.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCommand = resolve
        }),
    )

    render(<HomePage />)
    fireEvent.click(screen.getAllByRole('button', { name: '发送到编辑器' })[0])
    const oldEditor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(oldEditor).getByRole('button', { name: '导出 Word' }))
    await waitFor(() => expect(tauriMocks.runExportMarkdownDocx).toHaveBeenCalledTimes(1))
    const [key, , requestFingerprint] = tauriMocks.runExportMarkdownDocx.mock.calls[0]
    fireEvent.click(within(oldEditor).getByRole('button', { name: '关闭编辑器' }))

    fireEvent.click(screen.getAllByRole('button', { name: '发送到编辑器' })[1])
    const newEditor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    expect(within(newEditor).getByLabelText('文稿标题')).toHaveValue('命令返回时的新草稿')

    tauriMocks.consumeFileCommandTask.mockClear()
    await act(async () => {
      finishCommand({
        key,
        ownerWindow: 'main',
        requestFingerprint,
        outcome: {
          status: 'success',
          leaseId: 46,
          path: 'D:\\Docs\\pending.docx',
          message: 'saved',
        },
      })
      await Promise.resolve()
    })

    expect(tauriMocks.consumeFileCommandTask).not.toHaveBeenCalled()
    expect(within(newEditor).queryByText(/pending\.docx/)).not.toBeInTheDocument()
    expect(Object.values(useFileCommandDomain.getState().tasks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key,
          outcome: expect.objectContaining({ status: 'success', leaseId: 46 }),
        }),
      ]),
    )
  })

  it('does not clear a different draft with the same save fingerprint', async () => {
    useAppStore.setState({
      history: [
        {
          id: 9,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '相同草稿正文',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
        {
          id: 10,
          created_at: '2026-07-07T10:00:00.000Z',
          app_name: 'Code',
          app_type: 'Development',
          raw_text: '相同草稿正文',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
      ],
    })
    let finishConsume!: (value: 'consumed') => void
    const pendingConsume = new Promise<'consumed'>((resolve) => {
      finishConsume = resolve
    })
    tauriMocks.consumeFileCommandTask.mockImplementation(() => pendingConsume)

    render(<HomePage />)
    fireEvent.click(screen.getAllByRole('button', { name: '发送到编辑器' })[0])
    const oldEditor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    const originalTitle = (within(oldEditor).getByLabelText('文稿标题') as HTMLInputElement).value
    fireEvent.click(within(oldEditor).getByRole('button', { name: '保存 .md' }))
    await waitFor(() => expect(tauriMocks.consumeFileCommandTask).toHaveBeenCalled())
    fireEvent.click(within(oldEditor).getByRole('button', { name: '关闭编辑器' }))

    fireEvent.click(screen.getAllByRole('button', { name: '发送到编辑器' })[1])
    const newEditor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    const newTitle = within(newEditor).getByLabelText('文稿标题')
    await waitFor(() => expect(newTitle).not.toHaveAttribute('readonly'))
    fireEvent.change(newTitle, {
      target: { value: '临时标题' },
    })
    fireEvent.change(newTitle, {
      target: { value: originalTitle },
    })
    expect(within(newEditor).getByText('未保存')).toBeInTheDocument()

    await act(async () => {
      finishConsume('consumed')
      await pendingConsume
      await Promise.resolve()
    })
    expect(within(newEditor).getByText('未保存')).toBeInTheDocument()
    expect(within(newEditor).queryByText(/note\.md/)).not.toBeInTheDocument()
  })

  it('keeps foreign-window terminals out of the embedded editor and main toast layer', async () => {
    useAppStore.setState({
      history: [
        {
          id: 5,
          created_at: '2026-07-07T05:00:00.000Z',
          app_name: 'Notes',
          app_type: 'Writing',
          raw_text: '当前窗口文稿',
          polished_text: '',
          language: 'zh',
          duration_ms: 500,
        },
      ],
    })
    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '发送到编辑器' }))
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })

    toastMocks.toast.mockClear()
    const activeDraft = parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))!
    tauriMocks.consumeFileCommandTask.mockClear()
    await act(async () => {
      useFileCommandDomain.getState().accept({
        key: { resourceId: `draft:${activeDraft.id}`, commandKind: 'saveMarkdown' },
        ownerWindow: 'markdown-editor',
        requestFingerprint: 'foreign-window',
        outcome: {
          status: 'success',
          leaseId: 45,
          path: 'D:\\Docs\\foreign.md',
          message: 'saved',
        },
      })
      await Promise.resolve()
    })
    expect(tauriMocks.consumeFileCommandTask).not.toHaveBeenCalled()
    expect(within(editor).queryByText(/foreign\.md/)).not.toBeInTheDocument()
    expect(toastMocks.toast).not.toHaveBeenCalled()
  })
})
