import { FileText, Loader2, X } from 'lucide-react'
import type { MarkdownDraft } from '../MarkdownEditor/markdownDraft'
import type { MarkdownOpenMode, MarkdownOpenRequest } from './useMarkdownWorkspace'

export function MarkdownDraftRestoreDialog({
  draft,
  onDismiss,
  onRestore,
  onDiscard,
}: {
  draft: MarkdownDraft
  onDismiss: () => void
  onRestore: () => void
  onDiscard: () => void
}) {
  return (
    <div className="echo-dialog-backdrop" role="presentation">
      <section
        className="echo-dialog echo-markdown-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="echo-markdown-restore-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
          <div className="echo-screen-dialog-heading">
            <span className="echo-screen-dialog-icon" aria-hidden="true">
              <FileText size={18} />
            </span>
            <div>
              <strong id="echo-markdown-restore-title">恢复 Markdown 草稿</strong>
              <span>{draft.title}</span>
            </div>
          </div>
          <button type="button" className="echo-icon-button" aria-label="关闭" onClick={onDismiss}>
            <X size={17} />
          </button>
        </div>
        <div className="echo-dialog-body">
          <section className="echo-screen-state-panel">
            <FileText size={20} />
            <div>
              <strong>发现上次未保存的草稿</strong>
              <p>可以恢复继续编辑，也可以明确丢弃。</p>
            </div>
          </section>
        </div>
        <div className="echo-dialog-actions">
          <button type="button" className="echo-button echo-button--danger" onClick={onDiscard}>
            丢弃草稿
          </button>
          <button type="button" className="echo-button echo-button--primary" onClick={onRestore}>
            恢复草稿
          </button>
        </div>
      </section>
    </div>
  )
}

export function MarkdownDraftConflictDialog({
  request,
  onCancel,
  onApply,
}: {
  request: MarkdownOpenRequest
  onCancel: () => void
  onApply: (request: MarkdownOpenRequest, mode: MarkdownOpenMode) => void | Promise<void>
}) {
  return (
    <div className="echo-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="echo-dialog echo-markdown-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="echo-markdown-conflict-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
          <div className="echo-screen-dialog-heading">
            <span className="echo-screen-dialog-icon" aria-hidden="true">
              <FileText size={18} />
            </span>
            <div>
              <strong id="echo-markdown-conflict-title">处理当前 Markdown 草稿</strong>
              <span>{request.title}</span>
            </div>
          </div>
          <button type="button" className="echo-icon-button" aria-label="关闭" onClick={onCancel}>
            <X size={17} />
          </button>
        </div>
        <div className="echo-dialog-body">
          <section className="echo-screen-state-panel">
            <FileText size={20} />
            <div>
              <strong>当前草稿有未保存修改</strong>
              <p>选择如何处理这次发送来的内容。</p>
            </div>
          </section>
        </div>
        <div className="echo-dialog-actions">
          <button
            type="button"
            className="echo-button"
            onClick={() => void onApply(request, 'append')}
          >
            追加到当前
          </button>
          <button
            type="button"
            className="echo-button"
            onClick={() => void onApply(request, 'replace')}
          >
            替换当前
          </button>
          <button
            type="button"
            className="echo-button echo-button--primary"
            onClick={() => void onApply(request, 'new')}
          >
            新建草稿
          </button>
          <button type="button" className="echo-button" onClick={onCancel}>
            取消
          </button>
        </div>
      </section>
    </div>
  )
}

export function MarkdownEditorLoadingDialog() {
  return (
    <section
      className="echo-dialog echo-markdown-conflict-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="正在打开 Markdown 编辑器"
    >
      <div className="echo-dialog-body">
        <section className="echo-screen-state-panel">
          <Loader2 size={20} className="echo-spin" />
          <div>
            <strong>正在打开编辑器</strong>
            <p>Markdown 工作区加载中。</p>
          </div>
        </section>
      </div>
    </section>
  )
}
