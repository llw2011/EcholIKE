import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
  parseMarkdownDraft,
  serializeMarkdownDraft,
} from '../components/MarkdownEditor/markdownDraft'
import { useMarkdownAiDomain } from '../components/MarkdownEditor/markdownAiTask'
import { useAppStore } from '../stores/appStore'
import { useFileCommandDomain } from '../stores/fileCommandStore'

const mocks = vi.hoisted(() => ({
  runLocal: vi.fn(),
  getTasks: vi.fn().mockResolvedValue([]),
  consume: vi.fn().mockResolvedValue(true),
  getFileTasks: vi.fn().mockResolvedValue([]),
  consumeFile: vi.fn().mockResolvedValue('consumed'),
  openFile: vi.fn(),
  saveFile: vi.fn(),
  exportDocx: vi.fn(),
  getSpeechState: vi.fn(),
  startSpeech: vi.fn(),
  readSpeech: vi.fn(),
  openSpeechDirectory: vi.fn(),
  revealSpeech: vi.fn(),
  acquireTts: vi.fn(),
  releaseTts: vi.fn(),
  getConfig: vi.fn(),
  setBackgroundColor: vi.fn(),
  revealMarkdownWindow: vi.fn(),
  fetchDesktopBootstrap: vi.fn(),
  loadDesktopAuthSnapshot: vi.fn(),
  beginDesktopAuthCandidate: vi.fn(),
  commitDesktopAuthCandidate: vi.fn(),
  clearDesktopAuthAuthority: vi.fn(),
  confirmDesktopAuthRuntime: vi.fn(),
  invalidateDesktopAuthRuntime: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'markdown-editor',
    close: vi.fn(),
    startDragging: vi.fn(),
  }),
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ setBackgroundColor: mocks.setBackgroundColor }),
}))
vi.mock('../hooks/useTauriEvents', () => ({ useTauriEvents: vi.fn() }))
vi.mock('../lib/markdownWindowLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/markdownWindowLifecycle')>()
  return {
    ...actual,
    currentMarkdownEditorWindowBackgroundColor: () => [251, 255, 253, 0],
    markdownEditorWindowGeneration: () => 7,
  }
})
vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>()
  return {
    ...actual,
    getConfig: mocks.getConfig,
    fetchDesktopBootstrap: mocks.fetchDesktopBootstrap,
    loadDesktopAuthSnapshot: mocks.loadDesktopAuthSnapshot,
    beginDesktopAuthCandidate: mocks.beginDesktopAuthCandidate,
    commitDesktopAuthCandidate: mocks.commitDesktopAuthCandidate,
    clearDesktopAuthAuthority: mocks.clearDesktopAuthAuthority,
    confirmDesktopAuthRuntime: mocks.confirmDesktopAuthRuntime,
    invalidateDesktopAuthRuntime: mocks.invalidateDesktopAuthRuntime,
    runLocalMarkdownAi: mocks.runLocal,
    getMarkdownAiTasks: mocks.getTasks,
    consumeMarkdownAiTask: mocks.consume,
    getFileCommandTasks: mocks.getFileTasks,
    consumeFileCommandTask: mocks.consumeFile,
    openMarkdownFile: mocks.openFile,
    runSaveMarkdownFile: mocks.saveFile,
    runExportMarkdownDocx: mocks.exportDocx,
    getMarkdownSpeechState: mocks.getSpeechState,
    startMarkdownSpeechGeneration: mocks.startSpeech,
    readMarkdownSpeechAudio: mocks.readSpeech,
    openMarkdownSpeechDirectory: mocks.openSpeechDirectory,
    revealMarkdownSpeechAsset: mocks.revealSpeech,
    acquireTtsPlaybackOwner: mocks.acquireTts,
    releaseTtsPlaybackOwner: mocks.releaseTts,
    notifyOwnerWindowDestroyed: vi.fn().mockResolvedValue(false),
    revealMarkdownEditorWindow: mocks.revealMarkdownWindow,
  }
})

import App from '../App'

function renderableTestRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('standalone Markdown editor App entry', () => {
  beforeEach(() => {
    window.location.hash = '#markdown-editor'
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(renderableTestRect())
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    localStorage.clear()
    useMarkdownAiDomain.getState().reset()
    useFileCommandDomain.getState().reset()
    useAppStore.setState((state) => ({
      ...state,
      completedVoiceText: '',
      completedVoiceTextVersion: 0,
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrapAuthToken: null,
      desktopAuthSnapshot: null,
      desktopBootstrap: null,
      config: {
        ...state.config,
        config_source: 'local',
        llm_provider: 'ollama',
        llm_base_url: 'http://127.0.0.1:11434',
        llm_model: 'qwen3.5',
      },
    }))
    const draft = {
      id: 'standalone-draft',
      title: '独立文稿',
      text: 'Standalone text',
      source: 'manual' as const,
      sourceName: 'test',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      dirty: true,
    }
    localStorage.setItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY, serializeMarkdownDraft(draft))
    mocks.runLocal.mockImplementation(async (request) => ({
      key: request.key,
      outcome: { status: 'success', leaseId: 88, output: 'Standalone AI result' },
      applyContext: request.applyContext,
    }))
    mocks.runLocal.mockClear()
    mocks.getFileTasks.mockReset().mockResolvedValue([])
    mocks.consumeFile.mockReset().mockResolvedValue('consumed')
    mocks.openFile.mockReset().mockResolvedValue(null)
    mocks.getSpeechState.mockReset().mockImplementation(async (key) => ({
      key,
      task: null,
      currentAsset: null,
      latestAsset: null,
      directoryPath: 'C:\\Users\\TestUser\\Documents\\EcholIKE\\朗读音频',
    }))
    mocks.startSpeech.mockReset()
    mocks.readSpeech.mockReset()
    mocks.openSpeechDirectory.mockReset().mockResolvedValue(undefined)
    mocks.revealSpeech.mockReset().mockResolvedValue(undefined)
    mocks.acquireTts.mockReset().mockResolvedValue({ leaseId: 92, ownerWindow: 'markdown-editor' })
    mocks.releaseTts.mockReset().mockResolvedValue(true)
    mocks.getConfig.mockReset().mockImplementation(async () => useAppStore.getState().config)
    mocks.setBackgroundColor.mockReset().mockResolvedValue(undefined)
    mocks.revealMarkdownWindow.mockReset().mockResolvedValue(undefined)
    mocks.fetchDesktopBootstrap.mockReset().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
    })
    mocks.loadDesktopAuthSnapshot.mockReset().mockImplementation(async () => {
      const token = localStorage.getItem('echolike.v2.authToken')?.trim() || null
      return {
        generation: 0,
        authorityToken: token,
        rawCachedAuthToken: null,
        cache: null,
      }
    })
    mocks.beginDesktopAuthCandidate
      .mockReset()
      .mockImplementation(async (generation, authority) => ({
        generation: generation + 1,
        authorityToken: authority,
        rawCachedAuthToken: null,
        cache: null,
      }))
    mocks.confirmDesktopAuthRuntime.mockReset().mockResolvedValue(true)
    mocks.invalidateDesktopAuthRuntime.mockReset().mockResolvedValue(false)
    mocks.commitDesktopAuthCandidate
      .mockReset()
      .mockImplementation(async (generation, authority, _raw, bootstrap) => ({
        generation: generation + 1,
        authorityToken: authority,
        rawCachedAuthToken: authority,
        cache: {
          packageVersion: '0.2.12',
          bootstrap,
          authToken: authority,
          cachedAt: '2026-07-30T00:00:00.000Z',
        },
      }))
    mocks.clearDesktopAuthAuthority.mockReset().mockImplementation(async (generation) => ({
      generation: generation + 1,
      authorityToken: null,
      rawCachedAuthToken: null,
      cache: null,
    }))
    mocks.saveFile
      .mockReset()
      .mockImplementation(async (key, _name, _text, requestFingerprint) => ({
        key,
        ownerWindow: 'markdown-editor',
        requestFingerprint,
        outcome: {
          status: 'success',
          leaseId: 90,
          path: 'C:\\Downloads\\note.md',
          message: 'saved',
        },
      }))
    mocks.exportDocx.mockReset().mockImplementation(async (key, _result, requestFingerprint) => ({
      key,
      ownerWindow: 'markdown-editor',
      requestFingerprint,
      outcome: {
        status: 'success',
        leaseId: 91,
        path: 'C:\\Downloads\\note.docx',
        message: 'saved',
      },
    }))
  })

  it('waits for persisted Mint config and the complete editor shell before renderer-ready ACK', async () => {
    let resolveConfig!: (config: ReturnType<typeof useAppStore.getState>['config']) => void
    mocks.getConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfig = resolve
      }),
    )
    let themeAtReveal = ''
    let shellWasReadyAtReveal = false
    let draftTextAtReveal = ''
    mocks.revealMarkdownWindow.mockImplementation(async () => {
      themeAtReveal = document.documentElement.dataset.themeProfile ?? ''
      shellWasReadyAtReveal = Boolean(document.querySelector('.echo-markdown-editor-shell'))
      draftTextAtReveal =
        document.querySelector<HTMLElement>('[aria-label="Markdown 源文"]')?.textContent ?? ''
    })

    render(<App />)

    expect(screen.getByText('Markdown 工作区加载中。')).toBeInTheDocument()
    expect(mocks.revealMarkdownWindow).not.toHaveBeenCalled()
    const queuedDraft = parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))!
    localStorage.setItem(
      ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
      serializeMarkdownDraft({ ...queuedDraft, text: 'Mint cold-start latest draft' }),
    )

    act(() => {
      resolveConfig({
        ...useAppStore.getState().config,
        theme: 'light',
        theme_profile: 'mint',
      })
    })

    await waitFor(() => expect(mocks.revealMarkdownWindow).toHaveBeenCalledWith(7), {
      timeout: 5000,
    })
    expect(themeAtReveal).toBe('mint')
    expect(shellWasReadyAtReveal).toBe(true)
    expect(draftTextAtReveal).toContain('Mint cold-start latest draft')
    expect(mocks.setBackgroundColor).toHaveBeenCalledWith([251, 255, 253, 0])
    expect(mocks.setBackgroundColor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.revealMarkdownWindow.mock.invocationCallOrder[0],
    )
  })

  it('reveals only once when StrictMode replays effects', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    await waitFor(() => expect(mocks.revealMarkdownWindow).toHaveBeenCalledTimes(1))
    expect(mocks.setBackgroundColor).toHaveBeenCalledTimes(1)
    expect(mocks.revealMarkdownWindow).toHaveBeenCalledTimes(1)
  })

  it('shows a stable error surface instead of revealing an editor with fallback config', async () => {
    mocks.getConfig.mockRejectedValueOnce(new Error('config damaged'))

    render(<App />)

    expect(await screen.findByText('Markdown 编辑器未能启动')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Markdown 编辑器' })).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.revealMarkdownWindow).toHaveBeenCalledWith(7))
  })

  it('opens a supported Markdown text file after confirming replacement of dirty content', async () => {
    mocks.openFile.mockResolvedValue({
      fileName: 'meeting.notes.markdown',
      text: '# Imported notes\n\n- action',
    })

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 Markdown 文件' }))
    expect(mocks.openFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '继续打开' }))

    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
    expect(await screen.findByDisplayValue('meeting.notes')).toBeInTheDocument()
    expect(screen.getByText('来源：本地文件 · meeting.notes.markdown')).toBeInTheDocument()
    expect(parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))).toEqual(
      expect.objectContaining({
        title: 'meeting.notes',
        text: '# Imported notes\n\n- action',
        source: 'file',
        sourceName: 'meeting.notes.markdown',
        dirty: false,
      }),
    )
  })

  it('does not replace a standalone draft that changes while the file picker is open', async () => {
    let finishOpen!: (file: { fileName: string; text: string }) => void
    mocks.openFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve
        }),
    )

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 Markdown 文件' }))
    fireEvent.click(screen.getByRole('button', { name: '继续打开' }))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText('文稿标题'), {
      target: { value: '选择期间更新的标题' },
    })
    act(() => finishOpen({ fileName: 'stale.md', text: '# Must not replace' }))

    expect(
      await screen.findByText('选择文件期间文稿已更新，为避免覆盖当前修改，请重新打开文件。'),
    ).toBeInTheDocument()
    expect(screen.getByDisplayValue('选择期间更新的标题')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('stale')).not.toBeInTheDocument()
    expect(parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))).toEqual(
      expect.objectContaining({
        title: '选择期间更新的标题',
        text: 'Standalone text',
        dirty: true,
      }),
    )
  })

  it('silently discards a file result after the standalone editor switches drafts', async () => {
    let finishOpen!: (file: { fileName: string; text: string }) => void
    mocks.openFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve
        }),
    )
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 Markdown 文件' }))
    fireEvent.click(screen.getByRole('button', { name: '继续打开' }))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))

    const replacementDraft = {
      id: 'replacement-draft',
      title: '另一份活动文稿',
      text: '# Keep this draft',
      source: 'manual' as const,
      sourceName: 'replacement',
      createdAt: '2026-07-20T04:00:00.000Z',
      updatedAt: '2026-07-20T04:00:00.000Z',
      dirty: true,
    }
    const serializedReplacement = serializeMarkdownDraft(replacementDraft)
    localStorage.setItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY, serializedReplacement)
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
          newValue: serializedReplacement,
        }),
      )
    })
    expect(await screen.findByDisplayValue('另一份活动文稿')).toBeInTheDocument()

    act(() => finishOpen({ fileName: 'stale.md', text: '# Must not replace' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', { name: '打开文件并替换当前文稿？' }),
      ).not.toBeInTheDocument(),
    )
    expect(screen.getByDisplayValue('另一份活动文稿')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('stale')).not.toBeInTheDocument()
    expect(
      screen.queryByText('选择文件期间文稿已更新，为避免覆盖当前修改，请重新打开文件。'),
    ).not.toBeInTheDocument()
  })

  it('reports a file read failure after the same standalone draft changes', async () => {
    let failOpen!: (reason: Error) => void
    mocks.openFile.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failOpen = reject
        }),
    )
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '打开 Markdown 文件' }))
    fireEvent.click(screen.getByRole('button', { name: '继续打开' }))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('文稿标题'), {
      target: { value: '读取期间更新的标题' },
    })

    act(() => failOpen(new Error('测试文件读取失败。')))

    expect(await screen.findByText('测试文件读取失败。')).toBeInTheDocument()
    expect(screen.getByDisplayValue('读取期间更新的标题')).toBeInTheDocument()
  })

  it('restores exact running state from the process snapshot without blocking another kind', async () => {
    mocks.getFileTasks.mockResolvedValue([
      {
        key: { resourceId: 'draft:standalone-draft', commandKind: 'saveMarkdown' },
        ownerWindow: 'markdown-editor',
        requestFingerprint: 'rev-running',
        outcome: { status: 'running', leaseId: 92 },
      },
    ])
    render(<App />)
    expect(await screen.findByRole('button', { name: '保存中' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '导出 Word' })).toBeEnabled()
  })

  it('restores a matching save terminal and persists clean state', async () => {
    // The production fingerprint is captured through one normal save payload.
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '保存 .md' }))
    await waitFor(() => expect(mocks.saveFile).toHaveBeenCalled())
    const captured = mocks.saveFile.mock.calls[0][3]
    cleanup()
    const current = parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))!
    localStorage.setItem(
      ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
      serializeMarkdownDraft({ ...current, dirty: true }),
    )
    useFileCommandDomain.getState().reset()
    mocks.getFileTasks.mockResolvedValue([
      {
        key: { resourceId: 'draft:standalone-draft', commandKind: 'saveMarkdown' },
        ownerWindow: 'markdown-editor',
        requestFingerprint: captured,
        outcome: {
          status: 'success',
          leaseId: 94,
          path: 'C:\\Downloads\\note.md',
          message: 'saved',
        },
      },
    ])
    mocks.consumeFile.mockResolvedValue('consumed')
    render(<App />)
    await waitFor(() =>
      expect(
        parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))?.dirty,
      ).toBe(false),
    )
    const editor = screen.getByRole('dialog', { name: 'Markdown 编辑器' })
    expect(await within(editor).findByRole('status')).toHaveTextContent('Markdown 已保存到')
  })

  it('silently reconciles an already-consumed nonmatching save without clearing dirty', async () => {
    mocks.getFileTasks.mockResolvedValue([
      {
        key: { resourceId: 'draft:standalone-draft', commandKind: 'saveMarkdown' },
        ownerWindow: 'markdown-editor',
        requestFingerprint: 'old-title-revision',
        outcome: {
          status: 'success',
          leaseId: 95,
          path: 'C:\\Downloads\\old.md',
          message: 'saved',
        },
      },
    ])
    mocks.consumeFile.mockResolvedValue('alreadyConsumed')
    render(<App />)
    await waitFor(() => expect(mocks.consumeFile).toHaveBeenCalled())
    expect(parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))?.dirty).toBe(
      true,
    )
    expect(screen.queryByText(/Markdown 已保存到/)).not.toBeInTheDocument()
  })

  it('does not clear dirty when title changes while the saved revision is pending', async () => {
    let finish!: (value: unknown) => void
    mocks.saveFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '保存 .md' }))
    await waitFor(() => expect(mocks.saveFile).toHaveBeenCalledTimes(1))
    const [key, , , requestFingerprint] = mocks.saveFile.mock.calls[0]
    fireEvent.change(screen.getByLabelText('文稿标题'), { target: { value: '保存后继续编辑' } })
    finish({
      key,
      ownerWindow: 'markdown-editor',
      requestFingerprint,
      outcome: { status: 'success', leaseId: 93, path: 'C:\\Downloads\\old.md', message: 'saved' },
    })
    await waitFor(() => expect(mocks.consumeFile).toHaveBeenCalledWith(expect.anything(), 93))
    expect(await screen.findByText(/Markdown 已保存到/)).toBeInTheDocument()
    expect(screen.getByText('未保存')).toBeInTheDocument()
    expect(parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))?.dirty).toBe(
      true,
    )
  })

  it('requests a native destination when exporting Word from the standalone editor', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '导出 Word' }))

    await waitFor(() =>
      expect(mocks.exportDocx).toHaveBeenCalledWith(
        expect.objectContaining({ commandKind: 'exportDocx' }),
        expect.objectContaining({ text: 'Standalone text', source_kind: 'editor' }),
        expect.any(String),
        true,
      ),
    )
  })

  it('keeps copy and unavailable TTS feedback inside the standalone editor', async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })

    try {
      render(<App />)
      const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })

      fireEvent.click(within(editor).getByRole('button', { name: '复制 Markdown' }))
      expect(await within(editor).findByRole('status')).toHaveTextContent('Markdown 已复制。')

      fireEvent.click(within(editor).getByRole('button', { name: '生成朗读' }))
      expect(await within(editor).findByRole('alert')).toHaveTextContent(
        '本机配置暂未启用 TTS 朗读。',
      )
      expect(document.querySelector('.echo-toast-container')).toBeNull()
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      } else {
        Reflect.deleteProperty(navigator, 'clipboard')
      }
    }
  })

  it('clears stale save feedback when a completed voice result is appended', async () => {
    render(<App />)
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(editor).getByRole('button', { name: '保存 .md' }))
    expect(await within(editor).findByRole('status')).toHaveTextContent('Markdown 已保存到')

    act(() => useAppStore.getState().setCompletedVoiceText('追加的语音结果'))

    await waitFor(() => {
      expect(
        parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))?.text,
      ).toContain('追加的语音结果')
    })
    expect(within(editor).queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('未保存')).toBeInTheDocument()
  })

  it('ignores file terminals owned by the main window', async () => {
    render(<App />)
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    mocks.consumeFile.mockClear()

    await act(async () => {
      useFileCommandDomain.getState().accept({
        key: { resourceId: 'draft:standalone-draft', commandKind: 'saveMarkdown' },
        ownerWindow: 'main',
        requestFingerprint: 'foreign-window',
        outcome: {
          status: 'success',
          leaseId: 96,
          path: 'D:\\Docs\\main.md',
          message: 'saved',
        },
      })
      await Promise.resolve()
    })

    expect(mocks.consumeFile).not.toHaveBeenCalled()
    expect(within(editor).queryByText(/main\.md/)).not.toBeInTheDocument()
  })

  it('does not apply a consumed save result to a replacement draft', async () => {
    let finishConsume!: (value: 'consumed') => void
    const pendingConsume = new Promise<'consumed'>((resolve) => {
      finishConsume = resolve
    })
    mocks.consumeFile.mockImplementation(() => pendingConsume)

    render(<App />)
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    fireEvent.click(within(editor).getByRole('button', { name: '保存 .md' }))
    await waitFor(() => expect(mocks.consumeFile).toHaveBeenCalled())

    const current = parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))!
    const serializedOriginal = serializeMarkdownDraft(current)
    const replacement = {
      ...current,
      id: 'replacement-draft',
      sourceName: 'replacement',
      dirty: true,
    }
    const serializedReplacement = serializeMarkdownDraft(replacement)
    localStorage.setItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY, serializedReplacement)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
        newValue: serializedReplacement,
      }),
    )
    expect(await screen.findByText(/replacement/)).toBeInTheDocument()

    await act(async () => {
      finishConsume('consumed')
      await pendingConsume
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        parseMarkdownDraft(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)),
      ).toMatchObject({
        id: 'replacement-draft',
        dirty: true,
      }),
    )
    expect(within(editor).queryByText(/note\.md/)).not.toBeInTheDocument()

    localStorage.setItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY, serializedOriginal)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
        newValue: serializedOriginal,
      }),
    )
    expect(await within(editor).findByRole('status')).toHaveTextContent('Markdown 已保存到')
  })

  it('routes standalone AI through the typed Rust command and accepts its snapshot', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '润色' }))
    await waitFor(() => expect(mocks.runLocal).toHaveBeenCalledTimes(1))
    const payload = mocks.runLocal.mock.calls[0][0]
    expect(payload).toMatchObject({
      key: {
        draftId: 'standalone-draft',
        request: {
          action: 'polish',
          draftRevision: expect.any(String),
          semanticFingerprint: expect.any(String),
        },
      },
      applyContext: { fullText: 'Standalone text', text: 'Standalone text', title: '独立文稿' },
      provider: 'ollama',
      model: 'qwen3.5',
    })
    expect(payload.key.request.semanticFingerprint).not.toContain('apiKey')
    expect(await screen.findByText('Standalone AI result')).toBeInTheDocument()
    expect(useMarkdownAiDomain.getState().byDraft['standalone-draft'][0].outcome).toMatchObject({
      status: 'success',
      leaseId: 88,
    })
  })

  it('repairs a stale browser auth mirror from the native authority during Markdown startup', async () => {
    localStorage.setItem('echolike.v2.authToken', 'current-token')
    useAppStore.setState((state) => ({
      config: { ...state.config, config_source: 'backend' },
    }))
    const persisted = {
      generation: 4,
      authorityToken: 'older-token',
      rawCachedAuthToken: 'older-token',
      cache: {
        packageVersion: '0.2.12',
        cachedAt: '2026-07-29T00:00:00.000Z',
        authToken: 'older-token',
        bootstrap: {
          schemaVersion: 1,
          generatedAt: '2026-07-29T00:00:00.000Z',
          apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
          user: {
            email: 'old@example.com',
            name: null,
            plan: 'pro',
            subscriptionEnd: null,
          },
          services: { llm: { mode: 'proxy', configured: true } },
        },
      },
    }
    const candidate = { ...persisted, generation: 5, cache: null }
    const recoveredBootstrap = {
      schemaVersion: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'recovered@example.com',
        name: null,
        plan: 'pro' as const,
        subscriptionEnd: null,
      },
      services: { llm: { mode: 'proxy' as const, configured: true } },
    }
    mocks.loadDesktopAuthSnapshot.mockResolvedValue(persisted)
    mocks.beginDesktopAuthCandidate.mockResolvedValue(candidate)
    mocks.fetchDesktopBootstrap.mockResolvedValue(recoveredBootstrap)
    mocks.commitDesktopAuthCandidate.mockResolvedValue({
      generation: 6,
      authorityToken: 'older-token',
      rawCachedAuthToken: 'older-token',
      cache: {
        packageVersion: '0.2.12',
        cachedAt: '2026-07-30T00:00:00.000Z',
        authToken: 'older-token',
        bootstrap: recoveredBootstrap,
      },
    })

    render(<App />)

    const polishButton = await screen.findByRole('button', { name: '润色' })
    await waitFor(() => expect(polishButton).toBeEnabled())
    expect(mocks.beginDesktopAuthCandidate).toHaveBeenCalledWith(4, 'older-token')
    expect(mocks.fetchDesktopBootstrap).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'older-token',
    )
    expect(localStorage.getItem('echolike.v2.authToken')).toBe('older-token')
    expect(useAppStore.getState().desktopAuthStatus).toBe('authenticated')
    expect(useAppStore.getState().desktopBootstrap?.user?.email).toBe('recovered@example.com')
  })

  it('drops Markdown managed authorization when another window changes the token', async () => {
    localStorage.setItem('echolike.v2.authToken', 'current-token')
    useAppStore.setState((state) => ({
      config: { ...state.config, config_source: 'backend' },
    }))
    const nativeSnapshot = {
      generation: 4,
      authorityToken: 'current-token',
      rawCachedAuthToken: 'current-token',
      cache: {
        packageVersion: '0.2.12',
        cachedAt: '2026-07-30T00:00:00.000Z',
        authToken: 'current-token',
        bootstrap: {
          schemaVersion: 1,
          generatedAt: '2026-07-30T00:00:00.000Z',
          apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
          user: {
            email: 'user@example.com',
            name: null,
            plan: 'pro',
            subscriptionEnd: null,
          },
          services: { llm: { mode: 'proxy', configured: true } },
        },
      },
    }
    mocks.loadDesktopAuthSnapshot.mockResolvedValue(nativeSnapshot)
    const candidateSnapshot = {
      ...nativeSnapshot,
      generation: 5,
    }
    mocks.beginDesktopAuthCandidate.mockImplementationOnce(async () => {
      mocks.loadDesktopAuthSnapshot.mockResolvedValue(candidateSnapshot)
      return candidateSnapshot
    })
    mocks.fetchDesktopBootstrap.mockReturnValue(new Promise(() => undefined))

    render(<App />)

    const polish = await screen.findByRole('button', { name: '润色' })
    await waitFor(() => expect(polish).toBeEnabled())
    localStorage.setItem('echolike.v2.authToken', 'new-token')
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'echolike.v2.authToken',
        oldValue: 'current-token',
        newValue: 'new-token',
      }),
    )

    await waitFor(() => expect(polish).toBeDisabled())
    expect(useAppStore.getState().desktopAuthToken).toBe('new-token')
    expect(useAppStore.getState().desktopAuthStatus).toBe('unknown')
  })

  it('queues continuous voice results until the AI result is applied or cancelled', async () => {
    let finishAi!: () => void
    const pending = new Promise<void>((resolve) => {
      finishAi = resolve
    })
    mocks.runLocal.mockImplementationOnce(async (request) => {
      await pending
      return {
        key: request.key,
        outcome: { status: 'success' as const, leaseId: 93, output: '待处理结果' },
        applyContext: request.applyContext,
      }
    })

    render(<App />)
    const editor = await screen.findByRole('dialog', { name: 'Markdown 编辑器' })
    const polish = within(editor).getByRole('button', { name: '润色' })
    await waitFor(() => expect(polish).toBeEnabled())
    fireEvent.click(polish)

    act(() => {
      useAppStore.setState({
        completedVoiceText: 'AI 期间到达的语音',
        completedVoiceTextVersion: 1,
      })
    })
    expect(within(editor).getByRole('textbox', { name: 'Markdown 源文' })).not.toHaveTextContent(
      'AI 期间到达的语音',
    )

    finishAi()
    expect(await within(editor).findByText('待处理结果')).toBeInTheDocument()
    expect(within(editor).getByRole('textbox', { name: 'Markdown 源文' })).not.toHaveTextContent(
      'AI 期间到达的语音',
    )

    fireEvent.click(within(editor).getByRole('button', { name: '取消' }))
    await waitFor(() =>
      expect(within(editor).getByRole('textbox', { name: 'Markdown 源文' })).toHaveTextContent(
        'AI 期间到达的语音',
      ),
    )
  })
})
