import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../stores/appStore'

const windowMocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  hide: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMocks,
}))

vi.mock('../../../lib/tauri', () => ({
  refreshTrayLabels: vi.fn().mockResolvedValue(undefined),
}))

import { MainLayout } from '../index'

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState())
}

describe('MainLayout', () => {
  beforeEach(() => {
    window.location.hash = '#/'
    resetStore()
    windowMocks.close.mockResolvedValue(undefined)
    windowMocks.hide.mockResolvedValue(undefined)
    windowMocks.startDragging.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('uses manual titlebar dragging and ignores double-click presses', () => {
    render(
      <MainLayout>
        <div>content</div>
      </MainLayout>,
    )

    const titlebarCopy = screen
      .getByRole('heading', { level: 2, name: '主页' })
      .closest('.echo-titlebar-copy')
    if (!titlebarCopy) throw new Error('Titlebar copy not found')

    expect(titlebarCopy).not.toHaveAttribute('data-tauri-drag-region')

    fireEvent.mouseDown(titlebarCopy, { button: 0, detail: 1 })
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1)

    windowMocks.startDragging.mockClear()
    fireEvent.mouseDown(titlebarCopy, { button: 0, detail: 2 })
    fireEvent.doubleClick(titlebarCopy)

    expect(windowMocks.startDragging).not.toHaveBeenCalled()
  })

  it('shows the configured screen OCR shortcut in the sidebar quick status', () => {
    useAppStore.setState((state) => ({
      config: { ...state.config, screen_ocr_hotkey: 'Ctrl+Shift+O' },
    }))

    render(
      <MainLayout>
        <div>content</div>
      </MainLayout>,
    )

    const quickStatus = document.querySelector('.echo-side-status-grid')
    expect(quickStatus).toHaveTextContent('看图')
    expect(quickStatus).toHaveTextContent('Ctrl+Shift+O')
  })

  it('shows the dragon brand icon with the shared tooltip on hover and keyboard focus', () => {
    render(
      <MainLayout>
        <div>content</div>
      </MainLayout>,
    )

    const dragon = screen.getByRole('img', { name: 'EcholIKE 龙图标' })
    expect(dragon).toHaveTextContent('🐉')
    expect(dragon).toHaveClass('echo-dragon-icon')
    expect(dragon).toHaveAttribute('tabindex', '0')
    expect(dragon).not.toHaveAttribute('title')

    fireEvent.pointerEnter(dragon)
    expect(screen.getByRole('tooltip')).toHaveTextContent('龍')
    expect(screen.getByRole('tooltip')).toHaveClass('echo-tooltip', 'echo-tooltip--bottom')
    fireEvent.pointerLeave(dragon)
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.focus(dragon)
    expect(screen.getByRole('tooltip')).toHaveTextContent('龍')
    fireEvent.blur(dragon)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens the reusable quick-start guide from the titlebar help icon', () => {
    const onOpenQuickStart = vi.fn()
    render(
      <MainLayout onOpenQuickStart={onOpenQuickStart}>
        <div>content</div>
      </MainLayout>,
    )

    const quickStart = screen.getByRole('button', { name: '快速上手' })
    expect(quickStart).not.toHaveAttribute('title')
    expect(quickStart.closest('.echo-window-controls')).not.toBeNull()

    fireEvent.pointerEnter(quickStart)
    expect(screen.getByRole('tooltip')).toHaveTextContent('重新查看新手教程')
    fireEvent.pointerLeave(quickStart)
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.click(quickStart)
    expect(onOpenQuickStart).toHaveBeenCalledTimes(1)
  })
})
