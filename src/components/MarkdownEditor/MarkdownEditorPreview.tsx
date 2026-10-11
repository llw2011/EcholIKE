import { useEffect, useRef, type ReactNode } from 'react'
import {
  parsePositionedMarkdownBlocks,
  type MarkdownBlock,
  type PositionedMarkdownBlock,
} from './markdownPreview'
import {
  createMarkdownEditorPreviewScrollSurface,
  type MarkdownScrollSurface,
} from './markdownScrollSync'

export interface MarkdownEditorPreviewProps {
  text: string
  onScrollSurfaceChange?: (surface: MarkdownScrollSurface | null) => void
}

export function MarkdownEditorPreview({ text, onScrollSurfaceChange }: MarkdownEditorPreviewProps) {
  const blocks = parsePositionedMarkdownBlocks(text)
  const viewRef = useRef<HTMLDivElement | null>(null)
  const lineCountRef = useRef(markdownSourceLineCount(text))
  const onScrollSurfaceChangeRef = useRef(onScrollSurfaceChange)
  lineCountRef.current = markdownSourceLineCount(text)

  useEffect(() => {
    onScrollSurfaceChangeRef.current = onScrollSurfaceChange
  }, [onScrollSurfaceChange])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    onScrollSurfaceChangeRef.current?.(
      createMarkdownEditorPreviewScrollSurface(view, () => lineCountRef.current),
    )
    return () => onScrollSurfaceChangeRef.current?.(null)
  }, [])

  return (
    <div
      ref={viewRef}
      className="echo-markdown-view"
      tabIndex={onScrollSurfaceChange ? 0 : undefined}
    >
      {renderPositionedBlocks(blocks)}
    </div>
  )
}

function markdownSourceLineCount(text: string) {
  return text.replace(/\r\n/g, '\n').split('\n').length
}

function renderPositionedBlocks(blocks: PositionedMarkdownBlock[]) {
  return blocks.map(({ block, startLine, endLine }, index) => (
    <MarkdownBlockView
      key={`${block.kind}-${startLine}-${endLine}-${index}`}
      block={block}
      source={{ startLine, endLine }}
    />
  ))
}

function renderBlocks(blocks: MarkdownBlock[]) {
  return blocks.map((block, index) => (
    <MarkdownBlockView key={`${block.kind}-${index}`} block={block} />
  ))
}

function MarkdownBlockView({
  block,
  source,
}: {
  block: MarkdownBlock
  source?: Pick<PositionedMarkdownBlock, 'startLine' | 'endLine'>
}) {
  const sourceAttributes = source
    ? {
        'data-markdown-source-start': source.startLine,
        'data-markdown-source-end': source.endLine,
      }
    : {}

  if (block.kind === 'heading') {
    const content = renderInline(block.text)
    if (block.level === 1) return <h1 {...sourceAttributes}>{content}</h1>
    if (block.level === 2) return <h2 {...sourceAttributes}>{content}</h2>
    if (block.level === 3) return <h3 {...sourceAttributes}>{content}</h3>
    if (block.level === 4) return <h4 {...sourceAttributes}>{content}</h4>
    if (block.level === 5) return <h5 {...sourceAttributes}>{content}</h5>
    return <h6 {...sourceAttributes}>{content}</h6>
  }

  if (block.kind === 'list') {
    const ListTag = block.ordered ? 'ol' : 'ul'
    return (
      <ListTag
        className={block.checked ? 'echo-markdown-task-list' : undefined}
        {...sourceAttributes}
      >
        {block.items.map((item, index) => (
          <li key={index}>
            {block.checked?.[index] !== null && block.checked?.[index] !== undefined ? (
              <input
                type="checkbox"
                checked={block.checked[index] === true}
                readOnly
                disabled
                aria-label={block.checked[index] ? '已完成' : '未完成'}
              />
            ) : null}
            <span>{renderInline(item)}</span>
          </li>
        ))}
      </ListTag>
    )
  }

  if (block.kind === 'table') {
    return (
      <div className="echo-markdown-table-wrap" {...sourceAttributes}>
        <table>
          <thead>
            <tr>
              {block.headers.map((header, index) => (
                <th key={index} style={{ textAlign: block.alignments[index] ?? 'left' }}>
                  {renderInline(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.headers.map((_, cellIndex) => (
                  <td key={cellIndex} style={{ textAlign: block.alignments[cellIndex] ?? 'left' }}>
                    {renderInline(row[cellIndex] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (block.kind === 'code') {
    return (
      <pre className="echo-markdown-code" {...sourceAttributes}>
        <code>{block.code}</code>
      </pre>
    )
  }

  if (block.kind === 'quote') {
    return <blockquote {...sourceAttributes}>{renderTextWithBreaks(block.text)}</blockquote>
  }

  if (block.kind === 'rule') return <hr {...sourceAttributes} />

  if (block.kind === 'aligned') {
    return (
      <div
        className="echo-markdown-aligned"
        style={{ textAlign: block.align }}
        {...sourceAttributes}
      >
        {renderBlocks(block.blocks)}
      </div>
    )
  }

  return <p {...sourceAttributes}>{renderTextWithBreaks(block.text)}</p>
}

function renderTextWithBreaks(text: string) {
  return text.split('\n').map((line, index) => (
    <span key={index}>
      {index > 0 && <br />}
      {renderInline(line)}
    </span>
  ))
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|<u>[^<\n]*<\/u>|<mark>[^<\n]*<\/mark>|<br\s*\/?>|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*)/gi
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const token = match[0]
    const key = nodes.length
    if (token.startsWith('`')) {
      nodes.push(<code key={nodes.length}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2))}</strong>)
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key}>{renderInline(token.slice(2, -2))}</del>)
    } else if (/^<u>/i.test(token)) {
      nodes.push(<u key={key}>{renderInline(token.slice(3, -4))}</u>)
    } else if (/^<mark>/i.test(token)) {
      nodes.push(<mark key={key}>{renderInline(token.slice(6, -7))}</mark>)
    } else if (/^<br\s*\/?>$/i.test(token)) {
      nodes.push(<br key={key} />)
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      const href = link?.[2].trim() ?? ''
      if (link && isSafeMarkdownHref(href)) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {renderInline(link[1])}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1))}</em>)
    }
    cursor = match.index + token.length
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function isSafeMarkdownHref(href: string) {
  return /^(?:https?:\/\/|mailto:|#|\/)/i.test(href)
}
