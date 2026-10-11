import type { AppServices } from './services/app-services.js'

export interface ClosableServer {
  close(callback: (error?: Error) => void): void
}

export function createGracefulShutdown(
  server: ClosableServer,
  services: Pick<AppServices, 'stopWorkers' | 'closeDatabase'>,
): () => Promise<void> {
  let shutdown: Promise<void> | null = null
  return () => {
    if (shutdown) return shutdown
    shutdown = (async () => {
      const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      })
      const workerResult = await settled(services.stopWorkers())
      const serverResult = await settled(serverClosed)
      const databaseResult = await settled(services.closeDatabase())
      const failure = [workerResult, serverResult, databaseResult].find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failure) throw failure.reason
    })()
    return shutdown
  }
}

function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  )
}
