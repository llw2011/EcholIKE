export type MarkdownTextSelection = {
  from: number
  to: number
}

export type MarkdownAction =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'underline'
  | 'highlight'
  | 'inline-code'
  | 'code-block'
  | 'quote'
  | 'unordered-list'
  | 'ordered-list'
  | 'task-list'
  | 'link'
  | 'table'
  | 'horizontal-rule'
  | 'align-left'
  | 'align-center'
  | 'align-right'

export type MarkdownActionResult = {
  text: string
  selection: MarkdownTextSelection
}

export function applyMarkdownAction(
  text: string,
  selection: MarkdownTextSelection,
  action: MarkdownAction,
): MarkdownActionResult {
  const normalized = normalizeSelection(text, selection)

  if (action === 'heading-1') return applyHeading(text, normalized, 1)
  if (action === 'heading-2') return applyHeading(text, normalized, 2)
  if (action === 'heading-3') return applyHeading(text, normalized, 3)
  if (action === 'bold') return wrapSelection(text, normalized, '**', '**', '重点')
  if (action === 'italic') return wrapSelection(text, normalized, '*', '*', '强调')
  if (action === 'strikethrough') return wrapSelection(text, normalized, '~~', '~~', '删除内容')
  if (action === 'underline') return wrapSelection(text, normalized, '<u>', '</u>', '下划线')
  if (action === 'highlight') return wrapSelection(text, normalized, '<mark>', '</mark>', '高亮')
  if (action === 'inline-code') return wrapSelection(text, normalized, '`', '`', 'code')
  if (action === 'code-block') return insertCodeBlock(text, normalized)
  if (action === 'quote') return toggleLinePrefix(text, normalized, quoteLine, unquoteLine, '> ')
  if (action === 'unordered-list')
    return toggleLinePrefix(text, normalized, bulletLine, unbulletLine, '- ')
  if (action === 'ordered-list') return toggleOrderedList(text, normalized)
  if (action === 'task-list') return toggleTaskList(text, normalized)
  if (action === 'link') return insertLink(text, normalized)
  if (action === 'horizontal-rule') return insertHorizontalRule(text, normalized)
  if (action === 'align-left') return wrapAlignedBlock(text, normalized, 'left')
  if (action === 'align-center') return wrapAlignedBlock(text, normalized, 'center')
  if (action === 'align-right') return wrapAlignedBlock(text, normalized, 'right')
  return insertTable(text, normalized)
}

function normalizeSelection(text: string, selection: MarkdownTextSelection): MarkdownTextSelection {
  const from = clamp(Math.min(selection.from, selection.to), 0, text.length)
  const to = clamp(Math.max(selection.from, selection.to), 0, text.length)
  return { from, to }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function replaceRange(
  text: string,
  selection: MarkdownTextSelection,
  replacement: string,
  nextSelection?: MarkdownTextSelection,
): MarkdownActionResult {
  return {
    text: text.slice(0, selection.from) + replacement + text.slice(selection.to),
    selection: nextSelection ?? {
      from: selection.from,
      to: selection.from + replacement.length,
    },
  }
}

function wrapSelection(
  text: string,
  selection: MarkdownTextSelection,
  before: string,
  after: string,
  placeholder: string,
): MarkdownActionResult {
  const selected = text.slice(selection.from, selection.to)
  const content = selected || placeholder
  const replacement = `${before}${content}${after}`
  const contentStart = selection.from + before.length

  return replaceRange(text, selection, replacement, {
    from: contentStart,
    to: contentStart + content.length,
  })
}

function selectedLineRange(text: string, selection: MarkdownTextSelection) {
  const from = text.lastIndexOf('\n', Math.max(0, selection.from - 1)) + 1
  let to = selection.to

  if (to > selection.from && text[to - 1] === '\n') {
    to -= 1
  }

  const nextBreak = text.indexOf('\n', to)
  return {
    from,
    to: nextBreak === -1 ? text.length : nextBreak,
  }
}

function replaceSelectedLines(
  text: string,
  selection: MarkdownTextSelection,
  transform: (lines: string[]) => string[],
): MarkdownActionResult {
  const range = selectedLineRange(text, selection)
  const original = text.slice(range.from, range.to)
  const replacement = transform(original.split('\n')).join('\n')

  return replaceRange(text, range, replacement, {
    from: range.from,
    to: range.from + replacement.length,
  })
}

function applyHeading(
  text: string,
  selection: MarkdownTextSelection,
  level: 1 | 2 | 3,
): MarkdownActionResult {
  const marker = '#'.repeat(level)

  return replaceSelectedLines(text, selection, (lines) => {
    const nonEmpty = lines.filter((line) => line.trim())
    const allTarget = nonEmpty.length > 0 && nonEmpty.every((line) => headingLevel(line) === level)

    return lines.map((line) => {
      if (!line.trim()) return line
      const content = line.replace(/^\s*#{1,6}\s+/, '').trim()
      return allTarget ? content : `${marker} ${content}`
    })
  })
}

function headingLevel(line: string) {
  const match = /^\s*(#{1,6})\s+/.exec(line)
  return match ? match[1].length : 0
}

function toggleLinePrefix(
  text: string,
  selection: MarkdownTextSelection,
  add: (line: string, index: number) => string,
  remove: (line: string) => string,
  emptyFallback: string,
): MarkdownActionResult {
  if (selection.from === selection.to && text.length === 0) {
    return replaceRange(text, selection, emptyFallback, {
      from: emptyFallback.length,
      to: emptyFallback.length,
    })
  }

  return replaceSelectedLines(text, selection, (lines) => {
    const nonEmpty = lines.filter((line) => line.trim())
    const allPrefixed = nonEmpty.length > 0 && nonEmpty.every((line) => remove(line) !== line)

    return lines.map((line, index) => {
      if (!line.trim()) return line
      return allPrefixed ? remove(line) : add(line, index)
    })
  })
}

function quoteLine(line: string) {
  return `> ${line.replace(/^>\s?/, '')}`
}

function unquoteLine(line: string) {
  return line.replace(/^>\s?/, '')
}

function bulletLine(line: string) {
  return `- ${line.replace(/^\s*[-*+]\s+/, '').trim()}`
}

function unbulletLine(line: string) {
  return line.replace(/^\s*[-*+]\s+/, '')
}

function toggleOrderedList(text: string, selection: MarkdownTextSelection): MarkdownActionResult {
  if (selection.from === selection.to && text.length === 0) {
    return replaceRange(text, selection, '1. ', { from: 3, to: 3 })
  }

  return replaceSelectedLines(text, selection, (lines) => {
    const nonEmpty = lines.filter((line) => line.trim())
    const allOrdered = nonEmpty.length > 0 && nonEmpty.every((line) => /^\s*\d+[.)]\s+/.test(line))
    let counter = 1

    return lines.map((line) => {
      if (!line.trim()) return line
      if (allOrdered) return line.replace(/^\s*\d+[.)]\s+/, '')
      const content = line.replace(/^\s*\d+[.)]\s+/, '').trim()
      return `${counter++}. ${content}`
    })
  })
}

