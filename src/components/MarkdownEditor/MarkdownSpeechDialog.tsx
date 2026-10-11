import { CheckCircle2, FolderOpen, RefreshCw, Square, Volume2, X } from 'lucide-react'
import type { MarkdownSpeechAsset } from '../../lib/tauri'

interface MarkdownSpeechDialogProps {
  asset: MarkdownSpeechAsset
  playing: boolean
  error?: string
  onPlay: () => void
  onReveal: () => void
  onRegenerate: () => void
  onClose: () => void
}

export function MarkdownSpeechDialog({
  asset,
  playing,
  error,
  onPlay,
  onReveal,
  onRegenerate,
  onClose,
}: MarkdownSpeechDialogProps) {
  return (
    <div
      className="echo-dialog-backdrop echo-markdown-speech-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="echo-dialog echo-markdown-speech-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="echo-markdown-speech-title"
        aria-describedby="echo-markdown-speech-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
          <div className="echo-screen-dialog-heading">
            <span className="echo-screen-dialog-icon echo-screen-dialog-icon--success" aria-hidden>
              <CheckCircle2 size={18} />
            </span>
            <div>
              <strong id="echo-markdown-speech-title">朗读音频生成完毕</strong>
              <span>音频已保存到“文档\EcholIKE\朗读音频”</span>
            </div>
          </div>
          <button
            type="button"
            className="echo-icon-button"
            aria-label="关闭朗读成品"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <div className="echo-dialog-body">
          <section className="echo-screen-state-panel echo-screen-state-panel--success">
            <CheckCircle2 size={20} aria-hidden />
            <div>
              <strong title={asset.fileName}>{asset.fileName}</strong>
              <p id="echo-markdown-speech-description">
                {formatDuration(asset.durationMs)} · {formatBytes(asset.byteLength)}
                。关闭此窗口不会删除音频，之后仍可从“生成完毕”或文件夹入口找到它。
              </p>
            </div>
          </section>
          {error && (
            <p className="echo-markdown-speech-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="echo-dialog-actions">
          <button type="button" className="echo-button" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="echo-button" onClick={onReveal}>
            <FolderOpen size={16} />
            打开所在文件夹
          </button>
          <button type="button" className="echo-button" onClick={onRegenerate}>
            <RefreshCw size={16} />
            重新生成
          </button>
          <button
            type="button"
            className="echo-button echo-button--primary"
            onClick={onPlay}
            autoFocus
          >
            {playing ? <Square size={15} /> : <Volume2 size={16} />}
            {playing ? '停止朗读' : '立即朗读'}
          </button>
        </div>
      </section>
    </div>
  )
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

function formatBytes(byteLength: number) {
  if (byteLength >= 1024 * 1024) return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`
  if (byteLength >= 1024) return `${Math.round(byteLength / 1024)} KB`
  return `${byteLength} B`
}
