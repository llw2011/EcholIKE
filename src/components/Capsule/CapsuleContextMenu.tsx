import { Settings, LogOut, AppWindow, Eye, EyeOff } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { setCapsuleAutoHide } from '../../lib/tauri'
import { useAppStore } from '../../stores/appStore'

interface Props {
  onClose: () => void
}

export function CapsuleContextMenu({ onClose }: Props) {
  const capsuleAutoHide = useAppStore((s) => s.config.capsule_auto_hide)

  const openMainWindow = async (hash: string) => {
    try {
      const mainWin = await WebviewWindow.getByLabel('main')
      if (mainWin) {
        await mainWin.show()
        await mainWin.setFocus()
        await emitTo('main', 'navigate', hash)
      }
    } catch {
      /* ignore - window may not exist */
    }
  }

  const items = [
    {
      icon: AppWindow,
      label: '打开主窗口',
      onClick: () => {
        openMainWindow('#/')
        onClose()
      },
    },
    { type: 'separator' as const },
    {
      icon: capsuleAutoHide ? Eye : EyeOff,
      label: capsuleAutoHide ? '保持胶囊可见' : '空闲时隐藏胶囊',
      onClick: async () => {
        await setCapsuleAutoHide(!capsuleAutoHide)
        onClose()
      },
    },
    {
      icon: Settings,
      label: '设置',
      onClick: () => {
        openMainWindow('#/settings')
        onClose()
      },
    },
    { type: 'separator' as const },
    {
      icon: LogOut,
      label: '退出',
      onClick: () => {
        invoke('plugin:process|exit', { code: 0 }).catch(() => {})
        onClose()
      },
    },
  ]

  return (
    <>
      <div className="echo-capsule-context-backdrop" onClick={onClose} />
      <div className="echo-capsule-menu" role="menu">
        {items.map((item, i) => {
          if ('type' in item && item.type === 'separator') {
            return <div key={i} className="echo-capsule-menu-separator" />
          }
          const {
            icon: Icon,
            label,
            onClick,
          } = item as { icon: typeof Settings; label: string; onClick: () => void }
          return (
            <button
              key={label}
              onClick={onClick}
              role="menuitem"
              className="echo-capsule-menu-item"
            >
              <Icon size={14} />
              {label}
            </button>
          )
        })}
      </div>
    </>
  )
}
