import { create } from 'zustand'
import { classifyDesktopBootstrapIdentity, normalizeDesktopAuthToken } from '../lib/desktopAuth'
import { createMonotonicLeaseIdSource, isCurrentLease } from './lease'
import {
  applyPersistedConfigPatchTransition,
  createInitialConfigState,
  finishLocalOcrProbeTransition,
  localOcrConfigurationKey,
  resetConfigTransition,
  setConfigTransition,
  setSavedConfigTransition,
  startLocalOcrProbeTransition,
  updateConfigTransition,
} from './appStore.config'
import {
  completeOtaCheckTransition,
  completeOtaDownloadTransition,
  createInitialOtaTask,
  expireOtaCheckCooldownTransition,
  failOtaTaskTransition,
  startOtaTaskTransition,
  updateOtaProgressTransition,
} from './appStore.ota'
import {
  appendPolishedChunkTransition,
  createIdleRecordingTransition,
  failRecordingTransition,
  finishRecordingTransition,
  normalizeAudioVolume,
  pipelineStateTransition,
  resetRecordingTransition,
  startRecordingTransition,
} from './appStore.recording'
import {
  clearHistoryMutationTransition,
  createInitialHistoryState,
  failHistoryMutationTransition,
  finishHistoryMutationTransition,
  refreshHistoryTransition,
  startHistoryMutationTransition,
} from './appStore.history'
import {
  completedVoiceTextTransition,
  createIdleAskTask,
  createIdleOcrTask,
  dismissOcrDialogTransition,
  failAskTaskTransition,
  failOcrTaskTransition,
  finalizeAskTaskAcknowledgementTransition,
  finalizeOcrTaskAcknowledgementTransition,
  finishAskTaskTransition,
  finishOcrTaskTransition,
  finishTtsPlaybackTransition,
  resetOcrTaskTransition,
  startAskTaskTransition,
  startOcrTaskTransition,
  startTtsPlaybackTransition,
  workbenchFeedbackTransition,
} from './appStore.workbench'
import {
  completeSettingsConnectionTransition,
  completeSettingsModelsTransition,
  createInitialSettingsState,
  createSettingsNotice,
  dismissSettingsNoticeTransition,
  failSettingsConnectionTransition,
  finishSettingsAuthTransition,
  finishSettingsOperationTransition,
  finishSettingsScopedNoticeTransition,
  finishSettingsSyncTransition,
  markSettingsNoticeSeenTransition,
  publishSettingsNoticeTransition,
  setLlmModelsTransition,
  setSettingsDiagnosticPdfFileTransition,
  settingsConnectionSuccessMessage,
  settingsConnectionServiceForOperation,
  settingsDiagnosticKindForOperation,
  settingsNoticeScopeForConnection,
  startSettingsConnectionTransition,
  startSettingsDiagnosticsTransition,
  startSettingsOperationTransition,
  updateSettingsDiagnosticPdfTransition,
  updateSettingsDiagnosticTtsTransition,
} from './appStore.settings'
import type { AppState, SettingsNoticePhase, SettingsNoticeScope } from './appStore.types'

export type {
  AppConfig,
  AskTaskState,
  CapsuleStyle,
  ConfigSource,
  DiagnosticPdfFile,
  DictionaryEntry,
  HistoryEntry,
  HistoryMutationKind,
  HistoryMutationState,
  HotkeyMode,
  LlmProvider,
  LocalOcrAvailabilityState,
  LocalOcrAvailabilityStatus,
  OcrDialogState,
  OcrTaskKind,
  OcrTaskState,
  OtaTaskState,
  OutputMode,
  PipelineState,
  RecordingTransitionKind,
  RecordingTransitionTask,
  SettingsConnectionOutcome,
  SettingsConnectionService,
  SettingsDiagnosticsOutcome,
  SettingsNotice,
  SettingsNoticePhase,
  SettingsNoticeScope,
  SettingsOperationKind,
  SettingsOperationState,
  SettingsOutcomeStatus,
  SettingsPdfDiagnosticResult,
  SttProvider,
  Theme,
  ThemeProfile,
  TtsPlaybackTarget,
  WorkbenchFeedbackSlot,
  WorkbenchSurfaceFeedback,
} from './appStore.types'

