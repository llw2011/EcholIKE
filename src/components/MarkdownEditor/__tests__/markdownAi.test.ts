import { describe, expect, it } from 'vitest'
import {
  applyMarkdownAiResult,
  buildMarkdownAiPrompt,
  buildMarkdownTranslationRetryPrompt,
  getMarkdownAiTarget,
  type MarkdownAiResult,
} from '../markdownAi'

describe('markdownAi', () => {
  it('uses selected text when a non-empty selection exists', () => {
    expect(getMarkdownAiTarget('一二三四', { from: 1, to: 3 })).toEqual({
      text: '二三',
      selection: { from: 1, to: 3 },
      usedFullDocument: false,
    })
  })

  it('falls back to the full document when there is no selected text', () => {
    expect(getMarkdownAiTarget('全文', { from: 1, to: 1 })).toEqual({
      text: '全文',
      selection: { from: 0, to: 2 },
      usedFullDocument: true,
    })
  })

  it('builds action prompts that preserve Markdown-only output', () => {
    expect(
      buildMarkdownAiPrompt({
        action: 'summarize',
        title: '文稿',
        text: '# 标题',
        fullText: '# 标题',
        selection: { from: 0, to: 4 },
        usedFullDocument: true,
      }),
    ).toContain('只输出处理后的 Markdown 内容')
  })

  it('makes translation mandatory and provides a stricter retry prompt', () => {
    const request = makeResult({
      action: 'translate',
      text: 'Please send the final report tomorrow.',
      fullText: 'Please send the final report tomorrow.',
    })

    expect(buildMarkdownAiPrompt(request)).toContain('完整翻译成简体中文')
    expect(buildMarkdownTranslationRetryPrompt(request)).toContain('上一次输出未通过翻译检查')
  })

  it('applies an AI result by replacing the selected range', () => {
    expect(
      applyMarkdownAiResult(
        'hello world',
        makeResult({ output: 'Echo', selection: { from: 6, to: 11 } }),
        'replace',
      ),
    ).toEqual({
      text: 'hello Echo',
      selection: { from: 6, to: 10 },
    })
  })

  it('can insert below or append AI output without merging paragraphs', () => {
    const result = makeResult({ output: 'AI 输出', selection: { from: 0, to: 2 } })

    expect(applyMarkdownAiResult('原文', result, 'insert-below')).toEqual({
      text: '原文\n\nAI 输出',
      selection: { from: 4, to: 9 },
    })
    expect(applyMarkdownAiResult('原文', result, 'append')).toEqual({
      text: '原文\n\nAI 输出',
      selection: { from: 4, to: 9 },
    })
  })
})

function makeResult(overrides: Partial<MarkdownAiResult> = {}): MarkdownAiResult {
  return {
    action: 'polish',
    title: '文稿',
    text: 'world',
    fullText: 'hello world',
    selection: { from: 6, to: 11 },
    usedFullDocument: false,
    output: 'Echo',
    ...overrides,
  }
}
