import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useTauriEvents } from '../hooks/useTauriEvents'
import { useTheme } from '../hooks/useTheme'
import { useAppStore, type AppConfig } from '../stores/appStore'
import {
  fetchDesktopBootstrap,
  getConfig,
  notifyOwnerWindowDestroyed,
  openMarkdownFile,
  revealMarkdownEditorWindow,
  runExportMarkdownDocx,
  runLocalMarkdownAi,
  runProxyMarkdownAi,
  runSaveMarkdownFile,
  type FileCommandOwnerKey,
  type FileCommandSnapshot,
} from '../lib/tauri'
import { isDesktopAuthSessionAuthenticated } from '../lib/desktopAuth'
import {
  applyDesktopBootstrapResponse,
  beginDesktopAuthRequest,
  handleDesktopBootstrapFailure,
} from '../lib/desktopAuthRuntime'
import { safeDownloadFileName } from '../lib/fileNames'
import {
  currentMarkdownEditorWindowBackgroundColor,
  markdownEditorWindowGeneration,
} from '../lib/markdownWindowLifecycle'
import { userFacingErrorMessage } from '../lib/userErrors'
import { mergeScenePresetContext, scenePresetOptions } from '../lib/scenePresets'
import {
  buildMarkdownAiPrompt,
  buildMarkdownTranslationRetryPrompt,
  type MarkdownAiRequest,
} from '../components/MarkdownEditor/markdownAi'
import {
  ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
  appendMarkdownText,
  createMarkdownFileDraft,
  MARKDOWN_VOICE_APPEND_STORAGE_KEY,
  parseMarkdownDraft,
  parseMarkdownVoiceAppendEnabled,
  RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
  serializeMarkdownDraft,
  serializeRecentMarkdownDraft,
  type MarkdownDraft,
} from '../components/MarkdownEditor/markdownDraft'
import {
  latestMarkdownAiTask,
  latestRunningMarkdownAiTask,
  markdownDraftRevision,
  markdownSemanticFingerprint,
  useMarkdownAiDomain,
} from '../components/MarkdownEditor/markdownAiTask'
import type { MarkdownEditorFileFeedback } from '../components/MarkdownEditor/MarkdownEditorShell'
import { fileCommandIdentity, useFileCommandDomain } from '../stores/fileCommandStore'
import { APP_NAME, APP_VERSION, DESKTOP_BOOTSTRAP_URL } from '../lib/branding'

const MarkdownEditorShell = lazy(() =>
  import('../components/MarkdownEditor/MarkdownEditorShell').then((module) => ({
    default: module.MarkdownEditorShell,
  })),
)

function readLocalStorageItem(key: string) {
  try {
    return localStorage.getItem(key)
  } catch (error) {
    console.warn(`Local storage read skipped for "${key}":`, error)
    return null
  }
}

function writeLocalStorageItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch (error) {
    console.warn(`Local storage write skipped for "${key}":`, error)
  }
}

function removeLocalStorageItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch (error) {
    console.warn(`Local storage remove skipped for "${key}":`, error)
  }
}

function createEmptyMarkdownDraft(): MarkdownDraft {
  const now = new Date().toISOString()
  return {
    id: `manual-${Date.now()}`,
    title: '未命名文稿',
    text: '',
    source: 'manual',
    createdAt: now,
    updatedAt: now,
    dirty: false,
  }
}

function readActiveMarkdownDraft() {
  return parseMarkdownDraft(readLocalStorageItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))
}

function persistMarkdownDraft(draft: MarkdownDraft) {
  writeLocalStorageItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY, serializeMarkdownDraft(draft))
  if (draft.dirty && draft.text.trim()) {
    writeLocalStorageItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY, serializeRecentMarkdownDraft(draft))
    return
  }

  removeLocalStorageItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)
}

const errorMessage = userFacingErrorMessage

