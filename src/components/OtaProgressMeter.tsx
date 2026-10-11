import type { OtaInstallProgress } from '../lib/tauri'

interface OtaProgressMeterProps {
  progress: OtaInstallProgress | null
  compact?: boolean
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${value} B`
}

function progressLabel(progress: OtaInstallProgress) {
  if (progress.phase === 'checking') return '正在确认更新包'
  if (progress.phase === 'installing') return '下载完成，正在替换'
  if (progress.phase === 'relaunching') return '正在重启新版'
  return '正在下载更新包'
}

function progressValueText(progress: OtaInstallProgress) {
  if (progress.percent !== null) return `${progress.percent}%`
  if (progress.downloadedBytes > 0) return formatBytes(progress.downloadedBytes)
  return '准备中'
}

function progressDetail(progress: OtaInstallProgress) {
  if (progress.totalBytes && progress.downloadedBytes > 0) {
    return `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
  }
  if (progress.phase === 'installing' || progress.phase === 'relaunching') {
    return '完成后会自动重启'
  }
  return '请保持应用打开'
}

export function OtaProgressMeter({ progress, compact = false }: OtaProgressMeterProps) {
  if (!progress) return null

  const determinate = progress.percent !== null
  const clampedPercent = determinate ? Math.max(0, Math.min(100, progress.percent ?? 0)) : 0

  return (
    <div className={`echo-ota-progress${compact ? ' echo-ota-progress--compact' : ''}`}>
      <div className="echo-ota-progress-head">
        <strong>{progressLabel(progress)}</strong>
        <span>{progressValueText(progress)}</span>
      </div>
      <div
        className={`echo-ota-progress-track${determinate ? '' : ' echo-ota-progress-track--busy'}`}
        role="progressbar"
        aria-label="更新进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? clampedPercent : undefined}
      >
        <span style={determinate ? { width: `${clampedPercent}%` } : undefined} />
      </div>
      <p>{progressDetail(progress)}</p>
    </div>
  )
}
