import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check as checkTauriUpdate } from '@tauri-apps/plugin-updater'
import type { AppConfig, HistoryEntry, DictionaryEntry } from '../stores/appStore'
import type { ScenePreset } from './scenePresets'
import type { SignedOtaUpdateInfo } from './startupUpdate'

export interface DetectedAppContext {
  app_name: string
  window_title: string
  app_type: string
}

export type OcrProcessingRoute = 'direct' | 'tile' | 'pipeline'

export interface OcrReadResult extends DetectedAppContext {
  text: string
  elapsed_ms: number
  model: string
  source_kind?: 'upload' | 'screen' | string | null
  source_name?: string | null
  page_count?: number | null
  route?: OcrProcessingRoute | null
  processing_reason?: string | null
  warnings?: string[] | null
  degraded?: boolean | null
  operation_id?: string | null
}

export interface OcrConnectionTestResult {
  modelAvailable: boolean
  imageAvailable: boolean
  pdfAvailable: boolean
  routerAvailable?: boolean | null
  pipelineAvailable?: boolean | null
  issues: string[]
}

export type ScreenOcrSelectionOutcome =
  | { status: 'success'; result: OcrReadResult }
  | { status: 'cancelled' }

export interface UploadedOcrFile {
  fileName: string
  mimeType: string
  imageBase64?: string
  fileBase64?: string
  fileBytes?: number[]
}

export interface OpenedMarkdownFile {
  fileName: string
  text: string
}

export interface AskLlmRequest {
  question: string
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  context?: string
}

export interface OtaUpdateStatus {
  appName: string
  currentVersion: string
  latestVersion: string
  autoUpdate: boolean
  updateAvailable: boolean
  forceUpdate: boolean
  downloadUrl: string | null
  sha256?: string | null
  releaseNotes: string | null
  message: string
  checkedAt: string
}

export interface OtaDownloadResult {
  filePath: string
  latestVersion: string
  sha256: string | null
  sha256Verified: boolean
}

export type OtaInstallPhase = 'checking' | 'downloading' | 'installing' | 'relaunching'

export interface OtaInstallProgress {
  phase: OtaInstallPhase
  downloadedBytes: number
  totalBytes: number | null
  percent: number | null
}

export interface ProxyTtsResult {
  audioBytes: number[]
  mimeType: string
  operationId?: string | null
}

export interface ProxyTextResult {
  text: string
  operationId: string
}

export interface TtsDiagnosticResult {
  ok: boolean
  stage: string
  httpStatus?: number | null
  code?: string | null
  message: string
  requestId?: string | null
  mimeType?: string | null
  audioBytes?: number | null
  elapsedMs: number
  operationId?: string | null
}

export interface PdfDiagnosticResult {
  ok: boolean
  stage: string
  message: string
  pageCount?: number | null
  inputBytes?: number | null
  elapsedMs: number
}

export interface BackendAuthResult {
  token: string
}

export interface DesktopBootstrapService {
  mode: 'direct' | 'proxy' | 'byok' | 'local' | 'disabled'
  configured?: boolean
  providerId?: string | null
  displayName?: string | null
  baseUrl?: string | null
  endpoint?: string | null
  defaultModel?: string | null
  defaultLanguage?: string | null
  apiKey?: string | null
  apiKeyPreview?: string | null
  defaultVoice?: string | null
  localModel?: string | null
}

export interface DesktopBootstrapOcrCapabilities {
  imageAvailable?: boolean
  pdfAvailable?: boolean
  acceptedMimeTypes?: string[]
  maxInputBytes?: number
  maxPdfPages?: number
  processingRoutes?: Array<'direct' | 'tile' | 'pipeline'>
  documentContract?: 'ocr-document-v1'
  pdfMode?: 'client-rasterized' | 'server-pipeline' | 'unsupported'
}

export type DesktopAdminRole = 'owner' | 'admin' | 'operator' | 'viewer'
export type DesktopQuotaUnit = 'seconds' | 'tokens' | 'images' | 'chars'

