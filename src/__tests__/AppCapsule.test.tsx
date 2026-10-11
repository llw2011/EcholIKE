import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/appStore'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  useTauriEvents: vi.fn(),
  useTheme: vi.fn(),
  useDesktopAuthStorageSync: vi.fn(),
}))

vi.mock('../hooks/useTauriEvents', () => ({ useTauriEvents: mocks.useTauriEvents }))
vi.mock('../hooks/useTheme', () => ({ useTheme: mocks.useTheme }))
vi.mock('../hooks/useDesktopAuthStorageSync', () => ({
  useDesktopAuthStorageSync: mocks.useDesktopAuthStorageSync,
}))
vi.mock('../components/Capsule', () => ({
  Capsule: () => <div data-testid="capsule-window">Capsule</div>,
}))
vi.mock('../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tauri')>()
  return { ...actual, getConfig: mocks.getConfig }
})

import App from '../App'

describe('capsule App entry', () => {
  beforeEach(() => {
    window.location.hash = '#capsule'
    useAppStore.setState(useAppStore.getInitialState())
    mocks.getConfig.mockReset().mockResolvedValue({
      ...useAppStore.getState().config,
      capsule_style: 'orbit',
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('loads native config for the capsule window entry', async () => {
    render(<App />)

    expect(screen.getByTestId('capsule-window')).toBeInTheDocument()
    expect(document.documentElement.dataset.echoWindow).toBe('capsule')
    expect(mocks.useTauriEvents).toHaveBeenCalledTimes(1)
    expect(mocks.useTheme).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mocks.getConfig).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useAppStore.getState().config.capsule_style).toBe('orbit'))
  })
})
