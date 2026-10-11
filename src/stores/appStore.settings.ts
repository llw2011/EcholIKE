import type {
  AppState,
  SettingsConnectionOutcome,
  SettingsConnectionService,
  SettingsDiagnosticsOutcome,
  SettingsNotice,
  SettingsNoticePhase,
  SettingsNoticeScope,
  SettingsOperationKind,
} from './appStore.types'

type SettingsNotices = AppState['settingsNotices']
type SettingsState = Pick<
  AppState,
  | 'settingsOperation'
  | 'settingsNotices'
  | 'settingsConnectionOutcomes'
  | 'settingsDiagnosticsOutcome'
  | 'llmModels'
>
type SettingsNoticesPatch = Pick<AppState, 'settingsNotices'>
type SettingsOperationPatch = Pick<AppState, 'settingsOperation'>
type SettingsOperationStartPatch = Pick<AppState, 'settingsOperation' | 'settingsNotices'>
type SettingsConnectionPatch = Pick<AppState, 'settingsConnectionOutcomes'>
type SettingsConnectionCompletionPatch = Pick<
  AppState,
  'settingsOperation' | 'settingsConnectionOutcomes' | 'settingsNotices'
>
type SettingsDiagnosticsPatch = Pick<AppState, 'settingsDiagnosticsOutcome'>
type SettingsModelsCompletionPatch = Pick<
  AppState,
  'settingsOperation' | 'settingsNotices' | 'llmModels'
>
type SettingsOperationNoticePatch = Pick<AppState, 'settingsOperation' | 'settingsNotices'>

type DiagnosticKind = Exclude<SettingsDiagnosticsOutcome['kind'], null>
type DiagnosticPdfFile = Parameters<AppState['setSettingsDiagnosticPdfFile']>[1]
type DiagnosticTtsResult = Parameters<AppState['updateSettingsDiagnosticTts']>[1]
type DiagnosticPdfResult = Parameters<AppState['updateSettingsDiagnosticPdf']>[1]

export function createIdleSettingsConnectionOutcome(
  service: SettingsConnectionService,
): SettingsConnectionOutcome {
  return { status: 'idle', service, result: null, latencyMs: null }
}

export function createInitialSettingsState(): SettingsState {
  return {
    settingsOperation: null,
    settingsNotices: {},
    settingsConnectionOutcomes: {
      stt: createIdleSettingsConnectionOutcome('stt'),
      llm: createIdleSettingsConnectionOutcome('llm'),
      ocr: createIdleSettingsConnectionOutcome('ocr'),
    },
    settingsDiagnosticsOutcome: {
      kind: null,
      tts: null,
      pdf: null,
      pdfFile: null,
    },
    llmModels: [],
  }
}

function settingsNoticeScopeForOperation(kind: SettingsOperationKind): SettingsNoticeScope {
  switch (kind) {
    case 'auth-login':
    case 'auth-cache-clear':
      return 'backend-auth'
    case 'config-source':
    case 'bootstrap-sync':
      return 'managed-config'
    case 'quota-refresh':
      return 'backend-auth'
    case 'stt-test':
      return 'stt'
    case 'llm-test':
    case 'models-load':
      return 'text-ai'
    case 'ocr-test':
      return 'ocr'
    case 'system-proxy':
      return 'network-proxy'
    case 'tts-diagnostic':
    case 'pdf-diagnostic':
    case 'combined-diagnostic':
      return 'diagnostics'
  }
}

export function createSettingsNotice(
  id: number,
  scope: SettingsNoticeScope,
  phase: SettingsNoticePhase,
  text: string,
): SettingsNotice {
  return { id, scope, phase, text, seenAt: null, expiresAt: null }
}

export function withoutSettingsNotice(
  notices: SettingsNotices,
  scope: SettingsNoticeScope,
): SettingsNotices {
  const next = { ...notices }
  delete next[scope]
  return next
}

export function publishSettingsNoticeTransition(
  notices: SettingsNotices,
  notice: SettingsNotice,
): SettingsNoticesPatch {
  return { settingsNotices: { ...notices, [notice.scope]: notice } }
}

export function markSettingsNoticeSeenTransition(
  notices: SettingsNotices,
  scope: SettingsNoticeScope,
  id: number,
  seenAt: number,
  expiresAt: number,
): SettingsNoticesPatch | null {
  const notice = notices[scope]
  if (!notice || notice.id !== id || notice.seenAt !== null) return null
  return {
    settingsNotices: {
      ...notices,
      [scope]: { ...notice, seenAt, expiresAt },
    },
  }
}

export function dismissSettingsNoticeTransition(
  notices: SettingsNotices,
  scope: SettingsNoticeScope,
  id?: number,
): SettingsNoticesPatch | null {
  const notice = notices[scope]
  if (!notice || (id !== undefined && notice.id !== id)) return null
  return { settingsNotices: withoutSettingsNotice(notices, scope) }
}

export function startSettingsOperationTransition(
  notices: SettingsNotices,
  kind: SettingsOperationKind,
  leaseId: number,
  startedAt: string,
): SettingsOperationStartPatch {
  const noticeScope = settingsNoticeScopeForOperation(kind)
  return {
    settingsOperation: { kind, leaseId, startedAt },
    settingsNotices:
      kind === 'auth-login'
        ? withoutSettingsNotice(withoutSettingsNotice(notices, noticeScope), 'managed-config')
        : withoutSettingsNotice(notices, noticeScope),
  }
}

