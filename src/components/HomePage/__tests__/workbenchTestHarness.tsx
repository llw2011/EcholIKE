import { afterEach, beforeEach, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { cleanup } from '@testing-library/react'
import type { DesktopBootstrap, OcrConnectionTestResult, OcrReadResult } from '../../../lib/tauri'
import { localOcrConfigurationKey, useAppStore } from '../../../stores/appStore'
import { useMarkdownAiDomain } from '../../MarkdownEditor/markdownAiTask'
import { useFileCommandDomain } from '../../../stores/fileCommandStore'

const availableLocalOcrCapabilities: OcrConnectionTestResult = {
  modelAvailable: true,
  imageAvailable: true,
  pdfAvailable: true,
  routerAvailable: true,
  pipelineAvailable: true,
  issues: [],
}

const unavailableLocalOcrCapabilities: OcrConnectionTestResult = {
  modelAvailable: false,
  imageAvailable: false,
  pdfAvailable: false,
  routerAvailable: false,
  pipelineAvailable: false,
  issues: ['unavailable'],
}

const imageOnlyLocalOcrCapabilities: OcrConnectionTestResult = {
  modelAvailable: true,
  imageAvailable: true,
  pdfAvailable: false,
  routerAvailable: true,
  pipelineAvailable: false,
  issues: ['Document pipeline unavailable'],
}

const tauriMocks = vi.hoisted(() => ({
  abortRecording: vi.fn().mockResolvedValue(true),
  askLlmOnce: vi.fn().mockResolvedValue('ok'),
  askProxyLlmOnce: vi
    .fn()
    .mockResolvedValue({ text: 'cloud answer', operationId: 'ask-operation' }),
  beginMarkdownEditorWindow: vi.fn().mockResolvedValue({ status: 'activated', generation: 1 }),
  acknowledgeIdempotentOperation: vi.fn().mockResolvedValue(undefined),
  getMarkdownAiTasks: vi.fn().mockResolvedValue([]),
  consumeMarkdownAiTask: vi.fn().mockResolvedValue(true),
  getFileCommandTasks: vi.fn().mockResolvedValue([]),
  consumeFileCommandTask: vi.fn().mockResolvedValue('consumed'),
  clearHistory: vi.fn().mockResolvedValue({ clearedThroughId: 0 }),
  deleteHistoryEntries: vi.fn().mockResolvedValue([]),
  runLocalMarkdownAi: vi.fn(),
  runProxyMarkdownAi: vi.fn(),
  quitApp: vi.fn().mockResolvedValue(undefined),
  proxyTtsOnce: vi.fn().mockResolvedValue({ audioBytes: [1, 2, 3], mimeType: 'audio/mpeg' }),
  acquireTtsPlaybackOwner: vi.fn().mockResolvedValue({ leaseId: 91, ownerWindow: 'main' }),
  releaseTtsPlaybackOwner: vi.fn().mockResolvedValue(true),
  getMarkdownSpeechState: vi.fn(),
  startMarkdownSpeechGeneration: vi.fn(),
  readMarkdownSpeechAudio: vi.fn(),
  openMarkdownSpeechDirectory: vi.fn().mockResolvedValue(undefined),
  revealMarkdownSpeechAsset: vi.fn().mockResolvedValue(undefined),
  readScreenOcr: vi.fn(),
  readScreenOcrProxy: vi.fn(),
  readScreenOcrSelection: vi.fn(),
  readScreenOcrSelectionProxy: vi.fn(),
  readUploadedOcr: vi.fn(),
  readUploadedOcrProxy: vi.fn(),
  readUploadedPdfProxy: vi.fn(),
  openMarkdownFile: vi.fn(),
  runSaveMarkdownFile: vi.fn(),
  runExportMarkdownFile: vi.fn(),
  runExportMarkdownDocx: vi.fn(),
  runExportPdfImages: vi.fn(),
  startRecording: vi.fn().mockResolvedValue(true),
  stopRecording: vi.fn().mockResolvedValue(true),
  testOcrConnection: vi.fn().mockResolvedValue({
    modelAvailable: true,
    imageAvailable: true,
    pdfAvailable: true,
    routerAvailable: true,
    pipelineAvailable: true,
    issues: [],
  }),
}))

const toastMocks = vi.hoisted(() => ({
  toast: vi.fn(),
}))

const markdownWindowMocks = vi.hoisted(() => ({
  emitTo: vi.fn().mockResolvedValue(undefined),
  primaryMonitor: vi.fn().mockResolvedValue(null),
}))

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: markdownWindowMocks.emitTo,
  listen: vi.fn().mockResolvedValue(() => undefined),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main' }),
  primaryMonitor: markdownWindowMocks.primaryMonitor,
}))

