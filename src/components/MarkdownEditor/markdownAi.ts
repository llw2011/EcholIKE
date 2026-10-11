import type { MarkdownTextSelection } from './markdownActions'
import type { ScenePreset } from '../../lib/scenePresets'

export type MarkdownAiAction = 'polish' | 'translate' | 'summarize'
export type MarkdownAiApplyMode = 'replace' | 'insert-below' | 'append'

export interface MarkdownAiRequest {
  draftId?: string
  draftRevision?: string
  action: MarkdownAiAction
  text: string
  fullText: string
  selection: MarkdownTextSelection
  usedFullDocument: boolean
  title: string
  scenePreset?: ScenePreset | null
}

export interface MarkdownAiResult extends MarkdownAiRequest {
  output: string
}

export type MarkdownTranslationTarget = 'zh' | 'en'

export function markdownAiActionLabel(action: MarkdownAiAction) {
  const labels: Record<MarkdownAiAction, string> = {
    polish: '润色',
    translate: '翻译',
    summarize: '总结',
  }
  return labels[action]
}

export function getMarkdownAiTarget(fullText: string, selection: MarkdownTextSelection) {
  const from = Math.max(0, Math.min(selection.from, selection.to, fullText.length))
  const to = Math.max(0, Math.min(Math.max(selection.from, selection.to), fullText.length))
  const selectedText = fullText.slice(from, to)

  if (selectedText.trim()) {
    return {
      text: selectedText,
      selection: { from, to },
      usedFullDocument: false,
    }
  }

  return {
    text: fullText,
    selection: { from: 0, to: fullText.length },
    usedFullDocument: true,
  }
}

export function buildMarkdownAiPrompt(request: MarkdownAiRequest) {
  const actionInstruction: Record<Exclude<MarkdownAiAction, 'translate'>, string> = {
    polish: '润色下面的 Markdown 文本，保持原意，修正表达、错别字和明显 OCR 噪声。',
    summarize: '总结下面的 Markdown 文本，输出结构清晰、可直接放回文档的 Markdown 摘要。',
  }
  const target = markdownTranslationTarget(request.text)
  const instruction =
    request.action === 'translate'
      ? `必须把下面的 Markdown 文本完整翻译成${target === 'zh' ? '简体中文' : '自然、准确的英文'}。禁止原样返回原文，禁止只改写不翻译。`
      : actionInstruction[request.action]

  return [
    instruction,
    '保留合理的 Markdown 结构。',
    '只输出处理后的 Markdown 内容，不要解释过程，不要加寒暄。',
    request.usedFullDocument ? '处理范围：全文。' : '处理范围：用户选区。',
    '',
    request.text,
  ].join('\n')
}

export function buildMarkdownTranslationRetryPrompt(request: MarkdownAiRequest) {
  const target = markdownTranslationTarget(request.text)
  return [
    '上一次输出未通过翻译检查。请重新执行，不要解释失败原因。',
    `把 <source> 中的全部内容翻译成${target === 'zh' ? '简体中文' : '英文'}。`,
    target === 'zh'
      ? '最终内容必须以中文表达，专有名词、数字和代码可以保留原样。'
      : '最终内容必须以自然英文表达，专有名词、数字和代码可以保留原样。',
    '保留 Markdown 结构，只输出翻译结果。禁止复述原文，禁止输出“翻译如下”等前缀。',
    '',
    '<source>',
    request.text,
    '</source>',
  ].join('\n')
}

export function markdownTranslationTarget(text: string): MarkdownTranslationTarget {
  const chinese = countMatches(text, /[\u3400-\u9fff]/g)
  const latin = countMatches(text, /[A-Za-z]/g)
  return chinese >= Math.max(2, Math.ceil(latin * 0.25)) ? 'en' : 'zh'
}

function countMatches(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0
}

export function applyMarkdownAiResult(
  fullText: string,
  result: MarkdownAiResult,
  mode: MarkdownAiApplyMode,
) {
  const output = result.output.trim()
  const range = result.selection

  if (mode === 'replace') {
    return replaceRange(fullText, range, output)
  }

  if (mode === 'append') {
    const prefix = fullText.trim() ? `${fullText.trimEnd()}\n\n` : ''
    const nextText = `${prefix}${output}`
    const from = prefix.length
    return {
      text: nextText,
      selection: { from, to: nextText.length },
    }
  }

  const insertAt = range.to
  const prefix = blockPrefix(fullText, insertAt)
  const suffix = blockSuffix(fullText, insertAt)
  const insertion = `${prefix}${output}${suffix}`
  return replaceRange(fullText, { from: insertAt, to: insertAt }, insertion, {
    from: insertAt + prefix.length,
    to: insertAt + prefix.length + output.length,
  })
}

function replaceRange(
  text: string,
  range: MarkdownTextSelection,
  replacement: string,
  nextSelection?: MarkdownTextSelection,
) {
  return {
    text: text.slice(0, range.from) + replacement + text.slice(range.to),
    selection: nextSelection ?? {
      from: range.from,
      to: range.from + replacement.length,
    },
  }
}

function blockPrefix(text: string, index: number) {
  if (index === 0) return ''
  if (text.slice(Math.max(0, index - 2), index) === '\n\n') return ''
  if (text[index - 1] === '\n') return '\n'
  return '\n\n'
}

function blockSuffix(text: string, index: number) {
  if (index >= text.length) return ''
  if (text.slice(index, index + 2) === '\n\n') return ''
  if (text[index] === '\n') return '\n'
  return '\n\n'
}