export interface DesktopQuotaSnapshot {
  used: number
  limit: number
  remaining: number
  unit: DesktopQuotaUnit
}

export interface DesktopBootstrap {
  schemaVersion: number
  generatedAt: string
  apiBaseUrl: string
  user?: {
    email?: string | null
    name?: string | null
    plan: 'free' | 'pro'
    subscriptionEnd: string | null
    quotaLevel?: number
    quotaMultiplier?: number
    adminRole?: DesktopAdminRole | null
  }
  quotas?: {
    stt?: DesktopQuotaSnapshot
    llm?: DesktopQuotaSnapshot
    tts?: DesktopQuotaSnapshot
    ocr?: DesktopQuotaSnapshot
  }
  features?: {
    cloudStt: boolean
    cloudLlm: boolean
    cloudTts: boolean
    cloudOcr: boolean
    translate: boolean
    selectedTextEdit: boolean
    ota: boolean
  }
  services?: {
    stt?: DesktopBootstrapService
    llm?: DesktopBootstrapService
    tts?: DesktopBootstrapService
    ocr?: DesktopBootstrapService & {
      defaultBaseUrl?: string | null
      capabilities?: DesktopBootstrapOcrCapabilities
    }
  }
  scenes?: ScenePreset[]
  ota?: {
    enabled: boolean
    autoUpdate: boolean
    forceUpdate: boolean
    currentVersion: string
    latestVersion: string
    minVersion: string | null
    updateAvailable: boolean
    status: 'current' | 'available' | 'required'
    releaseNotes: string | null
    downloadUrl?: string | null
    downloadAvailable?: boolean
    sha256?: string | null
    checkedAt: string
  }
  policy?: {
    preferProxy: boolean
    allowDirectProviderKeys: boolean
    allowByok: boolean
    allowLocalModels: boolean
    remoteConfigDelivery?: 'startup'
    activation?: 'next_start' | 'next_ota'
    backgroundPolling?: boolean
    configTtlSeconds?: number
  }
}

export interface DesktopBootstrapCache {
  packageVersion: string
  bootstrap: DesktopBootstrap
  authToken: string | null
  cachedAt: string
}

export interface DesktopAuthSnapshot {
  generation: number
  authorityToken: string | null
  rawCachedAuthToken: string | null
  cache: DesktopBootstrapCache | null
}

export interface ProcessLease {
  leaseId: number
  ownerWindow: string
}
export interface MarkdownSpeechKey {
  draftId: string
  contentRevision: string
  voiceKey: string
  speedMilli: number
}
export interface MarkdownSpeechAsset {
  id: number
  key: MarkdownSpeechKey
  fileName: string
  directoryPath: string
  createdAt: string
  byteLength: number
  durationMs: number
}
export type MarkdownSpeechOutcome =
  | { status: 'running'; leaseId: number; completedChunks: number; totalChunks: number }
  | { status: 'success'; leaseId: number; asset: MarkdownSpeechAsset }
  | { status: 'error'; leaseId: number; error: string }
export interface MarkdownSpeechTaskSnapshot {
  key: MarkdownSpeechKey
  ownerWindow: string
  outcome: MarkdownSpeechOutcome
}
export interface MarkdownSpeechStateSnapshot {
  key: MarkdownSpeechKey
  task?: MarkdownSpeechTaskSnapshot | null
  currentAsset?: MarkdownSpeechAsset | null
  latestAsset?: MarkdownSpeechAsset | null
  directoryPath: string
}
export interface StartMarkdownSpeechRequest {
  key: MarkdownSpeechKey
  title: string
  chunks: string[]
  apiBaseUrl: string
  token: string
}
export type MarkdownAiAction = 'polish' | 'translate' | 'summarize'
export type MarkdownRequestTarget =
  | { kind: 'fullDocument' }
  | { kind: 'selection'; start: number; end: number }
