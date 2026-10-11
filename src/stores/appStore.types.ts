import type {
  DesktopBootstrap,
  DesktopAuthSnapshot,
  OtaInstallProgress,
  OtaUpdateStatus,
  OcrConnectionTestResult,
  OcrReadResult,
  PdfDiagnosticResult,
  TtsDiagnosticResult,
  UploadedOcrFile,
} from '../lib/tauri'
import type { DesktopAuthStatus } from '../lib/desktopAuth'
import type { BackendErrorDiagnostic } from '../lib/userErrors'
import type { CapsuleStyle, ThemeProfile } from '../lib/appearanceProfiles'

export type { CapsuleStyle, ThemeProfile } from '../lib/appearanceProfiles'

export type PipelineState = 'idle' | 'recording' | 'transcribing' | 'polishing' | 'outputting'

export type RecordingTransitionKind = 'start' | 'stop' | 'abort'
export interface RecordingTransitionTask {
  kind: RecordingTransitionKind | null
  status: 'idle' | 'running' | 'error'
  leaseId: number | null
  startedAt: string | null
  error: string | null
}

export type SttProvider =
  | 'deepgram'
  | 'assemblyai'
  | 'glm-asr'
  | 'openai-whisper'
  | 'groq-whisper'
  | 'siliconflow'
  | 'sensevoice-local'
  | 'custom-whisper'
export type LlmProvider =
  | 'zhipu'
  | 'deepseek'
  | 'siliconflow'
  | 'openai'
  | 'gemini'
  | 'moonshot'
  | 'qwen'
  | 'groq'
  | 'claude'
  | 'ollama'
  | 'openrouter'
export type OutputMode = 'keyboard' | 'clipboard'
export type HotkeyMode = 'hold' | 'toggle'
export type Theme = 'light' | 'dark' | 'system'
export type ConfigSource = 'backend' | 'local'

export interface HistoryEntry {
  id: number
  created_at: string
  app_name: string
  app_type: string
  raw_text: string
  polished_text: string
  language: string | null
  duration_ms: number | null
}

export type HistoryMutationKind = 'selected' | 'all'

export interface HistoryMutationState {
  kind: HistoryMutationKind | null
  status: 'idle' | 'running' | 'error'
  leaseId: number | null
  startedAt: string | null
  error: string | null
}

export interface DictionaryEntry {
  id: number
  word: string
  pronunciation: string | null
}

export interface AppConfig {
  config_source: ConfigSource
  onboarding_version: number
  stt_provider: SttProvider
  stt_api_key: string
  stt_custom_api_key: string
  stt_custom_preset: 'speaches' | 'custom'
  stt_custom_base_url: string
  stt_custom_model: string
  stt_language: string
  llm_provider: LlmProvider
  llm_api_key: string
  llm_model: string
  llm_base_url: string
  ocr_base_url: string
  ocr_model: string
  polish_enabled: boolean
  translate_enabled: boolean
  target_lang: string
  hotkey: string
  screen_ocr_hotkey: string
  hotkey_mode: HotkeyMode
  output_mode: OutputMode
  selected_text_enabled: boolean
  theme: Theme
  theme_profile: ThemeProfile
  auto_start: boolean
  close_to_tray: boolean
  start_minimized: boolean
  max_recording_seconds: number
  mute_system_audio_during_recording: boolean
  ui_language: string
  capsule_auto_hide: boolean
  capsule_style: CapsuleStyle
  network_proxy_enabled: boolean
  network_proxy_url: string
  network_proxy_bypass: string
}

export type TtsPlaybackTarget = 'result' | 'answer' | 'preview'
export type OcrTaskKind = 'screen-selection' | 'screen-window' | 'upload'
export type OcrDialogState =
  | { status: 'loading'; message: string }
  | { status: 'error'; message: string; diagnostic: BackendErrorDiagnostic | null }
  | { status: 'success'; result: OcrReadResult }

