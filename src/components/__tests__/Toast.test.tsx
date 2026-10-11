import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from '../../lib/toast'
import { ToastContainer } from '../Toast'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ToastContainer', () => {
  it('renders notifications inside the responsive window-safe viewport', () => {
    const { container } = render(<ToastContainer />)

    expect(container.querySelector('.echo-toast-viewport')).toBeInTheDocument()
  })

  it('replaces a toast with the same action key instead of stacking refresh states', () => {
    vi.useFakeTimers()
    render(<ToastContainer />)

    act(() => {
      toast('正在刷新全部服务额度...', 'info', { key: 'settings:bootstrap' })
      toast('全部服务额度已刷新。', 'success', { key: 'settings:bootstrap' })
    })

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('全部服务额度已刷新。')
    expect(screen.getByRole('alert')).toHaveAttribute('data-toast-key', 'settings:bootstrap')

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('deduplicates repeated default messages and caps visible notifications', () => {
    render(<ToastContainer />)

    act(() => {
      toast('正在同步配置...', 'info')
      toast('正在同步配置...', 'info')
      for (let index = 1; index <= 5; index += 1) {
        toast(`刷新结果 ${index}`, 'success', { key: `refresh:${index}` })
      }
    })

    expect(screen.getAllByRole('alert')).toHaveLength(4)
    expect(screen.queryByText('正在同步配置...')).toBeNull()
    expect(screen.queryByText('刷新结果 1')).toBeNull()
    expect(screen.getByText('刷新结果 5')).toBeInTheDocument()
  })
})
