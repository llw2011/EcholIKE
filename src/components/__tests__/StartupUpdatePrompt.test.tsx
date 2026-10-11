import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StartupUpdatePrompt } from '../StartupUpdatePrompt'

const update = {
  currentVersion: '0.1.37',
  latestVersion: '0.1.38',
  releaseNotes: 'Markdown editor rollout.',
  noteSummary: 'Markdown editor rollout.',
  checkedAt: '2026-07-07T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
})

describe('StartupUpdatePrompt', () => {
  it('shows the version and update summary before entering the app', () => {
    render(
      <StartupUpdatePrompt
        update={update}
        installing={false}
        onInstall={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveClass('echo-startup-update-screen')
    expect(screen.getByRole('dialog')).not.toHaveClass('echo-startup-update-screen--card-fit')
    expect(screen.getByText('EcholIKE v0.1.38')).toBeInTheDocument()
    expect(screen.getByText('当前 v0.1.37，可以更新到 v0.1.38')).toBeInTheDocument()
    expect(screen.getByText('Markdown editor rollout.')).toBeInTheDocument()
  })

  it('runs install or dismiss from the two explicit actions', () => {
    const onInstall = vi.fn()
    const onDismiss = vi.fn()

    render(
      <StartupUpdatePrompt
        update={update}
        installing={false}
        onInstall={onInstall}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '立即更新' }))
    fireEvent.click(screen.getByRole('button', { name: '下次提醒' }))

    expect(onInstall).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('locks actions while the silent install is running', () => {
    render(
      <StartupUpdatePrompt
        update={update}
        installing={true}
        progress={{ phase: 'downloading', downloadedBytes: 50, totalBytes: 100, percent: 50 }}
        onInstall={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: '正在更新...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下次提醒' })).toBeDisabled()
    expect(screen.getByRole('progressbar', { name: '更新进度' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    )
    expect(screen.getByText('50%')).toBeInTheDocument()
  })
})