vi.mock('../../../lib/tauri', () => ({
  abortRecording: tauriMocks.abortRecording,
  acknowledgeIdempotentOperation: tauriMocks.acknowledgeIdempotentOperation,
  askLlmOnce: tauriMocks.askLlmOnce,
  askProxyLlmOnce: tauriMocks.askProxyLlmOnce,
  beginMarkdownEditorWindow: tauriMocks.beginMarkdownEditorWindow,
  getMarkdownAiTasks: tauriMocks.getMarkdownAiTasks,
  consumeMarkdownAiTask: tauriMocks.consumeMarkdownAiTask,
  getFileCommandTasks: tauriMocks.getFileCommandTasks,
  consumeFileCommandTask: tauriMocks.consumeFileCommandTask,
  clearHistory: tauriMocks.clearHistory,
  deleteHistoryEntries: tauriMocks.deleteHistoryEntries,
  runLocalMarkdownAi: tauriMocks.runLocalMarkdownAi,
  runProxyMarkdownAi: tauriMocks.runProxyMarkdownAi,
  quitApp: tauriMocks.quitApp,
  proxyTtsOnce: tauriMocks.proxyTtsOnce,
  acquireTtsPlaybackOwner: tauriMocks.acquireTtsPlaybackOwner,
  releaseTtsPlaybackOwner: tauriMocks.releaseTtsPlaybackOwner,
  getMarkdownSpeechState: tauriMocks.getMarkdownSpeechState,
  startMarkdownSpeechGeneration: tauriMocks.startMarkdownSpeechGeneration,
  readMarkdownSpeechAudio: tauriMocks.readMarkdownSpeechAudio,
  openMarkdownSpeechDirectory: tauriMocks.openMarkdownSpeechDirectory,
  revealMarkdownSpeechAsset: tauriMocks.revealMarkdownSpeechAsset,
  readScreenOcr: tauriMocks.readScreenOcr,
  readScreenOcrProxy: tauriMocks.readScreenOcrProxy,
  readScreenOcrSelection: tauriMocks.readScreenOcrSelection,
  readScreenOcrSelectionProxy: tauriMocks.readScreenOcrSelectionProxy,
  readUploadedOcr: tauriMocks.readUploadedOcr,
  readUploadedOcrProxy: tauriMocks.readUploadedOcrProxy,
  readUploadedPdfProxy: tauriMocks.readUploadedPdfProxy,
  openMarkdownFile: tauriMocks.openMarkdownFile,
  runSaveMarkdownFile: tauriMocks.runSaveMarkdownFile,
  runExportMarkdownFile: tauriMocks.runExportMarkdownFile,
  runExportMarkdownDocx: tauriMocks.runExportMarkdownDocx,
  runExportPdfImages: tauriMocks.runExportPdfImages,
  startRecording: tauriMocks.startRecording,
  stopRecording: tauriMocks.stopRecording,
  testOcrConnection: tauriMocks.testOcrConnection,
}))

vi.mock('../../../lib/toast', () => ({
  toast: toastMocks.toast,
}))

import { HomePage as WorkbenchHomePage } from '../Workbench'

function homePageFixture(props: ComponentProps<typeof WorkbenchHomePage>) {
  const token = localStorage.getItem('echolike.v2.authToken')?.trim() || null
  const state = useAppStore.getState()
  if (token && state.desktopBootstrap) {
    useAppStore.setState({
      desktopAuthToken: token,
      desktopAuthStatus: 'authenticated',
      desktopBootstrapAuthToken: token,
      desktopBootstrap: state.desktopBootstrap.user?.email
        ? state.desktopBootstrap
        : {
            ...state.desktopBootstrap,
            user: {
              ...state.desktopBootstrap.user,
              email: 'fixture@example.com',
              name: state.desktopBootstrap.user?.name ?? null,
              plan: state.desktopBootstrap.user?.plan ?? 'pro',
              subscriptionEnd: state.desktopBootstrap.user?.subscriptionEnd ?? null,
            },
          },
    })
  }
  return <WorkbenchHomePage {...props} />
}
import {
  ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
  MARKDOWN_VOICE_APPEND_STORAGE_KEY,
  parseMarkdownDraft,
  RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
  serializeRecentMarkdownDraft,
  type MarkdownDraft,
} from '../../MarkdownEditor/markdownDraft'

const ocrResult: OcrReadResult = {
  app_name: 'Chrome',
  window_title: '订单页面',
  app_type: 'Browser',
  text: [
    '# 订单',
    '',
    '- 订单号 12345',
    '- 需要确认收货地址',
    '',
    '| 字段 | 值 |',
    '| --- | --- |',
    '| 状态 | 待确认 |',
    '| 备注 | A \\| B |',
    '',
    '```text',
    '复制码 ABC',
    '```',
  ].join('\n'),
  elapsed_ms: 321,
  model: 'glm-ocr:latest',
}

