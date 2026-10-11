import { Loader2, RefreshCw } from 'lucide-react'
import type { OtaInstallProgress } from '../../lib/tauri'
import { OtaProgressMeter } from '../OtaProgressMeter'
import type { StatusTone } from './settingsCache'
import { Badge, Panel, PanelAlert, type PanelAlertState } from './settingsUi'

interface AboutSettingsPanelProps {
  appVersion: string
  packageVersion: string
  appVersionMismatch: boolean
  otaStatusSummary: string
  otaPolicySummary: string
  otaResultNotice?: PanelAlertState
  updateActionDisabled: boolean
  updateActionMode: 'check' | 'download'
  updatePolicyTone: StatusTone
  updateVersionTone: StatusTone
  updateRunning: boolean
  updateProgress: OtaInstallProgress | null
  displayUpdateActionLabel: string
  onCheckForUpdate: () => Promise<void>
  onDownloadUpdate: () => Promise<void>
}

export function AboutSettingsPanel({
  appVersion,
  packageVersion,
  appVersionMismatch,
  otaStatusSummary,
  otaPolicySummary,
  otaResultNotice,
  updateActionDisabled,
  updateActionMode,
  updatePolicyTone,
  updateVersionTone,
  updateRunning,
  updateProgress,
  displayUpdateActionLabel,
  onCheckForUpdate,
  onDownloadUpdate,
}: AboutSettingsPanelProps) {
  return (
    <Panel title="关于">
      <div className="echo-about-card echo-about-card--summary">
        <p>
          EcholIKE 用快捷键完成语音输入、选区处理、截图/附件识别和 Markdown
          整理。你可以使用本机模型、自己的服务商配置，或登录后台托管服务。
        </p>
      </div>

      <div className="echo-about-update-card">
        <span className="echo-line-icon">
          <RefreshCw size={18} />
        </span>
        <div className="echo-line-copy">
          <strong>版本更新</strong>
          <p>{otaStatusSummary}</p>
        </div>
        <div className="echo-about-update-actions">
          <Badge tone={updatePolicyTone}>{otaPolicySummary}</Badge>
          <Badge tone={updateVersionTone}>v{appVersion}</Badge>
          {appVersionMismatch && <Badge tone="warn">包版本 v{packageVersion}</Badge>}
          <button
            type="button"
            className="echo-button echo-button--primary"
            onClick={updateActionMode === 'download' ? onDownloadUpdate : onCheckForUpdate}
            disabled={updateActionDisabled}
          >
            {updateRunning ? <Loader2 size={16} className="echo-spin" /> : <RefreshCw size={16} />}
            {displayUpdateActionLabel}
          </button>
        </div>
        {otaResultNotice && (
          <div className="echo-about-update-result">
            <PanelAlert notice={otaResultNotice} />
          </div>
        )}
        {updateProgress && (
          <div className="echo-about-update-progress">
            <OtaProgressMeter progress={updateProgress} compact />
          </div>
        )}
      </div>
      <p className="echo-license-note">
        Copyright © 2026 EcholIKE Rebuild Contributors. AGPL-3.0-only；第三方许可见 NOTICE。
      </p>
    </Panel>
  )
}
