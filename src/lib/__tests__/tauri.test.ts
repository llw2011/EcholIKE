import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../../stores/appStore'
import type { OtaInstallProgress } from '../tauri'

const tauriMocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  invoke: vi.fn(),
  relaunch: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: tauriMocks.getVersion,
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: tauriMocks.relaunch,
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: tauriMocks.check,
}))

import {
  acknowledgeIdempotentOperation,
  acquireTtsPlaybackOwner,
  beginMarkdownEditorWindow,
  downloadAndInstallOtaUpdate,
  notifyOwnerWindowDestroyed,
  proxyTtsOnce,
  getMarkdownAiTasks,
  runLocalMarkdownAi,
  runProxyMarkdownAi,
  releaseTtsPlaybackOwner,
  revealMarkdownEditorWindow,
  getMarkdownSpeechState,
  startMarkdownSpeechGeneration,
  readMarkdownSpeechAudio,
  openMarkdownSpeechDirectory,
  revealMarkdownSpeechAsset,
  getFileCommandTasks,
  consumeFileCommandTask,
  fetchDesktopBootstrap,
  beginDesktopAuthCandidate,
  beginDesktopAuthCandidateForLogin,
  clearDesktopAuthAuthority,
  commitDesktopAuthCandidate,
  confirmDesktopAuthRuntime,
  invalidateDesktopAuthRuntime,
  loadDesktopAuthSnapshot,
  openMarkdownFile,
  runSaveMarkdownFile,
  runExportMarkdownDocx,
  runExportPdfImages,
  runExportMarkdownFile,
  startRecording,
  stopRecording,
  abortRecording,
  readScreenOcrSelection,
  readScreenOcrSelectionProxy,
  readUploadedPdfProxy,
  readUploadedOcrProxy,
  testOcrConnection,
  syncMainWindowShape,
  updateConfig,
  getConfig,
  getConfigSnapshot,
  acquireOnboardingGuard,
  chooseUsageMode,
  clearHistory,
  deleteHistoryEntries,
  releaseOnboardingGuard,
  resolveOnboardingStartup,
} from '../tauri'

describe('history mutation bridge', () => {
  it('maps selected and full deletion to distinct native commands', async () => {
    tauriMocks.invoke.mockResolvedValueOnce([2, 7]).mockResolvedValueOnce({ clearedThroughId: 19 })

    await expect(deleteHistoryEntries([7, 2, 7])).resolves.toEqual([2, 7])
    await expect(clearHistory()).resolves.toEqual({ clearedThroughId: 19 })

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['delete_history_entries', { ids: [7, 2, 7] }],
      ['clear_history'],
    ])
  })
})

describe('idempotency acknowledgement bridge', () => {
  it('sends only the opaque operation ID to the native registry', async () => {
    await acknowledgeIdempotentOperation('operation-root-123')

    expect(tauriMocks.invoke).toHaveBeenCalledOnce()
    expect(tauriMocks.invoke).toHaveBeenCalledWith('acknowledge_idempotent_operation', {
      operationId: 'operation-root-123',
    })
  })
})

describe('first-run config bridge', () => {
  it('unwraps the config from the provenance snapshot command', async () => {
    const config = { config_source: 'backend', onboarding_version: 1 } as AppConfig
    tauriMocks.invoke.mockResolvedValueOnce({ config, origin: 'persisted' })

    await expect(getConfig()).resolves.toBe(config)
    expect(tauriMocks.invoke).toHaveBeenCalledWith('get_config_snapshot')
  })

  it('uses v2 config origin, native mode selection, and a process-local tutorial guard', async () => {
    tauriMocks.invoke
      .mockResolvedValueOnce({ config: {}, origin: 'created_new' })
      .mockResolvedValueOnce({ config_source: 'local', onboarding_version: 1 })
      .mockResolvedValueOnce(41)
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(true)

    await getConfigSnapshot()
    await chooseUsageMode('local')
    await resolveOnboardingStartup(true, true)
    await acquireOnboardingGuard()
    await releaseOnboardingGuard(42)

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['get_config_snapshot'],
      ['choose_usage_mode', { source: 'local' }],
      ['resolve_onboarding_startup', { showTour: true, configAvailable: true }],
      ['acquire_onboarding_guard'],
      ['release_onboarding_guard', { lease: 42 }],
    ])
  })

  it('sends both the renderer base and requested config for a field-level merge', async () => {
    const base = { config_source: 'backend', onboarding_version: 1 } as AppConfig
    const requested = { ...base, theme: 'dark' } as AppConfig
    tauriMocks.invoke.mockResolvedValueOnce(requested)

    await updateConfig(base, requested)

    expect(tauriMocks.invoke).toHaveBeenCalledWith('update_config', {
      baseConfig: base,
      config: requested,
    })
  })
})

