import { useDesktopAuthStorageSync } from './hooks/useDesktopAuthStorageSync'
import { CapsuleApp } from './windows/CapsuleWindowApp'
import { MainWindowApp } from './windows/MainWindowApp'
import { MarkdownEditorWindowApp } from './windows/MarkdownEditorWindowApp'

function App() {
  useDesktopAuthStorageSync()
  const isCapsuleWindow = window.location.hash === '#capsule'
  const isMarkdownEditorWindow = window.location.hash === '#markdown-editor'
  document.documentElement.dataset.echoWindow = isCapsuleWindow
    ? 'capsule'
    : isMarkdownEditorWindow
      ? 'markdown-editor'
      : 'main'

  if (isCapsuleWindow) return <CapsuleApp />
  if (isMarkdownEditorWindow) return <MarkdownEditorWindowApp />
  return <MainWindowApp />
}

export default App
