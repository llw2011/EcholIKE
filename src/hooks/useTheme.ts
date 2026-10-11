import { useLayoutEffect } from 'react'
import { isDarkThemeAppearance } from '../lib/appearanceProfiles'
import { useAppStore } from '../stores/appStore'

export function useTheme() {
  const theme = useAppStore((s) => s.config.theme)
  const themeProfile = useAppStore((s) => s.config.theme_profile)

  useLayoutEffect(() => {
    const root = document.documentElement
    const systemTheme =
      theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)') : null

    function applyTheme(prefersDark: boolean) {
      root.classList.toggle('dark', prefersDark)
      root.style.colorScheme = isDarkThemeAppearance(prefersDark, themeProfile) ? 'dark' : 'light'
      root.dataset.themeProfile = themeProfile || 'echo'
    }

    applyTheme(theme === 'dark' || (systemTheme?.matches ?? false))

    if (systemTheme) {
      const handler = (e: MediaQueryListEvent) => {
        applyTheme(e.matches)
      }
      systemTheme.addEventListener('change', handler)
      return () => systemTheme.removeEventListener('change', handler)
    }
  }, [theme, themeProfile])

  return theme
}
