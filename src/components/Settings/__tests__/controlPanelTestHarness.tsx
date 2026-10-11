import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { APP_VERSION } from '../../../lib/branding'
import { useAppStore } from '../../../stores/appStore'

const availableLocalOcrCapabilities = {
  modelAvailable: true,
  imageAvailable: true,
  pdfAvailable: true,
  routerAvailable: true,
  pipelineAvailable: true,
  issues: [],
}

const unavailableLocalOcrCapabilities = {
  modelAvailable: false,
  imageAvailable: false,
  pdfAvailable: false,
  routerAvailable: false,
  pipelineAvailable: false,
  issues: ['Ollama model is unavailable'],
}

const imageOnlyLocalOcrCapabilities = {
  ...availableLocalOcrCapabilities,
  pdfAvailable: false,
  pipelineAvailable: false,
  issues: ['Document pipeline unavailable'],
}

const tauriMocks = vi.hoisted(() => ({
  updateConfig: vi.fn().mockResolvedValue(undefined),
  chooseUsageMode: vi.fn(),
  backendAuthSignIn: vi.fn().mockResolvedValue({ token: 'signed-desktop-token' }),
  benchSttConnection: vi.fn().mockResolvedValue(123),
  benchLlmConnection: vi.fn().mockResolvedValue(456),
  fetchLlmModels: vi.fn().mockResolvedValue(['deepseek-chat', 'deepseek-reasoner']),
  pauseHotkey: vi.fn().mockResolvedValue(undefined),
  resumeHotkey: vi.fn().mockResolvedValue(undefined),
  updateHotkey: vi.fn().mockResolvedValue(undefined),
  updateScreenOcrHotkey: vi.fn().mockResolvedValue(undefined),
  testOcrConnection: vi.fn().mockResolvedValue({
    modelAvailable: true,
    imageAvailable: true,
    pdfAvailable: true,
    routerAvailable: true,
    pipelineAvailable: true,
    issues: [],
  }),
  checkOtaUpdate: vi.fn().mockResolvedValue({
    appName: 'EcholIKE',
    currentVersion: '0.1.38',
    latestVersion: '0.2.0',
    autoUpdate: true,
    updateAvailable: true,
    forceUpdate: true,
    downloadUrl: 'https://example.com/EcholIKE-0.2.0.exe',
    releaseNotes: '更好的窗口 OCR。',
    message: '检测到必须安装的新版本。',
    checkedAt: '2026-06-29T00:00:00.000Z',
  }),
  downloadAndInstallOtaUpdate: vi.fn().mockResolvedValue({
    filePath: 'C:\\Temp\\EcholIKE-0.2.0-update.exe',
    latestVersion: '0.2.0',
    sha256: 'abc123',
    sha256Verified: true,
  }),
  fetchDesktopBootstrap: vi.fn().mockResolvedValue({
    schemaVersion: 1,
    generatedAt: '2026-07-02T00:00:00.000Z',
    apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
    policy: {
      preferProxy: false,
      allowDirectProviderKeys: false,
      allowByok: true,
      allowLocalModels: true,
      remoteConfigDelivery: 'startup',
      activation: 'next_start',
      backgroundPolling: false,
    },
  }),
  getRuntimeAppVersion: vi.fn(),
  detectSystemHttpProxy: vi.fn().mockResolvedValue('http://127.0.0.1:7890'),
  loadDesktopAuthSnapshot: vi.fn(),
  beginDesktopAuthCandidate: vi.fn(),
  beginDesktopAuthCandidateForLogin: vi.fn(),
  commitDesktopAuthCandidate: vi.fn(),
  clearDesktopAuthAuthority: vi.fn(),
  confirmDesktopAuthRuntime: vi.fn(),
  invalidateDesktopAuthRuntime: vi.fn(),
  proxyTtsOnce: vi.fn().mockResolvedValue({ audioBytes: [1, 2, 3], mimeType: 'audio/mpeg' }),
  acquireTtsPlaybackOwner: vi.fn().mockResolvedValue({ leaseId: 92, ownerWindow: 'main' }),
  releaseTtsPlaybackOwner: vi.fn().mockResolvedValue(true),
  acknowledgeIdempotentOperation: vi.fn().mockResolvedValue(undefined),
  diagnoseTtsProxy: vi.fn().mockResolvedValue({
    ok: true,
    stage: 'audio',
    httpStatus: 200,
    code: null,
    message: 'TTS 代理返回了可播放音频。',
    requestId: null,
    mimeType: 'audio/mpeg',
    audioBytes: 3,
    elapsedMs: 50,
    operationId: 'tts-diagnostic-operation',
  }),
  diagnosePdfUpload: vi.fn().mockResolvedValue({
    ok: true,
    stage: 'render',
    message: 'PDF 解析正常，共 1 页。',
    pageCount: 1,
    inputBytes: 4,
    elapsedMs: 80,
  }),
  setAutoStart: vi.fn().mockResolvedValue(undefined),
  setCapsuleAutoHide: vi.fn().mockResolvedValue(undefined),
  updaterProxyUrl: vi.fn((config: { network_proxy_enabled: boolean; network_proxy_url: string }) =>
    config.network_proxy_enabled && config.network_proxy_url ? config.network_proxy_url : undefined,
  ),
}))

