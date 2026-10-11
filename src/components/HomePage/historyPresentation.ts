import type { HistoryEntry } from '../../stores/appStore'

function sanitizeHistoryText(text: string) {
  let cleaned = ''
  for (const ch of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')) {
    const code = ch.charCodeAt(0)
    const isHiddenControl =
      code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
    cleaned += isHiddenControl ? ' ' : ch
  }
  return cleaned.trim()
}

export function normalizeHistoryPreview(text: string) {
  return sanitizeHistoryText(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, ' / ')
    .trim()
}

export function hasReadableHistoryText(text: string) {
  const normalized = normalizeHistoryPreview(text)
  return /[0-9A-Za-z\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(normalized)
}

export function readableAppName(appName: string) {
  const raw = appName.trim()
  if (!raw) return '未知应用'
  const withoutExe = raw.replace(/\.exe$/i, '')
  const knownNames: Record<string, string> = {
    chrome: 'Chrome',
    msedge: 'Edge',
    firefox: 'Firefox',
    notepad: '记事本',
    notepad3: 'Notepad3',
    explorer: '资源管理器',
    code: 'VS Code',
  }
  return knownNames[withoutExe.toLowerCase()] ?? withoutExe
}

export function formatHistoryTime(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function historyEntryText(entry: HistoryEntry) {
  return sanitizeHistoryText(entry.polished_text.trim() || entry.raw_text.trim())
}
