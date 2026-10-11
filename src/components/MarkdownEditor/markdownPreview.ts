export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[]; checked?: Array<boolean | null> }
  | {
      kind: 'table'
      headers: string[]
      rows: string[][]
      alignments: MarkdownTextAlignment[]
    }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'aligned'; align: MarkdownTextAlignment; blocks: MarkdownBlock[] }

export type MarkdownTextAlignment = 'left' | 'center' | 'right'

export interface PositionedMarkdownBlock {
  block: MarkdownBlock
  startLine: number
  endLine: number
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  return parsePositionedMarkdownBlocks(markdown).map(({ block }) => block)
}

export function parsePositionedMarkdownBlocks(markdown: string): PositionedMarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: PositionedMarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (!trimmed) {
      index += 1
      continue
    }

    const startIndex = index
    const aligned = parseAlignedBlock(lines, index)
    if (aligned) {
      blocks.push(positionedBlock(aligned.block, startIndex, aligned.nextIndex))
      index = aligned.nextIndex
      continue
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim()
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      const code = codeLines.join('\n').trimEnd()
      if (code.trim()) {
        blocks.push(positionedBlock({ kind: 'code', language, code }, startIndex, index))
      }
      continue
    }

    if (isMarkdownTable(lines, index)) {
      const headers = splitTableRow(lines[index])
      const alignments = splitTableRow(lines[index + 1]).map(tableCellAlignment)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && splitTableRow(lines[index]).length >= 2) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      blocks.push(positionedBlock({ kind: 'table', headers, rows, alignments }, startIndex, index))
      continue
    }

    if (isHorizontalRule(line)) {
      index += 1
      blocks.push(positionedBlock({ kind: 'rule' }, startIndex, index))
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (heading) {
      index += 1
      blocks.push(
        positionedBlock(
          {
            kind: 'heading',
            level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
            text: heading[2].trim(),
          },
          startIndex,
          index,
        ),
      )
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const next = /^\s*>\s?(.*)$/.exec(lines[index])
        if (!next) break
        quoteLines.push(next[1].trimEnd())
        index += 1
      }
      blocks.push(
        positionedBlock({ kind: 'quote', text: quoteLines.join('\n').trim() }, startIndex, index),
      )
      continue
    }

    const unordered = parseUnorderedListItem(line)
    if (unordered) {
      const items: string[] = []
      const checked: Array<boolean | null> = []
      while (index < lines.length) {
        const item = parseUnorderedListItem(lines[index])
        if (!item) break
        items.push(item.text)
        checked.push(item.checked)
        index += 1
      }
      const block: MarkdownBlock = checked.some((value) => value !== null)
        ? { kind: 'list', ordered: false, items, checked }
        : { kind: 'list', ordered: false, items }
      blocks.push(positionedBlock(block, startIndex, index))
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      const items: string[] = []
      while (index < lines.length) {
        const item = /^\s*\d+[.)]\s+(.+)$/.exec(lines[index])
        if (!item) break
        items.push(item[1].trim())
        index += 1
      }
      blocks.push(positionedBlock({ kind: 'list', ordered: true, items }, startIndex, index))
      continue
    }

    const paragraphLines = [line.trimEnd()]
    index += 1
    while (index < lines.length && lines[index].trim()) {
      if (isMarkdownBlockStart(lines, index)) break
      paragraphLines.push(lines[index].trimEnd())
      index += 1
    }
    blocks.push(
      positionedBlock(
        { kind: 'paragraph', text: paragraphLines.join('\n').trim() },
        startIndex,
        index,
      ),
    )
  }

  return blocks.length
    ? blocks
    : [
        {
          block: { kind: 'paragraph', text: markdown },
          startLine: 1,
          endLine: lines.length,
        },
      ]
}

function positionedBlock(
  block: MarkdownBlock,
  startIndex: number,
  nextIndex: number,
): PositionedMarkdownBlock {
  return {
    block,
    startLine: startIndex + 1,
    endLine: Math.max(startIndex + 1, nextIndex),
  }
}

function isMarkdownBlockStart(lines: string[], index: number) {
  const trimmed = lines[index].trim()
  return (
    isAlignedBlockStart(trimmed) ||
    trimmed.startsWith('```') ||
    isHorizontalRule(lines[index]) ||
    /^(#{1,6})\s+/.test(trimmed) ||
    /^\s*>/.test(lines[index]) ||
    /^\s*[-*+]\s+/.test(lines[index]) ||
    /^\s*\d+[.)]\s+/.test(lines[index]) ||
    isMarkdownTable(lines, index)
  )
}

function parseUnorderedListItem(line: string) {
  const match = /^\s*[-*+]\s+(.+)$/.exec(line)
  if (!match) return null
  const task = /^\[([ xX])\]\s+(.+)$/.exec(match[1])
  return task
    ? { text: task[2].trim(), checked: task[1].toLowerCase() === 'x' }
    : { text: match[1].trim(), checked: null }
}

function isHorizontalRule(line: string) {
  const compact = line.trim().replace(/\s/g, '')
  return /^(?:\*{3,}|-{3,}|_{3,})$/.test(compact)
}

function tableCellAlignment(cell: string): MarkdownTextAlignment {
  const compact = cell.replace(/\s/g, '')
  if (compact.startsWith(':') && compact.endsWith(':')) return 'center'
  if (compact.endsWith(':')) return 'right'
  return 'left'
}

function isAlignedBlockStart(line: string) {
  return /^<(?:div|p)\s+align\s*=\s*["']?(?:left|center|right)["']?\s*>/i.test(line)
}

function parseAlignedBlock(
  lines: string[],
  index: number,
): { block: MarkdownBlock; nextIndex: number } | null {
  const opening = /^\s*<(div|p)\s+align\s*=\s*["']?(left|center|right)["']?\s*>\s*(.*)$/i.exec(
    lines[index],
  )
  if (!opening) return null

  const tag = opening[1].toLowerCase()
  const align = opening[2].toLowerCase() as MarkdownTextAlignment
  const content: string[] = []
  const closing = new RegExp(`^(.*)<\\/${tag}>\\s*$`, 'i')
  const sameLineClose = closing.exec(opening[3])
  if (sameLineClose) {
    if (sameLineClose[1].trim()) content.push(sameLineClose[1])
    return {
      block: { kind: 'aligned', align, blocks: parseMarkdownBlocks(content.join('\n')) },
      nextIndex: index + 1,
    }
  }

  if (opening[3].trim()) content.push(opening[3])
  let nextIndex = index + 1
  while (nextIndex < lines.length) {
    const close = closing.exec(lines[nextIndex])
    if (close) {
      if (close[1].trim()) content.push(close[1])
      return {
        block: { kind: 'aligned', align, blocks: parseMarkdownBlocks(content.join('\n')) },
        nextIndex: nextIndex + 1,
      }
    }
    content.push(lines[nextIndex])
    nextIndex += 1
  }

  return null
}

function isMarkdownTable(lines: string[], index: number) {
  if (index + 1 >= lines.length) return false
  const header = splitTableRow(lines[index])
  const divider = splitTableRow(lines[index + 1])
  return (
    header.length >= 2 &&
    divider.length === header.length &&
    divider.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))
  )
}

function splitTableRow(line: string) {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return []
  const content = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false
  let inCode = false

  for (const ch of content) {
    if (escaped) {
      if (ch !== '|') current += '\\'
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      escaped = true
      continue
    }

    if (ch === '`') {
      inCode = !inCode
      current += ch
      continue
    }

    if (ch === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
      continue
    }

    current += ch
  }

  if (escaped) current += '\\'
  cells.push(current.trim())
  return cells
}