describe('desktop bootstrap bridge', () => {
  it('preserves the negotiated PDF document contract without renderer-controlled flags', async () => {
    const bootstrap = {
      schemaVersion: 1,
      generatedAt: '2026-07-21T00:00:00.000Z',
      apiBaseUrl: 'https://example.test/echo-api',
      services: {
        ocr: {
          mode: 'proxy',
          capabilities: {
            documentContract: 'ocr-document-v1',
            pdfMode: 'server-pipeline',
          },
        },
      },
    }
    tauriMocks.invoke.mockResolvedValueOnce(bootstrap)

    await expect(
      fetchDesktopBootstrap('https://example.test/echo-api/desktop/bootstrap', '0.2.9', 'token'),
    ).resolves.toEqual(bootstrap)
    expect(tauriMocks.invoke).toHaveBeenCalledWith('fetch_desktop_bootstrap', {
      bootstrapUrl: 'https://example.test/echo-api/desktop/bootstrap',
      currentVersion: '0.2.9',
      authToken: 'token',
    })
  })

  it('maps the generation-fenced desktop auth snapshot commands', async () => {
    const bootstrap = {
      schemaVersion: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      apiBaseUrl: 'https://example.test/echo-api',
    }
    const snapshot = {
      generation: 9,
      authorityToken: 'session-token',
      rawCachedAuthToken: null,
      cache: null,
    }
    tauriMocks.invoke.mockResolvedValue(snapshot)

    await loadDesktopAuthSnapshot()
    await confirmDesktopAuthRuntime(9, 'session-token')
    await invalidateDesktopAuthRuntime(9, 'session-token')
    await beginDesktopAuthCandidate(9, 'session-token')
    await beginDesktopAuthCandidateForLogin(null, null, 'recovered-token')
    await commitDesktopAuthCandidate(10, 'next-token', null, bootstrap)
    await clearDesktopAuthAuthority(11, 'next-token')

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['load_desktop_auth_snapshot'],
      [
        'confirm_desktop_auth_runtime',
        { expectedGeneration: 9, expectedAuthorityToken: 'session-token' },
      ],
      [
        'invalidate_desktop_auth_runtime',
        { expectedGeneration: 9, expectedAuthorityToken: 'session-token' },
      ],
      [
        'begin_desktop_auth_candidate',
        {
          expectedGeneration: 9,
          expectedAuthorityToken: 'session-token',
        },
      ],
      [
        'begin_desktop_auth_candidate_for_login',
        {
          expectedGeneration: null,
          expectedAuthorityToken: null,
          nextAuthorityToken: 'recovered-token',
        },
      ],
      [
        'commit_desktop_auth_candidate',
        {
          expectedGeneration: 10,
          expectedAuthorityToken: 'next-token',
          expectedRawCachedAuthToken: null,
          bootstrap,
        },
      ],
      [
        'clear_desktop_auth_authority',
        { expectedGeneration: 11, expectedAuthorityToken: 'next-token' },
      ],
    ])
  })
})

describe('recording transition bridge', () => {
  it.each([
    ['start_recording', startRecording],
    ['stop_recording', stopRecording],
    ['abort_recording', abortRecording],
  ] as const)('returns the typed boolean from %s', async (command, call) => {
    tauriMocks.invoke.mockResolvedValueOnce(false)
    await expect(call()).resolves.toBe(false)
    expect(tauriMocks.invoke).toHaveBeenCalledWith(command)
  })
})

