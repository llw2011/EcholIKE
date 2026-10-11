import { useState, useEffect, useCallback } from 'react'
import { ShieldAlert, X } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { checkAccessibilityPermission, requestAccessibilityPermission } from '../../lib/tauri'

export function AccessibilityBanner() {
  const accessibilityTrusted = useAppStore((s) => s.accessibilityTrusted)
  const setAccessibilityTrusted = useAppStore((s) => s.setAccessibilityTrusted)
  const config = useAppStore((s) => s.config)
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
  const [dismissed, setDismissed] = useState(false)

  const show = isMac && !accessibilityTrusted && config.output_mode === 'keyboard' && !dismissed

  useEffect(() => {
    if (!accessibilityTrusted) setDismissed(false)
  }, [accessibilityTrusted])

  useEffect(() => {
    if (isMac && !accessibilityTrusted) {
      const onFocus = () => checkAccessibilityPermission().then(setAccessibilityTrusted)
      window.addEventListener('focus', onFocus)
      return () => window.removeEventListener('focus', onFocus)
    }
  }, [isMac, accessibilityTrusted, setAccessibilityTrusted])

  const handleGrant = useCallback(async () => {
    await requestAccessibilityPermission()
    const trusted = await checkAccessibilityPermission()
    setAccessibilityTrusted(trusted)
  }, [setAccessibilityTrusted])

  return (
    show && (
      <div className="echo-accessibility-banner-clip">
        <div className="echo-accessibility-banner">
          <ShieldAlert size={14} className="echo-accessibility-banner-icon" />
          <span className="echo-accessibility-banner-copy">
            键盘输出需要辅助功能权限 - macOS 辅助功能
          </span>
          <button
            type="button"
            onClick={handleGrant}
            className="echo-button echo-button--primary echo-accessibility-grant"
          >
            授权
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="关闭"
            className="echo-icon-button echo-icon-button--compact"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    )
  )
}
