import { describe, expect, it } from 'vitest'
import {
  createMarkdownFileDraft,
  parseMarkdownDraft,
  parseRecentMarkdownDraft,
  serializeMarkdownDraft,
  serializeRecentMarkdownDraft,
  type MarkdownDraft,
} from '../markdownDraft'

function makeDraft(overrides: Partial<MarkdownDraft> = {}): MarkdownDraft {
  return {
    id: 'draft-1',
    title: '恢复草稿',
    text: '# 标题\n\n正文',
    source: 'manual',
    sourceName: '本地草稿',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:01:00.000Z',
    dirty: true,
    ...overrides,
  }
}

describe('markdownDraft persistence', () => {
  it('round-trips a recent dirty draft', () => {
    const draft = makeDraft()

    expect(parseRecentMarkdownDraft(serializeRecentMarkdownDraft(draft))).toEqual(draft)
  })

  it('restores saved drafts as dirty even if stale payload says otherwise', () => {
    const raw = serializeRecentMarkdownDraft(makeDraft({ dirty: false }))

    expect(parseRecentMarkdownDraft(raw)).toEqual(expect.objectContaining({ dirty: true }))
  })

  it('rejects invalid, empty, or unknown-source payloads', () => {
    expect(parseRecentMarkdownDraft('not-json')).toBeNull()
    expect(
      parseRecentMarkdownDraft(serializeRecentMarkdownDraft(makeDraft({ text: '   ' }))),
    ).toBeNull()
    expect(
      parseRecentMarkdownDraft(
        JSON.stringify({
          schemaVersion: 1,
          draft: { ...makeDraft(), source: 'notes' },
        }),
      ),
    ).toBeNull()
  })

  it('creates and round-trips a clean draft from an opened Markdown text file', () => {
    const draft = createMarkdownFileDraft(
      'meeting.notes.markdown',
      '# 会议纪要\n\n- 待办',
      '2026-07-20T02:00:00.000Z',
      'file-draft-1',
    )

    expect(draft).toEqual({
      id: 'file-draft-1',
      title: 'meeting.notes',
      text: '# 会议纪要\n\n- 待办',
      source: 'file',
      sourceName: 'meeting.notes.markdown',
      createdAt: '2026-07-20T02:00:00.000Z',
      updatedAt: '2026-07-20T02:00:00.000Z',
      dirty: false,
    })
    expect(parseMarkdownDraft(serializeMarkdownDraft(draft))).toEqual(draft)
  })
})
