import { describe, expect, it, vi } from 'vitest'
import { OTA_MANUAL_CHECK_COOLDOWN_MS } from '../appStore'
import {
  completeOtaCheckTransition,
  completeOtaDownloadTransition,
  createInitialOtaTask,
  expireOtaCheckCooldownTransition,
  failOtaTaskTransition,
  startOtaTaskTransition,
  updateOtaProgressTransition,
} from '../appStore.ota'
import { getState, setupAppStoreTestLifecycle } from './appStoreTestHarness'

const updateAvailable = {
  appName: 'EcholIKE',
  currentVersion: '0.2.30',
  latestVersion: '0.2.31',
  autoUpdate: true,
  updateAvailable: true,
  forceUpdate: false,
  downloadUrl: null,
  sha256: null,
  releaseNotes: null,
  message: 'available',
  checkedAt: '2026-08-29T00:00:00.000Z',
}

describe('appStore OTA transitions', () => {
  it('creates isolated idle tasks', () => {
    const first = createInitialOtaTask()
    const second = createInitialOtaTask()

    expect(first).toEqual({
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
    })
    expect(first).not.toBe(second)
  })

  it('clears check state while preserving download result and cooldown', () => {
    const current = {
      ...createInitialOtaTask(),
      status: 'success' as const,
      result: updateAvailable,
      checkCooldownUntil: 42,
    }

    expect(
      startOtaTaskTransition(current, 'check', null, 7, '2026-08-29T00:00:00.000Z').otaTask,
    ).toMatchObject({ result: null, progress: null, checkCooldownUntil: null })
    expect(
      startOtaTaskTransition(current, 'download', '0.2.31', 8, '2026-08-29T00:00:00.000Z').otaTask,
    ).toMatchObject({
      result: updateAvailable,
      progress: { phase: 'checking', downloadedBytes: 0, totalBytes: null, percent: null },
      checkCooldownUntil: 42,
    })
  })

  it('builds progress, completion, failure and cooldown-expiry patches', () => {
    const running = startOtaTaskTransition(
      createInitialOtaTask(),
      'download',
      '0.2.31',
      9,
      '2026-08-29T00:00:00.000Z',
    ).otaTask
    const progress = {
      phase: 'downloading' as const,
      downloadedBytes: 5,
      totalBytes: 10,
      percent: 50,
    }

    expect(updateOtaProgressTransition(running, progress).otaTask.progress).toEqual(progress)
    expect(completeOtaDownloadTransition(running, null).otaTask).toMatchObject({
      status: 'success',
      leaseId: null,
      targetVersion: '0.2.31',
      restartStatus: 'readyToRestart',
    })
    expect(completeOtaCheckTransition(running, updateAvailable, 100).otaTask).toMatchObject({
      targetVersion: '0.2.31',
      result: updateAvailable,
      checkCooldownUntil: 100,
      restartStatus: 'none',
    })
    expect(failOtaTaskTransition(running, 'failed', 120).otaTask).toMatchObject({
      status: 'error',
      leaseId: null,
      progress: null,
      checkCooldownUntil: 120,
      error: 'failed',
    })
    expect(
      expireOtaCheckCooldownTransition({ ...running, checkCooldownUntil: 120 }).otaTask,
    ).toMatchObject({ checkCooldownUntil: null })
  })
})

