import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCapsuleAutoHide } from '../../../lib/tauri'
import { useAppStore } from '../../../stores/appStore'
import { CapsuleContextMenu } from '../CapsuleContextMenu'

vi.mock('../../../lib/tauri', () => ({
  setCapsuleAutoHide: vi.fn().mockResolvedValue(undefined),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAppStore.setState(useAppStore.getInitialState())
})

describe('CapsuleContextMenu', () => {
  it('shows hide action when auto-hide is disabled', () => {
    useAppStore.getState().updateConfig({ capsule_auto_hide: false })

    render(<CapsuleContextMenu onClose={vi.fn()} />)

    expect(screen.getByRole('menuitem', { name: '空闲时隐藏胶囊' })).toBeInTheDocument()
  })

  it('calls partial capsule visibility command', async () => {
    useAppStore.getState().updateConfig({ capsule_auto_hide: false })

    const onClose = vi.fn()
    render(<CapsuleContextMenu onClose={onClose} />)

    fireEvent.click(screen.getByRole('menuitem', { name: '空闲时隐藏胶囊' }))

    await waitFor(() => expect(setCapsuleAutoHide).toHaveBeenCalledWith(true))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows keep visible action when auto-hide is enabled', () => {
    useAppStore.getState().updateConfig({ capsule_auto_hide: true })

    render(<CapsuleContextMenu onClose={vi.fn()} />)

    expect(screen.getByRole('menuitem', { name: '保持胶囊可见' })).toBeInTheDocument()
  })

  it('does not surface account or upgrade actions', () => {
    render(<CapsuleContextMenu onClose={vi.fn()} />)

    expect(screen.queryByRole('menuitem', { name: /account|upgrade/i })).not.toBeInTheDocument()
  })
})
