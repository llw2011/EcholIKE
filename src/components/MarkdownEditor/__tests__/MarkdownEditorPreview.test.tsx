import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditorPreview } from '../MarkdownEditorPreview'
import { parseMarkdownBlocks, parsePositionedMarkdownBlocks } from '../markdownPreview'
import { createMarkdownEditorPreviewScrollSurface } from '../markdownScrollSync'

describe('MarkdownEditorPreview', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the OCR Markdown blocks used by the result dialog', () => {
    render(
      <MarkdownEditorPreview
        text={[
          '# 订单',
          '',
          '- 订单号 12345',
          '- 需要确认收货地址',
          '',
          '| 字段 | 值 |',
          '| --- | --- |',
          '| 状态 | 待确认 |',
          '| 备注 | A \\| B |',
          '',
          '```text',
          '复制码 ABC',
          '```',
        ].join('\n')}
      />,
    )

    expect(screen.getByRole('heading', { level: 1, name: '订单' })).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByText('订单号 12345')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '字段' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '待确认' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'A | B' })).toBeInTheDocument()
    expect(screen.getByText('复制码 ABC')).toBeInTheDocument()
    expect(screen.queryByText('# 订单')).not.toBeInTheDocument()
  })

  it('keeps inline bold and code formatting inside paragraphs and table cells', () => {
    const { container } = render(
      <MarkdownEditorPreview
        text={[
          '这是一段 **重点** 和 `code`。',
          '',
          '| 字段 | 值 |',
          '| --- | --- |',
          '| 名称 | **Echo** `like` |',
        ].join('\n')}
      />,
    )

    expect(container.querySelector('strong')).toHaveTextContent('重点')
    expect(container.querySelector('p code')).toHaveTextContent('code')

    const row = screen.getByRole('row', { name: /名称/ })
    expect(within(row).getByText('Echo')).toBeInTheDocument()
    expect(within(row).getByText('like')).toBeInTheDocument()
  })

  it('does not turn raw HTML or dangerous links into live DOM nodes', () => {
    const { container } = render(
      <MarkdownEditorPreview
        text={[
          '<script>alert(1)</script>',
          '[x](javascript:alert(1))',
          '<img src=x onerror=alert(1)>',
        ].join('\n')}
      />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument()
    expect(screen.getByText(/\[x\]\(javascript:alert\(1\)\)/)).toBeInTheDocument()
  })

  it('renders extended Markdown and allowlisted alignment HTML safely', () => {
    const { container } = render(
      <MarkdownEditorPreview
        text={[
          '> **引用重点**',
          '',
          '- [x] 已完成',
          '- [ ] 待处理',
          '',
          '~~旧内容~~ <u>下划线</u> <mark>高亮</mark>',
          '',
          '<div align="center">',
          '[官网](https://example.com)',
          '</div>',
          '',
          '---',
        ].join('\n')}
      />,
    )

    expect(container.querySelector('blockquote strong')).toHaveTextContent('引用重点')
    expect(screen.getByRole('checkbox', { name: '已完成' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '未完成' })).not.toBeChecked()
    expect(container.querySelector('del')).toHaveTextContent('旧内容')
    expect(container.querySelector('u')).toHaveTextContent('下划线')
    expect(container.querySelector('mark')).toHaveTextContent('高亮')
    expect(container.querySelector('.echo-markdown-aligned')).toHaveStyle({ textAlign: 'center' })
    expect(screen.getByRole('link', { name: '官网' })).toHaveAttribute(
      'href',
      'https://example.com',
    )
    expect(container.querySelector('hr')).toBeInTheDocument()
  })

  it('adds top-level source-line anchors without extra preview wrappers', () => {
    const text = [
      '# 标题',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '| 字段 | 值 |',
      '| --- | --- |',
      '| 状态 | 正常 |',
      '',
      '```text',
      'code',
      '```',
      '',
      '> 引用一',
      '> 引用二',
      '',
      '<div align="center">',
      '居中内容',
      '</div>',
      '',
      '第一行段落',
      '第二行段落',
      '',
      '---',
    ].join('\n')
    const { container } = render(<MarkdownEditorPreview text={text} />)

    expect(
      parsePositionedMarkdownBlocks(text).map(({ block, startLine, endLine }) => ({
        kind: block.kind,
        startLine,
        endLine,
      })),
    ).toEqual([
      { kind: 'heading', startLine: 1, endLine: 1 },
      { kind: 'list', startLine: 3, endLine: 4 },
      { kind: 'table', startLine: 6, endLine: 8 },
      { kind: 'code', startLine: 10, endLine: 12 },
      { kind: 'quote', startLine: 14, endLine: 15 },
      { kind: 'aligned', startLine: 17, endLine: 19 },
      { kind: 'paragraph', startLine: 21, endLine: 22 },
      { kind: 'rule', startLine: 24, endLine: 24 },
    ])

    const renderedBlocks = Array.from(container.querySelectorAll('.echo-markdown-view > *'))
    expect(renderedBlocks).toHaveLength(8)
    expect(
      renderedBlocks.map((element) => [
        element.getAttribute('data-markdown-source-start'),
        element.getAttribute('data-markdown-source-end'),
      ]),
    ).toEqual([
      ['1', '1'],
      ['3', '4'],
      ['6', '8'],
      ['10', '12'],
      ['14', '15'],
      ['17', '19'],
      ['21', '22'],
      ['24', '24'],
    ])
    expect(renderedBlocks[0]?.tagName).toBe('H1')
    expect(renderedBlocks[1]?.tagName).toBe('UL')
    expect(renderedBlocks[2]).toHaveClass('echo-markdown-table-wrap')
  })

  it('publishes a focusable preview scroll surface and clears it on unmount', async () => {
    const onScrollSurfaceChange = vi.fn()
    const view = render(
      <MarkdownEditorPreview
        text={'# 标题\n\n正文'}
        onScrollSurfaceChange={onScrollSurfaceChange}
      />,
    )

    await waitFor(() => expect(onScrollSurfaceChange).toHaveBeenCalled())
    const surface = onScrollSurfaceChange.mock.calls.find(([value]) => value !== null)?.[0]
    expect(surface?.element).toHaveClass('echo-markdown-view')
    expect(surface?.element).toHaveAttribute('tabindex', '0')

    view.unmount()
    expect(onScrollSurfaceChange).toHaveBeenLastCalledWith(null)
  })

  it('maps preview block anchors locally instead of using one document-height ratio', () => {
    const preview = document.createElement('div')
    Object.defineProperties(preview, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    })
    preview.scrollTop = 300
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 300,
    } as DOMRect)

    const first = document.createElement('h1')
    first.dataset.markdownSourceStart = '1'
    first.dataset.markdownSourceEnd = '1'
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({
      top: -184,
      bottom: -150,
    } as DOMRect)
    const middle = document.createElement('pre')
    middle.dataset.markdownSourceStart = '10'
    middle.dataset.markdownSourceEnd = '20'
    vi.spyOn(middle, 'getBoundingClientRect').mockReturnValue({
      top: 200,
      bottom: 400,
    } as DOMRect)
    const last = document.createElement('p')
    last.dataset.markdownSourceStart = '30'
    last.dataset.markdownSourceEnd = '30'
    vi.spyOn(last, 'getBoundingClientRect').mockReturnValue({
      top: 700,
      bottom: 760,
    } as DOMRect)
    preview.append(first, middle, last)

    const surface = createMarkdownEditorPreviewScrollSurface(preview, () => 30)
    expect(surface.readSourceLine()).toBe(7.75)

    surface.writeSourceLine(15)
    expect(preview.scrollTop).toBe(500)
    surface.writeSourceLine(30)
    expect(preview.scrollTop).toBe(800)
    surface.writeSourceLine(1)
    expect(preview.scrollTop).toBe(0)
  })
})

describe('parseMarkdownBlocks', () => {
  it('normalizes Windows newlines and keeps ordered lists together', () => {
    expect(parseMarkdownBlocks('1. 第一项\r\n2. 第二项')).toEqual([
      { kind: 'list', ordered: true, items: ['第一项', '第二项'] },
    ])
  })
})
