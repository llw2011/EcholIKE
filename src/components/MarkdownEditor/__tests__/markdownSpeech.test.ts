import { describe, expect, it } from 'vitest'
import { markdownSpeechButtonLabel, markdownSpeechKey } from '../markdownSpeech'
import type { MarkdownDraft } from '../markdownDraft'
import type { MarkdownSpeechStateSnapshot } from '../../../lib/tauri'

function draft(overrides: Partial<MarkdownDraft> = {}): MarkdownDraft {
  return {
    id: 'draft-1',
    title: '标题',
    text: '正文',
    source: 'manual',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    dirty: true,
    ...overrides,
  }
}

describe('Markdown speech identity and labels', () => {
  it('keeps title changes out of the audio identity but invalidates text and voice changes', () => {
    const config = { available: true, voiceKey: 'alloy', speedMilli: 1000 }
    const original = markdownSpeechKey(draft(), config)

    expect(markdownSpeechKey(draft({ title: '另一个标题' }), config)).toEqual(original)
    expect(markdownSpeechKey(draft({ text: '另一份正文' }), config).contentRevision).not.toBe(
      original.contentRevision,
    )
    expect(markdownSpeechKey(draft(), { ...config, voiceKey: 'nova' }).voiceKey).toBe('nova')
  })

  it('maps persistent asset and task facts to the five user-facing button states', () => {
    const key = markdownSpeechKey(draft(), { available: true })
    const asset = {
      id: 8,
      key,
      fileName: 'draft.wav',
      directoryPath: 'C:\\Users\\TestUser\\Documents\\EcholIKE\\朗读音频',
      createdAt: '2026-07-21T00:00:00.000Z',
      byteLength: 12,
      durationMs: 900,
    }
    const base: MarkdownSpeechStateSnapshot = {
      key,
      task: null,
      currentAsset: null,
      latestAsset: null,
      directoryPath: asset.directoryPath,
    }

    expect(markdownSpeechButtonLabel(base, false, false)).toBe('生成朗读')
    expect(markdownSpeechButtonLabel(base, true, false)).toBe('生成中…')
    expect(
      markdownSpeechButtonLabel(
        {
          ...base,
          task: {
            key,
            ownerWindow: 'main',
            outcome: { status: 'running', leaseId: 3, completedChunks: 1, totalChunks: 4 },
          },
        },
        false,
        false,
      ),
    ).toBe('生成中 1/4…')
    expect(markdownSpeechButtonLabel({ ...base, currentAsset: asset }, false, false)).toBe(
      '生成完毕',
    )
    expect(markdownSpeechButtonLabel({ ...base, latestAsset: asset }, false, false)).toBe(
      '重新生成',
    )
    expect(markdownSpeechButtonLabel({ ...base, currentAsset: asset }, false, true)).toBe('朗读中…')
  })
})
