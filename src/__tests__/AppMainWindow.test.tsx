import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useDesktopAuthStorageSync: vi.fn(),
}))

vi.mock('../hooks/useDesktopAuthStorageSync', () => ({
  useDesktopAuthStorageSync: mocks.useDesktopAuthStorageSync,
}))
vi.mock('../windows/MainWindowApp', () => ({
  MainWindowApp: () => <div data-testid="main-window">Main</div>,
}))

import App from '../App'

describe('main App entry', () => {
  beforeEach(() => {
    window.location.hash = '#/'
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('routes the default hash to the main window entry', () => {
    render(<App />)

    expect(screen.getByTestId('main-window')).toBeInTheDocument()
    expect(document.documentElement.dataset.echoWindow).toBe('main')
    expect(mocks.useDesktopAuthStorageSync).toHaveBeenCalledTimes(1)
  })
})
