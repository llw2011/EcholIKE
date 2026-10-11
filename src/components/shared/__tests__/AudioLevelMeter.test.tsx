import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../stores/appStore'
import { AudioLevelMeter } from '../AudioLevelMeter'
import { audioLevelSegmentCount } from '../audioLevel'

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState())
})

afterEach(cleanup)

describe('AudioLevelMeter', () => {
  it.each([
    [0, 24, 0],
    [Number.NaN, 24, 0],
    [Number.POSITIVE_INFINITY, 24, 0],
    [-0.4, 24, 0],
    [0.5, 24, 12],
    [0.5, 14, 7],
    [1, 24, 24],
    [3, 14, 14],
  ])('maps level %s across %i segments to %i active segments', (level, segments, active) => {
    expect(audioLevelSegmentCount(level, segments)).toBe(active)
  })

  it('renders no stale level while the pipeline is idle', () => {
    useAppStore.setState({ pipelineState: 'idle', audioVolume: 0.8 })

    const { container } = render(<AudioLevelMeter className="echo-meter" segmentCount={24} />)

    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0')
    expect(container.querySelectorAll('.is-active')).toHaveLength(0)
  })

  it('uses an explicit simulated level independently from the native pipeline state', () => {
    const { container } = render(
      <AudioLevelMeter className="echo-meter" segmentCount={24} simulatedLevel={0.54} />,
    )

    expect(container.querySelectorAll('.is-active')).toHaveLength(13)
  })

  it('subscribes at the leaf without rerendering its parent on volume updates', () => {
    const parentRender = vi.fn()
    useAppStore.getState().setPipelineState('recording')

    function Parent() {
      parentRender()
      return <AudioLevelMeter className="echo-meter" segmentCount={24} />
    }

    const { container } = render(<Parent />)

    act(() => useAppStore.getState().setAudioVolume(0.5))

    expect(container.querySelectorAll('.is-active')).toHaveLength(12)
    expect(parentRender).toHaveBeenCalledTimes(1)
  })
})