function makeMarkdownDraft(overrides: Partial<MarkdownDraft> = {}): MarkdownDraft {
  return {
    id: 'draft-restore',
    title: '未保存草稿',
    text: '# 恢复标题\n\n继续编辑',
    source: 'manual',
    sourceName: 'localStorage',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:01:00.000Z',
    dirty: true,
    ...overrides,
  }
}

const backendTtsBootstrap: DesktopBootstrap = {
  schemaVersion: 1,
  generatedAt: '2026-07-02T00:00:00.000Z',
  apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
  services: {
    tts: {
      mode: 'proxy',
      configured: true,
      providerId: 'openai',
      displayName: 'OpenAI TTS',
      defaultVoice: 'alloy',
    },
  },
}

const backendAiBootstrap: DesktopBootstrap = {
  schemaVersion: 1,
  generatedAt: '2026-07-02T00:00:00.000Z',
  apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
  services: {
    llm: {
      mode: 'proxy',
      configured: true,
      providerId: 'openai',
      displayName: 'OpenAI',
      defaultModel: 'gpt-4o-mini',
    },
    ocr: {
      mode: 'proxy',
      configured: true,
      providerId: 'openai',
      displayName: 'OpenAI Vision',
      defaultModel: 'gpt-4o-mini',
    },
  },
}

function backendServerPipelineBootstrap(): DesktopBootstrap {
  return {
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
          processingRoutes: ['pipeline'],
          documentContract: 'ocr-document-v1',
          pdfMode: 'server-pipeline',
        },
      },
    },
  }
}

function useBackendServerPipeline() {
  localStorage.setItem('echolike.v2.authToken', 'valid-pro-token')
  useAppStore.setState({
    desktopBootstrap: backendServerPipelineBootstrap(),
    config: {
      ...useAppStore.getState().config,
      config_source: 'backend',
    },
  })
}

