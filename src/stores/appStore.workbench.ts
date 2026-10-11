import type { AppState, AskTaskState, OcrTaskState } from './appStore.types'

type WorkbenchFeedback = AppState['workbenchFeedback']
type WorkbenchFeedbackPatch = Pick<AppState, 'workbenchFeedback'>
type CompletedVoicePatch = Pick<
  AppState,
  'completedVoiceText' | 'completedVoiceTextVersion' | 'workbenchFeedback'
>
type TtsPlaybackPatch = Pick<AppState, 'ttsPlaybackBusy' | 'ttsPlaybackLeaseId'>
type OcrTaskPatch = Pick<AppState, 'ocrTask'>
type OcrTaskStartPatch = Pick<AppState, 'ocrTask' | 'workbenchFeedback'>
type AskTaskPatch = Pick<AppState, 'askTask'>
type AskTaskStartPatch = Pick<AppState, 'askTask' | 'workbenchFeedback'>

type WorkbenchFeedbackSlot = Parameters<AppState['setWorkbenchFeedback']>[0]
type WorkbenchSurfaceFeedback = Parameters<AppState['setWorkbenchFeedback']>[1]
type TtsPlaybackTarget = Parameters<AppState['tryStartTtsPlayback']>[0]
type OcrTaskKind = Parameters<AppState['tryStartOcrTask']>[0]
type OcrTaskResult = Parameters<AppState['finishOcrTask']>[1]
type OcrPdfExportFile = Parameters<AppState['finishOcrTask']>[2]
type OcrDiagnostic = Parameters<AppState['failOcrTask']>[2]

export function completedVoiceTextTransition(
  state: CompletedVoicePatch,
  completedVoiceText: string,
): CompletedVoicePatch {
  return {
    completedVoiceText,
    completedVoiceTextVersion: state.completedVoiceTextVersion + 1,
    workbenchFeedback: { ...state.workbenchFeedback, voice: null },
  }
}

export function workbenchFeedbackTransition(
  workbenchFeedback: WorkbenchFeedback,
  slot: WorkbenchFeedbackSlot,
  feedback: WorkbenchSurfaceFeedback,
): WorkbenchFeedbackPatch {
  return {
    workbenchFeedback: { ...workbenchFeedback, [slot]: feedback },
  }
}

export function startTtsPlaybackTransition(
  target: TtsPlaybackTarget,
  playbackId: number,
): TtsPlaybackPatch {
  return { ttsPlaybackBusy: target, ttsPlaybackLeaseId: playbackId }
}

export function finishTtsPlaybackTransition(): TtsPlaybackPatch {
  return { ttsPlaybackBusy: null, ttsPlaybackLeaseId: null }
}

export function createIdleOcrTask(): OcrTaskState {
  return {
    status: 'idle',
    leaseId: null,
    runId: null,
    ackPending: false,
    operationId: null,
    startedAt: null,
    kind: null,
    sourceName: null,
    error: null,
    diagnostic: null,
    result: null,
    dialogState: null,
    pdfExportFile: null,
  }
}

export function startOcrTaskTransition(
  workbenchFeedback: WorkbenchFeedback,
  kind: OcrTaskKind,
  sourceName: string,
  message: string,
  leaseId: number,
  startedAt: string,
): OcrTaskStartPatch {
  return {
    ocrTask: {
      status: 'running',
      leaseId,
      runId: leaseId,
      ackPending: false,
      operationId: null,
      startedAt,
      kind,
      sourceName,
      error: null,
      diagnostic: null,
      result: null,
      dialogState: { status: 'loading', message },
      pdfExportFile: null,
    },
    workbenchFeedback: { ...workbenchFeedback, workspace: null },
  }
}

export function finishOcrTaskTransition(
  task: OcrTaskState,
  result: OcrTaskResult,
  pdfExportFile: OcrPdfExportFile = null,
): OcrTaskPatch {
  const operationId = result.operation_id?.trim() || null
  return {
    ocrTask: {
      ...task,
      status: 'success',
      leaseId: null,
      ackPending: operationId !== null,
      operationId,
      error: null,
      diagnostic: null,
      result,
      dialogState: { status: 'success', result },
      pdfExportFile,
    },
  }
}

export function finalizeOcrTaskAcknowledgementTransition(task: OcrTaskState): OcrTaskPatch {
  return { ocrTask: { ...task, ackPending: false, operationId: null } }
}

export function resetOcrTaskTransition(): OcrTaskPatch {
  return { ocrTask: createIdleOcrTask() }
}

export function failOcrTaskTransition(
  task: OcrTaskState,
  error: string,
  diagnostic: OcrDiagnostic = null,
): OcrTaskPatch {
  return {
    ocrTask: {
      ...task,
      status: 'error',
      leaseId: null,
      error,
      diagnostic,
      dialogState: { status: 'error', message: error, diagnostic },
      pdfExportFile: null,
    },
  }
}

export function dismissOcrDialogTransition(task: OcrTaskState): OcrTaskPatch {
  return { ocrTask: { ...task, dialogState: null, pdfExportFile: null } }
}

export function createIdleAskTask(): AskTaskState {
  return {
    status: 'idle',
    leaseId: null,
    runId: null,
    ackPending: false,
    operationId: null,
    startedAt: null,
    question: null,
    context: null,
    answer: null,
    error: null,
  }
}

export function startAskTaskTransition(
  workbenchFeedback: WorkbenchFeedback,
  question: string,
  context: string | null,
  leaseId: number,
  startedAt: string,
): AskTaskStartPatch {
  return {
    askTask: {
      status: 'running',
      leaseId,
      runId: leaseId,
      ackPending: false,
      operationId: null,
      startedAt,
      question,
      context,
      answer: null,
      error: null,
    },
    workbenchFeedback: { ...workbenchFeedback, workspace: null },
  }
}

export function finishAskTaskTransition(
  task: AskTaskState,
  answer: string,
  operationId: string | null = null,
): AskTaskPatch {
  const normalizedOperationId = operationId?.trim() || null
  return {
    askTask: {
      ...task,
      status: 'success',
      leaseId: null,
      ackPending: normalizedOperationId !== null,
      operationId: normalizedOperationId,
      answer,
      error: null,
    },
  }
}

export function finalizeAskTaskAcknowledgementTransition(task: AskTaskState): AskTaskPatch {
  return { askTask: { ...task, ackPending: false, operationId: null } }
}

export function failAskTaskTransition(task: AskTaskState, error: string): AskTaskPatch {
  return {
    askTask: { ...task, status: 'error', leaseId: null, answer: null, error },
  }
}
