import type { StartupUpdateInfo } from '../lib/startupUpdate'
import type { OtaInstallProgress } from '../lib/tauri'
import { OtaProgressMeter } from './OtaProgressMeter'

interface StartupUpdatePromptProps {
  update: StartupUpdateInfo
  installing: boolean
  progress?: OtaInstallProgress | null
  errorMessage?: string | null
  onInstall(): void
  onDismiss(): void
}

export function StartupUpdatePrompt({
  update,
  installing,
  progress = null,
  errorMessage,
  onInstall,
  onDismiss,
}: StartupUpdatePromptProps) {
  return (
    <div className="echo-startup-update-screen" role="dialog" aria-modal="true">
      <section className="echo-startup-update-dialog" aria-labelledby="startup-update-title">
        <div className="echo-startup-update-kicker">发现新版本</div>
        <h1 id="startup-update-title">EcholIKE v{update.latestVersion}</h1>
        <p className="echo-startup-update-version">
          当前 v{update.currentVersion}，可以更新到 v{update.latestVersion}
        </p>
        <div className="echo-startup-update-notes">
          <strong>更新摘要</strong>
          <p>{update.noteSummary}</p>
        </div>
        <OtaProgressMeter progress={progress} />
        {errorMessage && (
          <p className="echo-startup-update-error" role="alert">
            {errorMessage}
          </p>
        )}
        <div className="echo-startup-update-actions">
          <button
            type="button"
            className="echo-button echo-button--primary"
            onClick={onInstall}
            disabled={installing}
          >
            {installing ? '正在更新...' : '立即更新'}
          </button>
          <button type="button" className="echo-button" onClick={onDismiss} disabled={installing}>
            下次提醒
          </button>
        </div>
      </section>
    </div>
  )
}