describe('appStore', () => {
  setupAppStoreTestLifecycle()

  describe('OTA task', () => {
    it('starts independently and only matching leases may update or release it', () => {
      const settingsLease = getState().tryStartSettingsOperation('quota-refresh')
      const playbackLease = getState().tryStartTtsPlayback('preview')
      const lease = getState().tryStartOtaTask('download', '0.2.0') ?? -1

      expect(settingsLease).not.toBeNull()
      expect(playbackLease).not.toBeNull()
      expect(lease).toBeGreaterThan(0)
      expect(getState().isCurrentOtaTask(lease)).toBe(true)
      expect(getState().isCurrentOtaTask(lease - 1)).toBe(false)
      expect(getState().tryStartOtaTask('download', '0.2.0')).toBeNull()

      getState().updateOtaProgress(lease, {
        phase: 'downloading',
        downloadedBytes: 50,
        totalBytes: 100,
        percent: 50,
      })
      getState().failOtaTask(lease - 1, 'late error')
      expect(getState().otaTask).toMatchObject({
        status: 'running',
        leaseId: lease,
        targetVersion: '0.2.0',
        progress: { percent: 50 },
        error: null,
      })
      getState().failOtaTask(lease, '下载更新失败，请稍后再试。')
      expect(getState().isCurrentOtaTask(lease)).toBe(false)
      expect(getState().otaTask).toMatchObject({
        status: 'error',
        leaseId: null,
        error: '下载更新失败，请稍后再试。',
      })
    })

    it('has fresh-process idle state and rejects stale success after a newer lease starts', () => {
      expect(getState().otaTask).toMatchObject({ status: 'idle', leaseId: null })
      const oldLease = getState().tryStartOtaTask('check', null) ?? -1
      getState().failOtaTask(oldLease, 'first failure')
      expect(getState().tryStartOtaTask('check', null)).toBeNull()
      const newLease = getState().tryStartOtaTask('download', '0.2.0') ?? -1

      getState().completeOtaCheck(oldLease, {
        appName: 'EcholIKE',
        currentVersion: '0.1.0',
        latestVersion: '9.9.9',
        autoUpdate: true,
        updateAvailable: true,
        forceUpdate: false,
        downloadUrl: null,
        sha256: null,
        releaseNotes: null,
        message: 'late',
        checkedAt: '2026-07-12T00:00:00.000Z',
      })
      expect(getState().otaTask).toMatchObject({
        status: 'running',
        leaseId: newLease,
        kind: 'download',
        result: null,
      })
    })

    it('shares a 60-second manual-check cooldown without blocking downloads', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))

      const firstLease = getState().tryStartOtaTask('check', null) ?? -1
      getState().completeOtaCheck(firstLease, {
        appName: 'EcholIKE',
        currentVersion: '0.2.26',
        latestVersion: '0.2.26',
        autoUpdate: true,
        updateAvailable: false,
        forceUpdate: false,
        downloadUrl: null,
        sha256: null,
        releaseNotes: null,
        message: 'current',
        checkedAt: '2026-08-20T00:00:00.000Z',
      })

      const firstCooldownUntil = getState().otaTask.checkCooldownUntil ?? -1
      expect(firstCooldownUntil).toBe(Date.now() + OTA_MANUAL_CHECK_COOLDOWN_MS)
      expect(getState().tryStartOtaTask('check', null)).toBeNull()

      vi.advanceTimersByTime(OTA_MANUAL_CHECK_COOLDOWN_MS - 1)
      getState().expireOtaCheckCooldown(firstCooldownUntil)
      expect(getState().otaTask.checkCooldownUntil).toBe(firstCooldownUntil)
      expect(getState().tryStartOtaTask('check', null)).toBeNull()

      vi.advanceTimersByTime(1)
      getState().expireOtaCheckCooldown(firstCooldownUntil)
      expect(getState().otaTask.checkCooldownUntil).toBeNull()

      const failedCheckLease = getState().tryStartOtaTask('check', null) ?? -1
      getState().failOtaTask(failedCheckLease, '更新检测失败。')
      expect(getState().tryStartOtaTask('check', null)).toBeNull()
      const secondCooldownUntil = getState().otaTask.checkCooldownUntil

      getState().expireOtaCheckCooldown(firstCooldownUntil)
      expect(getState().otaTask.checkCooldownUntil).toBe(secondCooldownUntil)

      const downloadLease = getState().tryStartOtaTask('download', '0.2.27')
      expect(downloadLease).not.toBeNull()
      expect(getState().otaTask.checkCooldownUntil).toBe(Date.now() + OTA_MANUAL_CHECK_COOLDOWN_MS)
    })
  })
})
