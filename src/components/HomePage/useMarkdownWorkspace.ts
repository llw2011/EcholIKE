import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APP_NAME } from '../../lib/branding'
import { safeDownloadFileName } from '../../lib/fileNames'
import { currentMarkdownEditorWindowBackgroundColor } from '../../lib/markdownWindowLifecycle'
import { responsiveMarkdownEditorWindowSize } from '../../lib/markdownWindowSize'
import { mergeScenePresetContext, type ScenePreset } from '../../lib/scenePresets'
import {
  beginMarkdownEditorWindow,
  openMarkdownFile,
  runExportMarkdownDocx,
  runLocalMarkdownAi,
  runProxyMarkdownAi,
  runSaveMarkdownFile,
  type FileCommandOwnerKey,
  type FileCommandSnapshot,
} from '../../lib/tauri'
import { toast } from '../../lib/toast'
import { userFacingErrorMessage } from '../../lib/userErrors'
import { useAppStore } from '../../stores/appStore'
import { fileCommandIdentity, useFileCommandDomain } from '../../stores/fileCommandStore'
import {
  buildMarkdownAiPrompt,
  buildMarkdownTranslationRetryPrompt,
  type MarkdownAiRequest,
} from '../MarkdownEditor/markdownAi'
import {
  ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
  appendMarkdownText,
  createMarkdownFileDraft,
  MARKDOWN_VOICE_APPEND_STORAGE_KEY,
  parseMarkdownDraft,
  parseMarkdownVoiceAppendEnabled,
  parseRecentMarkdownDraft,
  RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
  serializeMarkdownDraft,
  serializeRecentMarkdownDraft,
  type MarkdownDraft,
  type MarkdownEditorSource,
} from '../MarkdownEditor/markdownDraft'
import {
  latestMarkdownAiTask,
  latestRunningMarkdownAiTask,
  markdownDraftRevision,
  markdownSemanticFingerprint,
  useMarkdownAiDomain,
} from '../MarkdownEditor/markdownAiTask'

export type MarkdownOpenRequest = {
  title: string
  text: string
  source: MarkdownEditorSource
  sourceName?: string
}

export type MarkdownOpenMode = 'new' | 'append' | 'replace'

type UseMarkdownWorkspaceOptions = {
  backendManaged: boolean
  desktopToken: string | null
  cloudLlmAvailable: boolean
  localLlmReady: boolean
  llmReady: boolean
  llmUnavailableMessage: string
  selectedScenePreset: ScenePreset | null
}

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

function isTauriRuntime() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

async function openStandaloneMarkdownEditorWindow() {
  if (!isTauriRuntime()) return false

  try {
    const [{ emitTo }, { primaryMonitor }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/window'),
    ])
    const label = 'markdown-editor'
    const editorSize = responsiveMarkdownEditorWindowSize(await primaryMonitor().catch(() => null))
    const decision = await beginMarkdownEditorWindow({
      width: editorSize.width,
      height: editorSize.height,
      minWidth: editorSize.minWidth,
      minHeight: editorSize.minHeight,
      backgroundColor: currentMarkdownEditorWindowBackgroundColor(),
    })
    if (decision.status !== 'create') {
      await emitTo(label, 'markdown-editor:load-draft').catch(() => undefined)
    }
    return true
  } catch (error) {
    console.warn('Standalone Markdown editor window skipped:', error)
    return false
  }
}

