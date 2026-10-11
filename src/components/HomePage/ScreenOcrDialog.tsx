import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  Eye,
  FileText,
  Loader2,
  MessageCircle,
  X,
} from 'lucide-react'
import type { OcrDialogState } from '../../stores/appStore'
import type { FileCommandSurfaceFeedback } from '../../stores/fileCommandStore'
import type { OcrReadResult, UploadedOcrFile } from '../../lib/tauri'
import { MarkdownEditorPreview } from '../MarkdownEditor/MarkdownEditorPreview'
import { cleanOcrText, ocrRouteLabel, ocrWarningMessage } from './ocrDomain'

export function ScreenOcrDialog({
  state,
  onClose,
  feedback,
  onCopy,
  onDownload,
  docxExportBusy,
  onExportDocx,
  pdfExportFile,
  pdfExportBusy,
  onExportPdfImages,
  onAskFromResult,
  onSendToEditor,
}: {
  state: OcrDialogState
  onClose: () => void
  feedback: FileCommandSurfaceFeedback | null
  onCopy: () => void
  onDownload: (result: OcrReadResult) => void | Promise<void>
  docxExportBusy: boolean
  onExportDocx: (result: OcrReadResult) => void
  pdfExportFile: UploadedOcrFile | null
  pdfExportBusy: boolean
  onExportPdfImages: (file: UploadedOcrFile) => void
  onAskFromResult: (result: OcrReadResult) => void
  onSendToEditor: (result: OcrReadResult) => void
}) {
  if (state.status === 'loading') {
    return (
      <div className="echo-dialog-backdrop" role="presentation" onMouseDown={onClose}>
        <section
          className="echo-dialog echo-screen-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="echo-screen-progress-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
            <div className="echo-screen-dialog-heading">
              <span className="echo-screen-dialog-icon" aria-hidden="true">
                <Loader2 size={18} className="echo-spin" />
              </span>
              <div>
                <strong id="echo-screen-progress-title">正在识别内容</strong>
                <span>正在处理截图或附件</span>
              </div>
            </div>
            <button type="button" className="echo-icon-button" aria-label="关闭" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
          <div className="echo-dialog-body">
            <section className="echo-screen-state-panel">
              <Loader2 size={20} className="echo-spin" />
              <div>
                <strong>处理中</strong>
                <p>{state.message}</p>
              </div>
            </section>
          </div>
          <div className="echo-dialog-actions">
            <button type="button" className="echo-button" onClick={onClose}>
              后台继续
            </button>
          </div>
        </section>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="echo-dialog-backdrop" role="presentation" onMouseDown={onClose}>
        <section
          className="echo-dialog echo-screen-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="echo-screen-error-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
            <div className="echo-screen-dialog-heading">
              <span
                className="echo-screen-dialog-icon echo-screen-dialog-icon--error"
                aria-hidden="true"
              >
                <AlertTriangle size={18} />
              </span>
              <div>
                <strong id="echo-screen-error-title">识别未完成</strong>
                <span>请根据提示处理后重试</span>
              </div>
            </div>
            <button type="button" className="echo-icon-button" aria-label="关闭" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
          <div className="echo-dialog-body">
            <section className="echo-screen-state-panel echo-screen-state-panel--error">
              <AlertTriangle size={20} />
              <div>
                <strong>处理建议</strong>
                <p>{state.message}</p>
                {state.diagnostic?.requestId ? <p>请求 ID：{state.diagnostic.requestId}</p> : null}
              </div>
            </section>
          </div>
          <div className="echo-dialog-actions">
            <button type="button" className="echo-button echo-button--primary" onClick={onClose}>
              关闭
            </button>
          </div>
        </section>
      </div>
    )
  }

  const result = state.result
  const text = cleanOcrText(result.text)
  const lineCount = text ? text.split(/\r?\n/).filter((line) => line.trim()).length : 0
  const charCount = Array.from(text).length
  const isUpload = result.source_kind === 'upload'
  const appName = result.app_name || '未知应用'
  const windowTitle = result.window_title || '未读取到窗口标题'
  const title = isUpload ? '附件处理结果' : '屏幕文字识别结果'
  const sourceName = result.source_name || windowTitle
  const routeLabel = ocrRouteLabel(result)
  const warningMessage = ocrWarningMessage(result)
  const textMeta =
    result.page_count && result.page_count > 1 ? `${result.page_count} 页` : 'Markdown'
  const canExportPdfImages =
    isUpload && Boolean(pdfExportFile?.fileBase64?.trim() || pdfExportFile?.fileBytes?.length)

  return (
    <div className="echo-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="echo-dialog echo-screen-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="echo-screen-result-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
          <div className="echo-screen-dialog-heading">
            <span className="echo-screen-dialog-icon" aria-hidden="true">
              <Eye size={18} />
            </span>
            <div>
              <strong id="echo-screen-result-title">{title}</strong>
              <span>
                {[
                  isUpload ? sourceName : appName,
                  routeLabel,
                  result.model,
                  `${result.elapsed_ms}ms`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          </div>
          <button type="button" className="echo-icon-button" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="echo-dialog-body">
          <div className="echo-screen-meta-grid">
            <div>
              <span>{isUpload ? '来源' : '应用'}</span>
              <strong>{isUpload ? '上传附件' : appName}</strong>
            </div>
            <div>
              <span>{isUpload ? '页数' : '类型'}</span>
              <strong>{isUpload ? result.page_count || 1 : result.app_type || 'General'}</strong>
            </div>
            <div>
              <span>模型</span>
              <strong>{result.model}</strong>
            </div>
            <div>
              <span>文本量</span>
              <strong>
                {lineCount} 行 · {charCount} 字
              </strong>
            </div>
          </div>
          <div className="echo-screen-window-title">
            <span>{isUpload ? '文件名' : '窗口标题'}</span>
            <strong>{sourceName}</strong>
          </div>
          {warningMessage && (
            <div className="echo-panel-alert echo-panel-alert--warn" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{warningMessage}</span>
            </div>
          )}
          {feedback && (
            <div
              className={`echo-panel-alert echo-panel-alert--${feedback.type === 'success' ? 'ok' : 'warn'}`}
              role={feedback.type === 'success' ? 'status' : 'alert'}
            >
              {feedback.type === 'success' ? (
                <CheckCircle2 size={15} aria-hidden="true" />
              ) : (
                <AlertTriangle size={15} aria-hidden="true" />
              )}
              <span>{feedback.message}</span>
            </div>
          )}
          <section className="echo-screen-text-panel echo-screen-text-panel--scrollable">
            <header>
              <span>{isUpload ? 'Markdown 预览' : '识别文本'}</span>
              <b>{text ? `${textMeta} · 可复制/下载/导出` : '未识别到可见文字'}</b>
            </header>
            <MarkdownEditorPreview text={text || '未读取到可见文字'} />
          </section>
        </div>
        <div className="echo-dialog-actions">
          <button
            type="button"
            className="echo-button echo-button--primary"
            onClick={() => onAskFromResult(result)}
            disabled={!text}
          >
            <MessageCircle size={16} />
            基于此内容提问
          </button>
          <button
            type="button"
            className="echo-button"
            aria-label="发送 OCR 到编辑器"
            onClick={() => onSendToEditor(result)}
            disabled={!text}
          >
            <FileText size={16} />
            整理
          </button>
          <button type="button" className="echo-button" onClick={onCopy} disabled={!text}>
            <Clipboard size={16} />
            复制 Markdown
          </button>
          <button
            type="button"
            className="echo-button"
            onClick={() => void onDownload(result)}
            disabled={!text}
          >
            <Download size={16} />
            下载 .md
          </button>
          <button
            type="button"
            className="echo-button"
            onClick={() => onExportDocx(result)}
            disabled={!text || docxExportBusy}
          >
            {docxExportBusy ? <Loader2 size={16} className="echo-spin" /> : <Download size={16} />}
            {docxExportBusy ? '导出中' : '导出 Word'}
          </button>
          {canExportPdfImages && pdfExportFile && (
            <button
              type="button"
              className="echo-button"
              onClick={() => onExportPdfImages(pdfExportFile)}
              disabled={pdfExportBusy}
            >
              {pdfExportBusy ? <Loader2 size={16} className="echo-spin" /> : <Download size={16} />}
              {pdfExportBusy ? '导出中' : '导出图片'}
            </button>
          )}
          <button type="button" className="echo-button" onClick={onClose}>
            关闭
          </button>
        </div>
      </section>
    </div>
  )
}