export const OTA_MANUAL_CHECK_COOLDOWN_MS = 60_000

export { localOcrConfigurationKey, normalizeAudioVolume }

export const SETTINGS_NOTICE_TIMEOUT_MS = 8000

export const isMacPlatform = () =>
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

const nextTtsPlaybackLeaseId = createMonotonicLeaseIdSource()
const nextOcrTaskLeaseId = createMonotonicLeaseIdSource()
const nextAskTaskLeaseId = createMonotonicLeaseIdSource()
const nextSettingsOperationLeaseId = createMonotonicLeaseIdSource()
const nextSettingsNoticeId = createMonotonicLeaseIdSource()
const nextOtaTaskLeaseId = createMonotonicLeaseIdSource()
const nextRecordingTransitionLeaseId = createMonotonicLeaseIdSource()
const nextLocalOcrProbeLeaseId = createMonotonicLeaseIdSource()
const nextHistoryMutationLeaseId = createMonotonicLeaseIdSource()

function createNextSettingsNotice(
  scope: SettingsNoticeScope,
  phase: SettingsNoticePhase,
  text: string,
) {
  return createSettingsNotice(nextSettingsNoticeId(), scope, phase, text)
}

export const useAppStore = create<AppState>((set, get) => ({
  pipelineState: 'idle',
  setPipelineState: (pipelineState) =>
    set((state) => pipelineStateTransition(state.pipelineState, pipelineState)),
  recordingTransition: createIdleRecordingTransition(),
  tryStartRecordingTransition: (kind) => {
    if (get().recordingTransition.status === 'running') return null
    const leaseId = nextRecordingTransitionLeaseId()
    set(startRecordingTransition(kind, leaseId, new Date().toISOString()))
    return leaseId
  },
  finishRecordingTransition: (leaseId) => {
    if (!isCurrentLease(get().recordingTransition.leaseId, leaseId)) return
    set(finishRecordingTransition())
  },
  failRecordingTransition: (leaseId, error) => {
    if (!isCurrentLease(get().recordingTransition.leaseId, leaseId)) return
    set((state) => failRecordingTransition(state.recordingTransition, error))
  },
  clearRecordingTransition: (leaseId) => {
    if (!isCurrentLease(get().recordingTransition.leaseId, leaseId)) return
    set(finishRecordingTransition())
  },

  audioVolume: 0,
  setAudioVolume: (value) => {
    const state = get()
    if (state.pipelineState !== 'recording') return
    const audioVolume = normalizeAudioVolume(value)
    if (state.audioVolume === audioVolume) return
    set({ audioVolume })
  },
  partialTranscript: '',
  setPartialTranscript: (partialTranscript) => set({ partialTranscript }),
  finalTranscript: '',
  setFinalTranscript: (finalTranscript) => set({ finalTranscript }),
  polishedText: '',
  appendPolishedChunk: (chunk) =>
    set((state) => appendPolishedChunkTransition(state.polishedText, chunk)),
  completedVoiceText: '',
  completedVoiceTextVersion: 0,
  setCompletedVoiceText: (completedVoiceText) =>
    set((state) => completedVoiceTextTransition(state, completedVoiceText)),
  targetApp: '',
  setTargetApp: (targetApp) => set({ targetApp }),
  ...createInitialConfigState(isMacPlatform()),
  setConfig: (config) => set((state) => setConfigTransition(state, config)),
  updateConfig: (partial) => set((state) => updateConfigTransition(state, partial)),
  applyPersistedConfigPatch: (patch) =>
    set((state) => applyPersistedConfigPatchTransition(state, patch)),
  beginLocalOcrProbe: (configurationKey) => {
    if (localOcrConfigurationKey(get().config) !== configurationKey) return null
    const current = get().localOcrAvailability
    if (current.configurationKey === configurationKey && current.status === 'checking') return null
    const leaseId = nextLocalOcrProbeLeaseId()
    set(startLocalOcrProbeTransition(configurationKey, leaseId))
    return leaseId
  },
  finishLocalOcrProbe: (configurationKey, leaseId, capabilities) => {
    const current = get().localOcrAvailability
    if (
      localOcrConfigurationKey(get().config) !== configurationKey ||
      current.configurationKey !== configurationKey ||
      current.leaseId !== leaseId
    ) {
      return false
    }
    set((state) =>
      finishLocalOcrProbeTransition(
        state.settingsConnectionOutcomes,
        configurationKey,
        capabilities,
      ),
    )
    return true
  },

  ...createInitialHistoryState(),
  setHistory: (history) => set((state) => refreshHistoryTransition(state, history)),
  tryStartHistoryMutation: (kind) => {
    if (get().historyMutation.status === 'running') return null
    const leaseId = nextHistoryMutationLeaseId()
    set(startHistoryMutationTransition(kind, leaseId, new Date().toISOString()))
    return leaseId
  },
  finishHistoryMutation: (leaseId, deletedIds, clearedThroughId = 0) => {
    if (!isCurrentLease(get().historyMutation.leaseId, leaseId)) return false
    set((state) => finishHistoryMutationTransition(state, deletedIds, clearedThroughId))
    return true
  },
  failHistoryMutation: (leaseId, error) => {
    if (!isCurrentLease(get().historyMutation.leaseId, leaseId)) return false
    set((state) => failHistoryMutationTransition(state.historyMutation, error))
    return true
  },
  clearHistoryMutationError: () => {
    if (get().historyMutation.status !== 'error') return
    set(clearHistoryMutationTransition())
  },

  dictionary: [],
  setDictionary: (dictionary) => set({ dictionary }),

  ttsPlaybackBusy: null,
  ttsPlaybackLeaseId: null,
  workbenchFeedback: { voice: null, workspace: null },
  setWorkbenchFeedback: (slot, feedback) =>
    set((state) => workbenchFeedbackTransition(state.workbenchFeedback, slot, feedback)),
  tryStartTtsPlayback: (target) => {
    const state = get()
    if (state.ttsPlaybackBusy !== null) return null

    const playbackId = nextTtsPlaybackLeaseId()
    set(startTtsPlaybackTransition(target, playbackId))
    return playbackId
  },
  finishTtsPlayback: (playbackId) => {
    const state = get()
    if (state.ttsPlaybackBusy === null || !isCurrentLease(state.ttsPlaybackLeaseId, playbackId))
      return
    set(finishTtsPlaybackTransition())
  },

  ocrTask: createIdleOcrTask(),
  tryStartOcrTask: (kind, sourceName, message = 'OCR 正在处理截图或附件') => {
    if (get().ocrTask.status === 'running' || get().ocrTask.ackPending) return null
    const leaseId = nextOcrTaskLeaseId()
    const startedAt = new Date().toISOString()
    set((state) =>
      startOcrTaskTransition(
        state.workbenchFeedback,
        kind,
        sourceName,
        message,
        leaseId,
        startedAt,
      ),
    )
    return leaseId
  },
  finishOcrTask: (leaseId, result, pdfExportFile = null) => {
    const task = get().ocrTask
    if (!isCurrentLease(task.leaseId, leaseId)) return false
    set(finishOcrTaskTransition(task, result, pdfExportFile))
    return true
  },
  finalizeOcrTaskAcknowledgement: (runId, operationId) => {
    const task = get().ocrTask
    if (task.runId !== runId || !task.ackPending || task.operationId !== operationId) return false
    set(finalizeOcrTaskAcknowledgementTransition(task))
    return true
  },
  cancelOcrTask: (leaseId) => {
    const task = get().ocrTask
    if (!isCurrentLease(task.leaseId, leaseId)) return
    set(resetOcrTaskTransition())
  },
  failOcrTask: (leaseId, error, diagnostic = null) => {
    const task = get().ocrTask
    if (!isCurrentLease(task.leaseId, leaseId)) return
    set(failOcrTaskTransition(task, error, diagnostic))
  },
  dismissOcrDialog: () => set((state) => dismissOcrDialogTransition(state.ocrTask)),
  clearOcrTask: () => {
    if (get().ocrTask.status === 'running' || get().ocrTask.ackPending) return
    set(resetOcrTaskTransition())
  },

  askTask: createIdleAskTask(),
  tryStartAskTask: (question, context) => {
    if (get().askTask.status === 'running' || get().askTask.ackPending) return null
    const leaseId = nextAskTaskLeaseId()
    const startedAt = new Date().toISOString()
    set((state) =>
      startAskTaskTransition(state.workbenchFeedback, question, context, leaseId, startedAt),
    )
    return leaseId
  },
  finishAskTask: (leaseId, answer, operationId = null) => {
    const task = get().askTask
    if (!isCurrentLease(task.leaseId, leaseId)) return false
    set(finishAskTaskTransition(task, answer, operationId))
    return true
  },
  finalizeAskTaskAcknowledgement: (runId, operationId) => {
    const task = get().askTask
    if (task.runId !== runId || !task.ackPending || task.operationId !== operationId) return false
    set(finalizeAskTaskAcknowledgementTransition(task))
    return true
  },
  failAskTask: (leaseId, error) => {
    const task = get().askTask
    if (!isCurrentLease(task.leaseId, leaseId)) return
    set(failAskTaskTransition(task, error))
  },

  ...createInitialSettingsState(),
  publishSettingsNotice: (scope, phase, text) => {
    const notice = createNextSettingsNotice(scope, phase, text)
    set((state) => publishSettingsNoticeTransition(state.settingsNotices, notice))
    return notice.id
  },
  markSettingsNoticeSeen: (scope, id, now = Date.now()) => {
    set((state) => {
      const patch = markSettingsNoticeSeenTransition(
        state.settingsNotices,
        scope,
        id,
        now,
        now + SETTINGS_NOTICE_TIMEOUT_MS,
      )
      return patch ?? state
    })
  },
  dismissSettingsNotice: (scope, id) => {
    set((state) => {
      const patch = dismissSettingsNoticeTransition(state.settingsNotices, scope, id)
      return patch ?? state
    })
  },
  otaTask: createInitialOtaTask(),
  tryStartOtaTask: (kind, targetVersion) => {
    const task = get().otaTask
    if (task.status === 'running') return null
    if (
      kind === 'check' &&
      task.checkCooldownUntil !== null &&
      Date.now() < task.checkCooldownUntil
    ) {
      return null
    }
    const leaseId = nextOtaTaskLeaseId()
    set((state) =>
      startOtaTaskTransition(state.otaTask, kind, targetVersion, leaseId, new Date().toISOString()),
    )
    return leaseId
  },
  isCurrentOtaTask: (leaseId) => isCurrentLease(get().otaTask.leaseId, leaseId),
  updateOtaProgress: (leaseId, progress) => {
    const task = get().otaTask
    if (!isCurrentLease(task.leaseId, leaseId)) return
    set(updateOtaProgressTransition(task, progress))
  },
  completeOtaCheck: (leaseId, result) => {
    const task = get().otaTask
    if (!isCurrentLease(task.leaseId, leaseId)) return
    set(completeOtaCheckTransition(task, result, Date.now() + OTA_MANUAL_CHECK_COOLDOWN_MS))
  },
  completeOtaDownload: (leaseId, targetVersion) => {
    const task = get().otaTask
    if (!isCurrentLease(task.leaseId, leaseId)) return
    set(completeOtaDownloadTransition(task, targetVersion))
  },
  failOtaTask: (leaseId, error) => {
    const task = get().otaTask
    if (!isCurrentLease(task.leaseId, leaseId)) return
    const checkCooldownUntil =
      task.kind === 'check' ? Date.now() + OTA_MANUAL_CHECK_COOLDOWN_MS : task.checkCooldownUntil
    set(failOtaTaskTransition(task, error, checkCooldownUntil))
  },
  expireOtaCheckCooldown: (expectedUntil) => {
    const task = get().otaTask
    if (task.checkCooldownUntil !== expectedUntil || Date.now() < expectedUntil) return
    set(expireOtaCheckCooldownTransition(task))
  },
  tryStartSettingsOperation: (kind) => {
    if (get().settingsOperation !== null) return null
    const leaseId = nextSettingsOperationLeaseId()
    const startedAt = new Date().toISOString()
    set((state) =>
      startSettingsOperationTransition(state.settingsNotices, kind, leaseId, startedAt),
    )
    const service = settingsConnectionServiceForOperation(kind)
    if (service)
      set((state) => startSettingsConnectionTransition(state.settingsConnectionOutcomes, service))
    const diagnosticKind = settingsDiagnosticKindForOperation(kind)
    if (diagnosticKind)
      set((state) =>
        startSettingsDiagnosticsTransition(state.settingsDiagnosticsOutcome, diagnosticKind),
      )
    return leaseId
  },
  finishSettingsOperation: (leaseId) => {
    if (!isCurrentLease(get().settingsOperation?.leaseId ?? null, leaseId)) return
    set(finishSettingsOperationTransition())
  },
  isCurrentSettingsOperation: (leaseId) =>
    isCurrentLease(get().settingsOperation?.leaseId ?? null, leaseId),
  completeSettingsAuth: (leaseId, message, phase = 'success') => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const notice = createNextSettingsNotice('backend-auth', phase, message)
    set((state) => finishSettingsAuthTransition(state.settingsNotices, notice))
  },
  failSettingsAuth: (leaseId, message) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const notice = createNextSettingsNotice('backend-auth', 'error', message)
    set((state) => finishSettingsAuthTransition(state.settingsNotices, notice))
  },
  completeSettingsSync: (leaseId, purpose, message) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const scope: SettingsNoticeScope = purpose === 'quota' ? 'backend-auth' : 'managed-config'
    const notice = createNextSettingsNotice(scope, 'success', message)
    set((state) => finishSettingsSyncTransition(state.settingsNotices, notice))
  },
  failSettingsSync: (leaseId, purpose, message) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const scope: SettingsNoticeScope = purpose === 'quota' ? 'backend-auth' : 'managed-config'
    const notice = createNextSettingsNotice(scope, 'error', message)
    set((state) => finishSettingsSyncTransition(state.settingsNotices, notice))
  },
  completeSettingsConnection: (leaseId, service, result, latencyMs, noticePhase = 'success') => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const scope = settingsNoticeScopeForConnection(service)
    const notice =
      noticePhase === 'info'
        ? createNextSettingsNotice(
            scope,
            'info',
            settingsConnectionSuccessMessage(service, result, latencyMs),
          )
        : null
    set((state) =>
      completeSettingsConnectionTransition(
        state.settingsConnectionOutcomes,
        state.settingsNotices,
        service,
        result,
        latencyMs,
        notice,
      ),
    )
  },
  failSettingsConnection: (leaseId, service, error) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const notice = createNextSettingsNotice(
      settingsNoticeScopeForConnection(service),
      'error',
      error,
    )
    set((state) =>
      failSettingsConnectionTransition(
        state.settingsConnectionOutcomes,
        state.settingsNotices,
        service,
        notice,
      ),
    )
  },
  completeSettingsModels: (leaseId, models, message) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const notice = models.length ? null : createNextSettingsNotice('text-ai', 'info', message)
    set((state) => completeSettingsModelsTransition(state.settingsNotices, models, notice))
  },
  failSettingsModels: (leaseId, error) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const notice = createNextSettingsNotice('text-ai', 'error', error)
    set((state) => finishSettingsScopedNoticeTransition(state.settingsNotices, notice))
  },
  completeSettingsProxy: (leaseId, message) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const notice = createNextSettingsNotice('network-proxy', 'success', message)
    set((state) => finishSettingsScopedNoticeTransition(state.settingsNotices, notice))
  },
  failSettingsProxy: (leaseId, error) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const notice = createNextSettingsNotice('network-proxy', 'error', error)
    set((state) => finishSettingsScopedNoticeTransition(state.settingsNotices, notice))
  },
  setSettingsDiagnosticPdfFile: (leaseId, pdfFile) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    set((state) =>
      setSettingsDiagnosticPdfFileTransition(state.settingsDiagnosticsOutcome, pdfFile),
    )
  },
  updateSettingsDiagnosticTts: (leaseId, tts) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    set((state) => updateSettingsDiagnosticTtsTransition(state.settingsDiagnosticsOutcome, tts))
  },
  updateSettingsDiagnosticPdf: (leaseId, pdf) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    set((state) => updateSettingsDiagnosticPdfTransition(state.settingsDiagnosticsOutcome, pdf))
  },
  completeSettingsDiagnostics: (leaseId) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    set(finishSettingsOperationTransition())
  },
  failSettingsDiagnostics: (leaseId, error) => {
    if (!get().isCurrentSettingsOperation(leaseId)) return
    const notice = createNextSettingsNotice('diagnostics', 'error', error)
    set((state) => finishSettingsScopedNoticeTransition(state.settingsNotices, notice))
  },

  setLlmModels: (llmModels) => set(setLlmModelsTransition(llmModels)),

  pipelineError: null,
  setPipelineError: (pipelineError) => set({ pipelineError }),
  pipelineNotice: null,
  setPipelineNotice: (pipelineNotice) => set({ pipelineNotice }),

  accessibilityTrusted: true,
  setAccessibilityTrusted: (accessibilityTrusted) => set({ accessibilityTrusted }),

  contextMenuOpen: false,
  setContextMenuOpen: (contextMenuOpen) => set({ contextMenuOpen }),
  contextMenuReady: false,
  setContextMenuReady: (contextMenuReady) => set({ contextMenuReady }),

  screenOcrShortcutRequest: 0,
  triggerScreenOcrShortcut: () =>
    set((s) => ({ screenOcrShortcutRequest: s.screenOcrShortcutRequest + 1 })),
  claimedScreenOcrShortcutRequest: 0,
  claimScreenOcrShortcutRequest: () => {
    const state = get()
    if (state.claimedScreenOcrShortcutRequest >= state.screenOcrShortcutRequest) return false
    set({ claimedScreenOcrShortcutRequest: state.screenOcrShortcutRequest })
    return true
  },

  resetRecording: () => set(resetRecordingTransition()),

  setSavedConfig: (savedConfig) => set(setSavedConfigTransition(savedConfig)),
  resetConfig: () => set((state) => resetConfigTransition(state)),

  desktopBootstrap: null,
  desktopAuthToken: null,
  setDesktopAuthToken: (token) =>
    set((state) => {
      const desktopAuthToken = normalizeDesktopAuthToken(token)
      if (state.desktopAuthToken === desktopAuthToken) return {}
      return {
        desktopAuthToken,
        desktopAuthStatus: 'unknown',
        desktopBootstrapAuthToken: null,
        desktopBootstrap: null,
      }
    }),
  desktopAuthStatus: 'unknown',
  desktopBootstrapAuthToken: null,
  desktopAuthSnapshot: null,
  setDesktopAuthSnapshot: (desktopAuthSnapshot) => {
    const current = get().desktopAuthSnapshot
    if (desktopAuthSnapshot && current && desktopAuthSnapshot.generation < current.generation) {
      return false
    }
    set({ desktopAuthSnapshot })
    return true
  },
  markDesktopAuthUnknown: (authToken) => {
    const state = get()
    if (state.desktopAuthToken !== normalizeDesktopAuthToken(authToken)) return false
    set({
      desktopAuthStatus: 'unknown',
      desktopBootstrapAuthToken: null,
      desktopBootstrap: null,
    })
    return true
  },
  acceptDesktopBootstrap: (desktopBootstrap, authToken) => {
    const state = get()
    const identity = classifyDesktopBootstrapIdentity(
      desktopBootstrap,
      authToken,
      state.desktopAuthToken,
    )
    if (identity.kind === 'stale' || identity.kind === 'rejected') return false
    set({
      desktopBootstrap,
      desktopAuthStatus: identity.kind === 'authenticated' ? 'authenticated' : 'unknown',
      desktopBootstrapAuthToken: identity.token,
    })
    return true
  },
  rejectDesktopAuthToken: (authToken) => {
    const state = get()
    const rejectedToken = normalizeDesktopAuthToken(authToken)
    if (!rejectedToken || state.desktopAuthToken !== rejectedToken) return false
    set({
      desktopAuthToken: null,
      desktopAuthStatus: 'rejected',
      desktopBootstrapAuthToken: null,
      desktopBootstrap: null,
    })
    return true
  },
  clearDesktopAuthState: () =>
    set({
      desktopAuthToken: null,
      desktopAuthStatus: 'unknown',
      desktopBootstrapAuthToken: null,
      desktopBootstrap: null,
    }),
}))
