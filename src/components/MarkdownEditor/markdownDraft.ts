export type MarkdownEditorSource =
  | 'ocr'
  | 'upload_ocr'
  | 'screen_ocr'
  | 'ai_answer'
  | 'history'
  | 'voice'
  | 'file'
  | 'manual'

export interface MarkdownDraft {
  id: string
  title: string
  text: string
  source: MarkdownEditorSource
  sourceName?: string
  createdAt: string
  updatedAt: string
  dirty: boolean
}

export const RECENT_MARKDOWN_DRAFT_STORAGE_KEY = 'echolike.markdownEditor.recentDraft.v1'
export const ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY = 'echolike.markdownEditor.activeDraft.v1'
export const MARKDOWN_VOICE_APPEND_STORAGE_KEY = 'echolike.markdownEditor.voiceAppend.v1'

const markdownEditorSources: MarkdownEditorSource[] = [
  'ocr',
  'upload_ocr',
  'screen_ocr',
  'ai_answer',
  'history',
  'voice',
  'file',
  'manual',
]

export function createMarkdownFileDraft(
  fileName: string,
  text: string,
  now = new Date().toISOString(),
  id = `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
): MarkdownDraft {
  const normalizedName = fileName.trim().replace(/^.*[\\/]/, '') || 'Markdown 文稿.md'
  const title = normalizedName.replace(/\.[^.]+$/, '').trim() || 'Markdown 文稿'

  return {
    id,
    title,
    text,
    source: 'file',
    sourceName: normalizedName,
    createdAt: now,
    updatedAt: now,
    dirty: false,
  }
}

export function markdownSourceLabel(source: MarkdownEditorSource) {
  const labels: Record<MarkdownEditorSource, string> = {
    ocr: 'OCR',
    upload_ocr: '附件 OCR',
    screen_ocr: '屏幕 OCR',
    ai_answer: 'AI 回答',
    history: '最近历史',
    voice: '语音输入',
    file: '本地文件',
    manual: '手动文稿',
  }

  return labels[source]
}

export function markdownDraftStats(text: string) {
  return {
    lines: text ? text.split(/\r?\n/).length : 0,
    nonEmptyLines: text.split(/\r?\n/).filter((line) => line.trim()).length,
    chars: text.length,
  }
}

export function appendMarkdownText(currentText: string, incomingText: string) {
  const incoming = incomingText.trim()
  if (!incoming) return currentText
  if (!currentText.trim()) return incoming
  return `${currentText.trimEnd()}\n\n${incoming}`
}

export function parseMarkdownVoiceAppendEnabled(raw: string | null) {
  return raw !== 'false'
}

export function serializeRecentMarkdownDraft(draft: MarkdownDraft) {
  return serializeMarkdownDraft({ ...draft, dirty: true })
}

export function serializeMarkdownDraft(draft: MarkdownDraft) {
  return JSON.stringify({
    schemaVersion: 1,
    draft: {
      id: draft.id,
      title: draft.title,
      text: draft.text,
      source: draft.source,
      sourceName: draft.sourceName,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      dirty: draft.dirty,
    },
  })
}

export function parseRecentMarkdownDraft(raw: string | null): MarkdownDraft | null {
  const draft = parseMarkdownDraft(raw)
  return draft ? { ...draft, dirty: true } : null
}

export function parseMarkdownDraft(raw: string | null): MarkdownDraft | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.draft)) return null

    const draft = parsed.draft
    if (
      typeof draft.id !== 'string' ||
      typeof draft.title !== 'string' ||
      typeof draft.text !== 'string' ||
      typeof draft.createdAt !== 'string' ||
      typeof draft.updatedAt !== 'string' ||
      !isMarkdownEditorSource(draft.source) ||
      !draft.text.trim()
    ) {
      return null
    }

    return {
      id: draft.id,
      title: draft.title,
      text: draft.text,
      source: draft.source,
      sourceName: typeof draft.sourceName === 'string' ? draft.sourceName : undefined,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      dirty: typeof draft.dirty === 'boolean' ? draft.dirty : true,
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isMarkdownEditorSource(value: unknown): value is MarkdownEditorSource {
  return typeof value === 'string' && markdownEditorSources.includes(value as MarkdownEditorSource)
}
