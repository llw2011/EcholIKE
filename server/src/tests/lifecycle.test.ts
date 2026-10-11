import { describe, expect, it, vi } from 'vitest'
import { createGracefulShutdown } from '../lifecycle.js'

describe('server lifecycle', () => {
  it('stops accepting connections, requests worker cleanup immediately, and waits for both', async () => {
    const order: string[] = []
    let finishServer: () => void = () => undefined
    let finishWorkers: () => void = () => undefined
    const workerCleanup = new Promise<void>((resolve) => {
      finishWorkers = resolve
    })
    const server = {
      close(callback: (error?: Error) => void) {
        order.push('server:stop-accepting')
        finishServer = () => callback()
      },
    }
    const services = {
      stopWorkers: vi.fn(async () => {
        order.push('workers:cancel')
        await workerCleanup
      }),
      closeDatabase: vi.fn(async () => {
        order.push('database:closed')
      }),
    }
    const shutdown = createGracefulShutdown(server, services)

    let settled = false
    const first = shutdown().then(() => {
      settled = true
    })
    const second = shutdown()
    await Promise.resolve()
    expect(order).toEqual(['server:stop-accepting', 'workers:cancel'])
    expect(services.stopWorkers).toHaveBeenCalledTimes(1)
    expect(services.closeDatabase).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    finishWorkers()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(services.closeDatabase).not.toHaveBeenCalled()
    order.push('route:quota-released')
    finishServer()
    await first
    await second
    expect(order).toEqual([
      'server:stop-accepting',
      'workers:cancel',
      'route:quota-released',
      'database:closed',
    ])
    expect(services.closeDatabase).toHaveBeenCalledTimes(1)
    expect(settled).toBe(true)
  })
})
