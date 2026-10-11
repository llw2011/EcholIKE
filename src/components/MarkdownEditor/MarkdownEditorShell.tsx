import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  Clipboard,
  Columns2,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Languages,
  Loader2,
  Mic,
  Pencil,
  Sparkles,
  Trash2,
  Volume2,
  Wand2,
  X,
} from 'lucide-react'
import { MarkdownEditorInput } from './MarkdownEditorInput'
import { MarkdownEditorPreview } from './MarkdownEditorPreview'
import { MarkdownEditorToolbar } from './MarkdownEditorToolbar'
import { MarkdownSpeechDialog } from './MarkdownSpeechDialog'
import {
  applyMarkdownAction,
  type MarkdownAction,
  type MarkdownTextSelection,
} from './markdownActions'
import {
  applyMarkdownAiResult,
  getMarkdownAiTarget,
  markdownAiActionLabel,
  type MarkdownAiAction,
  type MarkdownAiApplyMode,
  type MarkdownAiRequest,
  type MarkdownAiResult,
} from './markdownAi'
import { markdownDraftStats, markdownSourceLabel, type MarkdownDraft } from './markdownDraft'
import { getMarkdownEditorThemeKey } from './markdownEditorTheme'
import { userFacingErrorMessage } from '../../lib/userErrors'
import type { MarkdownAiTaskSnapshot } from '../../lib/tauri'
import {
  latestMarkdownAiTask,
  latestRunningMarkdownAiTask,
  markdownDraftRevision,
  useMarkdownAiDomain,
} from './markdownAiTask'
import { ScenePresetSelect } from '../ScenePresetSelect'
import { Tooltip } from '../Tooltip'
import {
  DEFAULT_SCENE_PRESET_ID,
  findScenePreset,
  scenePresetOptions,
  type ScenePreset,
} from '../../lib/scenePresets'
import {
  createMarkdownScrollCoordinator,
  type MarkdownScrollCoordinator,
  type MarkdownScrollSide,
  type MarkdownScrollSurface,
} from './markdownScrollSync'
import {
  markdownSpeechButtonLabel,
  useMarkdownSpeech,
  type MarkdownSpeechConfig,
} from './markdownSpeech'

export type MarkdownEditorViewMode = 'edit' | 'preview' | 'split'

export interface MarkdownEditorFileFeedback {
  resourceId?: string
  type: 'success' | 'error'
  message: string
}

export interface MarkdownEditorShellProps {
  draft: MarkdownDraft
  initialMode?: MarkdownEditorViewMode
  onDraftChange?: (draft: MarkdownDraft) => void
  onOpenMarkdown?: (draft: MarkdownDraft) => void | Promise<void>
  onCopyMarkdown?: (draft: MarkdownDraft) => void | Promise<void>
  onSaveMarkdown?: (draft: MarkdownDraft) => void | Promise<void>
  onExportDocx?: (draft: MarkdownDraft) => void | Promise<void>
  speechConfig?: MarkdownSpeechConfig
  onAiRequest?: (request: MarkdownAiRequest) => Promise<MarkdownAiTaskSnapshot | string>
  aiAvailable?: boolean
  scenePresets?: ScenePreset[]
  saveBusy?: boolean
  exportBusy?: boolean
  voiceAppendEnabled?: boolean
  onVoiceAppendEnabledChange?: (enabled: boolean) => void
  fileFeedback?: MarkdownEditorFileFeedback | null
  onDismissFileFeedback?: () => void
  onClose?: () => void
  onClearAndClose?: () => void | Promise<void>
  onRendererReady?: () => void
  draggableTitlebar?: boolean
  modal?: boolean
}

const viewModes: Array<{
  value: MarkdownEditorViewMode
  label: string
  icon: typeof Pencil
}> = [
  { value: 'edit', label: '编辑', icon: Pencil },
  { value: 'preview', label: '预览', icon: Eye },
  { value: 'split', label: '分屏', icon: Columns2 },
]

const MARKDOWN_SCROLL_SYNC_STORAGE_KEY = 'echolike.markdownEditor.scrollSync.v1'

