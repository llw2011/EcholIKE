import { describe, expect, it } from 'vitest'
import { applyMarkdownAction } from '../markdownActions'

describe('markdownActions', () => {
  it('wraps selected text with bold markers and keeps the content selected', () => {
    const result = applyMarkdownAction('hello world', { from: 6, to: 11 }, 'bold')

    expect(result.text).toBe('hello **world**')
    expect(result.selection).toEqual({ from: 8, to: 13 })
  })

  it('inserts an inline code placeholder when there is no selection', () => {
    const result = applyMarkdownAction('', { from: 0, to: 0 }, 'inline-code')

    expect(result.text).toBe('`code`')
    expect(result.selection).toEqual({ from: 1, to: 5 })
  })

  it('applies and removes heading markers over selected lines', () => {
    const selected = { from: 0, to: '第一行\n第二行'.length }
    const applied = applyMarkdownAction('第一行\n第二行', selected, 'heading-2')
    const removed = applyMarkdownAction(applied.text, applied.selection, 'heading-2')

    expect(applied.text).toBe('## 第一行\n## 第二行')
    expect(removed.text).toBe('第一行\n第二行')
  })

  it('numbers selected lines as an ordered list', () => {
    const result = applyMarkdownAction('苹果\n香蕉\n梨', { from: 0, to: 5 }, 'ordered-list')

    expect(result.text).toBe('1. 苹果\n2. 香蕉\n梨')
  })

  it('toggles unordered list markers across selected lines', () => {
    const applied = applyMarkdownAction('苹果\n香蕉', { from: 0, to: 5 }, 'unordered-list')
    const removed = applyMarkdownAction(applied.text, applied.selection, 'unordered-list')

    expect(applied.text).toBe('- 苹果\n- 香蕉')
    expect(removed.text).toBe('苹果\n香蕉')
  })

  it('wraps selected content in a fenced code block', () => {
    const result = applyMarkdownAction('const x = 1', { from: 0, to: 11 }, 'code-block')

    expect(result.text).toBe(['```text', 'const x = 1', '```', ''].join('\n'))
    expect(result.selection).toEqual({ from: 8, to: 19 })
  })

  it('inserts a table as a block without merging into surrounding paragraphs', () => {
    const result = applyMarkdownAction('前文', { from: 2, to: 2 }, 'table')

    expect(result.text).toBe(
      ['前文', '', '| 字段 | 值 |', '| --- | --- |', '| 名称 | 内容 |', ''].join('\n'),
    )
  })

  it('turns selected text into a link and selects the URL placeholder', () => {
    const result = applyMarkdownAction('Echo', { from: 0, to: 4 }, 'link')

    expect(result.text).toBe('[Echo](https://example.com)')
    expect(result.selection).toEqual({ from: 7, to: 26 })
  })

  it('creates task lists and safe HTML alignment blocks', () => {
    const tasks = applyMarkdownAction('完成文档\n发送邮件', { from: 0, to: 9 }, 'task-list')
    const aligned = applyMarkdownAction('标题', { from: 0, to: 2 }, 'align-center')

    expect(tasks.text).toBe('- [ ] 完成文档\n- [ ] 发送邮件')
    expect(aligned.text).toBe('<div align="center">\n标题\n</div>\n')
    expect(aligned.selection).toEqual({ from: 21, to: 23 })
  })

  it('supports strikethrough, underline, highlight, and horizontal rules', () => {
    expect(applyMarkdownAction('旧内容', { from: 0, to: 3 }, 'strikethrough').text).toBe(
      '~~旧内容~~',
    )
    expect(applyMarkdownAction('重点', { from: 0, to: 2 }, 'underline').text).toBe('<u>重点</u>')
    expect(applyMarkdownAction('提示', { from: 0, to: 2 }, 'highlight').text).toBe(
      '<mark>提示</mark>',
    )
    expect(applyMarkdownAction('前文', { from: 2, to: 2 }, 'horizontal-rule').text).toBe(
      '前文\n\n---\n',
    )
  })
})