function MarkdownEditorWindowReady({ generation }: { generation: number }) {
  const revealStarted = useRef(false)

  useEffect(() => {
    if (revealStarted.current) return
    revealStarted.current = true

    const editorWindow = getCurrentWebviewWindow()

    async function revealEditorWindow() {
      await editorWindow
        .setBackgroundColor(currentMarkdownEditorWindowBackgroundColor())
        .catch((error) => {
          console.warn('Markdown editor theme backing synchronization skipped:', error)
        })
      await revealMarkdownEditorWindow(generation).catch((error) => {
        throw new Error(`Markdown editor renderer-ready acknowledgement failed: ${String(error)}`)
      })
    }

    void revealEditorWindow().catch((error) => {
      console.warn('Markdown editor window reveal skipped:', error)
    })
  }, [generation])

  return null
}

export function MarkdownEditorWindowApp() {
  useTauriEvents()
  useTheme()

  const windowGeneration = useMemo(markdownEditorWindowGeneration, [])
  const config = useAppStore((s) => s.config)
  const desktopBootstrap = useAppStore((s) => s.desktopBootstrap)
  const desktopAuthToken = useAppStore((s) => s.desktopAuthToken)
  const desktopAuthStatus = useAppStore((s) => s.desktopAuthStatus)
  const desktopBootstrapAuthToken = useAppStore((s) => s.desktopBootstrapAuthToken)
  const completedVoiceText = useAppStore((s) => s.completedVoiceText)
  const completedVoiceTextVersion = useAppStore((s) => s.completedVoiceTextVersion)
  const setConfig = useAppStore((s) => s.setConfig)
  const setSavedConfig = useAppStore((s) => s.setSavedConfig)
  const [startupState, setStartupState] = useState<
    { status: 'loading' | 'ready' } | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [rendererShellReady, setRendererShellReady] = useState(false)
  const [rendererShellEpoch, setRendererShellEpoch] = useState(0)
  const [draft, setDraft] = useState<MarkdownDraft>(
    () => readActiveMarkdownDraft() ?? createEmptyMarkdownDraft(),
  )
  const draftAiTaskSnapshot = useMarkdownAiDomain((state) => state.byDraft[draft.id])
  const draftAiTasks = draftAiTaskSnapshot ?? []
  const localDraftAiPending = useMarkdownAiDomain(
    (state) => state.localPendingByDraft[draft.id] ?? null,
  )
  const draftAiRevision = markdownDraftRevision(`${draft.title}\0${draft.text}`)
  const draftAiLocked = Boolean(
    draftAiTaskSnapshot === undefined ||
    localDraftAiPending ||
    latestRunningMarkdownAiTask(draftAiTasks) ||
    latestMarkdownAiTask(
      draftAiTasks,
      (task) =>
        task.outcome.status === 'success' && task.key.request.draftRevision === draftAiRevision,
    ),
  )
  const [fileFeedback, setFileFeedback] = useState<MarkdownEditorFileFeedback | null>(null)
  const fileTasks = useFileCommandDomain((state) => state.tasks)
  const syncFileCommands = useFileCommandDomain((state) => state.sync)
  const acceptFileCommand = useFileCommandDomain((state) => state.accept)
  const consumeFileCommand = useFileCommandDomain((state) => state.consume)
  const handledFileOutcomesRef = useRef(new Set<string>())
  const activeDraftResourceRef = useRef('')
  const activeDraftRevisionRef = useRef('')
  const [voiceAppendEnabled, setVoiceAppendEnabled] = useState(() =>
    parseMarkdownVoiceAppendEnabled(readLocalStorageItem(MARKDOWN_VOICE_APPEND_STORAGE_KEY)),
  )
  const handledVoiceResultVersionRef = useRef(completedVoiceTextVersion)
  const queuedVoiceAppendRef = useRef<Array<{ draftId: string; version: number; text: string }>>([])

  const backendManaged = config.config_source === 'backend'
  const desktopToken = isDesktopAuthSessionAuthenticated(
    desktopBootstrap,
    desktopAuthToken,
    desktopAuthStatus,
    desktopBootstrapAuthToken,
  )
    ? desktopAuthToken
    : null
  const localLlmReady =
    config.llm_provider === 'ollama'
      ? Boolean(config.llm_base_url.trim() && config.llm_model.trim())
      : Boolean(config.llm_api_key.trim() && config.llm_base_url.trim() && config.llm_model.trim())
  const cloudLlm = desktopBootstrap?.services?.llm
  const cloudLlmAvailable = Boolean(
    backendManaged &&
    cloudLlm?.mode === 'proxy' &&
    cloudLlm.configured !== false &&
    desktopBootstrap?.apiBaseUrl &&
    desktopToken,
  )
  const llmReady = backendManaged ? cloudLlmAvailable : localLlmReady
  const llmUnavailableMessage = backendManaged
    ? '后台托管文本 AI 不可用，请先在主应用同步后台配置。'
    : '先在设置里配置可用的文本 AI 模型。'
  const cloudTts = desktopBootstrap?.services?.tts
  const ttsAvailable = Boolean(
    backendManaged &&
    cloudTts?.mode === 'proxy' &&
    cloudTts.configured !== false &&
    desktopBootstrap?.apiBaseUrl &&
    desktopToken,
  )
  const scenePresets = scenePresetOptions(desktopBootstrap?.scenes)
  const draftResourceId = `draft:${draft.id}`
  activeDraftResourceRef.current = draftResourceId
  activeDraftRevisionRef.current = markdownDraftRevision(`${draft.title}\0${draft.text}`)
  const visibleFileFeedback = fileFeedback?.resourceId === draftResourceId ? fileFeedback : null
  const saveKey = useMemo<FileCommandOwnerKey>(
    () => ({ resourceId: draftResourceId, commandKind: 'saveMarkdown' }),
    [draftResourceId],
  )
  const exportKey = useMemo<FileCommandOwnerKey>(
    () => ({ resourceId: draftResourceId, commandKind: 'exportDocx' }),
    [draftResourceId],
  )
  const saveBusy = fileTasks[fileCommandIdentity(saveKey)]?.outcome.status === 'running'
  const exportBusy = fileTasks[fileCommandIdentity(exportKey)]?.outcome.status === 'running'

  useEffect(() => {
    void syncFileCommands()
  }, [syncFileCommands])
  useEffect(() => {
    for (const key of [saveKey, exportKey]) {
      const snapshot = fileTasks[fileCommandIdentity(key)]
      if (!snapshot || snapshot.outcome.status === 'running') continue
      if (snapshot.ownerWindow && snapshot.ownerWindow !== 'markdown-editor') continue
      const token = `${fileCommandIdentity(key)}:${snapshot.outcome.leaseId}`
      if (handledFileOutcomesRef.current.has(token)) continue
      void consumeFileCommand(snapshot).then((result) => {
        if (result === 'stale') return
        handledFileOutcomesRef.current.add(token)
        if (snapshot.key.commandKind === 'saveMarkdown' && snapshot.outcome.status === 'success') {
          setDraft((current) => markStandaloneDraftSavedIfMatching(current, snapshot))
        }
        if (result === 'consumed') showStandaloneFileOutcome(snapshot, '文件操作失败。')
      })
    }
  }, [consumeFileCommand, exportKey, fileTasks, saveKey])

  useEffect(() => {
    let cancelled = false

    async function loadEditorConfig() {
      try {
        const nextConfig = await getConfig()
        if (cancelled) return

        setConfig(nextConfig)
        setSavedConfig(nextConfig)
        setStartupState({ status: 'ready' })
        void syncEditorBootstrap(nextConfig)
      } catch (error) {
        console.warn('Markdown editor config load skipped:', error)
        if (!cancelled) {
          setStartupState({
            status: 'error',
            message: errorMessage(
              error,
              '本地配置读取失败，Markdown 编辑器已停止加载以避免使用错误配置。',
            ),
          })
        }
      }
    }

    async function syncEditorBootstrap(nextConfig: AppConfig) {
      const request = await beginDesktopAuthRequest({
        allowPublic: nextConfig.config_source === 'backend',
      })
      if (!request || (!request.token && nextConfig.config_source !== 'backend')) return

      try {
        const bootstrap = await fetchDesktopBootstrap(
          DESKTOP_BOOTSTRAP_URL,
          APP_VERSION,
          request.token,
        )
        if (cancelled) return
        await applyDesktopBootstrapResponse(bootstrap, request)
      } catch (error) {
        await handleDesktopBootstrapFailure(error, request)
        console.warn('Markdown editor desktop policy sync skipped:', error)
      }
    }

    void loadEditorConfig()

    return () => {
      cancelled = true
    }
  }, [setConfig, setSavedConfig])

  useEffect(() => {
    function loadActiveDraft() {
      const nextDraft = readActiveMarkdownDraft() ?? createEmptyMarkdownDraft()
      setFileFeedback((current) =>
        current?.resourceId === `draft:${nextDraft.id}` ? current : null,
      )
      setDraft(nextDraft)
    }

    const unlistenPromise = listen('markdown-editor:load-draft', loadActiveDraft).catch((error) => {
      console.warn('Markdown editor load listener skipped:', error)
      return null
    })

    function onStorage(event: StorageEvent) {
      if (event.key === ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY) loadActiveDraft()
      if (event.key === MARKDOWN_VOICE_APPEND_STORAGE_KEY) {
        setVoiceAppendEnabled(parseMarkdownVoiceAppendEnabled(event.newValue))
      }
    }

    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      unlistenPromise.then((unlisten) => unlisten?.()).catch(() => undefined)
    }
  }, [])

  function updateDraft(nextDraft: MarkdownDraft) {
    setFileFeedback(null)
    setDraft(nextDraft)
    persistMarkdownDraft(nextDraft)
  }

  function updateVoiceAppendEnabled(enabled: boolean) {
    setVoiceAppendEnabled(enabled)
    if (!enabled) queuedVoiceAppendRef.current = []
    writeLocalStorageItem(MARKDOWN_VOICE_APPEND_STORAGE_KEY, enabled ? 'true' : 'false')
  }

  useEffect(() => {
    if (handledVoiceResultVersionRef.current === completedVoiceTextVersion) return
    handledVoiceResultVersionRef.current = completedVoiceTextVersion

    const nextText = completedVoiceText.trim()
    if (!voiceAppendEnabled || !nextText) return

    if (draftAiLocked) {
      queuedVoiceAppendRef.current.push({
        draftId: draft.id,
        version: completedVoiceTextVersion,
        text: nextText,
      })
      return
    }

    const nextDraft: MarkdownDraft = {
      ...draft,
      text: appendMarkdownText(draft.text, nextText),
      updatedAt: new Date().toISOString(),
      dirty: true,
    }
    setFileFeedback(null)
    setDraft(nextDraft)
    persistMarkdownDraft(nextDraft)
  }, [completedVoiceText, completedVoiceTextVersion, draft, draftAiLocked, voiceAppendEnabled])

  useEffect(() => {
    if (draftAiLocked || !voiceAppendEnabled || queuedVoiceAppendRef.current.length === 0) return
    const queued = queuedVoiceAppendRef.current.filter((item) => item.draftId === draft.id)
    if (queued.length === 0) return
    queuedVoiceAppendRef.current = queuedVoiceAppendRef.current.filter(
      (item) => item.draftId !== draft.id,
    )
    const nextText = queued.reduce((text, item) => appendMarkdownText(text, item.text), draft.text)
    const nextDraft: MarkdownDraft = {
      ...draft,
      text: nextText,
      updatedAt: new Date().toISOString(),
      dirty: true,
    }
    setFileFeedback(null)
    setDraft(nextDraft)
    persistMarkdownDraft(nextDraft)
  }, [draft, draftAiLocked, voiceAppendEnabled])

  async function copyMarkdownDraft(currentDraft: MarkdownDraft) {
    if (!currentDraft.text.trim()) return
    const resourceId = `draft:${currentDraft.id}`
    const revision = markdownDraftRevision(`${currentDraft.title}\0${currentDraft.text}`)
    setFileFeedback(null)
    try {
      await navigator.clipboard.writeText(currentDraft.text)
      if (
        activeDraftResourceRef.current === resourceId &&
        activeDraftRevisionRef.current === revision
      ) {
        setFileFeedback({ resourceId, type: 'success', message: 'Markdown 已复制。' })
      }
    } catch {
      if (
        activeDraftResourceRef.current === resourceId &&
        activeDraftRevisionRef.current === revision
      ) {
        setFileFeedback({ resourceId, type: 'error', message: '系统剪贴板不可用。' })
      }
    }
  }

  async function openMarkdownDraftFile(currentDraft: MarkdownDraft) {
    const resourceId = `draft:${currentDraft.id}`
    const revision = markdownDraftRevision(`${currentDraft.title}\0${currentDraft.text}`)
    setFileFeedback(null)
    try {
      const opened = await openMarkdownFile()
      if (!opened) return

      if (activeDraftResourceRef.current !== resourceId) return
      if (activeDraftRevisionRef.current !== revision) {
        setFileFeedback({
          resourceId,
          type: 'error',
          message: '选择文件期间文稿已更新，为避免覆盖当前修改，请重新打开文件。',
        })
        return
      }

      const nextDraft = createMarkdownFileDraft(opened.fileName, opened.text)
      setDraft(nextDraft)
      persistMarkdownDraft(nextDraft)
    } catch (error) {
      if (activeDraftResourceRef.current !== resourceId) return
      setFileFeedback({
        resourceId,
        type: 'error',
        message: errorMessage(error, '打开 Markdown 文件失败。'),
      })
    }
  }

  async function saveMarkdownDraft(currentDraft: MarkdownDraft) {
    if (saveBusy) return
    if (!currentDraft.text.trim()) {
      setFileFeedback({
        resourceId: `draft:${currentDraft.id}`,
        type: 'error',
        message: '没有可保存的 Markdown 内容。',
      })
      return
    }

    setFileFeedback(null)
    const fileName = markdownSaveFileName(currentDraft)
    const fingerprint = markdownSaveFingerprint(currentDraft)
    const snapshot = await applyFileCommand(
      runSaveMarkdownFile(saveKey, fileName, currentDraft.text, fingerprint),
      '保存 Markdown 失败。',
      saveKey.resourceId,
    )
    if (snapshot?.outcome.status === 'success') {
      setDraft((latest) => {
        if (
          latest.id !== currentDraft.id ||
          markdownSaveFingerprint(latest) !== snapshot.requestFingerprint
        )
          return latest
        const saved = { ...latest, dirty: false, updatedAt: new Date().toISOString() }
        persistMarkdownDraft(saved)
        return saved
      })
    }
  }

  async function exportMarkdownDraftDocx(currentDraft: MarkdownDraft) {
    if (exportBusy) return
    if (!currentDraft.text.trim()) {
      setFileFeedback({
        resourceId: `draft:${currentDraft.id}`,
        type: 'error',
        message: '没有可导出的 Markdown 内容。',
      })
      return
    }

    setFileFeedback(null)
    const input = {
      app_name: APP_NAME,
      window_title: currentDraft.title || 'Markdown 文稿',
      app_type: 'Markdown',
      text: currentDraft.text,
      elapsed_ms: 0,
      model: 'Markdown Editor',
      source_kind: 'editor',
      source_name: currentDraft.title || 'Markdown 文稿',
    }
    await applyFileCommand(
      runExportMarkdownDocx(
        exportKey,
        input,
        markdownDraftRevision(`${currentDraft.title}\0${currentDraft.text}`),
        true,
      ),
      '导出 Word 失败。',
      exportKey.resourceId,
    )
  }

  async function applyFileCommand(
    command: Promise<FileCommandSnapshot>,
    fallback: string,
    feedbackResourceId: string,
  ) {
    try {
      const snapshot = await command
      acceptFileCommand(snapshot)
      if (snapshot.outcome.status === 'running') return snapshot
      if (snapshot.key.resourceId !== activeDraftResourceRef.current) return snapshot
      const result = await consumeFileCommand(snapshot)
      if (result === 'consumed') showStandaloneFileOutcome(snapshot, fallback)
      return snapshot
    } catch (error) {
      setFileFeedback({
        resourceId: feedbackResourceId,
        type: 'error',
        message: errorMessage(error, fallback),
      })
      return null
    }
  }

  function showStandaloneFileOutcome(snapshot: FileCommandSnapshot, fallback: string) {
    if (snapshot.outcome.status === 'success') {
      setFileFeedback({
        resourceId: snapshot.key.resourceId,
        type: 'success',
        message: `${snapshot.key.commandKind === 'exportDocx' ? 'Word' : 'Markdown'} 已保存到：${snapshot.outcome.path}`,
      })
    } else if (snapshot.outcome.status === 'error') {
      setFileFeedback({
        resourceId: snapshot.key.resourceId,
        type: 'error',
        message: errorMessage(snapshot.outcome.error, fallback),
      })
    }
  }

  async function runMarkdownDraftAi(request: MarkdownAiRequest) {
    if (!llmReady) throw new Error(llmUnavailableMessage)

    const prompt = buildMarkdownAiPrompt(request)
    const context = [
      `Markdown 文稿: ${request.title || '未命名'}`,
      `处理范围: ${request.usedFullDocument ? '全文' : '选区'}`,
    ].join('\n')
    const promptContext = mergeScenePresetContext(context, request.scenePreset ?? null)
    const key = {
      draftId: request.draftId!,
      request: {
        action: request.action,
        target: request.usedFullDocument
          ? { kind: 'fullDocument' as const }
          : {
              kind: 'selection' as const,
              start: request.selection.from,
              end: request.selection.to,
            },
        draftRevision: request.draftRevision!,
        semanticFingerprint: markdownSemanticFingerprint(
          request.title,
          promptContext ?? '',
          backendManaged
            ? `proxy:${desktopBootstrap?.apiBaseUrl ?? ''}`
            : `local:${config.llm_provider}:${config.llm_base_url}:${config.llm_model}`,
        ),
      },
    }

    if (backendManaged) {
      if (!desktopBootstrap?.apiBaseUrl || !desktopToken || !cloudLlmAvailable) {
        throw new Error(llmUnavailableMessage)
      }

      try {
        return await runProxyMarkdownAi(
          {
            key,
            question: prompt,
            sourceText: request.text,
            context: promptContext,
            applyContext: { fullText: request.fullText, text: request.text, title: request.title },
          },
          desktopBootstrap.apiBaseUrl,
          desktopToken,
        )
      } catch (error) {
        const message = errorMessage(error, 'AI 处理未完成，请稍后重试。', 'llm')
        throw new Error(message)
      }
    }

    if (!localLlmReady) throw new Error(llmUnavailableMessage)
    const localRequest = {
      question: prompt,
      provider: config.llm_provider,
      apiKey: config.llm_api_key,
      baseUrl: config.llm_base_url,
      model: config.llm_model,
      context: promptContext,
    }
    return runLocalMarkdownAi({
      key,
      question: prompt,
      retryQuestion:
        request.action === 'translate' && config.llm_provider === 'ollama'
          ? buildMarkdownTranslationRetryPrompt(request)
          : null,
      sourceText: request.text,
      context: promptContext,
      applyContext: { fullText: request.fullText, text: request.text, title: request.title },
      provider: localRequest.provider,
      apiKey: localRequest.apiKey,
      baseUrl: localRequest.baseUrl,
      model: localRequest.model,
    })
  }

  async function closeEditorWindow() {
    await notifyOwnerWindowDestroyed().catch(() => false)
    await getCurrentWindow()
      .close()
      .catch(() => window.close())
  }

  function clearAndCloseEditorWindow() {
    try {
      window.localStorage.removeItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)
      window.localStorage.removeItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)
    } catch (error) {
      console.warn('Markdown draft cleanup skipped:', error)
    }
    setFileFeedback(null)
    setDraft(createEmptyMarkdownDraft())
    closeEditorWindow()
  }

  const acceptRendererShellReady = useCallback(() => {
    const latestDraft = readActiveMarkdownDraft()
    if (latestDraft && serializeMarkdownDraft(latestDraft) !== serializeMarkdownDraft(draft)) {
      setDraft(latestDraft)
      setRendererShellEpoch((current) => current + 1)
      return
    }
    setRendererShellReady(true)
  }, [draft])

  if (startupState.status === 'loading') {
    return (
      <div className="echo-markdown-editor-window">
        <MarkdownEditorWindowLoading />
      </div>
    )
  }

  if (startupState.status === 'error') {
    return (
      <div className="echo-markdown-editor-window">
        <MarkdownEditorWindowStartupError message={startupState.message} />
        {windowGeneration !== null && <MarkdownEditorWindowReady generation={windowGeneration} />}
      </div>
    )
  }

  return (
    <div className="echo-markdown-editor-window">
      <Suspense fallback={<MarkdownEditorWindowLoading />}>
        <MarkdownEditorShell
          key={rendererShellEpoch}
          draft={draft}
          onDraftChange={updateDraft}
          onOpenMarkdown={openMarkdownDraftFile}
          onCopyMarkdown={(currentDraft) => void copyMarkdownDraft(currentDraft)}
          onSaveMarkdown={(currentDraft) => void saveMarkdownDraft(currentDraft)}
          onExportDocx={(currentDraft) => void exportMarkdownDraftDocx(currentDraft)}
          speechConfig={{
            available: ttsAvailable,
            apiBaseUrl: desktopBootstrap?.apiBaseUrl,
            token: desktopToken,
            voiceKey: cloudTts?.defaultVoice,
            unavailableMessage: backendManaged
              ? '后台托管 TTS 不可用，请先在主应用同步后台配置。'
              : '本机配置暂未启用 TTS 朗读。',
          }}
          onAiRequest={runMarkdownDraftAi}
          aiAvailable={llmReady}
          scenePresets={scenePresets}
          saveBusy={saveBusy}
          exportBusy={exportBusy}
          voiceAppendEnabled={voiceAppendEnabled}
          onVoiceAppendEnabledChange={updateVoiceAppendEnabled}
          fileFeedback={visibleFileFeedback}
          onDismissFileFeedback={() => setFileFeedback(null)}
          onClose={closeEditorWindow}
          onClearAndClose={clearAndCloseEditorWindow}
          onRendererReady={acceptRendererShellReady}
          draggableTitlebar
          modal={false}
        />
        {rendererShellReady && windowGeneration !== null && (
          <MarkdownEditorWindowReady generation={windowGeneration} />
        )}
      </Suspense>
    </div>
  )
}