export function MarkdownEditorShell({
  draft,
  initialMode,
  onDraftChange,
  onOpenMarkdown,
  onCopyMarkdown,
  onSaveMarkdown,
  onExportDocx,
  speechConfig,
  onAiRequest,
  aiAvailable = false,
  scenePresets: scenePresetInput,
  saveBusy = false,
  exportBusy = false,
  voiceAppendEnabled = true,
  onVoiceAppendEnabledChange,
  fileFeedback = null,
  onDismissFileFeedback,
  onClose,
  onClearAndClose,
  onRendererReady,
  draggableTitlebar = false,
  modal = true,
}: MarkdownEditorShellProps) {
  const [workingDraft, setWorkingDraft] = useState(draft)
  const [mode, setMode] = useState<MarkdownEditorViewMode>(() => initialMode ?? defaultViewMode())
  const [editorSelection, setEditorSelection] = useState<MarkdownTextSelection>(() =>
    endSelection(draft.text),
  )
  const [requestedSelection, setRequestedSelection] = useState<MarkdownTextSelection | null>(null)
  const draftAiTasks = useMarkdownAiDomain((state) => state.byDraft[draft.id])
  const aiTasks = draftAiTasks ?? []
  const syncAiDraft = useMarkdownAiDomain((state) => state.syncDraft)
  const acceptAiTask = useMarkdownAiDomain((state) => state.accept)
  const consumeAiTask = useMarkdownAiDomain((state) => state.consume)
  const localAiPending = useMarkdownAiDomain((state) => state.localPendingByDraft[draft.id] ?? null)
  const tryStartLocalAi = useMarkdownAiDomain((state) => state.tryStartLocal)
  const finishLocalAi = useMarkdownAiDomain((state) => state.finishLocal)
  const aiTaskRecoveryEnabled = Boolean(onAiRequest)
  const [aiSyncing, setAiSyncing] = useState(
    () => aiTaskRecoveryEnabled && draftAiTasks === undefined,
  )
  const [aiApplying, setAiApplying] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [clearConfirmBusy, setClearConfirmBusy] = useState(false)
  const [clearConfirmError, setClearConfirmError] = useState('')
  const [openConfirmOpen, setOpenConfirmOpen] = useState(false)
  const [openBusy, setOpenBusy] = useState(false)
  const openInFlightRef = useRef(false)
  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(readMarkdownScrollSyncPreference)
  const [editorScrollSurface, setEditorScrollSurface] = useState<MarkdownScrollSurface | null>(null)
  const [previewScrollSurface, setPreviewScrollSurface] = useState<MarkdownScrollSurface | null>(
    null,
  )
  const [panesSideBySide, setPanesSideBySide] = useState(false)
  const [initialLayoutMeasured, setInitialLayoutMeasured] = useState(false)
  const [fontsReady, setFontsReady] = useState(() => typeof document.fonts === 'undefined')
  const editorPaneRef = useRef<HTMLElement | null>(null)
  const previewPaneRef = useRef<HTMLElement | null>(null)
  const editorGridRef = useRef<HTMLDivElement | null>(null)
  const scrollCoordinatorRef = useRef<MarkdownScrollCoordinator | null>(null)
  const scrollSyncActiveRef = useRef(false)
  const rendererReadyReportedRef = useRef(false)
  const [selectedScenePresetId, setSelectedScenePresetId] = useState(DEFAULT_SCENE_PRESET_ID)
  const previousDraftIdRef = useRef(draft.id)
  const workingDraftRef = useRef(workingDraft)
  const themeKey = useMarkdownEditorThemeKey()
  const stats = useMemo(() => markdownDraftStats(workingDraft.text), [workingDraft.text])
  const sourceLabel = markdownSourceLabel(workingDraft.source)
  const scenePresets = useMemo(() => scenePresetOptions(scenePresetInput), [scenePresetInput])
  const selectedScenePreset = findScenePreset(scenePresets, selectedScenePresetId)
  workingDraftRef.current = workingDraft
  const currentRevision = markdownDraftRevision(`${workingDraft.title}\0${workingDraft.text}`)
  const runningAiTask = latestRunningMarkdownAiTask(aiTasks)
  const currentAiTask = latestMarkdownAiTask(
    aiTasks,
    (task) => task.key.request.draftRevision === currentRevision,
  )
  const aiTask = runningAiTask ?? currentAiTask ?? latestMarkdownAiTask(aiTasks)
  const aiBusyAction = localAiPending?.action ?? runningAiTask?.key.request.action ?? null
  const aiError = aiTask?.outcome.status === 'error' ? aiTask.outcome.error : ''
  const aiErrorMessage = aiError
    ? userFacingErrorMessage(aiError, 'AI 处理未完成，请稍后重试。', 'llm')
    : ''
  const staleAiTask = Boolean(aiTask && aiTask.key.request.draftRevision !== currentRevision)
  const aiResult: MarkdownAiResult | null =
    aiTask?.outcome.status === 'success' && aiTask.applyContext
      ? {
          action: aiTask.key.request.action,
          fullText: aiTask.applyContext.fullText,
          text: aiTask.applyContext.text,
          title: aiTask.applyContext.title,
          selection:
            aiTask.key.request.target.kind === 'selection'
              ? { from: aiTask.key.request.target.start, to: aiTask.key.request.target.end }
              : { from: 0, to: aiTask.applyContext.fullText.length },
          usedFullDocument: aiTask.key.request.target.kind === 'fullDocument',
          output: aiTask.outcome.output,
          draftId: draft.id,
          draftRevision: aiTask.key.request.draftRevision,
        }
      : null
  const contentLocked = Boolean(
    aiSyncing || localAiPending || runningAiTask || aiApplying || (aiResult && !staleAiTask),
  )
  const scrollSyncActive = Boolean(
    mode === 'split' &&
    scrollSyncEnabled &&
    panesSideBySide &&
    editorScrollSurface &&
    previewScrollSurface,
  )
  const speech = useMarkdownSpeech(workingDraft, speechConfig)
  scrollSyncActiveRef.current = scrollSyncActive
  const acceptEditorScrollSurface = useCallback((surface: MarkdownScrollSurface | null) => {
    setEditorScrollSurface(surface)
  }, [])
  const acceptPreviewScrollSurface = useCallback((surface: MarkdownScrollSurface | null) => {
    setPreviewScrollSurface(surface)
  }, [])

  useEffect(() => {
    if (!aiTaskRecoveryEnabled) {
      setAiSyncing(false)
      return
    }
    let active = true
    setAiSyncing(true)
    void syncAiDraft(draft.id)
      .catch(() => undefined)
      .finally(() => {
        if (active) setAiSyncing(false)
      })
    return () => {
      active = false
    }
  }, [aiTaskRecoveryEnabled, draft.id, syncAiDraft])

  useEffect(() => {
    setWorkingDraft(draft)
    if (previousDraftIdRef.current !== draft.id) {
      const nextSelection = endSelection(draft.text)
      setEditorSelection(nextSelection)
      setRequestedSelection(nextSelection)
      previousDraftIdRef.current = draft.id
    }
  }, [draft])

  useEffect(() => {
    if (!clearConfirmOpen) return

    function handleClearConfirmKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || clearConfirmBusy) return
      event.preventDefault()
      setClearConfirmOpen(false)
      setClearConfirmError('')
    }

    window.addEventListener('keydown', handleClearConfirmKeyDown)
    return () => window.removeEventListener('keydown', handleClearConfirmKeyDown)
  }, [clearConfirmBusy, clearConfirmOpen])

  useEffect(() => {
    if (!openConfirmOpen) return

    function handleOpenConfirmKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || openBusy) return
      event.preventDefault()
      setOpenConfirmOpen(false)
    }

    window.addEventListener('keydown', handleOpenConfirmKeyDown)
    return () => window.removeEventListener('keydown', handleOpenConfirmKeyDown)
  }, [openBusy, openConfirmOpen])

  useLayoutEffect(() => {
    const grid = editorGridRef.current
    const editorPane = editorPaneRef.current
    const previewPane = previewPaneRef.current
    if (!grid) return

    const measure = () => {
      if (mode === 'split' && editorPane && previewPane) {
        setPanesSideBySide(markdownPanesAreSideBySide(editorPane, previewPane))
      } else {
        setPanesSideBySide(false)
      }

      if (
        markdownEditorLayoutIsRenderable({
          grid,
          mode,
          editorPane,
          previewPane,
          editorSurface: editorScrollSurface?.element ?? null,
          previewSurface: previewScrollSurface?.element ?? null,
        })
      ) {
        setInitialLayoutMeasured(true)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    if (editorPane) observer.observe(editorPane)
    if (previewPane) observer.observe(previewPane)
    if (editorScrollSurface) observer.observe(editorScrollSurface.element)
    if (previewScrollSurface) observer.observe(previewScrollSurface.element)
    return () => observer.disconnect()
  }, [editorScrollSurface, mode, previewScrollSurface])

  useEffect(() => {
    if (typeof document.fonts === 'undefined') return
    let active = true
    void document.fonts.ready.then(() => {
      if (active) setFontsReady(true)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!editorScrollSurface || !previewScrollSurface) return

    const coordinator = createMarkdownScrollCoordinator({
      active: scrollSyncActiveRef.current,
      ports: {
        editor: editorScrollSurface,
        preview: previewScrollSurface,
      },
    })
    scrollCoordinatorRef.current = coordinator
    const unbindEditor = bindMarkdownScrollSurface('editor', editorScrollSurface, coordinator)
    const unbindPreview = bindMarkdownScrollSurface('preview', previewScrollSurface, coordinator)

    return () => {
      unbindEditor()
      unbindPreview()
      coordinator.destroy()
      if (scrollCoordinatorRef.current === coordinator) scrollCoordinatorRef.current = null
    }
  }, [editorScrollSurface, previewScrollSurface])

  useEffect(() => {
    scrollCoordinatorRef.current?.setActive(scrollSyncActive)
  }, [scrollSyncActive])

  function commitDraft(nextDraft: MarkdownDraft) {
    setWorkingDraft(nextDraft)
    onDraftChange?.(nextDraft)
  }

  function updateTitle(event: ChangeEvent<HTMLInputElement>) {
    if (contentLocked) return
    commitDraft({
      ...workingDraft,
      title: event.target.value,
      updatedAt: new Date().toISOString(),
      dirty: true,
    })
  }

  function updateText(text: string) {
    if (contentLocked) return
    commitDraft({
      ...workingDraft,
      text,
      updatedAt: new Date().toISOString(),
      dirty: true,
    })
  }

  function runToolbarAction(action: MarkdownAction) {
    if (contentLocked) return
    const result = applyMarkdownAction(workingDraft.text, editorSelection, action)
    commitDraft({
      ...workingDraft,
      text: result.text,
      updatedAt: new Date().toISOString(),
      dirty: true,
    })
    setEditorSelection(result.selection)
    setRequestedSelection(result.selection)
  }

  async function runAiAction(action: MarkdownAiAction) {
    if (!onAiRequest || !aiAvailable || !workingDraft.text.trim() || contentLocked) return

    const localToken = tryStartLocalAi(workingDraft.id, action)
    if (localToken === null) return

    const requestDraft = workingDraft
    const target = getMarkdownAiTarget(requestDraft.text, editorSelection)
    const request: MarkdownAiRequest = {
      draftId: requestDraft.id,
      draftRevision: markdownDraftRevision(`${requestDraft.title}\0${requestDraft.text}`),
      action,
      title: requestDraft.title,
      fullText: requestDraft.text,
      text: target.text,
      selection: target.selection,
      usedFullDocument: target.usedFullDocument,
      scenePreset: selectedScenePreset,
    }

    try {
      const snapshot = await onAiRequest(request)
      if (typeof snapshot === 'string') {
        acceptAiTask({
          key: {
            draftId: requestDraft.id,
            request: {
              action,
              target: target.usedFullDocument
                ? { kind: 'fullDocument' }
                : { kind: 'selection', start: target.selection.from, end: target.selection.to },
              draftRevision: request.draftRevision!,
              semanticFingerprint: 'legacy-test',
            },
          },
          outcome: { status: 'success', leaseId: -1, output: snapshot },
          applyContext: { fullText: request.fullText, text: request.text, title: request.title },
        })
      } else acceptAiTask(snapshot)
    } catch (error) {
      console.warn(userFacingErrorMessage(error, 'AI 处理失败。', 'llm'))
      await syncAiDraft(requestDraft.id)
    } finally {
      finishLocalAi(requestDraft.id, localToken)
    }
  }

  async function applyAiResult(mode: MarkdownAiApplyMode) {
    if (!aiResult || !aiTask || staleAiTask || aiApplying) return
    const localToken = tryStartLocalAi(workingDraft.id, aiResult.action)
    if (localToken === null) return
    const expectedDraftId = workingDraft.id
    const expectedRevision = currentRevision
    setAiApplying(true)
    try {
      if (aiTask.outcome.leaseId >= 0 && !(await consumeAiTask(aiTask))) return
      const latestDraft = workingDraftRef.current
      if (
        latestDraft.id !== expectedDraftId ||
        markdownDraftRevision(`${latestDraft.title}\0${latestDraft.text}`) !== expectedRevision
      ) {
        return
      }

      const result = applyMarkdownAiResult(latestDraft.text, aiResult, mode)
      commitDraft({
        ...latestDraft,
        text: result.text,
        updatedAt: new Date().toISOString(),
        dirty: true,
      })
      setEditorSelection(result.selection)
      setRequestedSelection(result.selection)
      if (aiTask.outcome.leaseId < 0) void consumeAiTask(aiTask)
    } finally {
      setAiApplying(false)
      finishLocalAi(expectedDraftId, localToken)
    }
  }

  const showEditor = mode === 'edit' || mode === 'split'
  const showPreview = mode === 'preview' || mode === 'split'
  useEffect(() => {
    if (
      !onRendererReady ||
      rendererReadyReportedRef.current ||
      !initialLayoutMeasured ||
      !fontsReady
    ) {
      return
    }
    if (showEditor && !editorScrollSurface) return
    if (showPreview && !previewScrollSurface) return

    rendererReadyReportedRef.current = true
    onRendererReady()
  }, [
    editorScrollSurface,
    fontsReady,
    initialLayoutMeasured,
    onRendererReady,
    previewScrollSurface,
    showEditor,
    showPreview,
  ])
  const hasText = Boolean(workingDraft.text.trim())
  const aiDisabled = !hasText || !aiAvailable || !onAiRequest || contentLocked
  const speechRunning = speech.state?.task?.outcome.status === 'running'
  const speechPlaying = speech.playingAssetId !== null
  const speechLabel = markdownSpeechButtonLabel(speech.state, speech.starting, speechPlaying)
  const sourceSummary = sourceLabel
    ? `来源：${sourceLabel}${workingDraft.sourceName ? ` · ${workingDraft.sourceName}` : ''}`
    : ''

  async function openMarkdownFromFile() {
    if (!onOpenMarkdown || openInFlightRef.current || contentLocked) return
    openInFlightRef.current = true
    setOpenBusy(true)
    try {
      await onOpenMarkdown(workingDraft)
      setOpenConfirmOpen(false)
    } finally {
      openInFlightRef.current = false
      setOpenBusy(false)
    }
  }

  function requestOpenMarkdown() {
    if (!onOpenMarkdown || openInFlightRef.current || contentLocked) return
    if (workingDraft.dirty) {
      setOpenConfirmOpen(true)
      return
    }
    void openMarkdownFromFile()
  }

  function cancelOpenMarkdown() {
    if (openBusy) return
    setOpenConfirmOpen(false)
  }

  function requestClearAndClose() {
    if (!onClearAndClose || contentLocked) return
    setClearConfirmError('')
    setClearConfirmOpen(true)
  }

  function cancelClearAndClose() {
    if (clearConfirmBusy) return
    setClearConfirmOpen(false)
    setClearConfirmError('')
  }

  async function confirmClearAndClose() {
    if (!onClearAndClose || clearConfirmBusy) return
    setClearConfirmBusy(true)
    setClearConfirmError('')
    try {
      await onClearAndClose()
      setClearConfirmOpen(false)
    } catch (error) {
      setClearConfirmError(userFacingErrorMessage(error, '清空文稿失败，请稍后重试。'))
    } finally {
      setClearConfirmBusy(false)
    }
  }

  function startTitlebarDrag(event: MouseEvent<HTMLElement>) {
    if (!draggableTitlebar || event.button !== 0 || event.detail > 1) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, select, a')) return
    event.preventDefault()
    getCurrentWindow()
      .startDragging()
      .catch(() => undefined)
  }

  function toggleScrollSync() {
    setScrollSyncEnabled((current) => {
      const next = !current
      writeMarkdownScrollSyncPreference(next)
      return next
    })
  }

  function openOrGenerateSpeech() {
    if (speechPlaying) {
      const playingAsset = [speech.state?.currentAsset, speech.state?.latestAsset].find(
        (asset) => asset?.id === speech.playingAssetId,
      )
      if (playingAsset) {
        speech.setDialogAsset(playingAsset)
        return
      }
    }
    if (speech.state?.currentAsset) {
      speech.setDialogAsset(speech.state.currentAsset)
      return
    }
    void speech.generate()
  }

  async function regenerateSpeech() {
    await speech.stopPlayback()
    speech.setDialogAsset(null)
    await speech.generate()
  }

  return (
    <section
      className="echo-dialog echo-markdown-editor-shell"
      role="dialog"
      aria-modal={modal}
      aria-labelledby="echo-markdown-editor-title"
      data-view-mode={mode}
      data-theme-key={themeKey}
      data-content-locked={contentLocked || undefined}
    >
      <div
        className="echo-dialog-titlebar echo-dialog-titlebar--inline echo-markdown-editor-titlebar"
        onMouseDown={startTitlebarDrag}
      >
        <div className="echo-screen-dialog-heading">
          <span className="echo-screen-dialog-icon" aria-hidden="true">
            <FileText size={18} />
          </span>
          <div>
            <strong id="echo-markdown-editor-title">Markdown 编辑器</strong>
            <span>{sourceSummary}</span>
          </div>
        </div>
        <div className="echo-markdown-editor-titlebar-actions">
          {onVoiceAppendEnabledChange && (
            <Tooltip
              content={
                voiceAppendEnabled
                  ? '新语音结果会自动追加到文稿末尾。'
                  : '新语音结果不会自动写入文稿。'
              }
              side="bottom"
            >
              <button
                type="button"
                className="echo-button echo-markdown-voice-append-toggle"
                aria-pressed={voiceAppendEnabled}
                onClick={() => onVoiceAppendEnabledChange(!voiceAppendEnabled)}
                disabled={contentLocked}
              >
                <Mic size={15} />
                连续追加
              </button>
            </Tooltip>
          )}
          {onClose && (
            <button
              type="button"
              className="echo-icon-button echo-icon-button--window-close"
              aria-label="关闭编辑器"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          )}
        </div>
      </div>

      <div className="echo-dialog-body echo-markdown-editor-body">
        <div className="echo-markdown-editor-head">
          <input
            aria-label="文稿标题"
            className="echo-markdown-title-input"
            value={workingDraft.title}
            onChange={updateTitle}
            readOnly={contentLocked}
            aria-readonly={contentLocked}
          />
          <div className="echo-markdown-editor-view-controls">
            <div className="echo-segmented-lite" role="tablist" aria-label="编辑器视图">
              {viewModes.map((item) => {
                const Icon = item.icon
                const active = item.value === mode
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={active ? 'is-active' : undefined}
                    onClick={() => setMode(item.value)}
                  >
                    <Icon size={15} />
                    {item.label}
                  </button>
                )
              })}
            </div>
            {mode === 'split' && (
              <Tooltip
                content={
                  scrollSyncEnabled
                    ? scrollSyncActive
                      ? '左右分屏已同步滚动。'
                      : '当前不是左右并排布局；恢复并排后会自动同步。'
                    : '开启后，左右分屏会按文稿位置同步滚动。'
                }
                side="bottom"
              >
                <button
                  type="button"
                  className="echo-button echo-markdown-scroll-sync-toggle"
                  aria-label="同步滚动"
                  aria-pressed={scrollSyncEnabled}
                  data-scroll-sync-active={scrollSyncActive}
                  onClick={toggleScrollSync}
                >
                  <ArrowDownUp size={15} />
                  同步滚动
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <MarkdownEditorToolbar onAction={runToolbarAction} disabled={contentLocked} />
        <div className="echo-markdown-ai-bar" role="toolbar" aria-label="Markdown AI 工具栏">
          <ScenePresetSelect
            presets={scenePresets}
            value={selectedScenePresetId}
            onChange={setSelectedScenePresetId}
            compact
            disabled={contentLocked}
          />
          <button
            type="button"
            className="echo-button"
            onClick={() => void runAiAction('polish')}
            disabled={aiDisabled}
          >
            <Wand2 size={16} />
            {aiBusyAction === 'polish' ? '润色中' : '润色'}
          </button>
          <button
            type="button"
            className="echo-button"
            onClick={() => void runAiAction('translate')}
            disabled={aiDisabled}
          >
            <Languages size={16} />
            {aiBusyAction === 'translate' ? '翻译中' : '翻译'}
          </button>
          <button
            type="button"
            className="echo-button"
            onClick={() => void runAiAction('summarize')}
            disabled={aiDisabled}
          >
            <Sparkles size={16} />
            {aiBusyAction === 'summarize' ? '总结中' : '总结'}
          </button>
        </div>
        {(aiResult || aiError || staleAiTask) && (
          <section className="echo-markdown-ai-result" aria-label="AI 处理结果">
            {staleAiTask ? (
              <>
                <p>
                  {aiTask?.outcome.status === 'running'
                    ? '旧版草稿的 AI 任务仍在处理中，完成后可丢弃。'
                    : '此结果属于旧版草稿，不能自动应用。'}
                </p>
                {aiTask?.outcome.status !== 'running' && (
                  <button
                    type="button"
                    className="echo-button"
                    onClick={() => aiTask && void consumeAiTask(aiTask)}
                  >
                    丢弃过期结果
                  </button>
                )}
              </>
            ) : aiResult ? (
              <>
                <div>
                  <strong>{markdownAiActionLabel(aiResult.action)}结果</strong>
                  <span>{aiResult.usedFullDocument ? '全文' : '选区'}</span>
                </div>
                <pre>{aiResult.output}</pre>
                <div className="echo-markdown-ai-result-actions">
                  <button
                    type="button"
                    className="echo-button echo-button--primary"
                    onClick={() => void applyAiResult('replace')}
                  >
                    替换选区
                  </button>
                  <button
                    type="button"
                    className="echo-button"
                    onClick={() => void applyAiResult('insert-below')}
                  >
                    插入下方
                  </button>
                  <button
                    type="button"
                    className="echo-button"
                    onClick={() => void applyAiResult('append')}
                  >
                    追加文末
                  </button>
                  <button
                    type="button"
                    className="echo-button"
                    onClick={() => aiTask && void consumeAiTask(aiTask)}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="echo-markdown-ai-error" role="alert">
                  {aiErrorMessage}
                </p>
                {aiTask?.outcome.status === 'error' && (
                  <button
                    type="button"
                    className="echo-button"
                    onClick={() => void consumeAiTask(aiTask)}
                  >
                    关闭错误并重试
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {fileFeedback && (
          <div
            className={`echo-markdown-file-feedback echo-markdown-file-feedback--${fileFeedback.type}`}
            role={fileFeedback.type === 'error' ? 'alert' : 'status'}
          >
            {fileFeedback.type === 'success' ? (
              <CheckCircle2 size={16} aria-hidden="true" />
            ) : (
              <AlertTriangle size={16} aria-hidden="true" />
            )}
            <span title={fileFeedback.message}>{fileFeedback.message}</span>
            {onDismissFileFeedback && (
              <button
                type="button"
                className="echo-icon-button"
                aria-label="关闭文件操作提示"
                onClick={onDismissFileFeedback}
              >
                <X size={15} />
              </button>
            )}
          </div>
        )}

        {speech.error && !speech.dialogAsset && (
          <div
            className="echo-markdown-file-feedback echo-markdown-file-feedback--error"
            role="alert"
          >
            <AlertTriangle size={16} aria-hidden="true" />
            <span title={speech.error}>{speech.error}</span>
            <button
              type="button"
              className="echo-icon-button"
              aria-label="关闭朗读提示"
              onClick={speech.clearError}
            >
              <X size={15} />
            </button>
          </div>
        )}

        <div
          ref={editorGridRef}
          className="echo-markdown-editor-grid"
          data-view-mode={mode}
          data-scroll-sync={scrollSyncActive ? 'active' : scrollSyncEnabled ? 'paused' : 'off'}
        >
          {showEditor && (
            <section
              ref={editorPaneRef}
              className="echo-markdown-editor-pane"
              aria-label="Markdown 源文"
            >
              <MarkdownEditorInput
                key={workingDraft.id}
                value={workingDraft.text}
                onChange={updateText}
                onSelectionChange={setEditorSelection}
                requestedSelection={requestedSelection}
                themeKey={themeKey}
                readOnly={contentLocked}
                onScrollSurfaceChange={acceptEditorScrollSurface}
              />
            </section>
          )}
          {showPreview && (
            <section
              ref={previewPaneRef}
              className="echo-markdown-editor-pane"
              aria-label="Markdown 预览"
            >
              <MarkdownEditorPreview
                text={workingDraft.text || ' '}
                onScrollSurfaceChange={acceptPreviewScrollSurface}
              />
            </section>
          )}
        </div>
      </div>

      <footer className="echo-markdown-editor-status">
        <div className="echo-markdown-editor-stats">
          <span>{workingDraft.dirty ? '未保存' : '已同步'}</span>
          <span>{stats.nonEmptyLines} 行</span>
          <span>{stats.chars} 字</span>
        </div>
        <div className="echo-markdown-editor-actions">
          {onClearAndClose && (
            <button
              type="button"
              className="echo-button echo-button--danger"
              onClick={requestClearAndClose}
              disabled={
                saveBusy ||
                exportBusy ||
                contentLocked ||
                clearConfirmOpen ||
                openConfirmOpen ||
                openBusy
              }
            >
              <Trash2 size={16} />
              清空退出
            </button>
          )}
          {onOpenMarkdown && (
            <button
              type="button"
              className="echo-button"
              aria-label={openBusy ? '正在打开 Markdown 文件' : '打开 Markdown 文件'}
              onClick={requestOpenMarkdown}
              disabled={openBusy || clearConfirmOpen || contentLocked}
            >
              <FolderOpen size={16} />
              {openBusy ? '打开中' : '打开'}
            </button>
          )}
          {speechConfig && (
            <button
              type="button"
              className="echo-button"
              onClick={openOrGenerateSpeech}
              disabled={!hasText || speech.loading || speech.starting || speechRunning}
            >
              {speech.starting || speechRunning ? (
                <Loader2 size={16} className="echo-spin" />
              ) : speech.state?.currentAsset ? (
                <CheckCircle2 size={16} />
              ) : (
                <Volume2 size={16} />
              )}
              {speechLabel}
            </button>
          )}
          {speechConfig && (
            <button
              type="button"
              className="echo-button echo-markdown-speech-folder-button"
              aria-label="打开朗读音频文件夹"
              onClick={() => void speech.openDirectory()}
            >
              <FolderOpen size={16} />
              朗读音频
            </button>
          )}
          <button
            type="button"
            className="echo-button"
            onClick={() => void onCopyMarkdown?.(workingDraft)}
            disabled={!hasText || !onCopyMarkdown}
          >
            <Clipboard size={16} />
            复制 Markdown
          </button>
          <button
            type="button"
            className="echo-button"
            onClick={() => void onSaveMarkdown?.(workingDraft)}
            disabled={!hasText || !onSaveMarkdown || saveBusy}
          >
            <Download size={16} />
            {saveBusy ? '保存中' : '保存 .md'}
          </button>
          <button
            type="button"
            className="echo-button echo-button--primary"
            onClick={() => void onExportDocx?.(workingDraft)}
            disabled={!hasText || !onExportDocx || exportBusy}
          >
            <Download size={16} />
            {exportBusy ? '导出中' : '导出 Word'}
          </button>
        </div>
      </footer>
      {clearConfirmOpen && (
        <div
          className="echo-dialog-backdrop echo-markdown-clear-backdrop"
          role="presentation"
          onMouseDown={cancelClearAndClose}
        >
          <section
            className="echo-dialog echo-markdown-clear-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-busy={clearConfirmBusy}
            aria-labelledby="echo-markdown-clear-title"
            aria-describedby="echo-markdown-clear-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
              <div className="echo-screen-dialog-heading">
                <span
                  className="echo-screen-dialog-icon echo-screen-dialog-icon--error"
                  aria-hidden="true"
                >
                  <AlertTriangle size={18} />
                </span>
                <div>
                  <strong id="echo-markdown-clear-title">清空并退出编辑器？</strong>
                  <span>此操作无法撤销</span>
                </div>
              </div>
              <button
                type="button"
                className="echo-icon-button"
                aria-label="关闭清空确认"
                onClick={cancelClearAndClose}
                disabled={clearConfirmBusy}
              >
                <X size={17} />
              </button>
            </div>
            <div className="echo-dialog-body">
              <section className="echo-screen-state-panel echo-screen-state-panel--error">
                <Trash2 size={20} />
                <div>
                  <strong>当前文稿会被永久清空</strong>
                  <p id="echo-markdown-clear-description">
                    确认后将删除当前 Markdown 文稿和恢复记录，并关闭编辑器。
                  </p>
                </div>
              </section>
              {clearConfirmError && (
                <p className="echo-markdown-clear-error" role="alert">
                  {clearConfirmError}
                </p>
              )}
            </div>
            <div className="echo-dialog-actions">
              <button
                type="button"
                className="echo-button"
                onClick={cancelClearAndClose}
                disabled={clearConfirmBusy}
                autoFocus
              >
                取消
              </button>
              <button
                type="button"
                className="echo-button echo-button--danger"
                onClick={() => void confirmClearAndClose()}
                disabled={clearConfirmBusy}
              >
                <Trash2 size={16} />
                {clearConfirmBusy ? '正在清空' : '清空并退出'}
              </button>
            </div>
          </section>
        </div>
      )}
      {openConfirmOpen && (
        <div
          className="echo-dialog-backdrop echo-markdown-clear-backdrop"
          role="presentation"
          onMouseDown={cancelOpenMarkdown}
        >
          <section
            className="echo-dialog echo-markdown-clear-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-busy={openBusy}
            aria-labelledby="echo-markdown-open-title"
            aria-describedby="echo-markdown-open-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="echo-dialog-titlebar echo-dialog-titlebar--inline">
              <div className="echo-screen-dialog-heading">
                <span className="echo-screen-dialog-icon" aria-hidden="true">
                  <FolderOpen size={18} />
                </span>
                <div>
                  <strong id="echo-markdown-open-title">打开文件并替换当前文稿？</strong>
                  <span>当前文稿有未保存修改</span>
                </div>
              </div>
            </div>
            <div className="echo-dialog-body">
              <section className="echo-screen-state-panel">
                <FileText size={20} />
                <div>
                  <strong>只有文件成功读取后才会替换</strong>
                  <p id="echo-markdown-open-description">如需保留当前修改，请先取消并保存文稿。</p>
                </div>
              </section>
            </div>
            <div className="echo-dialog-actions">
              <button
                type="button"
                className="echo-button"
                onClick={cancelOpenMarkdown}
                disabled={openBusy}
              >
                取消
              </button>
              <button
                type="button"
                className="echo-button echo-button--primary"
                onClick={() => void openMarkdownFromFile()}
                disabled={openBusy}
              >
                <FolderOpen size={16} />
                {openBusy ? '打开中' : '继续打开'}
              </button>
            </div>
          </section>
        </div>
      )}
      {speech.dialogAsset && (
        <MarkdownSpeechDialog
          asset={speech.dialogAsset}
          playing={speech.playingAssetId === speech.dialogAsset.id}
          error={speech.error}
          onPlay={() => void speech.play(speech.dialogAsset!)}
          onReveal={() => void speech.reveal(speech.dialogAsset!)}
          onRegenerate={() => void regenerateSpeech()}
          onClose={() => speech.setDialogAsset(null)}
        />
      )}
    </section>
  )
}

function defaultViewMode(): MarkdownEditorViewMode {
  return window.innerWidth >= 860 ? 'split' : 'edit'
}

function readMarkdownScrollSyncPreference() {
  try {
    return window.localStorage.getItem(MARKDOWN_SCROLL_SYNC_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

function writeMarkdownScrollSyncPreference(enabled: boolean) {
  try {
    window.localStorage.setItem(MARKDOWN_SCROLL_SYNC_STORAGE_KEY, String(enabled))
  } catch {
    // Preference persistence must not block the editor.
  }
}

function markdownPanesAreSideBySide(editorPane: HTMLElement, previewPane: HTMLElement) {
  const editorRect = editorPane.getBoundingClientRect()
  const previewRect = previewPane.getBoundingClientRect()
  if (
    editorRect.width <= 1 ||
    previewRect.width <= 1 ||
    editorRect.height <= 1 ||
    previewRect.height <= 1
  ) {
    return false
  }

  const verticalOverlap =
    Math.min(editorRect.bottom, previewRect.bottom) - Math.max(editorRect.top, previewRect.top)
  const horizontalGap =
    Math.max(editorRect.left, previewRect.left) - Math.min(editorRect.right, previewRect.right)
  return (
    verticalOverlap >= Math.min(editorRect.height, previewRect.height) * 0.5 && horizontalGap >= -1
  )
}

function markdownEditorLayoutIsRenderable({
  grid,
  mode,
  editorPane,
  previewPane,
  editorSurface,
  previewSurface,
}: {
  grid: HTMLElement
  mode: MarkdownEditorViewMode
  editorPane: HTMLElement | null
  previewPane: HTMLElement | null
  editorSurface: HTMLElement | null
  previewSurface: HTMLElement | null
}) {
  const requiredElements: Array<HTMLElement | null> = [grid]
  if (mode === 'edit' || mode === 'split') requiredElements.push(editorPane, editorSurface)
  if (mode === 'preview' || mode === 'split') requiredElements.push(previewPane, previewSurface)
  return requiredElements.every((element) => element && elementHasRenderableBox(element))
}

function elementHasRenderableBox(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return rect.width > 1 && rect.height > 1
}

function bindMarkdownScrollSurface(
  side: MarkdownScrollSide,
  surface: MarkdownScrollSurface,
  coordinator: MarkdownScrollCoordinator,
) {
  const { element } = surface
  const handleScroll = () => coordinator.onScroll(side)
  const handleUserIntent = () => coordinator.onUserIntent(side)
  const handleKeyDown = (event: KeyboardEvent) => {
    if (markdownScrollKeys.has(event.key)) coordinator.onUserIntent(side)
  }

  element.addEventListener('scroll', handleScroll, { passive: true })
  element.addEventListener('wheel', handleUserIntent, { passive: true })
  element.addEventListener('pointerdown', handleUserIntent, { passive: true })
  element.addEventListener('touchstart', handleUserIntent, { passive: true })
  element.addEventListener('keydown', handleKeyDown)

  return () => {
    element.removeEventListener('scroll', handleScroll)
    element.removeEventListener('wheel', handleUserIntent)
    element.removeEventListener('pointerdown', handleUserIntent)
    element.removeEventListener('touchstart', handleUserIntent)
    element.removeEventListener('keydown', handleKeyDown)
  }
}

const markdownScrollKeys = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
])

function endSelection(text: string): MarkdownTextSelection {
  return { from: text.length, to: text.length }
}

function useMarkdownEditorThemeKey() {
  const [themeKey, setThemeKey] = useState(() => getMarkdownEditorThemeKey())

  useEffect(() => {
    const root = document.documentElement
    const sync = () => setThemeKey(getMarkdownEditorThemeKey(root))
    const observer = new MutationObserver(sync)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-theme-profile'],
    })
    sync()
    return () => observer.disconnect()
  }, [])

  return themeKey
}
