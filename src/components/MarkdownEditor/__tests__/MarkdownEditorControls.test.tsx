import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ScenePresetSelect } from '../../ScenePresetSelect'
import { MarkdownEditorToolbar } from '../MarkdownEditorToolbar'

const preset = {
  id: 'test-preset',
  name: '测试预设',
  description: '用于测试禁用状态。',
  category: 'test',
  promptTemplate: '整理内容。',
  dictionaryTerms: [],
  isPro: false,
}

describe('Markdown editor mutation controls', () => {
  it('disables every formatting action when the toolbar is locked', () => {
    const onAction = vi.fn()
    render(<MarkdownEditorToolbar onAction={onAction} disabled />)

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
    buttons.forEach((button) => expect(button).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('passes the optional disabled state to the native scene preset select', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <ScenePresetSelect presets={[preset]} value="test-preset" onChange={onChange} disabled />,
    )

    expect(screen.getByLabelText('预设')).toBeDisabled()
    rerender(<ScenePresetSelect presets={[preset]} value="test-preset" onChange={onChange} />)
    expect(screen.getByLabelText('预设')).toBeEnabled()
  })
})