function toggleTaskList(text: string, selection: MarkdownTextSelection): MarkdownActionResult {
  if (selection.from === selection.to && text.length === 0) {
    return replaceRange(text, selection, '- [ ] ', { from: 6, to: 6 })
  }

  return replaceSelectedLines(text, selection, (lines) => {
    const nonEmpty = lines.filter((line) => line.trim())
    const allTasks =
      nonEmpty.length > 0 && nonEmpty.every((line) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line))

    return lines.map((line) => {
      if (!line.trim()) return line
      if (allTasks) return line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
      const content = line
        .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .trim()
      return `- [ ] ${content}`
    })
  })
}

function insertLink(text: string, selection: MarkdownTextSelection): MarkdownActionResult {
  const selected = text.slice(selection.from, selection.to)
  const label = selected || '链接文本'
  const url = 'https://example.com'
  const replacement = `[${label}](${url})`
  const urlStart = selection.from + label.length + 3

  return replaceRange(text, selection, replacement, {
    from: urlStart,
    to: urlStart + url.length,
  })
}

function insertCodeBlock(text: string, selection: MarkdownTextSelection): MarkdownActionResult {
  const selected = text.slice(selection.from, selection.to)
  const content = selected || '代码'
  const prefix = blockPrefix(text, selection.from)
  const suffix = blockSuffix(text, selection.to)
  const replacement = `${prefix}\`\`\`text\n${content}\n\`\`\`${suffix}`
  const contentStart = selection.from + prefix.length + '```text\n'.length

  return replaceRange(text, selection, replacement, {
    from: contentStart,
    to: contentStart + content.length,
  })
}

function insertTable(text: string, selection: MarkdownTextSelection): MarkdownActionResult {
  const table = ['| 字段 | 值 |', '| --- | --- |', '| 名称 | 内容 |'].join('\n')
  const prefix = blockPrefix(text, selection.from)
  const suffix = blockSuffix(text, selection.to)
  const replacement = `${prefix}${table}${suffix}`

  return replaceRange(text, selection, replacement, {
    from: selection.from + prefix.length,
    to: selection.from + prefix.length + table.length,
  })
}

function insertHorizontalRule(
  text: string,
  selection: MarkdownTextSelection,
): MarkdownActionResult {
  const insertion = { from: selection.to, to: selection.to }
  const prefix = blockPrefix(text, insertion.from)
  const suffix = blockSuffix(text, insertion.to)
  const replacement = `${prefix}---${suffix}`
  const cursor = insertion.from + replacement.length

  return replaceRange(text, insertion, replacement, { from: cursor, to: cursor })
}

function wrapAlignedBlock(
  text: string,
  selection: MarkdownTextSelection,
  alignment: 'left' | 'center' | 'right',
): MarkdownActionResult {
  const selected = text.slice(selection.from, selection.to)
  const content = selected || '对齐文本'
  const prefix = blockPrefix(text, selection.from)
  const suffix = blockSuffix(text, selection.to)
  const opening = `<div align="${alignment}">\n`
  const replacement = `${prefix}${opening}${content}\n</div>${suffix}`
  const contentStart = selection.from + prefix.length + opening.length

  return replaceRange(text, selection, replacement, {
    from: contentStart,
    to: contentStart + content.length,
  })
}

function blockPrefix(text: string, from: number) {
  if (from === 0) return ''
  if (text.slice(Math.max(0, from - 2), from) === '\n\n') return ''
  if (text[from - 1] === '\n') return '\n'
  return '\n\n'
}

function blockSuffix(text: string, to: number) {
  if (to >= text.length) return '\n'
  if (text.slice(to, to + 2) === '\n\n') return ''
  if (text[to] === '\n') return '\n'
  return '\n\n'
}
