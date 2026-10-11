import type { AppState, OtaTaskState } from './appStore.types'

type OtaTaskPatch = Pick<AppState, 'otaTask'>
type OtaProgress = Parameters<AppState['updateOtaProgress']>[1]
type OtaCheckResult = Parameters<AppState['completeOtaCheck']>[1]

export function createInitialOtaTask(): OtaTaskState {
  return {
    status: 'idle',
    leaseId: null,
    startedAt: null,
    kind: 'check',
    targetVersion: null,
    result: null,
    progress: null,
    restartStatus: 'none',
    checkCooldownUntil: null,
    error: null,
  }
}

export function startOtaTaskTransition(
  current: OtaTaskState,
  kind: OtaTaskState['kind'],
  targetVersion: string | null,
  leaseId: number,
  startedAt: string,
): OtaTaskPatch {
  return {
    otaTask: {
      status: 'running',
      leaseId,
      startedAt,
      kind,
      targetVersion,
      result: kind === 'check' ? null : current.result,
      progress:
        kind === 'download'
          ? { phase: 'checking', downloadedBytes: 0, totalBytes: null, percent: null }
          : null,
      restartStatus: 'none',
      checkCooldownUntil: kind === 'check' ? null : current.checkCooldownUntil,
      error: null,
    },
  }
}

export function updateOtaProgressTransition(
  current: OtaTaskState,
  progress: OtaProgress,
): OtaTaskPatch {
  return { otaTask: { ...current, progress } }
}

export function completeOtaCheckTransition(
  current: OtaTaskState,
  result: OtaCheckResult,
  checkCooldownUntil: number,
): OtaTaskPatch {
  return {
    otaTask: {
      ...current,
      status: 'success',
      leaseId: null,
      targetVersion: result.updateAvailable ? result.latestVersion : null,
      result,
      progress: null,
      restartStatus: 'none',
      checkCooldownUntil,
      error: null,
    },
  }
}

export function completeOtaDownloadTransition(
  current: OtaTaskState,
  targetVersion: string | null,
): OtaTaskPatch {
  return {
    otaTask: {
      ...current,
      status: 'success',
      leaseId: null,
      targetVersion: targetVersion ?? current.targetVersion,
      progress: null,
      restartStatus: 'readyToRestart',
      error: null,
    },
  }
}

export function failOtaTaskTransition(
  current: OtaTaskState,
  error: string,
  checkCooldownUntil: number | null,
): OtaTaskPatch {
  return {
    otaTask: {
      ...current,
      status: 'error',
      leaseId: null,
      progress: null,
      checkCooldownUntil,
      error,
    },
  }
}

export function expireOtaCheckCooldownTransition(current: OtaTaskState): OtaTaskPatch {
  return { otaTask: { ...current, checkCooldownUntil: null } }
}