describe('system screenshot OCR bridge', () => {
  it('maps the local availability probe to the native OCR connection command', async () => {
    const capabilities = {
      modelAvailable: true,
      imageAvailable: true,
      pdfAvailable: true,
      routerAvailable: true,
      pipelineAvailable: true,
      issues: [],
    }
    tauriMocks.invoke.mockResolvedValueOnce(capabilities)

    await expect(testOcrConnection('http://127.0.0.1:11434', 'glm-ocr:latest')).resolves.toEqual(
      capabilities,
    )
    expect(tauriMocks.invoke).toHaveBeenCalledWith('test_ocr_connection', {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'glm-ocr:latest',
    })
  })

  it('preserves explicit success and cancellation outcomes with exact command arguments', async () => {
    const success = {
      status: 'success' as const,
      result: {
        app_name: 'Code',
        window_title: 'Editor',
        app_type: 'Development',
        text: '# OCR',
        elapsed_ms: 12,
        model: 'glm-ocr:latest',
        route: 'pipeline' as const,
        processing_reason: 'dense-layout',
        warnings: ['完整文档管线未完成'],
        degraded: true,
      },
    }
    tauriMocks.invoke.mockResolvedValueOnce(success).mockResolvedValueOnce({ status: 'cancelled' })

    await expect(
      readScreenOcrSelection('http://127.0.0.1:11434', 'glm-ocr:latest'),
    ).resolves.toEqual(success)
    await expect(
      readScreenOcrSelectionProxy('https://example.test/echo-api', 'token'),
    ).resolves.toEqual({ status: 'cancelled' })
    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['read_screen_ocr_selection', { baseUrl: 'http://127.0.0.1:11434', model: 'glm-ocr:latest' }],
      [
        'read_screen_ocr_selection_proxy',
        { apiBaseUrl: 'https://example.test/echo-api', token: 'token' },
      ],
    ])
  })
})

describe('uploaded OCR bridge', () => {
  it('keeps image and negotiated PDF uploads on separate native commands', async () => {
    const image = {
      fileName: 'scan.png',
      mimeType: 'image/png',
      imageBase64: 'aW1hZ2U=',
    }
    const document = {
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileBase64: 'JVBERi0xLjc=',
    }

    await readUploadedOcrProxy('https://example.test/echo-api', 'token', image)
    await readUploadedPdfProxy('https://example.test/echo-api', 'token', document)

    expect(tauriMocks.invoke.mock.calls).toEqual([
      [
        'read_uploaded_ocr_proxy',
        {
          apiBaseUrl: 'https://example.test/echo-api',
          token: 'token',
          fileName: 'scan.png',
          mimeType: 'image/png',
          imageBase64: 'aW1hZ2U=',
          fileBase64: undefined,
          fileBytes: undefined,
        },
      ],
      [
        'read_uploaded_pdf_proxy',
        {
          apiBaseUrl: 'https://example.test/echo-api',
          token: 'token',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          fileBase64: 'JVBERi0xLjc=',
          fileBytes: undefined,
        },
      ],
    ])
  })
})

describe('native window lifecycle bridge', () => {
  it('delegates shape synchronization to the native window command', async () => {
    await syncMainWindowShape()

    expect(tauriMocks.invoke).toHaveBeenCalledWith('sync_main_window_shape')
  })

  it('uses native Markdown creation and the generation-fenced renderer-ready command', async () => {
    const options = {
      width: 1120,
      height: 780,
      minWidth: 720,
      minHeight: 520,
      backgroundColor: [251, 255, 253, 0] as [number, number, number, number],
    }
    await beginMarkdownEditorWindow(options)
    await revealMarkdownEditorWindow(7)

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['begin_markdown_editor_window', { options }],
      ['reveal_markdown_editor_window', { generation: 7 }],
    ])
  })
})