export interface MarkdownRequestIdentity {
  action: MarkdownAiAction
  target: MarkdownRequestTarget
  draftRevision: string
  semanticFingerprint: string
}
export interface MarkdownAiOwnerKey {
  draftId: string
  request: MarkdownRequestIdentity
}
export type MarkdownAiOutcome =
  | { status: 'running'; leaseId: number }
  | { status: 'success'; leaseId: number; output: string }
  | { status: 'error'; leaseId: number; error: string }
export interface MarkdownAiTaskSnapshot {
  key: MarkdownAiOwnerKey
  outcome: MarkdownAiOutcome
  applyContext?: { fullText: string; text: string; title: string } | null
}
export interface MarkdownAiPromptRequest {
  key: MarkdownAiOwnerKey
  question: string
  retryQuestion?: string | null
  sourceText: string
  context?: string | null
  applyContext: { fullText: string; text: string; title: string }
}
export interface LocalMarkdownAiRequest extends MarkdownAiPromptRequest {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
}
export type FileCommandKind = 'saveMarkdown' | 'exportPdf' | 'exportDocx' | 'exportMarkdown'
export interface FileCommandOwnerKey {
  resourceId: string
  commandKind: FileCommandKind
}
export type FileCommandOutcome =
  | { status: 'running'; leaseId: number }
  | { status: 'success'; leaseId: number; path: string; message: string }
  | { status: 'cancelled'; leaseId: number }
  | { status: 'error'; leaseId: number; error: string }
export interface FileCommandSnapshot {
  key: FileCommandOwnerKey
  ownerWindow?: string
  requestFingerprint: string
  outcome: FileCommandOutcome
}
export type ConsumeFileCommandResult = 'consumed' | 'alreadyConsumed' | 'stale'

export const acquireTtsPlaybackOwner = (): Promise<ProcessLease | null> =>
  invoke('acquire_tts_playback_owner')
export const releaseTtsPlaybackOwner = (leaseId: number): Promise<boolean> =>
  invoke('release_tts_playback_owner', { leaseId })
export const getMarkdownSpeechState = (
  key: MarkdownSpeechKey,
): Promise<MarkdownSpeechStateSnapshot> => invoke('get_markdown_speech_state', { key })
export const startMarkdownSpeechGeneration = (
  request: StartMarkdownSpeechRequest,
): Promise<MarkdownSpeechTaskSnapshot> => invoke('start_markdown_speech_generation', { request })
export const readMarkdownSpeechAudio = (assetId: number): Promise<ArrayBuffer> =>
  invoke('read_markdown_speech_audio', { assetId })
export const openMarkdownSpeechDirectory = (): Promise<void> =>
  invoke('open_markdown_speech_directory')
export const revealMarkdownSpeechAsset = (assetId: number): Promise<void> =>
  invoke('reveal_markdown_speech_asset', { assetId })
export const getMarkdownAiTasks = (draftId: string): Promise<MarkdownAiTaskSnapshot[]> =>
  invoke('get_markdown_ai_tasks', { draftId })
export const consumeMarkdownAiTask = (key: MarkdownAiOwnerKey, leaseId: number): Promise<boolean> =>
  invoke('consume_markdown_ai_task', { key, leaseId })
export const runProxyMarkdownAi = (
  request: MarkdownAiPromptRequest,
  apiBaseUrl: string,
  token: string,
): Promise<MarkdownAiTaskSnapshot> =>
  invoke('run_proxy_markdown_ai', { request, apiBaseUrl, token })
export const runLocalMarkdownAi = (
  request: LocalMarkdownAiRequest,
): Promise<MarkdownAiTaskSnapshot> => invoke('run_local_markdown_ai', { request })
export const getFileCommandTasks = (): Promise<FileCommandSnapshot[]> =>
  invoke('get_file_command_tasks')
export const consumeFileCommandTask = (
  key: FileCommandOwnerKey,
  leaseId: number,
): Promise<ConsumeFileCommandResult> => invoke('consume_file_command_task', { key, leaseId })
export const runSaveMarkdownFile = (
  key: FileCommandOwnerKey,
  fileName: string,
  text: string,
  requestFingerprint: string,
): Promise<FileCommandSnapshot> =>
  invoke('run_save_markdown_file', { key, fileName, text, requestFingerprint })
