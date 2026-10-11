import { Component, type ReactNode, type ErrorInfo } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getConfig, revealMarkdownEditorWindow, syncMainWindowShape } from '../lib/tauri'
import {
  currentMarkdownEditorWindowBackgroundColor,
  markdownEditorWindowGeneration,
} from '../lib/markdownWindowLifecycle'
import { userFacingErrorMessage } from '../lib/userErrors'

const ERROR_CONFIG_TIMEOUT_MS = 300
const ERROR_SHAPE_TIMEOUT_MS = 200

async function startMinimizedForErrorFallback() {
  let timeout: number | undefined
  try {
    return await Promise.race([
      getConfig().then((config) => config.start_minimized),
      new Promise<boolean>((resolve) => {
        timeout = window.setTimeout(() => resolve(false), ERROR_CONFIG_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    console.warn('Could not read start-minimized state for the error window:', error)
    return false
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout)
  }
}

async function synchronizeErrorWindowShape(synchronize: () => Promise<void>, description: string) {
  let shapeTimeout: number | undefined
  await Promise.race([
    synchronize(),
    new Promise<void>((resolve) => {
      shapeTimeout = window.setTimeout(resolve, ERROR_SHAPE_TIMEOUT_MS)
    }),
  ]).catch((error) => {
    console.warn(`Could not synchronize the ${description} error window shape:`, error)
  })
  if (shapeTimeout !== undefined) window.clearTimeout(shapeTimeout)
}

async function revealRendererErrorWindow() {
  const appWindow = getCurrentWindow()
  if (appWindow.label === 'markdown-editor') {
    const generation = markdownEditorWindowGeneration()
    if (generation === null) {
      console.warn('Could not reveal the Markdown editor error window without its generation')
      return
    }
    await getCurrentWebviewWindow()
      .setBackgroundColor(currentMarkdownEditorWindowBackgroundColor())
      .catch((error) => {
        console.warn('Could not prepare the Markdown editor error surface:', error)
      })
    await revealMarkdownEditorWindow(generation).catch((error) => {
      console.warn('Could not reveal the Markdown editor error window:', error)
    })
    return
  }
  if (appWindow.label !== 'main') return
  const startMinimized = await startMinimizedForErrorFallback()

  await synchronizeErrorWindowShape(syncMainWindowShape, 'main')

  if (startMinimized) return

  await appWindow.show().catch((error) => {
    console.warn('Could not reveal the main error window:', error)
  })
  await appWindow.setFocus().catch((error) => {
    console.warn('Could not focus the main error window:', error)
  })
}

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
    void revealRendererErrorWindow().catch((revealError) => {
      console.warn('Could not prepare the native error window:', revealError)
    })
  }

  render() {
    if (this.state.hasError) {
      const message = userFacingErrorMessage(this.state.error, '应用界面暂时无法显示，请重新加载。')
      return (
        <div className="echo-renderer-error-screen">
          <h2 className="echo-renderer-error-title">出了点问题</h2>
          <p className="echo-renderer-error-message">{message}</p>
          <button type="button" onClick={() => window.location.reload()} className="echo-button">
            重新加载
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
