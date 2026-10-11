import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { DESKTOP_AUTH_STATE_CHANGED_EVENT, DESKTOP_AUTH_TOKEN_KEY } from '../lib/desktopAuth'
import { refreshDesktopAuthSnapshot } from '../lib/desktopAuthRuntime'

export function useDesktopAuthStorageSync(): void {
  useEffect(() => {
    let disposed = false
    let unlistenNative: (() => void) | null = null

    const refresh = (source: 'startup' | 'storage' | 'native') => {
      void refreshDesktopAuthSnapshot().catch((error) => {
        console.warn(`Desktop auth ${source} reconciliation skipped:`, error)
      })
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === DESKTOP_AUTH_TOKEN_KEY) {
        refresh('storage')
      }
    }
    window.addEventListener('storage', handleStorage)

    void listen(DESKTOP_AUTH_STATE_CHANGED_EVENT, () => refresh('native'))
      .then((unlisten) => {
        if (disposed) unlisten()
        else {
          unlistenNative = unlisten
          refresh('startup')
        }
      })
      .catch((error) => {
        console.warn('Desktop auth native listener unavailable:', error)
        if (!disposed) refresh('startup')
      })

    return () => {
      disposed = true
      window.removeEventListener('storage', handleStorage)
      unlistenNative?.()
    }
  }, [])
}
