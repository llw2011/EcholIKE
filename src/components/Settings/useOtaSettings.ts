import { useCallback, useEffect, useState } from 'react'
import { UPDATE_CHECK_URL } from '../../lib/branding'
import {
  checkOtaUpdate,
  downloadAndInstallOtaUpdate,
  updaterProxyUrl,
  type DesktopBootstrap,
} from '../../lib/tauri'
import type { ErrorContext } from '../../lib/userErrors'
import { useAppStore, type AppConfig } from '../../stores/appStore'
import {
  clearPendingOtaUpdate,
  compareVersions,
  loadPendingOtaUpdate,
  savePendingOtaUpdate,
  type PendingOtaUpdate,
  type StatusTone,
} from './settingsCache'

type SettingsErrorMessage = (error: unknown, fallback: string, context?: ErrorContext) => string

type UseOtaSettingsOptions = {
  appVersion: string
  config: AppConfig
  desktopBootstrap: DesktopBootstrap | null
  settingsErrorMessage: SettingsErrorMessage
}

export function useOtaSettings({
  appVersion,
  config,
  desktopBootstrap,
  settingsErrorMessage,
}: UseOtaSettingsOptions) {
  const [pendingUpdate, setPendingUpdate] = useState<PendingOtaUpdate | null>(loadPendingOtaUpdate)
  const otaTask = useAppStore((s) => s.otaTask)
  const tryStartOtaTask = useAppStore((s) => s.tryStartOtaTask)
  const isCurrentOtaTask = useAppStore((s) => s.isCurrentOtaTask)
  const updateOtaProgress = useAppStore((s) => s.updateOtaProgress)
  const completeOtaCheck = useAppStore((s) => s.completeOtaCheck)
  const completeOtaDownload = useAppStore((s) => s.completeOtaDownload)
  const failOtaTask = useAppStore((s) => s.failOtaTask)
  const expireOtaCheckCooldown = useAppStore((s) => s.expireOtaCheckCooldown)

  const runtimePendingUpdate: PendingOtaUpdate | null =
    otaTask.status === 'success' &&
    otaTask.kind === 'download' &&
    otaTask.restartStatus === 'readyToRestart' &&
    otaTask.targetVersion
      ? {
          version: otaTask.targetVersion,
          status: 'readyToRestart',
          checkedAt: otaTask.startedAt ?? new Date().toISOString(),
          source: 'tauri-updater',
        }
      : null
  const activePendingUpdate =
    runtimePendingUpdate ??
    (pendingUpdate && compareVersions(appVersion, pendingUpdate.version) < 0 ? pendingUpdate : null)
  const otaDisplay = otaTask.result ?? desktopBootstrap?.ota ?? null
  const otaPolicySummary = activePendingUpdate
    ? 'Tauri updater · 已记录'
    : otaDisplay
      ? `${otaDisplay.autoUpdate ? '自动开' : '自动关'} · ${otaDisplay.forceUpdate ? '强制开' : '强制关'}`
      : desktopBootstrap
        ? '后台已同步'
        : '待同步'
  const otaStateLabel = activePendingUpdate
    ? activePendingUpdate.status === 'readyToRestart'
      ? '待重启'
      : '安装未完成'
    : otaDisplay
      ? otaDisplay.forceUpdate
        ? '强制'
        : otaDisplay.updateAvailable
          ? '可更新'
          : otaTask.result
            ? '已检最新'
            : '最新'
      : '待检查'
  const otaStatusSummary = activePendingUpdate
    ? `v${appVersion} -> v${activePendingUpdate.version} · ${otaStateLabel}`
    : otaDisplay
      ? `v${appVersion} -> v${otaDisplay.latestVersion} · ${otaStateLabel}`
      : `v${appVersion} · ${otaStateLabel}`
  const updatePolicyTone: StatusTone = activePendingUpdate
    ? 'warn'
    : otaDisplay?.updateAvailable
      ? otaDisplay.forceUpdate
        ? 'warn'
        : 'ok'
      : 'neutral'
  const updateVersionTone: StatusTone =
    activePendingUpdate || otaDisplay?.forceUpdate
      ? 'warn'
      : otaDisplay?.updateAvailable
        ? 'ok'
        : 'neutral'
  const updateActionMode: 'check' | 'download' =
    activePendingUpdate || otaDisplay?.updateAvailable ? 'download' : 'check'
  const otaCheckCooldownActive =
    otaTask.checkCooldownUntil !== null && Date.now() < otaTask.checkCooldownUntil
  const updateActionDisabled =
    otaTask.status === 'running' ||
    otaTask.restartStatus === 'readyToRestart' ||
    (updateActionMode === 'check' && otaCheckCooldownActive)
  const updateActionLabel =
    otaTask.status === 'running' && otaTask.kind === 'check'
      ? '检查中'
      : otaTask.status === 'running' && otaTask.kind === 'download'
        ? '下载中'
        : updateActionMode === 'download'
          ? activePendingUpdate
            ? '继续重启更新'
            : '立即重启更新'
          : otaCheckCooldownActive
            ? '稍后可重试'
            : otaTask.result
              ? '重新检查'
              : '检查更新'
  const displayUpdateActionLabel =
    otaTask.status === 'running' && otaTask.kind === 'download' ? '更新中' : updateActionLabel
  const otaResultNotice = otaTask.error
    ? { text: otaTask.error, tone: 'warn' as const }
    : otaTask.restartStatus === 'readyToRestart' && otaTask.targetVersion
      ? {
          text: `正在重启以完成 v${otaTask.targetVersion} 更新。`,
          tone: 'ok' as const,
        }
      : undefined

  useEffect(() => {
    if (!pendingUpdate) return
    if (compareVersions(appVersion, pendingUpdate.version) >= 0) {
      clearPendingOtaUpdate()
      setPendingUpdate(null)
    }
  }, [appVersion, pendingUpdate])

  useEffect(() => {
    const cooldownUntil = otaTask.checkCooldownUntil
    if (cooldownUntil === null) return
    const remainingMs = cooldownUntil - Date.now()
    if (remainingMs <= 0) {
      expireOtaCheckCooldown(cooldownUntil)
      return
    }
    const timeout = window.setTimeout(() => expireOtaCheckCooldown(cooldownUntil), remainingMs)
    return () => window.clearTimeout(timeout)
  }, [expireOtaCheckCooldown, otaTask.checkCooldownUntil])

  const checkForUpdate = useCallback(async () => {
    const leaseId = tryStartOtaTask('check', null)
    if (leaseId === null) return
    try {
      const result = await checkOtaUpdate(UPDATE_CHECK_URL, appVersion)
      if (!isCurrentOtaTask(leaseId)) return
      completeOtaCheck(leaseId, result)
    } catch (error) {
      if (!isCurrentOtaTask(leaseId)) return
      const message = settingsErrorMessage(error, '更新检测失败。', 'update')
      failOtaTask(leaseId, message)
    }
  }, [
    appVersion,
    completeOtaCheck,
    failOtaTask,
    isCurrentOtaTask,
    settingsErrorMessage,
    tryStartOtaTask,
  ])

  async function downloadUpdate() {
    const targetVersion = activePendingUpdate?.version ?? otaDisplay?.latestVersion
    const leaseId = tryStartOtaTask('download', targetVersion ?? null)
    if (leaseId === null) return
    try {
      await downloadAndInstallOtaUpdate(
        UPDATE_CHECK_URL,
        appVersion,
        updaterProxyUrl(config),
        (progress) => {
          if (isCurrentOtaTask(leaseId)) updateOtaProgress(leaseId, progress)
        },
        async (result) => {
          if (!isCurrentOtaTask(leaseId)) return false
          const installedVersion = result.latestVersion || targetVersion || appVersion
          const pending: PendingOtaUpdate = {
            version: installedVersion,
            status: 'readyToRestart',
            checkedAt: new Date().toISOString(),
            source: 'tauri-updater',
          }
          savePendingOtaUpdate(pending)
          completeOtaDownload(leaseId, installedVersion)
          return true
        },
      )
      if (!isCurrentOtaTask(leaseId)) return
    } catch (error) {
      if (!isCurrentOtaTask(leaseId)) return
      const message = settingsErrorMessage(error, '更新下载失败。', 'update')
      failOtaTask(leaseId, message)
    }
  }

  return {
    checkForUpdate,
    displayUpdateActionLabel,
    downloadUpdate,
    otaPolicySummary,
    otaResultNotice,
    otaStatusSummary,
    otaTask,
    updateActionDisabled,
    updateActionMode,
    updatePolicyTone,
    updateVersionTone,
  }
}