function installTtsBrowserMocks({ autoEnd = true }: { autoEnd?: boolean } = {}) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }),
  )
  tauriMocks.proxyTtsOnce.mockImplementation(async (apiBaseUrl, token, text, voice) => {
    const response = await fetchMock(`${String(apiBaseUrl).replace(/\/+$/, '')}/proxy/tts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice: voice ?? undefined,
      }),
    })
    if (response instanceof Response) {
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(
          body.includes('quota') ? 'quota exceeded' : body || `HTTP ${response.status}`,
        )
      }
      return {
        audioBytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        mimeType: response.headers.get('content-type') || 'audio/mpeg',
      }
    }
    return { audioBytes: [1, 2, 3], mimeType: 'audio/mpeg' }
  })
  const playMock = vi.fn().mockResolvedValue(undefined)
  const audioInstances: Array<{ onended: (() => void) | null }> = []
  const audioMock = vi.fn(function () {
    const instance = {
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      play: () => {
        const playPromise = Promise.resolve(playMock()).then(() => undefined)
        if (autoEnd) window.setTimeout(() => instance.onended?.(), 0)
        return playPromise
      },
    }
    audioInstances.push(instance)
    return instance
  })
  const createObjectURLMock = vi.fn().mockReturnValue('blob:tts-audio')
  const revokeObjectURLMock = vi.fn()

  vi.stubGlobal('Audio', audioMock)
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURLMock,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectURLMock,
  })

  return {
    audioMock,
    audioInstances,
    createObjectURLMock,
    fetchMock,
    playMock,
    revokeObjectURLMock,
  }
}

afterEach(() => {
  cleanup()
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  useMarkdownAiDomain.getState().reset()
  window.location.hash = '#/'
  document.documentElement.style.removeProperty('--echo-surface')
  localStorage.clear()
  markdownWindowMocks.primaryMonitor.mockResolvedValue(null)
  tauriMocks.beginMarkdownEditorWindow
    .mockReset()
    .mockResolvedValue({ status: 'activated', generation: 1 })
  tauriMocks.askLlmOnce.mockResolvedValue('ok')
  tauriMocks.acknowledgeIdempotentOperation.mockReset().mockResolvedValue(undefined)
  tauriMocks.clearHistory.mockReset().mockResolvedValue({ clearedThroughId: 0 })
  tauriMocks.deleteHistoryEntries.mockReset().mockResolvedValue([])
  tauriMocks.testOcrConnection.mockResolvedValue(availableLocalOcrCapabilities)
  tauriMocks.getMarkdownAiTasks.mockResolvedValue([])
  tauriMocks.runLocalMarkdownAi.mockImplementation(async (request) => {
    let output = await tauriMocks.askLlmOnce({
      question: request.question,
      provider: request.provider,
      apiKey: request.apiKey,
      baseUrl: request.baseUrl,
      model: request.model,
      context: request.context,
    })
    if (request.retryQuestion && output === request.sourceText) {
      output = await tauriMocks.askLlmOnce({
        question: request.retryQuestion,
        provider: request.provider,
        apiKey: request.apiKey,
        baseUrl: request.baseUrl,
        model: request.model,
        context: request.context,
      })
    }
    return {
      key: request.key,
      outcome: { status: 'success', leaseId: 1, output },
      applyContext: request.applyContext,
    }
  })
  tauriMocks.runProxyMarkdownAi.mockImplementation(async (request, apiBaseUrl, token) => {
    const result = await tauriMocks.askProxyLlmOnce(
      apiBaseUrl,
      token,
      request.question,
      request.context,
    )
    return {
      key: request.key,
      outcome: {
        status: 'success',
        leaseId: 1,
        output: typeof result === 'string' ? result : result.text,
      },
      applyContext: request.applyContext,
    }
  })
  tauriMocks.openMarkdownFile.mockReset().mockResolvedValue(null)
  tauriMocks.getMarkdownSpeechState.mockReset().mockImplementation(async (key) => ({
    key,
    task: null,
    currentAsset: null,
    latestAsset: null,
    directoryPath: 'C:\\Users\\TestUser\\Documents\\EcholIKE\\朗读音频',
  }))
  tauriMocks.startMarkdownSpeechGeneration.mockReset()
  tauriMocks.readMarkdownSpeechAudio.mockReset()
  tauriMocks.openMarkdownSpeechDirectory.mockReset().mockResolvedValue(undefined)
  tauriMocks.revealMarkdownSpeechAsset.mockReset().mockResolvedValue(undefined)
  const terminal = (key: { commandKind: string }, requestFingerprint: string) => ({
    key,
    ownerWindow: 'main',
    requestFingerprint,
    outcome: {
      status: 'success',
      leaseId: 40,
      path: `C:\\Users\\TestUser\\Downloads\\${key.commandKind === 'exportDocx' ? 'report.docx' : key.commandKind === 'exportPdf' ? 'report-pages.zip' : 'note.md'}`,
      message: key.commandKind === 'exportPdf' ? '已导出 2 页图片包' : 'saved',
    },
  })
  tauriMocks.runSaveMarkdownFile.mockImplementation((key, _name, _text, fingerprint) =>
    Promise.resolve(terminal(key, fingerprint)),
  )
  tauriMocks.runExportMarkdownFile.mockImplementation((key, name, _text, fingerprint) =>
    Promise.resolve({
      ...terminal(key, fingerprint),
      outcome: {
        ...terminal(key, fingerprint).outcome,
        path: `C:\\Users\\TestUser\\Downloads\\${name}`,
      },
    }),
  )
  tauriMocks.runExportMarkdownDocx.mockImplementation((key, _result, fingerprint) =>
    Promise.resolve(terminal(key, fingerprint)),
  )
  tauriMocks.runExportPdfImages.mockImplementation((key, _file, fingerprint) =>
    Promise.resolve(terminal(key, fingerprint)),
  )
  useAppStore.setState(useAppStore.getInitialState())
  useFileCommandDomain.getState().reset()
  const config = {
    ...useAppStore.getState().config,
    config_source: 'local' as const,
  }
  useAppStore.setState({ config })
  const configurationKey = localOcrConfigurationKey(config)
  if (!configurationKey) throw new Error('Expected the default local OCR config to be complete')
  const probeLeaseId = useAppStore.getState().beginLocalOcrProbe(configurationKey)
  if (probeLeaseId === null) throw new Error('Expected the local OCR probe lease to start')
  useAppStore
    .getState()
    .finishLocalOcrProbe(configurationKey, probeLeaseId, availableLocalOcrCapabilities)
})

export const workbenchTestHarness = {
  ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
  MARKDOWN_VOICE_APPEND_STORAGE_KEY,
  RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
  homePageFixture,
  rawWorkbenchHomePage: WorkbenchHomePage,
  availableLocalOcrCapabilities,
  backendAiBootstrap,
  backendServerPipelineBootstrap,
  backendTtsBootstrap,
  imageOnlyLocalOcrCapabilities,
  installTtsBrowserMocks,
  localOcrConfigurationKey,
  makeMarkdownDraft,
  markdownWindowMocks,
  ocrResult,
  parseMarkdownDraft,
  serializeRecentMarkdownDraft,
  tauriMocks,
  toastMocks,
  unavailableLocalOcrCapabilities,
  useAppStore,
  useBackendServerPipeline,
  useFileCommandDomain,
  useMarkdownAiDomain,
}
