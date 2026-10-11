import { AlertTriangle, FileText, Loader2, Trash2, X } from 'lucide-react'
import type { HistoryEntry, HistoryMutationKind, HistoryMutationState } from '../../stores/appStore'
import { Tooltip } from '../Tooltip'
import {
  formatHistoryTime,
  hasReadableHistoryText,
  historyEntryText,
  normalizeHistoryPreview,
  readableAppName,
} from './historyPresentation'

export type HistoryDeleteRequest = {
  kind: HistoryMutationKind
  ids: number[]
}

export function RecentHistoryPanel({
  entries,
  selectedIds,
  selectionStable,
  mutation,
  onSendToEditor,
  onSelectionChange,
  onRequestDelete,
  onDismissError,
}: {
  entries: HistoryEntry[]
  selectedIds: ReadonlySet<number>
  selectionStable: boolean
  mutation: HistoryMutationState
  onSendToEditor: (entry: HistoryEntry) => void
  onSelectionChange: (id: number, selected: boolean) => void
  onRequestDelete: (kind: HistoryMutationKind, ids: number[]) => void
  onDismissError: () => void
}) {
  const selectedEntryIds = Array.from(selectedIds).sort((left, right) => left - right)
  const selectedCount = selectedEntryIds.length
  const busy = mutation.status === 'running'
  const deleteKind: HistoryMutationKind = selectedCount > 0 ? 'selected' : 'all'

  return (
    <section className="echo-panel echo-history-panel" aria-label="最近历史">
      <div className="echo-history-panel-head">
        <div className="echo-panel-title">
          <span className="echo-status-dot" />
          <div>
            <strong>最近历史</strong>
            <small>可继续整理为 Markdown</small>
          </div>
        </div>
        <button
          type="button"
          className="echo-button echo-button--danger echo-history-delete-button"
          onClick={() => onRequestDelete(deleteKind, selectedEntryIds)}
          disabled={busy || !selectionStable}
          aria-busy={busy}
        >
          {busy ? <Loader2 size={15} className="echo-spin" /> : <Trash2 size={15} />}
          {busy ? '正在删除' : selectedCount > 0 ? '删除选中' : '删除所有'}
        </button>
      </div>
      {mutation.status === 'error' && mutation.error ? (
        <div className="echo-history-error echo-panel-alert echo-panel-alert--warn" role="alert">
          <AlertTriangle size={14} />
          <span>{mutation.error}</span>
          <button
            type="button"
            className="echo-icon-button"
            aria-label="关闭历史删除错误"
            onClick={onDismissError}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      <div className="echo-history-list">
        {entries.map((entry, index) => {
          const text = historyEntryText(entry)
          const readable = hasReadableHistoryText(text)
          const preview = readable ? normalizeHistoryPreview(text) : '这条历史没有可读文本'
          const meta = [readableAppName(entry.app_name), formatHistoryTime(entry.created_at)]
            .filter(Boolean)
            .join(' · ')
          return (
            <article className="echo-history-item" key={entry.id}>
              <div className="echo-history-item-copy">
                <Tooltip content={preview}>
                  <strong>{preview}</strong>
                </Tooltip>
                <Tooltip content={meta || '未知来源'}>
                  <span>{meta || '未知来源'}</span>
                </Tooltip>
                <div className="echo-history-item-actions">
                  <button
                    type="button"
                    className="echo-button echo-history-send-button"
                    onClick={() => onSendToEditor(entry)}
                    disabled={!readable}
                  >
                    <FileText size={14} />
                    发送到编辑器
                  </button>
                </div>
              </div>
              <label
                className="echo-history-selector"
                title={selectedIds.has(entry.id) ? '取消选择' : '选择此记录'}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(entry.id)}
                  onChange={(event) => onSelectionChange(entry.id, event.currentTarget.checked)}
                  disabled={busy || !selectionStable}
                  aria-label={`选择第 ${index + 1} 条历史记录`}
                />
              </label>
            </article>
          )
        })}
      </div>
    </section>
  )
}

export function HistoryDeleteConfirmDialog({
  request,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  request: HistoryDeleteRequest
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const selected = request.kind === 'selected'
  const title = selected ? `删除选中的 ${request.ids.length} 条历史？` : '删除所有历史记录？'
  const description = selected
    ? '确认后，这些记录会从本机历史数据库永久删除。'
    : '确认后，本机全部历史记录都会永久删除，包括当前列表未显示的记录。'

  return (
    <div className="echo-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="echo-dialog echo-history-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="echo-history-delete-title"
        aria-describedby="echo-history-delete-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
          <div className="echo-screen-dialog-heading">
            <span className="echo-screen-dialog-icon echo-screen-dialog-icon--error" aria-hidden>
              <AlertTriangle size={18} />
            </span>
            <div>
              <strong id="echo-history-delete-title">{title}</strong>
              <span>此操作无法撤销</span>
            </div>
          </div>
          <button
            type="button"
            className="echo-icon-button"
            aria-label="关闭历史删除确认"
            onClick={onCancel}
            disabled={busy}
          >
            <X size={17} />
          </button>
        </div>
        <div className="echo-dialog-body">
          <section className="echo-screen-state-panel echo-screen-state-panel--error">
            <Trash2 size={20} />
            <div>
              <strong>{selected ? '只删除当前选中的记录' : '清空本机历史'}</strong>
              <p id="echo-history-delete-description">{description}</p>
            </div>
          </section>
          {error ? (
            <p className="echo-history-delete-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="echo-dialog-actions">
          <button
            type="button"
            className="echo-button"
            onClick={onCancel}
            disabled={busy}
            autoFocus
          >
            取消
          </button>
          <button
            type="button"
            className="echo-button echo-button--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 size={16} className="echo-spin" /> : <Trash2 size={16} />}
            {busy ? '正在删除' : selected ? '删除选中' : '删除所有'}
          </button>
        </div>
      </section>
    </div>
  )
}