const toastMocks = vi.hoisted(() => ({
  toast: vi.fn(),
}))

vi.mock('../../../lib/tauri', () => ({
  updateConfig: tauriMocks.updateConfig,
  chooseUsageMode: tauriMocks.chooseUsageMode,
  backendAuthSignIn: tauriMocks.backendAuthSignIn,
  benchSttConnection: tauriMocks.benchSttConnection,
  benchLlmConnection: tauriMocks.benchLlmConnection,
  fetchLlmModels: tauriMocks.fetchLlmModels,
  pauseHotkey: tauriMocks.pauseHotkey,
  resumeHotkey: tauriMocks.resumeHotkey,
  updateHotkey: tauriMocks.updateHotkey,
  updateScreenOcrHotkey: tauriMocks.updateScreenOcrHotkey,
  testOcrConnection: tauriMocks.testOcrConnection,
  checkOtaUpdate: tauriMocks.checkOtaUpdate,
  downloadAndInstallOtaUpdate: tauriMocks.downloadAndInstallOtaUpdate,
  fetchDesktopBootstrap: tauriMocks.fetchDesktopBootstrap,
  getRuntimeAppVersion: tauriMocks.getRuntimeAppVersion,
  detectSystemHttpProxy: tauriMocks.detectSystemHttpProxy,
  loadDesktopAuthSnapshot: tauriMocks.loadDesktopAuthSnapshot,
  beginDesktopAuthCandidate: tauriMocks.beginDesktopAuthCandidate,
  beginDesktopAuthCandidateForLogin: tauriMocks.beginDesktopAuthCandidateForLogin,
  commitDesktopAuthCandidate: tauriMocks.commitDesktopAuthCandidate,
  clearDesktopAuthAuthority: tauriMocks.clearDesktopAuthAuthority,
  confirmDesktopAuthRuntime: tauriMocks.confirmDesktopAuthRuntime,
  invalidateDesktopAuthRuntime: tauriMocks.invalidateDesktopAuthRuntime,
  proxyTtsOnce: tauriMocks.proxyTtsOnce,
  acquireTtsPlaybackOwner: tauriMocks.acquireTtsPlaybackOwner,
  releaseTtsPlaybackOwner: tauriMocks.releaseTtsPlaybackOwner,
  acknowledgeIdempotentOperation: tauriMocks.acknowledgeIdempotentOperation,
  diagnoseTtsProxy: tauriMocks.diagnoseTtsProxy,
  diagnosePdfUpload: tauriMocks.diagnosePdfUpload,
  setAutoStart: tauriMocks.setAutoStart,
  setCapsuleAutoHide: tauriMocks.setCapsuleAutoHide,
  updaterProxyUrl: tauriMocks.updaterProxyUrl,
}))

vi.mock('../../../lib/toast', () => ({
  toast: toastMocks.toast,
}))

import { Settings } from '../index'

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState())
}

function renderSettings() {
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
  return render(<Settings />)
}

function openTab(label: string) {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(label) }))
}