export function settingsConnectionServiceForOperation(
  kind: SettingsOperationKind,
): SettingsConnectionService | null {
  return kind === 'stt-test'
    ? 'stt'
    : kind === 'llm-test'
      ? 'llm'
      : kind === 'ocr-test'
        ? 'ocr'
        : null
}

export function startSettingsConnectionTransition(
  outcomes: AppState['settingsConnectionOutcomes'],
  service: SettingsConnectionService,
): SettingsConnectionPatch {
  return {
    settingsConnectionOutcomes: {
      ...outcomes,
      [service]: { ...outcomes[service], status: 'running', result: null, latencyMs: null },
    },
  }
}

export function settingsDiagnosticKindForOperation(
  kind: SettingsOperationKind,
): DiagnosticKind | null {
  if (!kind.endsWith('-diagnostic')) return null
  return kind === 'tts-diagnostic' ? 'tts' : kind === 'pdf-diagnostic' ? 'pdf' : 'combined'
}

export function startSettingsDiagnosticsTransition(
  outcome: SettingsDiagnosticsOutcome,
  kind: DiagnosticKind,
): SettingsDiagnosticsPatch {
  return {
    settingsDiagnosticsOutcome: {
      ...outcome,
      kind,
      tts: kind === 'pdf' ? outcome.tts : null,
      pdf: kind === 'tts' ? outcome.pdf : null,
    },
  }
}

export function finishSettingsOperationTransition(): SettingsOperationPatch {
  return { settingsOperation: null }
}

export function finishSettingsAuthTransition(
  notices: SettingsNotices,
  notice: SettingsNotice,
): SettingsOperationNoticePatch {
  return {
    settingsOperation: null,
    settingsNotices: {
      ...withoutSettingsNotice(notices, 'managed-config'),
      'backend-auth': notice,
    },
  }
}

export function finishSettingsSyncTransition(
  notices: SettingsNotices,
  notice: SettingsNotice,
): SettingsOperationNoticePatch {
  return {
    settingsOperation: null,
    settingsNotices: { ...notices, [notice.scope]: notice },
  }
}

export function settingsNoticeScopeForConnection(
  service: SettingsConnectionService,
): SettingsNoticeScope {
  return service === 'llm' ? 'text-ai' : service
}

export function settingsConnectionSuccessMessage(
  service: SettingsConnectionService,
  result: string,
  latencyMs: number,
): string {
  return service === 'stt'
    ? `STT 连接正常：${latencyMs}ms`
    : service === 'llm'
      ? `文本 AI 连接正常：${latencyMs}ms`
      : `OCR 组件检查完成：${result}（${latencyMs}ms）`
}

export function completeSettingsConnectionTransition(
  outcomes: AppState['settingsConnectionOutcomes'],
  notices: SettingsNotices,
  service: SettingsConnectionService,
  result: string,
  latencyMs: number,
  notice: SettingsNotice | null,
): SettingsConnectionCompletionPatch {
  const scope = settingsNoticeScopeForConnection(service)
  return {
    settingsOperation: null,
    settingsConnectionOutcomes: {
      ...outcomes,
      [service]: { status: 'success', service, result, latencyMs },
    },
    settingsNotices: notice
      ? { ...withoutSettingsNotice(notices, scope), [scope]: notice }
      : withoutSettingsNotice(notices, scope),
  }
}

export function failSettingsConnectionTransition(
  outcomes: AppState['settingsConnectionOutcomes'],
  notices: SettingsNotices,
  service: SettingsConnectionService,
  notice: SettingsNotice,
): SettingsConnectionCompletionPatch {
  return {
    settingsOperation: null,
    settingsConnectionOutcomes: {
      ...outcomes,
      [service]: { status: 'error', service, result: null, latencyMs: null },
    },
    settingsNotices: { ...notices, [notice.scope]: notice },
  }
}

export function completeSettingsModelsTransition(
  notices: SettingsNotices,
  models: string[],
  notice: SettingsNotice | null,
): SettingsModelsCompletionPatch {
  const cleared = withoutSettingsNotice(notices, 'text-ai')
  return {
    settingsOperation: null,
    llmModels: models,
    settingsNotices: models.length || !notice ? cleared : { ...cleared, 'text-ai': notice },
  }
}

export function finishSettingsScopedNoticeTransition(
  notices: SettingsNotices,
  notice: SettingsNotice,
): SettingsOperationNoticePatch {
  return {
    settingsOperation: null,
    settingsNotices: { ...notices, [notice.scope]: notice },
  }
}

export function setSettingsDiagnosticPdfFileTransition(
  outcome: SettingsDiagnosticsOutcome,
  pdfFile: DiagnosticPdfFile,
): SettingsDiagnosticsPatch {
  return { settingsDiagnosticsOutcome: { ...outcome, pdfFile } }
}

export function updateSettingsDiagnosticTtsTransition(
  outcome: SettingsDiagnosticsOutcome,
  tts: DiagnosticTtsResult,
): SettingsDiagnosticsPatch {
  return { settingsDiagnosticsOutcome: { ...outcome, tts } }
}

export function updateSettingsDiagnosticPdfTransition(
  outcome: SettingsDiagnosticsOutcome,
  pdf: DiagnosticPdfResult,
): SettingsDiagnosticsPatch {
  return { settingsDiagnosticsOutcome: { ...outcome, pdf } }
}

export function setLlmModelsTransition(llmModels: string[]): Pick<AppState, 'llmModels'> {
  return { llmModels }
}
