import { useEffect } from 'react'
import { useTauriEvents } from '../hooks/useTauriEvents'
import { useTheme } from '../hooks/useTheme'
import { useAppStore } from '../stores/appStore'
import { getConfig } from '../lib/tauri'
import { Capsule } from '../components/Capsule'

export function CapsuleApp() {
  useTauriEvents()
  useTheme()

  const setConfig = useAppStore((s) => s.setConfig)

  useEffect(() => {
    getConfig()
      .then((config) => {
        setConfig(config)
      })
      .catch((e) => {
        console.error('Failed to load config in capsule:', e)
      })
  }, [setConfig])

  return <Capsule />
}
