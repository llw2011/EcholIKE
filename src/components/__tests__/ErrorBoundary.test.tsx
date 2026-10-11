import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  label: 'main',
  getConfig: vi.fn(),
  syncMainWindowShape: vi.fn(),
  setMarkdownBackgroundColor: vi.fn(),
  revealMarkdownEditorWindow: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: mocks.label,
    show: mocks.show,
    setFocus: mocks.setFocus,
  }),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ setBackgroundColor: mocks.setMarkdownBackgroundColor }),
}))

vi.mock('../../lib/markdownWindowLifecycle', () => ({
  currentMarkdownEditorWindowBackgroundColor: () => [251, 255, 253, 0],
  markdownEditorWindowGeneration: () => 9,
}))

vi.mock('../../lib/tauri', () => ({
  getConfig: mocks.getConfig,
  syncMainWindowShape: mocks.syncMainWindowShape,
  revealMarkdownEditorWindow: mocks.revealMarkdownEditorWindow,
}))

import { ErrorBoundary } from '../ErrorBoundary'

function CrashingChild(): ReactNode {
  throw new Error('renderer failed')
}

afterEach(cleanup)

describe('ErrorBoundary native visibility fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.label = 'main'
    mocks.getConfig.mockResolvedValue({ start_minimized: false })
    mocks.syncMainWindowShape.mockResolvedValue(undefined)
    mocks.setMarkdownBackgroundColor.mockResolvedValue(undefined)
    mocks.revealMarkdownEditorWindow.mockResolvedValue(undefined)
    mocks.show.mockResolvedValue(undefined)
    mocks.setFocus.mockResolvedValue(undefined)
  })

  it('reveals a committed main-window error page after synchronizing its shape', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      render(
        <ErrorBoundary>
          <CrashingChild />
        </ErrorBoundary>,
      )

      expect(screen.getByText('出了点问题').closest('.echo-renderer-error-screen')).not.toBeNull()
      expect(screen.getByText('应用界面暂时无法显示，请重新加载。')).toBeInTheDocument()
      expect(screen.queryByText('renderer failed')).not.toBeInTheDocument()
      await waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1))
      expect(mocks.syncMainWindowShape.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.show.mock.invocationCallOrder[0],
      )
      expect(mocks.revealMarkdownEditorWindow).not.toHaveBeenCalled()
      expect(mocks.setFocus).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  it('respects start-minimized when the renderer commits an error page', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.getConfig.mockResolvedValue({ start_minimized: true })

    try {
      render(
        <ErrorBoundary>
          <CrashingChild />
        </ErrorBoundary>,
      )

      await waitFor(() => expect(mocks.getConfig).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
      expect(mocks.syncMainWindowShape).toHaveBeenCalledTimes(1)
      expect(mocks.show).not.toHaveBeenCalled()
      expect(mocks.setFocus).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('reveals a standalone Markdown renderer error without main-window policy work', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.label = 'markdown-editor'

    try {
      render(
        <ErrorBoundary>
          <CrashingChild />
        </ErrorBoundary>,
      )

      await waitFor(() => expect(mocks.revealMarkdownEditorWindow).toHaveBeenCalledWith(9))
      expect(mocks.getConfig).not.toHaveBeenCalled()
      expect(mocks.syncMainWindowShape).not.toHaveBeenCalled()
      expect(mocks.setMarkdownBackgroundColor).toHaveBeenCalledWith([251, 255, 253, 0])
      expect(mocks.setMarkdownBackgroundColor.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.revealMarkdownEditorWindow.mock.invocationCallOrder[0],
      )
      expect(mocks.show).not.toHaveBeenCalled()
      expect(mocks.setFocus).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('still delegates Markdown error reveal when backing synchronization fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.label = 'markdown-editor'
    mocks.setMarkdownBackgroundColor.mockRejectedValueOnce(new Error('background unavailable'))

    try {
      render(
        <ErrorBoundary>
          <CrashingChild />
        </ErrorBoundary>,
      )

      await waitFor(() => expect(mocks.revealMarkdownEditorWindow).toHaveBeenCalledWith(9))
      expect(mocks.show).not.toHaveBeenCalled()
      expect(mocks.setFocus).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('does not reveal the Rust-managed capsule after a renderer error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.label = 'capsule'

    try {
      render(
        <ErrorBoundary>
          <CrashingChild />
        </ErrorBoundary>,
      )

      expect(screen.getByText('出了点问题')).toBeInTheDocument()
      await new Promise((resolve) => window.setTimeout(resolve, 20))
      expect(mocks.getConfig).not.toHaveBeenCalled()
      expect(mocks.syncMainWindowShape).not.toHaveBeenCalled()
      expect(mocks.revealMarkdownEditorWindow).not.toHaveBeenCalled()
      expect(mocks.show).not.toHaveBeenCalled()
      expect(mocks.setFocus).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})