describe('typed file command bridge', () => {
  it('sends stable key and small request fingerprint without generic payloads', async () => {
    const key = { resourceId: 'draft-a', commandKind: 'saveMarkdown' as const }
    await getFileCommandTasks()
    await consumeFileCommandTask(key, 9)
    await runSaveMarkdownFile(key, 'note.md', '# note', 'rev-1')
    await runExportMarkdownFile(
      { ...key, commandKind: 'exportMarkdown' },
      'ocr.md',
      '# ocr',
      'ocr-1',
    )
    await runExportMarkdownDocx(
      { ...key, commandKind: 'exportDocx' },
      { text: '# note', source_name: 'note' } as never,
      'rev-1',
      true,
    )
    await runExportPdfImages(
      { resourceId: 'ocr-3', commandKind: 'exportPdf' },
      { fileName: 'scan.pdf', mimeType: 'application/pdf', fileBytes: [37, 80] },
      'ocr-lease-3',
    )
    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['get_file_command_tasks'],
      ['consume_file_command_task', { key, leaseId: 9 }],
      [
        'run_save_markdown_file',
        { key, fileName: 'note.md', text: '# note', requestFingerprint: 'rev-1' },
      ],
      [
        'run_export_markdown_file',
        {
          key: { ...key, commandKind: 'exportMarkdown' },
          fileName: 'ocr.md',
          text: '# ocr',
          requestFingerprint: 'ocr-1',
        },
      ],
      [
        'run_export_markdown_docx',
        {
          key: { ...key, commandKind: 'exportDocx' },
          sourceName: 'note',
          markdown: '# note',
          pageCount: null,
          requestFingerprint: 'rev-1',
          promptForDestination: true,
        },
      ],
      [
        'run_export_pdf_images',
        {
          key: { resourceId: 'ocr-3', commandKind: 'exportPdf' },
          fileName: 'scan.pdf',
          mimeType: 'application/pdf',
          fileBase64: undefined,
          fileBytes: [37, 80],
          requestFingerprint: 'ocr-lease-3',
        },
      ],
    ])
  })
})

describe('Markdown file open bridge', () => {
  it('delegates the native filtered picker without renderer file-system access', async () => {
    const opened = { fileName: 'notes.markdown', text: '# Notes' }
    tauriMocks.invoke.mockResolvedValueOnce(opened)

    await expect(openMarkdownFile()).resolves.toEqual(opened)
    expect(tauriMocks.invoke).toHaveBeenCalledWith('open_markdown_file')
  })
})

beforeEach(() => {
  tauriMocks.check.mockReset()
  tauriMocks.getVersion.mockReset()
  tauriMocks.invoke.mockReset()
  tauriMocks.relaunch.mockReset()
  tauriMocks.invoke.mockResolvedValue(undefined)
  tauriMocks.relaunch.mockResolvedValue(undefined)
})

describe('process ownership bridge', () => {
  it('uses domain commands with typed camel-case payloads', async () => {
    const markdownKey = {
      draftId: 'draft-1',
      request: {
        action: 'translate',
        target: { kind: 'selection', start: 4, end: 12 },
        draftRevision: 'sha256:abc',
        semanticFingerprint: 'scope-a',
      },
    } as const
    await acquireTtsPlaybackOwner()
    await releaseTtsPlaybackOwner(4)
    const speechKey = {
      draftId: 'draft-1',
      contentRevision: 'rev-1',
      voiceKey: 'alloy',
      speedMilli: 1000,
    }
    await getMarkdownSpeechState(speechKey)
    await startMarkdownSpeechGeneration({
      key: speechKey,
      title: '文稿',
      chunks: ['第一段', '第二段'],
      apiBaseUrl: 'https://api',
      token: 'token',
    })
    await readMarkdownSpeechAudio(12)
    await openMarkdownSpeechDirectory()
    await revealMarkdownSpeechAsset(12)
    await getMarkdownAiTasks('draft-a')
    await runProxyMarkdownAi(
      {
        key: markdownKey,
        question: 'q',
        sourceText: 's',
        applyContext: { fullText: 's', text: 's', title: 't' },
      },
      'https://api',
      'token',
    )
    await runLocalMarkdownAi({
      key: markdownKey,
      question: 'q',
      sourceText: 's',
      applyContext: { fullText: 's', text: 's', title: 't' },
      provider: 'ollama',
      apiKey: '',
      baseUrl: 'http://local',
      model: 'm',
    })
    await notifyOwnerWindowDestroyed()
    await proxyTtsOnce('https://api.test', 'token', 'chunk', 'voice', 7)
    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['acquire_tts_playback_owner'],
      ['release_tts_playback_owner', { leaseId: 4 }],
      ['get_markdown_speech_state', { key: speechKey }],
      [
        'start_markdown_speech_generation',
        {
          request: {
            key: speechKey,
            title: '文稿',
            chunks: ['第一段', '第二段'],
            apiBaseUrl: 'https://api',
            token: 'token',
          },
        },
      ],
      ['read_markdown_speech_audio', { assetId: 12 }],
      ['open_markdown_speech_directory'],
      ['reveal_markdown_speech_asset', { assetId: 12 }],
      ['get_markdown_ai_tasks', { draftId: 'draft-a' }],
      [
        'run_proxy_markdown_ai',
        {
          request: {
            key: markdownKey,
            question: 'q',
            sourceText: 's',
            applyContext: { fullText: 's', text: 's', title: 't' },
          },
          apiBaseUrl: 'https://api',
          token: 'token',
        },
      ],
      [
        'run_local_markdown_ai',
        {
          request: {
            key: markdownKey,
            question: 'q',
            sourceText: 's',
            applyContext: { fullText: 's', text: 's', title: 't' },
            provider: 'ollama',
            apiKey: '',
            baseUrl: 'http://local',
            model: 'm',
          },
        },
      ],
      ['notify_owner_window_destroyed'],
      [
        'proxy_tts_once',
        {
          apiBaseUrl: 'https://api.test',
          token: 'token',
          text: 'chunk',
          voice: 'voice',
          playbackLeaseId: 7,
        },
      ],
    ])
  })
})