export interface OcrTaskState {
  status: 'idle' | 'running' | 'success' | 'error'
  leaseId: number | null
  runId: number | null
  ackPending: boolean
  operationId: string | null
  startedAt: string | null
  kind: OcrTaskKind | null
  sourceName: string | null
  error: string | null
  diagnostic: BackendErrorDiagnostic | null
  result: OcrReadResult | null
  dialogState: OcrDialogState | null
  pdfExportFile: UploadedOcrFile | null
}

export interface AskTaskState {
  status: 'idle' | 'running' | 'success' | 'error'
  leaseId: number | null
  runId: number | null
  ackPending: boolean
  operationId: string | null
  startedAt: string | null
  question: string | null
  context: string | null
  answer: string | null
  error: string | null
}

export interface WorkbenchSurfaceFeedback {
  resourceId: string
  type: 'success' | 'error'
  message: string
}

export type WorkbenchFeedbackSlot = 'voice' | 'workspace'

export type SettingsOperationKind =
  | 'auth-login'
  | 'auth-cache-clear'
  | 'config-source'
  | 'bootstrap-sync'
  | 'quota-refresh'
  | 'models-load'
  | 'system-proxy'
  | 'stt-test'
  | 'llm-test'
  | 'ocr-test'
  | 'tts-diagnostic'
  | 'pdf-diagnostic'
  | 'combined-diagnostic'

export type SettingsNoticeScope =
  | 'input-trigger'
  | 'input-method'
  | 'recording'
  | 'voice-processing'
  | 'backend-auth'
  | 'managed-config'
  | 'stt'
  | 'text-ai'
  | 'ocr'
  | 'tts'
  | 'network-proxy'
  | 'startup-tray'
  | 'appearance'
  | 'diagnostics'
export type SettingsNoticePhase = 'success' | 'error' | 'info'

export interface SettingsNotice {
  id: number
  scope: SettingsNoticeScope
  phase: SettingsNoticePhase
  text: string
  seenAt: number | null
  expiresAt: number | null
}

export interface SettingsOperationState {
  kind: SettingsOperationKind
  leaseId: number
  startedAt: string
}

export type SettingsOutcomeStatus = 'idle' | 'running' | 'success' | 'error'
export type SettingsConnectionService = 'stt' | 'llm' | 'ocr'
export interface SettingsConnectionOutcome {
  status: SettingsOutcomeStatus
  service: SettingsConnectionService
  result: string | null
  latencyMs: number | null
}

export type LocalOcrAvailabilityStatus = 'idle' | 'checking' | 'available' | 'unavailable'
export interface LocalOcrAvailabilityState {
  configurationKey: string | null
  status: LocalOcrAvailabilityStatus
  leaseId: number | null
  capabilities: OcrConnectionTestResult | null
}
export interface DiagnosticPdfFile extends UploadedOcrFile {
  inputBytes: number
}
export interface SettingsPdfDiagnosticResult extends PdfDiagnosticResult {
  fileName: string
}
export interface SettingsDiagnosticsOutcome {
  kind: 'tts' | 'pdf' | 'combined' | null
  tts: TtsDiagnosticResult | null
  pdf: SettingsPdfDiagnosticResult | null
  pdfFile: DiagnosticPdfFile | null
}

export interface OtaTaskState {
  status: 'idle' | 'running' | 'success' | 'error'
  leaseId: number | null
  startedAt: string | null
  kind: 'check' | 'download'
  targetVersion: string | null
  result: OtaUpdateStatus | null
  progress: OtaInstallProgress | null
  restartStatus: 'none' | 'readyToRestart'
  checkCooldownUntil: number | null
  error: string | null
}

export interface AppState {
  // Pipeline
  pipelineState: PipelineState
  setPipelineState: (state: PipelineState) => void
  recordingTransition: RecordingTransitionTask
  tryStartRecordingTransition: (kind: RecordingTransitionKind) => number | null
  finishRecordingTransition: (leaseId: number) => void
  failRecordingTransition: (leaseId: number, error: string) => void
  clearRecordingTransition: (leaseId: number) => void