function markdownDraftId() {
  return `markdown-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createMarkdownDraft(request: MarkdownOpenRequest): MarkdownDraft {
  const now = new Date().toISOString()
  return {
    id: markdownDraftId(),
    title: request.title.trim() || 'Markdown 文稿',
    text: request.text,
    source: request.source,
    sourceName: request.sourceName,
    createdAt: now,
    updatedAt: now,
    dirty: false,
  }
}

function activeMarkdownDraft() {
  return parseMarkdownDraft(readLocalStorageItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY))
}

function persistActiveMarkdownDraft(draft: MarkdownDraft) {
  writeLocalStorageItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY, serializeMarkdownDraft(draft))
}

function markdownDraftFileName(draft: MarkdownDraft) {
  return safeDownloadFileName(`${draft.title || 'echolike-markdown'}.md`, 'echolike-markdown.md')
}

function markdownDraftSaveFingerprint(draft: MarkdownDraft) {
  return markdownDraftRevision(`${markdownDraftFileName(draft)}\0${draft.text}`)
}

export function useMarkdownWorkspace({
  backendManaged,
  desktopToken,
  cloudLlmAvailable,
  localLlmReady,
  llmReady,
  llmUnavailableMessage,
  selectedScenePreset,
}: UseMarkdownWorkspaceOptions) {
  const config = useAppStore((state) => state.config)
  const desktopBootstrap = useAppStore((state) => state.desktopBootstrap)
  const completedVoiceText = useAppStore((state) => state.completedVoiceText)
  const completedVoiceTextVersion = useAppStore((state) => state.completedVoiceTextVersion)
  const fileTasks = useFileCommandDomain((state) => state.tasks)
  const acceptFileCommand = useFileCommandDomain((state) => state.accept)
  const consumeFileCommand = useFileCommandDomain((state) => state.consume)
  const markdownFileFeedback = useFileCommandDomain((state) => state.markdownFeedback)
  const setMarkdownFileFeedback = useFileCommandDomain((state) => state.setMarkdownFeedback)
  const [markdownDraft, setMarkdownDraft] = useState<MarkdownDraft | null>(null)
  const [markdownEditorOpen, setMarkdownEditorOpen] = useState(false)
  const markdownAiTaskSnapshot = useMarkdownAiDomain((state) =>
    markdownDraft ? state.byDraft[markdownDraft.id] : undefined,
  )
  const markdownAiTasks = markdownAiTaskSnapshot ?? []
  const localMarkdownAiPending = useMarkdownAiDomain((state) =>
    markdownDraft ? (state.localPendingByDraft[markdownDraft.id] ?? null) : null,
  )
  const markdownAiRevision = markdownDraft
    ? markdownDraftRevision(`${markdownDraft.title}\0${markdownDraft.text}`)
    : ''
  const markdownAiLocked = Boolean(
    (markdownEditorOpen && markdownDraft && markdownAiTaskSnapshot === undefined) ||
    localMarkdownAiPending ||
    latestRunningMarkdownAiTask(markdownAiTasks) ||
    latestMarkdownAiTask(
      markdownAiTasks,
      (task) =>
        task.outcome.status === 'success' && task.key.request.draftRevision === markdownAiRevision,
    ),
  )
  const markdownEditorOpenRef = useRef(false)
  const markdownDraftResourceRef = useRef('')
  const markdownDraftRevisionRef = useRef('')
  const updateMarkdownEditorOpen = useCallback((open: boolean) => {
    markdownEditorOpenRef.current = open
    setMarkdownEditorOpen(open)
  }, [])
  const [markdownEditorOpening, setMarkdownEditorOpening] = useState(false)
  const [pendingMarkdownRequest, setPendingMarkdownRequest] = useState<MarkdownOpenRequest | null>(
    null,
  )
  const handledFileOutcomesRef = useRef(new Set<string>())
  const [restorableMarkdownDraft, setRestorableMarkdownDraft] = useState<MarkdownDraft | null>(() =>
    parseRecentMarkdownDraft(readLocalStorageItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)),
  )
  const [markdownVoiceAppendEnabled, setMarkdownVoiceAppendEnabled] = useState(() =>
    parseMarkdownVoiceAppendEnabled(readLocalStorageItem(MARKDOWN_VOICE_APPEND_STORAGE_KEY)),
  )
  const handledMarkdownVoiceResultVersionRef = useRef(completedVoiceTextVersion)
  const queuedMarkdownVoiceAppendRef = useRef<
    Array<{ draftId: string; version: number; text: string }>
  >([])
  const draftResourceId = markdownDraft ? `draft:${markdownDraft.id}` : ''
  markdownDraftResourceRef.current = draftResourceId
  markdownDraftRevisionRef.current = markdownDraft
    ? markdownDraftRevision(`${markdownDraft.title}\0${markdownDraft.text}`)
    : ''
  const visibleMarkdownFileFeedback =
    markdownFileFeedback?.resourceId === draftResourceId ? markdownFileFeedback : null
  const draftSaveKey = useMemo<FileCommandOwnerKey>(
    () => ({ resourceId: draftResourceId, commandKind: 'saveMarkdown' }),
    [draftResourceId],
  )
  const draftDocxKey = useMemo<FileCommandOwnerKey>(
    () => ({ resourceId: draftResourceId, commandKind: 'exportDocx' }),
    [draftResourceId],
  )
  const isRunning = (key: FileCommandOwnerKey) =>
    fileTasks[fileCommandIdentity(key)]?.outcome.status === 'running'
  const draftDocxExportBusy = draftResourceId ? isRunning(draftDocxKey) : false
  const markdownSaveBusy = draftResourceId ? isRunning(draftSaveKey) : false
  const canResumeMarkdownDraft = Boolean(
    markdownDraft &&
    !markdownEditorOpen &&
    !markdownEditorOpening &&
    (markdownDraft.dirty || markdownDraft.text.trim()),
  )

  useEffect(() => {
    return () => {
      markdownEditorOpenRef.current = false
    }
  }, [])

  useEffect(() => {
    for (const snapshot of Object.values(fileTasks)) {
      if (snapshot.ownerWindow && snapshot.ownerWindow !== 'main') continue
      if (!snapshot.key.resourceId.startsWith('draft:')) continue
      if (!markdownEditorOpenRef.current) continue
      if (snapshot.key.resourceId !== draftResourceId || snapshot.outcome.status === 'running')
        continue
      const token = `${fileCommandIdentity(snapshot.key)}:${snapshot.outcome.leaseId}`
      if (handledFileOutcomesRef.current.has(token)) continue
      void applyRecoveredFileOutcome(snapshot, token)
    }
  }, [consumeFileCommand, draftResourceId, fileTasks, markdownEditorOpen])

  function updateMarkdownVoiceAppendEnabled(enabled: boolean) {
    setMarkdownVoiceAppendEnabled(enabled)
    if (!enabled) queuedMarkdownVoiceAppendRef.current = []
    writeLocalStorageItem(MARKDOWN_VOICE_APPEND_STORAGE_KEY, enabled ? 'true' : 'false')
  }

  useEffect(() => {
    if (!markdownDraft) return

    persistActiveMarkdownDraft(markdownDraft)
    if (markdownDraft.dirty && markdownDraft.text.trim()) {
      writeLocalStorageItem(
        RECENT_MARKDOWN_DRAFT_STORAGE_KEY,
        serializeRecentMarkdownDraft(markdownDraft),
      )
      return
    }

    removeLocalStorageItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)
  }, [markdownDraft])

  useEffect(() => {
    function handleMarkdownStorage(event: StorageEvent) {
      if (event.key === ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY && event.newValue === null) {
        setMarkdownFileFeedback(null)
        setMarkdownDraft(null)
        updateMarkdownEditorOpen(false)
      }
      if (event.key === RECENT_MARKDOWN_DRAFT_STORAGE_KEY && event.newValue === null) {
        setRestorableMarkdownDraft(null)
      }
      if (event.key === MARKDOWN_VOICE_APPEND_STORAGE_KEY) {
        setMarkdownVoiceAppendEnabled(parseMarkdownVoiceAppendEnabled(event.newValue))
      }
    }

    window.addEventListener('storage', handleMarkdownStorage)
    return () => window.removeEventListener('storage', handleMarkdownStorage)
  }, [setMarkdownFileFeedback, updateMarkdownEditorOpen])

  useEffect(() => {
    if (!markdownEditorOpen) {
      handledMarkdownVoiceResultVersionRef.current = completedVoiceTextVersion
      return
    }

    if (handledMarkdownVoiceResultVersionRef.current === completedVoiceTextVersion) return
    handledMarkdownVoiceResultVersionRef.current = completedVoiceTextVersion

    const nextText = completedVoiceText.trim()
    if (!markdownVoiceAppendEnabled || !nextText) return

    if (markdownAiLocked && markdownDraft) {
      queuedMarkdownVoiceAppendRef.current.push({
        draftId: markdownDraft.id,
        version: completedVoiceTextVersion,
        text: nextText,
      })
      return
    }

    setMarkdownFileFeedback(null)
    setMarkdownDraft((current) => {
      if (!current) return current
      return {
        ...current,
        text: appendMarkdownText(current.text, nextText),
        updatedAt: new Date().toISOString(),
        dirty: true,
      }
    })
  }, [
    completedVoiceText,
    completedVoiceTextVersion,
    markdownAiLocked,
    markdownDraft,
    markdownEditorOpen,
    markdownVoiceAppendEnabled,
    setMarkdownFileFeedback,
  ])

  useEffect(() => {
    if (
      !markdownEditorOpen ||
      !markdownDraft ||
      markdownAiLocked ||
      !markdownVoiceAppendEnabled ||
      queuedMarkdownVoiceAppendRef.current.length === 0
    ) {
      return
    }
    const queued = queuedMarkdownVoiceAppendRef.current.filter(
      (item) => item.draftId === markdownDraft.id,
    )
    if (queued.length === 0) return
    queuedMarkdownVoiceAppendRef.current = queuedMarkdownVoiceAppendRef.current.filter(
      (item) => item.draftId !== markdownDraft.id,
    )
    setMarkdownFileFeedback(null)
    setMarkdownDraft((current) => {
      if (!current || current.id !== markdownDraft.id) return current
      return {
        ...current,
        text: queued.reduce((text, item) => appendMarkdownText(text, item.text), current.text),
        updatedAt: new Date().toISOString(),
        dirty: true,
      }
    })
  }, [
    markdownAiLocked,
    markdownDraft,
    markdownEditorOpen,
    markdownVoiceAppendEnabled,
    setMarkdownFileFeedback,
  ])

  function requestOpenMarkdownEditor(request: MarkdownOpenRequest) {
    if (!request.text.trim()) {
      toast('没有可整理的 Markdown 内容。', 'info')
      return
    }

    if (markdownDraft?.dirty || activeMarkdownDraft()?.dirty) {
      setPendingMarkdownRequest(request)
      return
    }

    void applyMarkdownOpenRequest(request, 'new')
  }

  async function openBlankMarkdownEditor() {
    const currentDraft = activeMarkdownDraft() ?? markdownDraft
    if (currentDraft?.dirty) {
      await openMarkdownDraft(currentDraft)
      return
    }

    await openMarkdownDraft(
      createMarkdownDraft({
        title: '未命名文稿',
        text: '',
        source: 'manual',
        sourceName: '手动写作',
      }),
    )
  }

  async function restoreRecentMarkdownDraft() {
    if (!restorableMarkdownDraft) return
    await openMarkdownDraft(restorableMarkdownDraft)
    setRestorableMarkdownDraft(null)
  }

  function discardRecentMarkdownDraft() {
    removeLocalStorageItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)
    setRestorableMarkdownDraft(null)
    toast('已丢弃上次未保存的 Markdown 草稿。', 'info')
  }

  function clearAndCloseMarkdownEditor() {
    removeLocalStorageItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)
    removeLocalStorageItem(RECENT_MARKDOWN_DRAFT_STORAGE_KEY)
    setRestorableMarkdownDraft(null)
    setMarkdownFileFeedback(null)
    setMarkdownDraft(null)
    updateMarkdownEditorOpen(false)
    toast('Markdown 文稿已清空。', 'info')
  }

  async function openMarkdownDraft(draft: MarkdownDraft) {
    setMarkdownEditorOpening(true)
    if (markdownFileFeedback?.resourceId !== `draft:${draft.id}`) {
      setMarkdownFileFeedback(null)
    }
    setMarkdownDraft(draft)
    persistActiveMarkdownDraft(draft)

    try {
      if (await openStandaloneMarkdownEditorWindow()) {
        updateMarkdownEditorOpen(false)
        return
      }

      updateMarkdownEditorOpen(true)
    } finally {
      setMarkdownEditorOpening(false)
    }
  }

  async function applyMarkdownOpenRequest(request: MarkdownOpenRequest, mode: MarkdownOpenMode) {
    const now = new Date().toISOString()
    const currentDraft = activeMarkdownDraft() ?? markdownDraft
    const nextDraft =
      mode === 'append' && currentDraft
        ? {
            ...currentDraft,
            text: appendMarkdownText(currentDraft.text, request.text),
            sourceName: currentDraft.sourceName || request.sourceName,
            updatedAt: now,
            dirty: true,
          }
        : createMarkdownDraft(request)

    setPendingMarkdownRequest(null)
    await openMarkdownDraft(nextDraft)
  }

  async function appendMarkdownRequest(request: MarkdownOpenRequest) {
    const currentDraft = activeMarkdownDraft() ?? markdownDraft
    const nextDraft = currentDraft
      ? {
          ...currentDraft,
          text: appendMarkdownText(currentDraft.text, request.text),
          updatedAt: new Date().toISOString(),
          dirty: true,
        }
      : createMarkdownDraft(request)
    await openMarkdownDraft(nextDraft)
  }

  function updateMarkdownDraft(draft: MarkdownDraft) {
    setMarkdownFileFeedback(null)
    setMarkdownDraft(draft)
  }

  async function copyMarkdownDraft(draft: MarkdownDraft) {
    if (!draft.text.trim()) return
    const resourceId = `draft:${draft.id}`
    const revision = markdownDraftRevision(`${draft.title}\0${draft.text}`)
    setMarkdownFileFeedback(null)
    try {
      await navigator.clipboard.writeText(draft.text)
      const current = activeMarkdownDraft()
      if (
        current?.id === draft.id &&
        markdownDraftRevision(`${current.title}\0${current.text}`) === revision
      ) {
        setMarkdownFileFeedback({ resourceId, type: 'success', message: 'Markdown 已复制。' })
      }
    } catch {
      const current = activeMarkdownDraft()
      if (
        current?.id === draft.id &&
        markdownDraftRevision(`${current.title}\0${current.text}`) === revision
      ) {
        setMarkdownFileFeedback({
          resourceId,
          type: 'error',
          message: '系统剪贴板不可用。',
        })
      }
    }
  }

  async function openMarkdownDraftFile(draft: MarkdownDraft) {
    const resourceId = `draft:${draft.id}`
    const revision = markdownDraftRevision(`${draft.title}\0${draft.text}`)
    setMarkdownFileFeedback(null)
    try {
      const opened = await openMarkdownFile()
      if (!opened) return

      if (markdownDraftResourceRef.current !== resourceId) return
      if (markdownDraftRevisionRef.current !== revision) {
        setMarkdownFileFeedback({
          resourceId,
          type: 'error',
          message: '选择文件期间文稿已更新，为避免覆盖当前修改，请重新打开文件。',
        })
        return
      }

      const nextDraft = createMarkdownFileDraft(opened.fileName, opened.text)
      setMarkdownDraft(nextDraft)
      setRestorableMarkdownDraft(null)
    } catch (error) {
      if (markdownDraftResourceRef.current !== resourceId) return
      setMarkdownFileFeedback({
        resourceId,
        type: 'error',
        message: userFacingErrorMessage(error, '打开 Markdown 文件失败。'),
      })
    }
  }

  async function saveMarkdownDraft(draft: MarkdownDraft) {
    if (markdownSaveBusy) return
    if (!draft.text.trim()) {
      setMarkdownFileFeedback({
        resourceId: draftResourceId,
        type: 'error',
        message: '没有可保存的 Markdown 内容。',
      })
      return
    }

    setMarkdownFileFeedback(null)
    const fileName = markdownDraftFileName(draft)
    const fingerprint = markdownDraftSaveFingerprint(draft)
    const snapshot = await runAndApplyFileCommand(
      runSaveMarkdownFile(draftSaveKey, fileName, draft.text, fingerprint),
      '保存 Markdown 失败。',
      draftResourceId,
    )
    if (snapshot?.outcome.status === 'success') {
      setMarkdownDraft((current) =>
        current?.id === draft.id &&
        markdownDraftSaveFingerprint(current) === snapshot.requestFingerprint
          ? { ...current, dirty: false, updatedAt: new Date().toISOString() }
          : current,
      )
    }
  }

  async function exportMarkdownDraftDocx(draft: MarkdownDraft) {
    if (!draft.text.trim()) {
      setMarkdownFileFeedback({
        resourceId: draftResourceId,
        type: 'error',
        message: '没有可导出的 Markdown 内容。',
      })
      return
    }

    setMarkdownFileFeedback(null)
    const input = {
      app_name: APP_NAME,
      window_title: draft.title || 'Markdown 文稿',
      app_type: 'Markdown',
      text: draft.text,
      elapsed_ms: 0,
      model: 'Markdown Editor',
      source_kind: 'editor',
      source_name: draft.title || 'Markdown 文稿',
    }
    await runAndApplyFileCommand(
      runExportMarkdownDocx(
        draftDocxKey,
        input,
        markdownDraftRevision(`${draft.title}\0${draft.text}`),
        true,
      ),
      '导出 Word 失败。',
      draftResourceId,
    )
  }

  async function runAndApplyFileCommand(
    command: Promise<FileCommandSnapshot>,
    fallback: string,
    feedbackResourceId = '',
  ) {
    try {
      const snapshot = await command
      acceptFileCommand(snapshot)
      if (snapshot.outcome.status === 'running') return snapshot
      if (
        !markdownEditorOpenRef.current ||
        snapshot.key.resourceId !== markdownDraftResourceRef.current
      ) {
        return snapshot
      }
      const result = await consumeFileCommand(snapshot)
      if (result === 'consumed') showFileOutcome(snapshot, fallback)
      return snapshot
    } catch (error) {
      const message = userFacingErrorMessage(error, fallback)
      setMarkdownFileFeedback({ resourceId: feedbackResourceId, type: 'error', message })
      return null
    }
  }

  async function applyRecoveredFileOutcome(snapshot: FileCommandSnapshot, token: string) {
    const result = await consumeFileCommand(snapshot)
    if (result === 'stale') return
    handledFileOutcomesRef.current.add(token)
    if (snapshot.key.commandKind === 'saveMarkdown' && snapshot.outcome.status === 'success') {
      setMarkdownDraft((current) => {
        if (
          !current ||
          snapshot.key.resourceId !== `draft:${current.id}` ||
          markdownDraftSaveFingerprint(current) !== snapshot.requestFingerprint
        ) {
          return current
        }
        return { ...current, dirty: false, updatedAt: new Date().toISOString() }
      })
    }
    if (result === 'consumed') {
      showFileOutcome(snapshot, '文件操作失败。')
    }
  }

  function showFileOutcome(snapshot: FileCommandSnapshot, fallback: string) {
    if (snapshot.outcome.status === 'success') {
      const prefix =
        snapshot.key.commandKind === 'exportPdf'
          ? snapshot.outcome.message
          : snapshot.key.commandKind === 'exportDocx'
            ? 'Word 已保存到'
            : 'Markdown 已保存到'
      const message = `${prefix}：${snapshot.outcome.path}`
      setMarkdownFileFeedback({ resourceId: snapshot.key.resourceId, type: 'success', message })
    } else if (snapshot.outcome.status === 'error') {
      const message = userFacingErrorMessage(snapshot.outcome.error, fallback)
      setMarkdownFileFeedback({ resourceId: snapshot.key.resourceId, type: 'error', message })
    }
  }

  async function runMarkdownDraftAi(request: MarkdownAiRequest) {
    if (!llmReady) throw new Error(llmUnavailableMessage)

    const context = [
      `Markdown 文稿: ${request.title || '未命名'}`,
      `处理范围: ${request.usedFullDocument ? '全文' : '选区'}`,
    ].join('\n')
    const promptContext = mergeScenePresetContext(
      context,
      request.scenePreset ?? selectedScenePreset,
    )
    const key = {
      draftId: request.draftId!,
      request: {
        action: request.action,
        target: request.usedFullDocument
          ? ({ kind: 'fullDocument' } as const)
          : ({
              kind: 'selection',
              start: request.selection.from,
              end: request.selection.to,
            } as const),
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
    const common = {
      key,
      question: buildMarkdownAiPrompt(request),
      sourceText: request.text,
      context: promptContext,
      applyContext: { fullText: request.fullText, text: request.text, title: request.title },
    }
    if (backendManaged) {
      if (!desktopBootstrap?.apiBaseUrl || !desktopToken || !cloudLlmAvailable) {
        throw new Error(llmUnavailableMessage)
      }
      return runProxyMarkdownAi(common, desktopBootstrap.apiBaseUrl, desktopToken)
    }
    if (!localLlmReady) throw new Error(llmUnavailableMessage)
    return runLocalMarkdownAi({
      ...common,
      retryQuestion:
        request.action === 'translate' && config.llm_provider === 'ollama'
          ? buildMarkdownTranslationRetryPrompt(request)
          : null,
      provider: config.llm_provider,
      apiKey: config.llm_api_key,
      baseUrl: config.llm_base_url,
      model: config.llm_model,
    })
  }

  return {
    applyMarkdownOpenRequest,
    appendMarkdownRequest,
    canResumeMarkdownDraft,
    cancelPendingMarkdownRequest: () => setPendingMarkdownRequest(null),
    clearAndCloseMarkdownEditor,
    clearMarkdownFileFeedback: () => setMarkdownFileFeedback(null),
    closeMarkdownEditor: () => updateMarkdownEditorOpen(false),
    copyMarkdownDraft,
    discardRecentMarkdownDraft,
    dismissRestorableMarkdownDraft: () => setRestorableMarkdownDraft(null),
    draftDocxExportBusy,
    exportMarkdownDraftDocx,
    markdownDraft,
    markdownEditorOpen,
    markdownEditorOpening,
    markdownSaveBusy,
    markdownVoiceAppendEnabled,
    openBlankMarkdownEditor,
    openMarkdownDraft,
    openMarkdownDraftFile,
    pendingMarkdownRequest,
    requestOpenMarkdownEditor,
    restorableMarkdownDraft,
    restoreRecentMarkdownDraft,
    runMarkdownDraftAi,
    saveMarkdownDraft,
    updateMarkdownDraft,
    updateMarkdownVoiceAppendEnabled,
    visibleMarkdownFileFeedback,
  }
}