describe('downloadAndInstallOtaUpdate', () => {
  it('keeps OTA as one native updater transaction and relaunches only after it returns', async () => {
    const order: string[] = []
    const progress: OtaInstallProgress[] = []
    const update = {
      version: '0.2.0',
      downloadAndInstall: vi.fn(async (onEvent: (event: any) => void) => {
        onEvent({ event: 'Started', data: { contentLength: 100 } })
        onEvent({ event: 'Progress', data: { chunkLength: 25 } })
        onEvent({ event: 'Finished', data: {} })
        order.push('downloadAndInstall')
      }),
    }

    tauriMocks.check.mockResolvedValue(update)
    tauriMocks.relaunch.mockImplementation(async () => {
      order.push('relaunch')
    })

    await downloadAndInstallOtaUpdate(
      'https://example.com/update.json',
      '0.1.0',
      undefined,
      (next) => progress.push(next),
      async (result) => {
        expect(result.latestVersion).toBe('0.2.0')
        order.push('ready')
        return true
      },
    )

    expect(order).toEqual(['downloadAndInstall', 'ready', 'relaunch'])
    expect(tauriMocks.invoke).not.toHaveBeenCalled()
    expect(progress.map((item) => item.phase)).toEqual([
      'checking',
      'downloading',
      'downloading',
      'downloading',
      'installing',
      'relaunching',
    ])
    expect(progress[progress.length - 1]).toEqual({
      phase: 'relaunching',
      downloadedBytes: 100,
      totalBytes: 100,
      percent: 100,
    })
  })

  it('does not relaunch when the owner becomes stale at the verified install boundary', async () => {
    tauriMocks.check.mockResolvedValue({
      version: '0.2.0',
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    })

    await downloadAndInstallOtaUpdate(
      'https://example.com/update.json',
      '0.1.0',
      undefined,
      undefined,
      async () => false,
    )

    expect(tauriMocks.relaunch).not.toHaveBeenCalled()
  })

  it('does not relaunch or run frontend tray cleanup when the native updater fails', async () => {
    const installError = new Error('installer failed')
    const update = {
      version: '0.2.0',
      downloadAndInstall: vi.fn().mockRejectedValue(installError),
    }
    tauriMocks.check.mockResolvedValue(update)

    await expect(
      downloadAndInstallOtaUpdate('https://example.com/update.json', '0.1.0'),
    ).rejects.toBe(installError)

    expect(tauriMocks.invoke).not.toHaveBeenCalled()
    expect(tauriMocks.relaunch).not.toHaveBeenCalled()
  })
})
