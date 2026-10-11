import type {
  AppState,
  PipelineState,
  RecordingTransitionKind,
  RecordingTransitionTask,
} from './appStore.types'

type PipelineStatePatch = Pick<AppState, 'pipelineState'> & Partial<Pick<AppState, 'audioVolume'>>
type RecordingTransitionPatch = Pick<AppState, 'recordingTransition'>
type RecordingResetPatch = Pick<
  AppState,
  'audioVolume' | 'partialTranscript' | 'finalTranscript' | 'polishedText'
>

export function normalizeAudioVolume(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function createIdleRecordingTransition(): RecordingTransitionTask {
  return {
    kind: null,
    status: 'idle',
    leaseId: null,
    startedAt: null,
    error: null,
  }
}

export function pipelineStateTransition(
  currentState: PipelineState,
  pipelineState: PipelineState,
): PipelineStatePatch {
  return {
    pipelineState,
    ...(pipelineState !== 'recording' || currentState !== 'recording' ? { audioVolume: 0 } : {}),
  }
}

export function startRecordingTransition(
  kind: RecordingTransitionKind,
  leaseId: number,
  startedAt: string,
): RecordingTransitionPatch {
  return {
    recordingTransition: {
      kind,
      status: 'running',
      leaseId,
      startedAt,
      error: null,
    },
  }
}

export function finishRecordingTransition(): RecordingTransitionPatch {
  return { recordingTransition: createIdleRecordingTransition() }
}

export function failRecordingTransition(
  recordingTransition: RecordingTransitionTask,
  error: string,
): RecordingTransitionPatch {
  return {
    recordingTransition: { ...recordingTransition, status: 'error', error },
  }
}

export function appendPolishedChunkTransition(
  polishedText: string,
  chunk: string,
): Pick<AppState, 'polishedText'> {
  return { polishedText: polishedText + chunk }
}

export function resetRecordingTransition(): RecordingResetPatch {
  return {
    audioVolume: 0,
    partialTranscript: '',
    finalTranscript: '',
    polishedText: '',
  }
}