export const runExportMarkdownFile = (
  key: FileCommandOwnerKey,
  fileName: string,
  text: string,
  requestFingerprint: string,
): Promise<FileCommandSnapshot> =>
  invoke('run_export_markdown_file', { key, fileName, text, requestFingerprint })
export const runExportMarkdownDocx = (
  key: FileCommandOwnerKey,
  result: OcrReadResult,
  requestFingerprint: string,
  promptForDestination = false,
): Promise<FileCommandSnapshot> =>
  invoke('run_export_markdown_docx', {
    key,
    sourceName: result.source_name || result.window_title || 'echolike-ocr',
    markdown: result.text,
    pageCount: result.page_count ?? null,
    requestFingerprint,
    promptForDestination,
  })
export const runExportPdfImages = (
  key: FileCommandOwnerKey,
  file: UploadedOcrFile,
  requestFingerprint: string,
): Promise<FileCommandSnapshot> =>
  invoke('run_export_pdf_images', {
    key,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileBase64: file.fileBase64,
    fileBytes: file.fileBytes,
    requestFingerprint,
  })
export const notifyOwnerWindowDestroyed = (): Promise<boolean> =>
  invoke('notify_owner_window_destroyed')

// Pipeline commands
export async function startRecording(): Promise<boolean> {
  return invoke('start_recording')
}

export async function stopRecording(): Promise<boolean> {
  return invoke('stop_recording')
}

export async function abortRecording(): Promise<boolean> {
  return invoke('abort_recording')
}

export async function syncMainWindowShape(): Promise<void> {
  return invoke('sync_main_window_shape')
}

export type MarkdownEditorWindowOpenDecision =
  | { status: 'create'; generation: number }
  | { status: 'pending'; generation: number }
  | { status: 'activated'; generation: number }

export interface MarkdownEditorWindowOptions {
  width: number
  height: number
  minWidth: number
  minHeight: number
  backgroundColor: [number, number, number, number]
}

export async function beginMarkdownEditorWindow(
  options: MarkdownEditorWindowOptions,
): Promise<MarkdownEditorWindowOpenDecision> {
  return invoke('begin_markdown_editor_window', { options })
}

export async function revealMarkdownEditorWindow(generation: number): Promise<void> {
  return invoke('reveal_markdown_editor_window', { generation })
}

// Config commands
export type AppConfigOrigin = 'persisted' | 'created_new'

export interface AppConfigSnapshot {
  config: AppConfig
  origin: AppConfigOrigin
}

export async function getConfig(): Promise<AppConfig> {
  return (await getConfigSnapshot()).config
}

export async function getConfigSnapshot(): Promise<AppConfigSnapshot> {
  return invoke('get_config_snapshot')
}

export async function chooseUsageMode(source: AppConfig['config_source']): Promise<AppConfig> {
  return invoke('choose_usage_mode', { source })
}

export async function resolveOnboardingStartup(
  showTour: boolean,
  configAvailable: boolean,
): Promise<number | null> {
  return invoke('resolve_onboarding_startup', { showTour, configAvailable })
}

export async function acquireOnboardingGuard(): Promise<number> {
  return invoke('acquire_onboarding_guard')
}

export async function releaseOnboardingGuard(lease: number): Promise<boolean> {
  return invoke('release_onboarding_guard', { lease })
}

export async function updateConfig(baseConfig: AppConfig, config: AppConfig): Promise<AppConfig> {
  return invoke('update_config', { baseConfig, config })
}

export async function detectSystemHttpProxy(): Promise<string | null> {
  return invoke('detect_system_http_proxy')
}

export async function setCapsuleAutoHide(enabled: boolean): Promise<void> {
  return invoke('set_capsule_auto_hide', { enabled })
}

export async function refreshTrayLabels(): Promise<void> {
  return invoke('refresh_tray_labels')
}

