import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapsuleSkinPreview } from '../CapsuleSkinPreview'
import { capsuleStyleOptions, getCapsuleSize } from '../capsuleSkin'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

describe('CapsuleSkinPreview', () => {
  it('uses the same skin scope and glyph selection as the live capsule', () => {
    const { container } = render(<CapsuleSkinPreview capsuleStyle="pulse" variant="current" />)

    const skin = container.querySelector('.echo-capsule-skin')
    expect(skin).toHaveAttribute('data-capsule-style', 'pulse')
    expect(skin).toHaveClass('echo-capsule-skin--preview-current')
    expect(skin?.querySelector('.echo-capsule-surface--active')).not.toBeNull()
    expect(skin?.querySelector('.echo-capsule-frame')).not.toBeNull()
    expect(skin?.querySelector('[data-capsule-content-state="recording"]')).not.toBeNull()
    expect(skin?.querySelector('.echo-capsule-waveform')).toHaveAttribute(
      'data-capsule-waveform',
      'preview-animated',
    )
    expect(skin?.querySelector('.echo-capsule-waveform')).toHaveAttribute(
      'data-capsule-waveform-style',
      'pulse',
    )
    expect(skin?.querySelector('.echo-capsule-waveform')).toHaveClass('is-synthetic')
    expect(skin?.querySelector('.echo-capsule-preview-lines')).toBeNull()
    expect(skin?.querySelector('.echo-capsule-frame')).toHaveStyle({
      width: `${getCapsuleSize('pulse', 'recording').width}px`,
      height: `${getCapsuleSize('pulse', 'recording').height}px`,
    })
  })

  it('keeps every selectable skin renderable in the shared preview surface', () => {
    const { container, rerender } = render(<CapsuleSkinPreview capsuleStyle="classic" />)

    for (const style of capsuleStyleOptions) {
      rerender(<CapsuleSkinPreview capsuleStyle={style.id} />)
      const size = getCapsuleSize(style.id, 'recording')
      const viewport = container.querySelector<HTMLElement>('.echo-capsule-preview-viewport')
      const scaleLayer = container.querySelector<HTMLElement>('.echo-capsule-preview-scale')

      expect(container.querySelector('.echo-capsule-skin')).toHaveAttribute(
        'data-capsule-style',
        style.id,
      )
      expect(container.querySelector('.echo-capsule-frame')).toHaveStyle({
        width: `${size.width}px`,
        height: `${size.height}px`,
      })
      expect(viewport).toHaveAttribute('data-capsule-preview-variant', 'card')
      expect(Number.parseFloat(viewport?.style.width ?? '')).toBeCloseTo(size.width * 0.64)
      expect(Number.parseFloat(viewport?.style.width ?? '')).toBeLessThanOrEqual(176 - 32)
      expect(scaleLayer).toHaveStyle({ width: `${size.width}px`, height: `${size.height}px` })
      expect(container.querySelector('.echo-capsule-waveform')).toHaveAttribute(
        'data-capsule-waveform',
        'preview-static',
      )
      expect(container.querySelector('.echo-capsule-waveform')).toHaveAttribute(
        'data-capsule-waveform-style',
        style.id,
      )
      expect(container.querySelector('.echo-capsule-status-dot')).toHaveAttribute(
        'data-capsule-indicator-style',
        style.id,
      )
      expect(container.querySelector('.echo-capsule-status-dot')).not.toHaveClass('is-animated')
      expect(container.querySelector('button')).toBeNull()
      expect(container.querySelector('[data-capsule-preview-cancel="recording"]')).not.toBeNull()
      expect(
        container.querySelector<HTMLElement>('.echo-capsule-waveform-bar')?.style.transition,
      ).toBe('')
    }
  })

  it('keeps the current preview static when reduced motion is requested', () => {
    stubReducedMotion(true)

    const { container } = render(<CapsuleSkinPreview capsuleStyle="orbit" variant="current" />)

    expect(container.querySelector('.echo-capsule-waveform')).toHaveAttribute(
      'data-capsule-waveform',
      'preview-static',
    )
    expect(container.querySelector('.echo-capsule-waveform')).not.toHaveClass('is-synthetic')
    expect(container.querySelector('.echo-capsule-status-dot')).not.toHaveClass('is-animated')
  })

  it('keeps the whole static preview as a selectable card click target', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <button type="button" onClick={onSelect}>
        <CapsuleSkinPreview capsuleStyle="signal" />
      </button>,
    )

    const previewCancel = container.querySelector('[data-capsule-preview-cancel="recording"]')
    expect(previewCancel).not.toBeNull()
    expect(previewCancel?.closest('button')).toBe(container.querySelector('button'))

    fireEvent.click(previewCancel as Element)

    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