  // Recording
  audioVolume: number
  setAudioVolume: (v: number) => void
  partialTranscript: string
  setPartialTranscript: (t: string) => void
  finalTranscript: string
  setFinalTranscript: (t: string) => void
  polishedText: string
  appendPolishedChunk: (chunk: string) => void
  completedVoiceText: string
  completedVoiceTextVersion: number
  setCompletedVoiceText: (text: string) => void
  targetApp: string
  setTargetApp: (app: string) => void
  // Config
  config: AppConfig
  setConfig: (config: AppConfig) => void
  updateConfig: (partial: Partial<AppConfig>) => void
  applyPersistedConfigPatch: (patch: Partial<AppConfig>) => void
  localOcrAvailability: LocalOcrAvailabilityState
  beginLocalOcrProbe: (configurationKey: string) => number | null
  finishLocalOcrProbe: (
    configurationKey: string,
    leaseId: number,
    capabilities: OcrConnectionTestResult | null,
  ) => boolean

  // History
  history: HistoryEntry[]
  historyDeletedIds: number[]
  historyClearedThroughId: number
  historyMutation: HistoryMutationState
  setHistory: (h: HistoryEntry[]) => void
  tryStartHistoryMutation: (kind: HistoryMutationKind) => number | null
  finishHistoryMutation: (
    leaseId: number,
    deletedIds: number[],
    clearedThroughId?: number,
  ) => boolean
  failHistoryMutation: (leaseId: number, error: string) => boolean
  clearHistoryMutationError: () => void

  // Dictionary
  dictionary: DictionaryEntry[]
  setDictionary: (d: DictionaryEntry[]) => void

  // TTS playback mutex. This intentionally lives outside page-local state so a
  // route change cannot allow another request while audio is still playing.
  ttsPlaybackBusy: TtsPlaybackTarget | null
  ttsPlaybackLeaseId: number | null
  workbenchFeedback: Record<WorkbenchFeedbackSlot, WorkbenchSurfaceFeedback | null>
  setWorkbenchFeedback: (
    slot: WorkbenchFeedbackSlot,
    feedback: WorkbenchSurfaceFeedback | null,
  ) => void
  tryStartTtsPlayback: (target: TtsPlaybackTarget) => number | null
  finishTtsPlayback: (playbackId: number) => void

  ocrTask: OcrTaskState
  tryStartOcrTask: (kind: OcrTaskKind, sourceName: string, message?: string) => number | null
  finishOcrTask: (
    leaseId: number,
    result: OcrReadResult,
    pdfExportFile?: UploadedOcrFile | null,
  ) => boolean
  finalizeOcrTaskAcknowledgement: (runId: number, operationId: string) => boolean
  cancelOcrTask: (leaseId: number) => void
  failOcrTask: (leaseId: number, error: string, diagnostic?: BackendErrorDiagnostic | null) => void
  dismissOcrDialog: () => void
  clearOcrTask: () => void

  askTask: AskTaskState
  tryStartAskTask: (question: string, context: string | null) => number | null
  finishAskTask: (leaseId: number, answer: string, operationId?: string | null) => boolean
  finalizeAskTaskAcknowledgement: (runId: number, operationId: string) => boolean
  failAskTask: (leaseId: number, error: string) => void