function markdownSaveFileName(draft: MarkdownDraft) {
  return safeDownloadFileName(`${draft.title || 'echolike-markdown'}.md`, 'echolike-markdown.md')
}

function markdownSaveFingerprint(draft: MarkdownDraft) {
  return markdownDraftRevision(`${markdownSaveFileName(draft)}\0${draft.text}`)
}

function markStandaloneDraftSavedIfMatching(draft: MarkdownDraft, snapshot: FileCommandSnapshot) {
  if (
    snapshot.key.resourceId !== `draft:${draft.id}` ||
    markdownSaveFingerprint(draft) !== snapshot.requestFingerprint
  ) {
    return draft
  }
  const saved = { ...draft, dirty: false, updatedAt: new Date().toISOString() }
  persistMarkdownDraft(saved)
  return saved
}

function MarkdownEditorWindowLoading() {
  return (
    <section
      className="echo-dialog echo-markdown-conflict-dialog"
      aria-label="正在打开 Markdown 编辑器"
    >
      <div className="echo-dialog-body">
        <section className="echo-screen-state-panel">
          <strong>正在打开编辑器</strong>
          <p>Markdown 工作区加载中。</p>
        </section>
      </div>
    </section>
  )
}

function MarkdownEditorWindowStartupError({ message }: { message: string }) {
  return (
    <section
      className="echo-renderer-error-screen echo-markdown-renderer-error-screen"
      role="alert"
    >
      <h2 className="echo-renderer-error-title">Markdown 编辑器未能启动</h2>
      <p className="echo-renderer-error-message">{message}</p>
    </section>
  )
}