export function installControlPanelTestHarness() {
  beforeEach(() => {
    window.location.hash = '#/'
    localStorage.clear()
    sessionStorage.clear()
    resetStore()
    tauriMocks.acknowledgeIdempotentOperation.mockReset().mockResolvedValue(undefined)
    tauriMocks.chooseUsageMode
      .mockReset()
      .mockImplementation(async (source: 'local' | 'backend') => ({
        ...useAppStore.getState().config,
        config_source: source,
        onboarding_version: Math.max(useAppStore.getState().config.onboarding_version, 1),
      }))
    tauriMocks.fetchDesktopBootstrap.mockReset().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '2026-07-02T00:00:00.000Z',
      apiBaseUrl: 'http://127.0.0.1:8787/echo-api',
      user: {
        email: 'fixture@example.com',
        name: null,
        plan: 'pro' as const,
        subscriptionEnd: null,
      },
      policy: {
        preferProxy: false,
        allowDirectProviderKeys: false,
        allowByok: true,
        allowLocalModels: true,
        remoteConfigDelivery: 'startup',
        activation: 'next_start',
        backgroundPolling: false,
      },
    })
    tauriMocks.loadDesktopAuthSnapshot.mockReset().mockImplementation(async () => {
      const token = localStorage.getItem('echolike.v2.authToken')?.trim() || null
      const bootstrap = useAppStore.getState().desktopBootstrap
      return {
        generation: 0,
        authorityToken: token,
        rawCachedAuthToken: bootstrap ? token : null,
        cache: bootstrap
          ? {
              packageVersion: APP_VERSION,
              bootstrap,
              authToken: token,
              cachedAt: '2026-07-30T00:00:00.000Z',
            }
          : null,
      }
    })
    tauriMocks.beginDesktopAuthCandidate
      .mockReset()
      .mockImplementation(async (generation, authority) => {
        const cachedBootstrap = useAppStore.getState().desktopBootstrap
        return {
          generation: generation + 1,
          authorityToken: authority,
          rawCachedAuthToken: cachedBootstrap ? authority : null,
          cache: cachedBootstrap
            ? {
                packageVersion: APP_VERSION,
                bootstrap: cachedBootstrap,
                authToken: authority,
                cachedAt: '2026-07-30T00:00:00.000Z',
              }
            : null,
        }
      })
    tauriMocks.confirmDesktopAuthRuntime.mockReset().mockResolvedValue(true)
    tauriMocks.invalidateDesktopAuthRuntime.mockReset().mockResolvedValue(false)
    tauriMocks.beginDesktopAuthCandidateForLogin
      .mockReset()
      .mockImplementation(async (generation, _authority, nextAuthority) => ({
        generation: (generation ?? 0) + 1,
        authorityToken: nextAuthority,
        rawCachedAuthToken: null,
        cache: null,
      }))
    tauriMocks.commitDesktopAuthCandidate
      .mockReset()
      .mockImplementation(async (generation, authority, _raw, bootstrap) => ({
        generation: generation + 1,
        authorityToken: authority,
        rawCachedAuthToken: authority,
        cache: {
          packageVersion: APP_VERSION,
          bootstrap,
          authToken: authority,
          cachedAt: '2026-07-30T00:00:00.000Z',
        },
      }))
    tauriMocks.clearDesktopAuthAuthority.mockReset().mockImplementation(async (generation) => ({
      generation: generation + 1,
      authorityToken: null,
      rawCachedAuthToken: null,
      cache: null,
    }))
    tauriMocks.testOcrConnection.mockResolvedValue(availableLocalOcrCapabilities)
    tauriMocks.getRuntimeAppVersion.mockResolvedValue(APP_VERSION)
    tauriMocks.checkOtaUpdate.mockResolvedValue({
      appName: 'EcholIKE',
      currentVersion: '0.1.38',
      latestVersion: '0.2.0',
      autoUpdate: true,
      updateAvailable: true,
      forceUpdate: true,
      downloadUrl: 'https://example.com/EcholIKE-0.2.0.exe',
      releaseNotes: 'Better window OCR.',
      message: 'Forced update available.',
      checkedAt: '2026-06-29T00:00:00.000Z',
    })
    useAppStore.setState({
      config: {
        ...useAppStore.getState().config,
        config_source: 'local',
        stt_api_key: 'stt-key',
        llm_api_key: 'llm-key',
        llm_base_url: 'https://api.deepseek.com/v1',
        llm_model: 'deepseek-chat',
      },
    })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
    sessionStorage.clear()
  })
}

export {
  availableLocalOcrCapabilities,
  unavailableLocalOcrCapabilities,
  imageOnlyLocalOcrCapabilities,
  tauriMocks,
  toastMocks,
  resetStore,
  renderSettings,
  openTab,
}