  settingsOperation: SettingsOperationState | null
  tryStartSettingsOperation: (kind: SettingsOperationKind) => number | null
  finishSettingsOperation: (leaseId: number) => void
  settingsNotices: Partial<Record<SettingsNoticeScope, SettingsNotice>>
  publishSettingsNotice: (
    scope: SettingsNoticeScope,
    phase: SettingsNoticePhase,
    text: string,
  ) => number
  markSettingsNoticeSeen: (scope: SettingsNoticeScope, id: number, now?: number) => void
  dismissSettingsNotice: (scope: SettingsNoticeScope, id?: number) => void
  isCurrentSettingsOperation: (leaseId: number) => boolean
  completeSettingsAuth: (
    leaseId: number,
    message: string,
    phase?: Extract<SettingsNoticePhase, 'success' | 'info'>,
  ) => void
  failSettingsAuth: (leaseId: number, message: string) => void
  completeSettingsSync: (leaseId: number, purpose: 'config' | 'quota', message: string) => void
  failSettingsSync: (leaseId: number, purpose: 'config' | 'quota', message: string) => void
  settingsConnectionOutcomes: Record<SettingsConnectionService, SettingsConnectionOutcome>
  settingsDiagnosticsOutcome: SettingsDiagnosticsOutcome
  completeSettingsConnection: (
    leaseId: number,
    service: SettingsConnectionService,
    result: string,
    latencyMs: number,
    noticePhase?: Extract<SettingsNoticePhase, 'success' | 'info'>,
  ) => void
  failSettingsConnection: (
    leaseId: number,
    service: SettingsConnectionService,
    error: string,
  ) => void
  completeSettingsModels: (leaseId: number, models: string[], message: string) => void
  failSettingsModels: (leaseId: number, error: string) => void
  completeSettingsProxy: (leaseId: number, message: string) => void
  failSettingsProxy: (leaseId: number, error: string) => void
  setSettingsDiagnosticPdfFile: (leaseId: number, file: DiagnosticPdfFile) => void
  updateSettingsDiagnosticTts: (leaseId: number, result: TtsDiagnosticResult) => void
  updateSettingsDiagnosticPdf: (leaseId: number, result: SettingsPdfDiagnosticResult) => void
  completeSettingsDiagnostics: (leaseId: number) => void
  failSettingsDiagnostics: (leaseId: number, error: string) => void

  otaTask: OtaTaskState
  tryStartOtaTask: (kind: 'check' | 'download', targetVersion: string | null) => number | null
  isCurrentOtaTask: (leaseId: number) => boolean
  updateOtaProgress: (leaseId: number, progress: OtaInstallProgress) => void
  completeOtaCheck: (leaseId: number, result: OtaUpdateStatus) => void
  completeOtaDownload: (leaseId: number, targetVersion: string | null) => void
  failOtaTask: (leaseId: number, error: string) => void
  expireOtaCheckCooldown: (expectedUntil: number) => void

  // LLM model list cache (persists across tab switches)
  llmModels: string[]
  setLlmModels: (models: string[]) => void

  // Pipeline error
  pipelineError: string | null
  setPipelineError: (error: string | null) => void
  pipelineNotice: string | null
  setPipelineNotice: (notice: string | null) => void

  // macOS Accessibility permission
  accessibilityTrusted: boolean
  setAccessibilityTrusted: (trusted: boolean) => void

  // Context menu
  contextMenuOpen: boolean
  setContextMenuOpen: (open: boolean) => void
  contextMenuReady: boolean
  setContextMenuReady: (ready: boolean) => void

  // Global shortcut requests
  screenOcrShortcutRequest: number
  triggerScreenOcrShortcut: () => void
  claimedScreenOcrShortcutRequest: number
  claimScreenOcrShortcutRequest: () => boolean

  // Reset recording state
  resetRecording: () => void

  // Config snapshot for dirty detection
  savedConfig: AppConfig | null
  setSavedConfig: (config: AppConfig) => void
  resetConfig: () => void

  // Backend-managed desktop policy
  desktopBootstrap: DesktopBootstrap | null
  desktopAuthToken: string | null
  setDesktopAuthToken: (token: string | null) => void
  desktopAuthStatus: DesktopAuthStatus
  desktopBootstrapAuthToken: string | null
  desktopAuthSnapshot: DesktopAuthSnapshot | null
  setDesktopAuthSnapshot: (snapshot: DesktopAuthSnapshot | null) => boolean
  markDesktopAuthUnknown: (authToken: string | null) => boolean
  acceptDesktopBootstrap: (bootstrap: DesktopBootstrap, authToken: string | null) => boolean
  rejectDesktopAuthToken: (authToken: string) => boolean
  clearDesktopAuthState: () => void
}
