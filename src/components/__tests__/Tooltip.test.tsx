import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from '../Tooltip'

const initialViewport = { width: window.innerWidth, height: window.innerHeight }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setViewport(initialViewport.width, initialViewport.height)
})

function rect({ left = 0, top = 0, width = 0, height = 0 } = {}) {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

function setViewport(width: number, height: number) {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
  })
}

describe('Tooltip', () => {
  it('renders a Discord-style portal tooltip for hover and focus without a native title', () => {
    render(
      <Tooltip content="重新查看新手教程" side="bottom">
        <button type="button">帮助</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: '帮助' })
    expect(trigger).not.toHaveAttribute('title')
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.pointerEnter(trigger)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('重新查看新手教程')
    expect(tooltip).toHaveClass('echo-tooltip', 'echo-tooltip--bottom')
    expect(tooltip).toHaveAttribute('data-tooltip-side', 'bottom')
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)

    fireEvent.pointerLeave(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('重新查看新手教程')
  })

  it('uses the pointer position for wide text triggers instead of centering the whole row', () => {
    setViewport(900, 520)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'tooltip') return rect({ width: 160, height: 34 })
      return rect({ left: 24, top: 110, width: 700, height: 20 })
    })

    render(
      <Tooltip content="怎么着啊？怎么着？">
        <strong>怎么着啊？怎么着？</strong>
      </Tooltip>,
    )

    const trigger = screen.getByText('怎么着啊？怎么着？')
    const pointerOver = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(pointerOver, 'clientX', { value: 200 })
    fireEvent(trigger, pointerOver)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.style.left).toBe('120px')
    expect(tooltip.style.top).toBe('68px')
  })

  it('keeps a right-edge action tooltip inside the viewport and flips when the preferred side has no room', () => {
    setViewport(900, 220)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'tooltip') return rect({ width: 160, height: 34 })
      return rect({ left: 842, top: 4, width: 42, height: 28 })
    })

    render(
      <Tooltip content="刷新全部服务的剩余额度">
        <button type="button">刷新额度</button>
      </Tooltip>,
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: '刷新额度' }), { clientX: 864 })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveAttribute('data-tooltip-side', 'bottom')
    expect(tooltip.style.left).toBe('728px')
    expect(tooltip.style.top).toBe('40px')
  })

  it('keeps the pointer-aligned arrow when a clicked button receives focus', () => {
    setViewport(900, 520)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'tooltip') return rect({ width: 160, height: 34 })
      return rect({ left: 842, top: 110, width: 42, height: 28 })
    })

    render(
      <Tooltip content="刷新全部服务的剩余额度">
        <button type="button">刷新额度</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole('button', { name: '刷新额度' })
    const pointerOver = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(pointerOver, 'clientX', { value: 854 })
    fireEvent(trigger, pointerOver)

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.style.getPropertyValue('--echo-tooltip-arrow-left')).toBe('126px')

    const pointerMove = new MouseEvent('pointermove', { bubbles: true })
    Object.defineProperty(pointerMove, 'clientX', { value: 874 })
    fireEvent(trigger, pointerMove)
    const pointerDown = new MouseEvent('pointerdown', { bubbles: true })
    Object.defineProperty(pointerDown, 'clientX', { value: 874 })
    fireEvent(trigger, pointerDown)
    const pointerAlignedArrowLeft = tooltip.style.getPropertyValue('--echo-tooltip-arrow-left')
    expect(pointerAlignedArrowLeft).toBe('146px')

    fireEvent.focus(trigger)

    expect(tooltip.style.getPropertyValue('--echo-tooltip-arrow-left')).toBe(
      pointerAlignedArrowLeft,
    )
  })
})
