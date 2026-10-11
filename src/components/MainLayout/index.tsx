import type { MouseEvent, ReactNode } from 'react'
import { CircleHelp, Home, Image, Mic, Settings, X, Zap } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useRoute, type Route } from '../../lib/router'
import { refreshTrayLabels } from '../../lib/tauri'
import { APP_NAME } from '../../lib/branding'
import brandIcon from '../../assets/echolike-icon.png'
import { useAppStore } from '../../stores/appStore'
import { Tooltip } from '../Tooltip'
import { AccessibilityBanner } from './AccessibilityBanner'

const navItems: { id: Route; label: string; caption: string; icon: typeof Home }[] = [
  { id: 'home', label: '主页', caption: '输入总览', icon: Home },
  { id: 'settings', label: '设置', caption: '快捷键与引擎', icon: Settings },
]

const routeCopy: Record<Route, { title: string; subtitle: string }> = {
  home: {
    title: '主页',
    subtitle: '本地优先的语音输入工作台',
  },
  settings: {
    title: '设置',
    subtitle: '输入、模型、外观和系统行为',
  },
}

interface Props {
  children: ReactNode
  onOpenQuickStart?: () => void
}

export function MainLayout({ children, onOpenQuickStart }: Props) {
  const { route, navigate } = useRoute()
  const config = useAppStore((s) => s.config)
  const pipelineState = useAppStore((s) => s.pipelineState)
  const copy = routeCopy[route]

  const closeWindow = () => {
    const currentWindow = getCurrentWindow()
    if (config.close_to_tray) {
      currentWindow
        .hide()
        .then(() => refreshTrayLabels().catch(() => undefined))
        .catch(() => currentWindow.close().catch(() => undefined))
      return
    }
    currentWindow.close().catch(() => undefined)
  }

  const startTitlebarDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.detail > 1) return
    event.preventDefault()
    getCurrentWindow()
      .startDragging()
      .catch(() => undefined)
  }

  const suppressTitlebarDoubleClick = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className="echo-shell">
      <aside className="echo-sidebar">
        <div className="echo-brand" data-tauri-drag-region>
          <img
            className="echo-brand-mark"
            src={brandIcon}
            alt=""
            aria-hidden="true"
            draggable={false}
            data-tauri-drag-region
          />
          <div className="echo-brand-copy" data-tauri-drag-region>
            <div className="echo-brand-title-row" data-tauri-drag-region>
              <h1 data-tauri-drag-region>{APP_NAME}</h1>
              <Tooltip content="龍" side="bottom">
                <span
                  className="echo-dragon-icon"
                  role="img"
                  aria-label="EcholIKE 龙图标"
                  tabIndex={0}
                  data-tauri-drag-region
                >
                  🐉
                </span>
              </Tooltip>
            </div>
            <p data-tauri-drag-region>本地极速语音输入</p>
          </div>
        </div>

        <nav className="echo-nav" aria-label="主导航">
          {navItems.map(({ id, label, caption, icon: Icon }) => {
            const active = route === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => navigate(id)}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                data-onboarding-target={id === 'settings' ? 'settings-nav' : undefined}
                className={`echo-nav-item ${active ? 'echo-nav-item--active' : ''}`}
              >
                <span className="echo-nav-icon">
                  <Icon size={17} />
                </span>
                <span className="echo-nav-copy">
                  <strong>{label}</strong>
                  <small>{caption}</small>
                </span>
              </button>
            )
          })}
        </nav>

        <div className="echo-side-status">
          <div className="echo-side-status-title">
            <span className="echo-dot echo-dot--live" />
            <strong>{statusText(pipelineState)}</strong>
          </div>
          <div className="echo-side-status-grid">
            <span>
              <Zap size={13} />
              触发键
            </span>
            <b>{config.hotkey}</b>
            <span>
              <Mic size={13} />
              麦克风
            </span>
            <b>跟随系统</b>
            <span>
              <Image size={13} />
              看图
            </span>
            <b>{config.screen_ocr_hotkey}</b>
          </div>
        </div>
      </aside>

      <main className="echo-main">
        <AccessibilityBanner />
        <header className="echo-titlebar">
          <div
            className="echo-titlebar-copy"
            onMouseDown={startTitlebarDrag}
            onDoubleClick={suppressTitlebarDoubleClick}
          >
            <h2>{copy.title}</h2>
            <p>{copy.subtitle}</p>
          </div>
          <div className="echo-titlebar-actions">
            <div className="echo-window-controls">
              {onOpenQuickStart && (
                <Tooltip content="重新查看新手教程" side="bottom">
                  <button
                    type="button"
                    className="echo-icon-button echo-icon-button--titlebar"
                    aria-label="快速上手"
                    onClick={onOpenQuickStart}
                  >
                    <CircleHelp size={16} />
                  </button>
                </Tooltip>
              )}
              <button
                type="button"
                aria-label="关闭"
                className="echo-icon-button echo-icon-button--titlebar echo-icon-button--window-close"
                onClick={closeWindow}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </header>
        <div className="echo-content">{children}</div>
      </main>
    </div>
  )
}

function statusText(state: string) {
  const labels: Record<string, string> = {
    idle: '可直接开始输入',
    recording: '正在采集语音',
    transcribing: '正在识别文字',
    polishing: 'AI 正在处理',
    outputting: '正在写入文本',
  }
  return labels[state] ?? labels.idle
}