// Latency benchmark - returns round-trip time in milliseconds
export async function benchSttConnection(
  apiKey: string,
  provider: string,
  customBaseUrl?: string,
  customModel?: string,
): Promise<number> {
  return invoke('bench_stt_connection', {
    apiKey,
    provider,
    customBaseUrl,
    customModel,
  })
}

export async function benchLlmConnection(
  apiKey: string,
  provider: string,
  baseUrl: string,
  model: string,
): Promise<number> {
  return invoke('bench_llm_connection', { apiKey, provider, baseUrl, model })
}

// LLM models
export async function fetchLlmModels(
  apiKey: string,
  provider: string,
  baseUrl: string,
): Promise<string[]> {
  return invoke('fetch_llm_models', { apiKey, provider, baseUrl })
}

export async function askLlmOnce(request: AskLlmRequest): Promise<string> {
  return invoke('ask_llm_once', {
    question: request.question,
    provider: request.provider,
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    model: request.model,
    context: request.context,
  })
}

export async function askProxyLlmOnce(
  apiBaseUrl: string,
  token: string,
  question: string,
  context?: string,
): Promise<ProxyTextResult> {
  return invoke('ask_proxy_llm_once', { apiBaseUrl, token, question, context })
}

export async function acknowledgeIdempotentOperation(operationId: string): Promise<void> {
  let lastError: unknown
  for (const delayMs of [0, 75, 250]) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      await invoke('acknowledge_idempotent_operation', { operationId })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export async function proxyTtsOnce(
  apiBaseUrl: string,
  token: string,
  text: string,
  voice?: string | null,
  playbackLeaseId?: number,
): Promise<ProxyTtsResult> {
  return invoke('proxy_tts_once', { apiBaseUrl, token, text, voice, playbackLeaseId })
}

export async function diagnoseTtsProxy(
  apiBaseUrl: string,
  token: string,
  text: string,
  voice?: string | null,
): Promise<TtsDiagnosticResult> {
  return invoke('diagnose_tts_proxy', { apiBaseUrl, token, text, voice })
}

export async function backendAuthSignIn(
  authUrl: string,
  email: string,
  password: string,
): Promise<BackendAuthResult> {
  return invoke('backend_auth_sign_in', { authUrl, email, password })
}

export async function testOcrConnection(
  baseUrl: string,
  model: string,
): Promise<OcrConnectionTestResult> {
  return invoke('test_ocr_connection', { baseUrl, model })
}

export async function readScreenOcr(baseUrl: string, model: string): Promise<OcrReadResult> {
  return invoke('read_screen_ocr', { baseUrl, model })
}

export async function readScreenOcrProxy(
  apiBaseUrl: string,
  token: string,
): Promise<OcrReadResult> {
  return invoke('read_screen_ocr_proxy', { apiBaseUrl, token })
}

export async function readScreenOcrSelection(
  baseUrl: string,
  model: string,
): Promise<ScreenOcrSelectionOutcome> {
  return invoke('read_screen_ocr_selection', { baseUrl, model })
}

export async function readScreenOcrSelectionProxy(
  apiBaseUrl: string,
  token: string,
): Promise<ScreenOcrSelectionOutcome> {
  return invoke('read_screen_ocr_selection_proxy', { apiBaseUrl, token })
}

export async function readUploadedOcr(
  baseUrl: string,
  model: string,
  file: UploadedOcrFile,
): Promise<OcrReadResult> {
  return invoke('read_uploaded_ocr', {
    baseUrl,
    model,
    fileName: file.fileName,
    mimeType: file.mimeType,
    imageBase64: file.imageBase64,
    fileBase64: file.fileBase64,
    fileBytes: file.fileBytes,
  })
}

export async function readUploadedOcrProxy(
  apiBaseUrl: string,
  token: string,
  file: UploadedOcrFile,
): Promise<OcrReadResult> {
  return invoke('read_uploaded_ocr_proxy', {
    apiBaseUrl,
    token,
    fileName: file.fileName,
    mimeType: file.mimeType,
    imageBase64: file.imageBase64,
    fileBase64: file.fileBase64,
    fileBytes: file.fileBytes,
  })
}

export async function readUploadedPdfProxy(
  apiBaseUrl: string,
  token: string,
  file: UploadedOcrFile,
): Promise<OcrReadResult> {
  return invoke('read_uploaded_pdf_proxy', {
    apiBaseUrl,
    token,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileBase64: file.fileBase64,
    fileBytes: file.fileBytes,
  })
}

export async function diagnosePdfUpload(file: UploadedOcrFile): Promise<PdfDiagnosticResult> {
  if (!file.fileBase64?.trim() && !file.fileBytes?.length) {
    throw new Error('PDF 文件内容为空，无法诊断。')
  }

  return invoke('diagnose_pdf_upload', {
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileBase64: file.fileBase64,
    fileBytes: file.fileBytes,
  })
}

export async function openMarkdownFile(): Promise<OpenedMarkdownFile | null> {
  return invoke('open_markdown_file')
}

export async function checkOtaUpdate(
  updateUrl: string,
  currentVersion: string,
): Promise<OtaUpdateStatus> {
  return invoke('check_ota_update', { updateUrl, currentVersion })
}

export function updaterProxyUrl(
  config: Pick<AppConfig, 'network_proxy_enabled' | 'network_proxy_url'>,
) {
  const proxyUrl = config.network_proxy_url.trim()
  return config.network_proxy_enabled && proxyUrl ? proxyUrl : undefined
}

export async function checkSignedOtaUpdate(
  timeoutMs = 3500,
  proxyUrl?: string,
): Promise<SignedOtaUpdateInfo | null> {
  const update = await checkTauriUpdate({ timeout: timeoutMs, proxy: proxyUrl })
  if (!update) return null

  return {
    currentVersion: update.currentVersion,
    latestVersion: update.version,
    releaseNotes: update.body ?? null,
    checkedAt: new Date().toISOString(),
  }
}

export async function downloadAndInstallOtaUpdate(
  updateUrl: string,
  currentVersion: string,
  proxyUrl?: string,
  onProgress?: (progress: OtaInstallProgress) => void,
  beforeRelaunch?: (result: OtaDownloadResult) => Promise<boolean> | boolean,
): Promise<OtaDownloadResult> {
  void updateUrl
  void currentVersion

  onProgress?.({
    phase: 'checking',
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
  })

  const update = await checkTauriUpdate({ timeout: 8000, proxy: proxyUrl })
  if (!update) {
    throw new Error('当前版本没有可安装的签名更新包，请稍后再试或联系管理员检查 OTA 发布。')
  }

  let downloadedBytes = 0
  let totalBytes: number | null = null
  const emitProgress = (phase: OtaInstallPhase) => {
    const percent =
      totalBytes && totalBytes > 0
        ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
        : null
    onProgress?.({
      phase,
      downloadedBytes,
      totalBytes,
      percent,
    })
  }

  emitProgress('downloading')
  await update.downloadAndInstall(
    (event) => {
      if (event.event === 'Started') {
        downloadedBytes = 0
        totalBytes =
          typeof event.data.contentLength === 'number' && event.data.contentLength > 0
            ? event.data.contentLength
            : null
        emitProgress('downloading')
        return
      }
      if (event.event === 'Progress') {
        downloadedBytes += event.data.chunkLength
        emitProgress('downloading')
        return
      }
      if (event.event === 'Finished') {
        if (totalBytes) downloadedBytes = totalBytes
        emitProgress('installing')
      }
    },
    { timeout: 120000 },
  )
  const result: OtaDownloadResult = {
    filePath: 'tauri-updater',
    latestVersion: update.version,
    sha256: null,
    sha256Verified: false,
  }
  onProgress?.({
    phase: 'relaunching',
    downloadedBytes: totalBytes ?? downloadedBytes,
    totalBytes,
    percent: totalBytes ? 100 : null,
  })
  if (beforeRelaunch && !(await beforeRelaunch(result))) return result
  await relaunch()

  return result
}

export async function getRuntimeAppVersion(fallbackVersion: string): Promise<string> {
  try {
    const version = (await getVersion()).trim()
    return version || fallbackVersion
  } catch {
    return fallbackVersion
  }
}

export async function quitApp(): Promise<void> {
  return invoke('quit_app')
}

export async function fetchDesktopBootstrap(
  bootstrapUrl: string,
  currentVersion: string,
  authToken?: string | null,
): Promise<DesktopBootstrap> {
  return invoke('fetch_desktop_bootstrap', { bootstrapUrl, currentVersion, authToken })
}

export async function loadDesktopAuthSnapshot(): Promise<DesktopAuthSnapshot> {
  return invoke('load_desktop_auth_snapshot')
}

export async function confirmDesktopAuthRuntime(
  expectedGeneration: number,
  expectedAuthorityToken: string | null,
): Promise<boolean> {
  return invoke('confirm_desktop_auth_runtime', {
    expectedGeneration,
    expectedAuthorityToken,
  })
}

export async function invalidateDesktopAuthRuntime(
  expectedGeneration: number,
  expectedAuthorityToken: string | null,
): Promise<boolean> {
  return invoke('invalidate_desktop_auth_runtime', {
    expectedGeneration,
    expectedAuthorityToken,
  })
}

export async function beginDesktopAuthCandidate(
  expectedGeneration: number,
  expectedAuthorityToken: string | null,
): Promise<DesktopAuthSnapshot | null> {
  return invoke('begin_desktop_auth_candidate', {
    expectedGeneration,
    expectedAuthorityToken,
  })
}

export async function beginDesktopAuthCandidateForLogin(
  expectedGeneration: number | null,
  expectedAuthorityToken: string | null,
  nextAuthorityToken: string,
): Promise<DesktopAuthSnapshot | null> {
  return invoke('begin_desktop_auth_candidate_for_login', {
    expectedGeneration,
    expectedAuthorityToken,
    nextAuthorityToken,
  })
}

export async function commitDesktopAuthCandidate(
  expectedGeneration: number,
  expectedAuthorityToken: string | null,
  expectedRawCachedAuthToken: string | null,
  bootstrap: DesktopBootstrap,
): Promise<DesktopAuthSnapshot | null> {
  return invoke('commit_desktop_auth_candidate', {
    expectedGeneration,
    expectedAuthorityToken,
    expectedRawCachedAuthToken,
    bootstrap,
  })
}

export async function clearDesktopAuthAuthority(
  expectedGeneration: number,
  expectedAuthorityToken: string | null,
): Promise<DesktopAuthSnapshot | null> {
  return invoke('clear_desktop_auth_authority', {
    expectedGeneration,
    expectedAuthorityToken,
  })
}

// Hotkey
export async function updateHotkey(hotkey: string): Promise<void> {
  return invoke('update_hotkey', { hotkey })
}

export async function updateScreenOcrHotkey(hotkey: string): Promise<void> {
  return invoke('update_screen_ocr_hotkey', { hotkey })
}

export async function pauseHotkey(): Promise<void> {
  return invoke('pause_hotkey')
}

export async function resumeHotkey(): Promise<void> {
  return invoke('resume_hotkey')
}

// History
export async function getHistory(limit: number, offset: number): Promise<HistoryEntry[]> {
  return invoke('get_history', { limit, offset })
}

export async function deleteHistoryEntries(ids: number[]): Promise<number[]> {
  return invoke('delete_history_entries', { ids })
}

export async function clearHistory(): Promise<{ clearedThroughId: number }> {
  return invoke('clear_history')
}

// Dictionary
export async function getDictionary(): Promise<DictionaryEntry[]> {
  return invoke('get_dictionary')
}

// Auto-start
export async function setAutoStart(enabled: boolean): Promise<void> {
  return invoke('set_auto_start', { enabled })
}

// macOS Accessibility permission
export async function checkAccessibilityPermission(): Promise<boolean> {
  return invoke('check_accessibility_permission')
}

export async function requestAccessibilityPermission(): Promise<boolean> {
  return invoke('request_accessibility_permission')
}
