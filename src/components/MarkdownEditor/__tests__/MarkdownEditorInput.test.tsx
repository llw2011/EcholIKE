import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditorInput } from '../MarkdownEditorInput'
import { createMarkdownEditorInputScrollSurface } from '../markdownScrollSync'

describe('MarkdownEditorInput', () => {
  afterEach(cleanup)

  it('reconfigures CodeMirror read-only state without remounting or reporting external sync as an edit', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <MarkdownEditorInput value="初始正文" onChange={onChange} themeKey="light:echo" />,
    )
    const editor = screen.getByRole('textbox', { name: 'Markdown 源文' })
    expect(editor).toHaveAttribute('aria-readonly', 'false')
    expect(editor).toHaveAttribute('contenteditable', 'true')

    rerender(
      <MarkdownEditorInput value="初始正文" onChange={onChange} themeKey="light:echo" readOnly />,
    )
    await waitFor(() => {
      expect(editor).toHaveAttribute('aria-readonly', 'true')
      expect(editor).toHaveAttribute('contenteditable', 'false')
    })

    rerender(
      <MarkdownEditorInput
        value="外部同步的新正文"
        onChange={onChange}
        themeKey="light:echo"
        readOnly
      />,
    )
    await waitFor(() => expect(editor).toHaveTextContent('外部同步的新正文'))
    expect(screen.getByRole('textbox', { name: 'Markdown 源文' })).toBe(editor)
    expect(onChange).not.toHaveBeenCalled()

    rerender(
      <MarkdownEditorInput value="外部同步的新正文" onChange={onChange} themeKey="light:echo" />,
    )
    await waitFor(() => {
      expect(editor).toHaveAttribute('aria-readonly', 'false')
      expect(editor).toHaveAttribute('contenteditable', 'true')
    })
  })

  it('publishes and clears the CodeMirror scroll surface with the component lifecycle', async () => {
    const onScrollSurfaceChange = vi.fn()
    const view = render(
      <MarkdownEditorInput
        value={'第一行\n第二行'}
        onChange={vi.fn()}
        themeKey="light:echo"
        onScrollSurfaceChange={onScrollSurfaceChange}
      />,
    )

    await waitFor(() => expect(onScrollSurfaceChange).toHaveBeenCalled())
    const surface = onScrollSurfaceChange.mock.calls.find(([value]) => value !== null)?.[0]
    expect(surface?.element).toHaveClass('cm-scroller')
    expect(surface?.readSourceLine()).toEqual(expect.any(Number))

    view.unmount()
    expect(onScrollSurfaceChange).toHaveBeenLastCalledWith(null)
  })

  it('maps CodeMirror line blocks to continuous source positions in both directions', () => {
    const scrollDOM = document.createElement('div')
    Object.defineProperties(scrollDOM, {
      clientHeight: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 120 },
    })
    vi.spyOn(scrollDOM, 'getBoundingClientRect').mockReturnValue({
      top: 100,
    } as DOMRect)
    const blocks = [
      { from: 0, top: 0, height: 20 },
      { from: 10, top: 20, height: 20 },
      { from: 20, top: 40, height: 20 },
    ]
    const view = {
      scrollDOM,
      get documentTop() {
        return 100 - scrollDOM.scrollTop
      },
      scaleY: 1,
      state: {
        doc: {
          lines: 3,
          line: (number: number) => ({ from: (number - 1) * 10 }),
          lineAt: (position: number) => ({ number: Math.floor(position / 10) + 1 }),
        },
      },
      lineBlockAtHeight: vi.fn((height: number) => blocks[Math.min(2, Math.floor(height / 20))]),
      lineBlockAt: vi.fn((position: number) => blocks[Math.min(2, Math.floor(position / 10))]),
    }
    const surface = createMarkdownEditorInputScrollSurface(view)

    scrollDOM.scrollTop = 30
    expect(surface.readSourceLine()).toBe(2.5)
    expect(view.lineBlockAtHeight).toHaveBeenCalledWith(30)

    surface.writeSourceLine(2.25)
    expect(scrollDOM.scrollTop).toBe(25)
    expect(view.lineBlockAt).toHaveBeenCalledWith(10)
    surface.writeSourceLine(3)
    expect(scrollDOM.scrollTop).toBe(80)
    surface.writeSourceLine(1)
    expect(scrollDOM.scrollTop).toBe(0)
  })
})
