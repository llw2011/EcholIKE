import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../stores/appStore'
import { Waveform } from '../Waveform'

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

function barHeights(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('.echo-capsule-waveform-bar')].map((bar) =>
    Number.parseFloat(bar.style.height),
  )
}

describe('Capsule runtime waveform', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState())
    stubReducedMotion(false)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps true zero stationary and never invents time-based movement', () => {
    const requestAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)

    const { container } = render(<Waveform capsuleStyle="classic" />)
    const waveform = container.querySelector('.echo-capsule-waveform')
    const bars = container.querySelectorAll<HTMLElement>('.echo-capsule-waveform-bar')

    expect(waveform).toHaveAttribute('data-capsule-waveform', 'runtime')
    expect(barHeights(container)).toEqual([3, 3, 3, 3, 3, 3, 3])
    expect([...bars].map((bar) => bar.style.opacity)).toEqual([
      '0.5',
      '0.5',
      '0.5',
      '0.5',
      '0.5',
      '0.5',
      '0.5',
    ])
    expect([...bars].every((bar) => bar.style.transition === '')).toBe(true)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('maps each real level to one deterministic fixed bar shape', () => {
    const { container } = render(<Waveform capsuleStyle="classic" />)

    act(() => {
      useAppStore.getState().setPipelineState('recording')
      useAppStore.getState().setAudioVolume(0.5)
    })

    const firstHeights = barHeights(container)
    expect(firstHeights).toEqual([5.73, 7.42, 8.72, 9.5, 8.72, 7.42, 5.73])
    expect(firstHeights[0]).toBe(firstHeights[6])
    expect(firstHeights[1]).toBe(firstHeights[5])
    expect(firstHeights[2]).toBe(firstHeights[4])
    expect(firstHeights[3]).toBeGreaterThan(firstHeights[2])

    act(() => useAppStore.getState().setAudioVolume(0.5))
    expect(barHeights(container)).toEqual(firstHeights)

    act(() => useAppStore.getState().setAudioVolume(0))
    expect(barHeights(container)).toEqual([3, 3, 3, 3, 3, 3, 3])
  })

  it('keeps real level feedback under reduced motion while disabling interpolation', () => {
    stubReducedMotion(true)
    useAppStore.getState().setPipelineState('recording')
    useAppStore.getState().setAudioVolume(0.75)

    const { container } = render(<Waveform capsuleStyle="classic" />)
    const bars = container.querySelectorAll<HTMLElement>('.echo-capsule-waveform-bar')

    expect(barHeights(container)).toEqual([7.1, 9.63, 11.58, 12.75, 11.58, 9.63, 7.1])
    expect([...bars].every((bar) => bar.style.transition === '')).toBe(true)
  })

  it('leaves preview-only synthetic animation opt-in and independent from live audio', () => {
    useAppStore.getState().setAudioVolume(1)

    const { container } = render(<Waveform capsuleStyle="classic" preview animatePreview />)

    expect(container.querySelector('.echo-capsule-waveform')).toHaveAttribute(
      'data-capsule-waveform',
      'preview-animated',
    )
    expect(container.querySelector('.echo-capsule-waveform')).toHaveClass('is-synthetic')
    expect(barHeights(container)).toEqual([6, 12, 8, 15, 9, 13, 7])
  })

  it.each([
    ['classic', [6, 12, 8, 15, 9, 13, 7]],
    ['compact', [5, 11, 14, 9, 6]],
    ['glass', [5, 9, 13, 16, 13, 9, 5]],
    ['ink', [12, 6, 10, 4]],
    ['command', [4, 8, 14, 8, 4]],
    ['signal', [3, 6, 10, 14, 16, 14, 10, 6, 3]],
    ['pulse', [4, 8, 13, 16, 13, 8, 4]],
    ['orbit', [5, 11, 15, 7, 13, 6]],
  ] as const)('binds the %s waveform identity to its own envelope', (capsuleStyle, heights) => {
    const { container } = render(<Waveform capsuleStyle={capsuleStyle} preview />)

    expect(container.querySelector('.echo-capsule-waveform')).toHaveAttribute(
      'data-capsule-waveform-style',
      capsuleStyle,
    )
    expect(barHeights(container)).toEqual(heights)
  })
})
