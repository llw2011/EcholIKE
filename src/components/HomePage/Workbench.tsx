import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Cloud,
  FileText,
  Loader2,
  KeyRound,
  Laptop,
  MessageCircle,
  Mic,
  ScanLine,
  Search,
  Settings,
  RefreshCw,
  Square,
  Upload,
  Volume2,
} from 'lucide-react'
import {
  useAppStore,
  type HistoryEntry,
  type HistoryMutationKind,
  type WorkbenchFeedbackSlot,
} from '../../stores/appStore'
import { useRoute } from '../../lib/router'
import { userFacingErrorMessage, type ErrorContext } from '../../lib/userErrors'
import {
  abortRecording,
  clearHistory,
  deleteHistoryEntries,
  runExportMarkdownDocx,
  runExportMarkdownFile,
  runExportPdfImages,
  quitApp,
  startRecording,
  stopRecording,
  type OcrReadResult,
  type UploadedOcrFile,
} from '../../lib/tauri'
import { ScenePresetSelect } from '../ScenePresetSelect'
import { Tooltip } from '../Tooltip'
import { AudioLevelMeter } from '../shared/AudioLevelMeter'
import {
  DEFAULT_SCENE_PRESET_ID,
  findScenePreset,
  scenePresetOptions,
} from '../../lib/scenePresets'
import { toast } from '../../lib/toast'
import { backendSttAvailability } from '../../lib/onboarding'
import { isDesktopAuthSessionAuthenticated } from '../../lib/desktopAuth'
import { markdownDraftRevision } from '../MarkdownEditor/markdownAiTask'
import { fileCommandIdentity, useFileCommandDomain } from '../../stores/fileCommandStore'
import type { FileCommandOwnerKey, FileCommandSnapshot } from '../../lib/tauri'
import {
  cleanOcrResult,
  cleanOcrText,
  markdownDownloadName,
  ocrRouteLabel,
  ocrSourceLabel,
  ocrWarningMessage,
} from './ocrDomain'
import { useWorkbenchOcr } from './useWorkbenchOcr'
import { useWorkbenchAsk, type AskAnswer } from './useWorkbenchAsk'
import { useWorkbenchSpeech } from './useWorkbenchSpeech'
import { useMarkdownWorkspace } from './useMarkdownWorkspace'
import {
  HistoryDeleteConfirmDialog,
  RecentHistoryPanel,
  type HistoryDeleteRequest,
} from './WorkbenchHistoryViews'
import {
  formatHistoryTime,
  hasReadableHistoryText,
  historyEntryText,
  normalizeHistoryPreview,
  readableAppName,
} from './historyPresentation'
import {
  MarkdownDraftConflictDialog,
  MarkdownDraftRestoreDialog,
  MarkdownEditorLoadingDialog,
} from './MarkdownWorkspaceDialogs'
import {
  AskAnswerView,
  AskPendingView,
  Metric,
  OcrPreview,
  ServiceSummary,
} from './WorkbenchResultViews'
import { ScreenOcrDialog } from './ScreenOcrDialog'

type OnboardingSimulationState = 'idle' | 'recording' | 'result'

type HomePageProps = {
  onboardingSimulation?: OnboardingSimulationState
  onOpenNetworkLogin?: () => void
  onRefreshNetwork?: () => void
  onSwitchToLocal?: () => void
  networkRefreshBusy?: boolean
  networkRefreshError?: string | null
  networkSwitchBusy?: boolean
}

const pipelineCopy = {
  idle: '可直接开始输入',
  recording: '正在采集语音',
  transcribing: '正在识别文字',
  polishing: 'AI 正在处理',
  outputting: '正在写入文本',
} as const

const MarkdownEditorShell = lazy(() =>
  import('../MarkdownEditor/MarkdownEditorShell').then((module) => ({
    default: module.MarkdownEditorShell,
  })),
)

function markdownTitleFromText(text: string, fallback: string) {
  const firstLine = normalizeHistoryPreview(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!firstLine) return fallback
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine
}

function errorMessage(error: unknown, fallback: string, context: ErrorContext = 'general') {
  return userFacingErrorMessage(error, fallback, context)
}

export function HomePage({
  onboardingSimulation = 'idle',
  onOpenNetworkLogin,
  onRefreshNetwork,
  onSwitchToLocal,
  networkRefreshBusy = false,
  networkRefreshError = null,
  networkSwitchBusy = false,
}: HomePageProps = {}) {
  const config = useAppStore((s) => s.config)
  const desktopBootstrap = useAppStore((s) => s.desktopBootstrap)
  const desktopAuthToken = useAppStore((s) => s.desktopAuthToken)
  const desktopAuthStatus = useAppStore((s) => s.desktopAuthStatus)
  const desktopBootstrapAuthToken = useAppStore((s) => s.desktopBootstrapAuthToken)
  const history = useAppStore((s) => s.history)
  const historyMutation = useAppStore((s) => s.historyMutation)
  const tryStartHistoryMutation = useAppStore((s) => s.tryStartHistoryMutation)
  const finishHistoryMutation = useAppStore((s) => s.finishHistoryMutation)
  const failHistoryMutation = useAppStore((s) => s.failHistoryMutation)
  const clearHistoryMutationError = useAppStore((s) => s.clearHistoryMutationError)
  const pipelineState = useAppStore((s) => s.pipelineState)
  const partialTranscript = useAppStore((s) => s.partialTranscript)
  const finalTranscript = useAppStore((s) => s.finalTranscript)
  const polishedText = useAppStore((s) => s.polishedText)
  const completedVoiceText = useAppStore((s) => s.completedVoiceText)
  const resetRecording = useAppStore((s) => s.resetRecording)
  const forceUpdateRequired = Boolean(
    desktopBootstrap?.ota?.forceUpdate && desktopBootstrap.ota.updateAvailable !== false,
  )
  const openUpdatePage = useCallback(() => {
    window.location.hash = '#/settings/about'
  }, [])
  const blockForRequiredUpdate = useCallback(() => {
    toast('检测到强制更新，请先安装新版本。', 'error')
    openUpdatePage()
  }, [openUpdatePage])
  const {
    backendServiceError: backendOcrServiceError,
    detectedContext,
    dismissOcrDialog,
    hasServiceIssue: ocrServiceIssue,
    ocrBusy,
    ocrDialog,
    ocrReady,
    ocrResult,
    ocrTask,
    ocrUploadAcceptValue,
    pdfExportFile,
    readScreen: handleReadScreen,
    readUploadedFile,
    screenOcrReady,
    statusText: ocrStatusText,
  } = useWorkbenchOcr({
    forceUpdateRequired,
    onRequiredUpdate: blockForRequiredUpdate,
  })
  const { navigate } = useRoute()
  const questionInputRef = useRef<HTMLInputElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<number>>(() => new Set())
  const [historyDeleteRequest, setHistoryDeleteRequest] = useState<HistoryDeleteRequest | null>(
    null,
  )

  const recordingTransition = useAppStore((state) => state.recordingTransition)
  const configSourceSwitchPending = useAppStore(
    (state) => state.settingsOperation?.kind === 'config-source',
  )
  const ocrResourceId = `ocr:${ocrTask.runId ?? 'current'}`
  const fileTasks = useFileCommandDomain((state) => state.tasks)
  const syncFileCommands = useFileCommandDomain((state) => state.sync)
  const acceptFileCommand = useFileCommandDomain((state) => state.accept)
  const consumeFileCommand = useFileCommandDomain((state) => state.consume)
  const ocrDialogFeedback = useFileCommandDomain((state) => state.ocrFeedback)
  const setOcrDialogFeedback = useFileCommandDomain((state) => state.setOcrFeedback)
  const handledOcrFileOutcomesRef = useRef(new Set<string>())
  const visibleOcrDialogFeedback =
    ocrDialogFeedback?.resourceId === ocrResourceId ? ocrDialogFeedback : null
  const pdfKey = useMemo<FileCommandOwnerKey>(
    () => ({ resourceId: ocrResourceId, commandKind: 'exportPdf' }),
    [ocrResourceId],
  )
  const ocrDocxKey = useMemo<FileCommandOwnerKey>(
    () => ({ resourceId: ocrResourceId, commandKind: 'exportDocx' }),
    [ocrResourceId],
  )
  const ocrMarkdownKey = useMemo<FileCommandOwnerKey>(
    () => ({ resourceId: ocrResourceId, commandKind: 'exportMarkdown' }),
    [ocrResourceId],
  )
  const isOcrFileCommandRunning = (key: FileCommandOwnerKey) =>
    fileTasks[fileCommandIdentity(key)]?.outcome.status === 'running'
  const pdfExportBusy = isOcrFileCommandRunning(pdfKey)
  const ocrDocxExportBusy = isOcrFileCommandRunning(ocrDocxKey)

  useEffect(() => {
    if (!ocrDialogFeedback) return
    const feedback = ocrDialogFeedback
    const timer = window.setTimeout(() => {
      if (useFileCommandDomain.getState().ocrFeedback === feedback) setOcrDialogFeedback(null)
    }, 4500)
    return () => window.clearTimeout(timer)
  }, [ocrDialogFeedback, setOcrDialogFeedback])

  useEffect(() => {
    void syncFileCommands()
  }, [syncFileCommands])

  useEffect(() => {
    for (const snapshot of Object.values(fileTasks)) {
      if (snapshot.ownerWindow && snapshot.ownerWindow !== 'main') continue
      if (!snapshot.key.resourceId.startsWith('ocr:')) continue
      if (snapshot.key.resourceId !== ocrResourceId || snapshot.outcome.status === 'running')
        continue
      const token = `${fileCommandIdentity(snapshot.key)}:${snapshot.outcome.leaseId}`
      if (handledOcrFileOutcomesRef.current.has(token)) continue
      void applyRecoveredOcrFileOutcome(snapshot, token)
    }
  }, [consumeFileCommand, fileTasks, ocrResourceId])
  const [selectedScenePresetId, setSelectedScenePresetId] = useState(DEFAULT_SCENE_PRESET_ID)

  const todayCount = useMemo(() => {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`
    return history.filter((entry) => entry.created_at.startsWith(today)).length
  }, [history])
  const recentHistory = useMemo(() => history.slice(0, 3), [history])
  const visibleSelectedHistoryIds = useMemo(() => {
    const visibleIds = new Set(recentHistory.map((entry) => entry.id))
    return new Set(Array.from(selectedHistoryIds).filter((id) => visibleIds.has(id)))
  }, [recentHistory, selectedHistoryIds])
  const historySelectionReconcilePending =
    visibleSelectedHistoryIds.size !== selectedHistoryIds.size

  useEffect(() => {
    const availableIds = new Set(recentHistory.map((entry) => entry.id))
    setSelectedHistoryIds((current) => {
      const next = new Set(Array.from(current).filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [recentHistory])

  const currentText =
    onboardingSimulation === 'recording'
      ? '正在模拟转写…'
      : onboardingSimulation === 'result'
        ? '你好，这是一段本地模拟的语音输入结果。'
        : completedVoiceText || polishedText || finalTranscript || partialTranscript
  const displayedPipelineState =
    onboardingSimulation === 'recording' ? 'transcribing' : pipelineState
  const scenePresets = useMemo(
    () => scenePresetOptions(desktopBootstrap?.scenes),
    [desktopBootstrap?.scenes],
  )
  const selectedScenePreset = findScenePreset(scenePresets, selectedScenePresetId)
  const backendManaged = config.config_source === 'backend'
  const desktopToken = isDesktopAuthSessionAuthenticated(
    desktopBootstrap,
    desktopAuthToken,
    desktopAuthStatus,
    desktopBootstrapAuthToken,
  )
    ? desktopAuthToken
    : null
  const {
    answer,
    answerText,
    askBusy,
    askTask,
    backendServiceError: backendLlmServiceError,
    cloudLlmAvailable,
    llmReady,
    llmStatusText,
    llmUnavailableMessage,
    localLlmReady,
    pendingQuestion,
    question,
    setQuestion,
    submitQuestion: handleAsk,
    visibleAnswer,
  } = useWorkbenchAsk({
    backendManaged,
    desktopToken,
    detectedContext,
    ocrResult,
    selectedScenePreset,
    forceUpdateRequired,
    onRequiredUpdate: blockForRequiredUpdate,
  })
  const {
    clearFeedback: clearWorkbenchFeedback,
    lastReadVoiceResult,
    resultSpeechText,
    setFeedbackIfCurrent: setWorkbenchFeedbackIfCurrent,
    speakText,
    speakVoiceResult,
    speechConfig,
    ttsAvailable,
    ttsBusy,
    visibleVoiceFeedback,
    visibleWorkspaceFeedback,
    voiceFeedbackResourceId,
    workspaceFeedbackResourceId,
  } = useWorkbenchSpeech({ backendManaged, desktopToken })
  const {
    applyMarkdownOpenRequest,
    appendMarkdownRequest,
    canResumeMarkdownDraft,
    cancelPendingMarkdownRequest,
    clearAndCloseMarkdownEditor,
    clearMarkdownFileFeedback,
    closeMarkdownEditor,
    copyMarkdownDraft,
    discardRecentMarkdownDraft,
    dismissRestorableMarkdownDraft,
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
  } = useMarkdownWorkspace({
    backendManaged,
    desktopToken,
    cloudLlmAvailable,
    localLlmReady,
    llmReady,
    llmUnavailableMessage,
    selectedScenePreset,
  })
  const backendSttState = backendSttAvailability(desktopBootstrap, Boolean(desktopToken))
  const showNetworkActivation = backendManaged && backendSttState !== 'ready'
  const serviceIssueCount = [ocrServiceIssue, !llmReady || Boolean(backendLlmServiceError)].filter(
    Boolean,
  ).length
  const serviceSummaryText = `${backendManaged ? '托管' : '本机'} ${2 - serviceIssueCount}/2`
  const serviceSummaryDetail = [
    `OCR：${ocrStatusText}${backendOcrServiceError ? ` · ${backendOcrServiceError}` : ''}`,
    `文本 AI：${llmStatusText}${backendLlmServiceError ? ` · ${backendLlmServiceError}` : ''}`,
  ].join('\n')
  const serviceSummaryTone = serviceIssueCount === 0 ? 'ok' : 'warn'

  async function handleRecording() {
    if (forceUpdateRequired) {
      blockForRequiredUpdate()
      return
    }
    if (configSourceSwitchPending) return
    if (pipelineState !== 'idle' && pipelineState !== 'recording') return
    const kind = pipelineState === 'recording' ? 'stop' : 'start'
    const leaseId = useAppStore.getState().tryStartRecordingTransition(kind)
    if (leaseId === null) return
    try {
      if (pipelineState === 'recording') {
        await stopRecording()
      } else if (pipelineState === 'idle') {
        const acquired = await startRecording()
        if (acquired) resetRecording()
      }
      useAppStore.getState().finishRecordingTransition(leaseId)
    } catch (error) {
      const message = errorMessage(error, '录音命令执行失败。')
      useAppStore.getState().failRecordingTransition(leaseId, message)
    }
  }

  async function handleAbort() {
    const leaseId = useAppStore.getState().tryStartRecordingTransition('abort')
    if (leaseId === null) return
    try {
      await abortRecording()
      useAppStore.getState().finishRecordingTransition(leaseId)
    } catch (error) {
      const message = errorMessage(error, '取消录音失败。')
      useAppStore.getState().failRecordingTransition(leaseId, message)
    }
  }

  async function handleUploadFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    await readUploadedFile(file)
  }

  function handleAskFromOcr(result: OcrReadResult) {
    const text = cleanOcrText(result.text)
    if (!text) {
      toast('没有可用于提问的 OCR 文本。', 'info')
      return
    }

    const source = result.source_kind === 'upload' ? '附件内容' : '屏幕内容'
    setQuestion(`请基于刚才识别到的${source}，帮我总结重点并指出需要处理的事项。`)
    dismissOcrDialog()
    window.requestAnimationFrame(() => questionInputRef.current?.focus())
  }

  function closeOcrDialog() {
    setOcrDialogFeedback(null)
    dismissOcrDialog()
  }

  async function insertVoiceResultIntoMarkdownEditor() {
    const text = resultSpeechText.trim()
    if (!text) return
    await appendMarkdownRequest({
      title: markdownTitleFromText(text, '语音文稿'),
      text,
      source: 'voice',
      sourceName: '本次识别结果',
    })
  }

  function openOcrInMarkdownEditor(result: OcrReadResult) {
    const text = cleanOcrText(result.text)
    requestOpenMarkdownEditor({
      title:
        result.source_name ||
        result.window_title ||
        (result.source_kind === 'upload' ? '附件 OCR' : '屏幕 OCR'),
      text,
      source: result.source_kind === 'upload' ? 'upload_ocr' : 'screen_ocr',
      sourceName: result.source_name || result.window_title || result.app_name,
    })
    dismissOcrDialog()
  }

  function openAnswerInMarkdownEditor(currentAnswer: AskAnswer) {
    requestOpenMarkdownEditor({
      title: 'AI 回答',
      text: `Q：${currentAnswer.question}\n\nA：${currentAnswer.answer}`,
      source: 'ai_answer',
      sourceName: currentAnswer.question,
    })
  }

  function openHistoryInMarkdownEditor(entry: HistoryEntry) {
    const text = historyEntryText(entry)
    if (!hasReadableHistoryText(text)) {
      toast('这条历史没有可读文本，已跳过。', 'info')
      return
    }

    const appName = readableAppName(entry.app_name)
    const time = formatHistoryTime(entry.created_at)
    requestOpenMarkdownEditor({
      title: markdownTitleFromText(text, appName),
      text,
      source: 'history',
      sourceName: [appName, time].filter(Boolean).join(' · '),
    })
  }

  function updateHistorySelection(id: number, selected: boolean) {
    setSelectedHistoryIds((current) => {
      const next = new Set(current)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function requestHistoryDeletion(kind: HistoryMutationKind, ids: number[]) {
    if (historyMutation.status === 'running') return
    const normalizedIds = Array.from(
      new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)),
    ).sort((left, right) => left - right)
    if (kind === 'selected' && normalizedIds.length === 0) return
    clearHistoryMutationError()
    setHistoryDeleteRequest({ kind, ids: normalizedIds })
  }

  function cancelHistoryDeletion() {
    if (historyMutation.status === 'running') return
    setHistoryDeleteRequest(null)
  }

  async function confirmHistoryDeletion() {
    const request = historyDeleteRequest
    if (!request) return
    const leaseId = tryStartHistoryMutation(request.kind)
    if (leaseId === null) return

    try {
      const completed =
        request.kind === 'selected'
          ? finishHistoryMutation(
              leaseId,
              Array.from(new Set([...request.ids, ...(await deleteHistoryEntries(request.ids))])),
            )
          : finishHistoryMutation(leaseId, [], (await clearHistory()).clearedThroughId)
      if (completed) setHistoryDeleteRequest(null)
    } catch (error) {
      failHistoryMutation(leaseId, userFacingErrorMessage(error, '删除历史记录失败，请稍后重试。'))
    }
  }

  async function copyWorkbenchText(
    text: string,
    slot: WorkbenchFeedbackSlot,
    resourceId: string,
    successMessage: string,
  ) {
    if (!text) return
    clearWorkbenchFeedback(slot)
    try {
      await navigator.clipboard.writeText(text)
      setWorkbenchFeedbackIfCurrent(slot, resourceId, 'success', successMessage)
    } catch {
      setWorkbenchFeedbackIfCurrent(slot, resourceId, 'error', '系统剪贴板不可用。')
    }
  }

  async function copyOcrResult(text: string) {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setOcrDialogFeedback({ resourceId: ocrResourceId, type: 'success', message: '结果已复制。' })
    } catch {
      setOcrDialogFeedback({
        resourceId: ocrResourceId,
        type: 'error',
        message: '系统剪贴板不可用。',
      })
    }
  }

  async function downloadMarkdown(result: OcrReadResult) {
    const text = cleanOcrText(result.text)
    if (!text) return
    await runAndApplyOcrFileCommand(
      runExportMarkdownFile(
        ocrMarkdownKey,
        markdownDownloadName(result),
        text,
        markdownDraftRevision(`${markdownDownloadName(result)}\0${text}`),
      ),
      '保存 Markdown 失败。',
    )
  }

  async function exportCurrentPdfImages(file: UploadedOcrFile) {
    await runAndApplyOcrFileCommand(
      runExportPdfImages(
        pdfKey,
        file,
        markdownDraftRevision(
          `${file.fileName}\0${file.fileBytes?.length ?? file.fileBase64?.length ?? 0}`,
        ),
      ),
      'PDF 导出图片失败。',
    )
  }

  async function exportCurrentDocx(result: OcrReadResult) {
    const cleaned = cleanOcrResult(result)
    await runAndApplyOcrFileCommand(
      runExportMarkdownDocx(
        ocrDocxKey,
        cleaned,
        markdownDraftRevision(`${cleaned.source_name ?? ''}\0${cleaned.text}`),
        true,
      ),
      '导出 Word 失败。',
    )
  }

  async function runAndApplyOcrFileCommand(
    command: Promise<FileCommandSnapshot>,
    fallback: string,
  ) {
    try {
      const snapshot = await command
      acceptFileCommand(snapshot)
      if (snapshot.outcome.status === 'running') return snapshot
      const result = await consumeFileCommand(snapshot)
      if (result === 'consumed') showOcrFileOutcome(snapshot, fallback)
      return snapshot
    } catch (error) {
      setOcrDialogFeedback({
        resourceId: ocrResourceId,
        type: 'error',
        message: errorMessage(error, fallback),
      })
      return null
    }
  }

  async function applyRecoveredOcrFileOutcome(snapshot: FileCommandSnapshot, token: string) {
    const result = await consumeFileCommand(snapshot)
    if (result === 'stale') return
    handledOcrFileOutcomesRef.current.add(token)
    if (result === 'consumed') showOcrFileOutcome(snapshot, '文件操作失败。')
  }

  function showOcrFileOutcome(snapshot: FileCommandSnapshot, fallback: string) {
    if (snapshot.outcome.status === 'success') {
      const prefix =
        snapshot.key.commandKind === 'exportPdf'
          ? snapshot.outcome.message
          : snapshot.key.commandKind === 'exportDocx'
            ? 'Word 已保存到'
            : 'Markdown 已保存到'
      setOcrDialogFeedback({
        resourceId: snapshot.key.resourceId,
        type: 'success',
        message: `${prefix}：${snapshot.outcome.path}`,
      })
    } else if (snapshot.outcome.status === 'error') {
      setOcrDialogFeedback({
        resourceId: snapshot.key.resourceId,
        type: 'error',
        message: errorMessage(snapshot.outcome.error, fallback),
      })
    }
  }

  const ocrPreviewText = ocrResult && !ocrDialog ? cleanOcrText(ocrResult.text) : ''
  const workspaceOcrWarning = ocrResult && !ocrDialog ? ocrWarningMessage(ocrResult) : null
  const workspaceResultTitle =
    askBusy || answer ? 'AI 回答' : ocrResult ? `${ocrSourceLabel(ocrResult)} 结果` : '当前结果'
  const workspaceResultMeta =
    askBusy && pendingQuestion
      ? '正在处理问题'
      : answer
        ? '可复制或朗读'
        : ocrResult
          ? [
              ocrResult.source_name || ocrResult.window_title || null,
              ocrRouteLabel(ocrResult),
              ocrResult.degraded ? '降级结果' : null,
              !ocrResult.degraded && (ocrResult.warnings ?? []).some((warning) => warning.trim())
                ? '有提示'
                : null,
              `${ocrResult.elapsed_ms}ms`,
            ]
              .filter(Boolean)
              .join(' · ')
          : '等待识别或提问'
  const aiCapabilityChips = ['Markdown', '.md', 'Word', 'PDF 图片', '表格结构', '追问']

  return (
    <div className="echo-page echo-workbench">
      <section className="echo-workbench-hero">
        <div className="echo-hero-copy">
          <span className="echo-label">极速输入优先</span>
          <h2>说完就出文字</h2>
          <p>录音、识别、润色和写入会按当前设置执行，需要处理文本时才调用已配置的模型。</p>
        </div>
        <div className="echo-hero-actions">
          <button
            type="button"
            className="echo-button echo-button--primary"
            data-onboarding-target="voice-trigger"
            onClick={handleRecording}
            disabled={
              forceUpdateRequired ||
              configSourceSwitchPending ||
              recordingTransition.status === 'running' ||
              pipelineState === 'transcribing' ||
              pipelineState === 'polishing' ||
              pipelineState === 'outputting'
            }
          >
            {recordingTransition.status === 'running' ? (
              <Loader2 size={17} className="echo-spin" />
            ) : pipelineState === 'recording' ? (
              <Square size={16} />
            ) : (
              <Mic size={17} />
            )}
            {pipelineState === 'recording' ? '停止并输出' : '开始说话'}
          </button>
          {pipelineState !== 'idle' && (
            <button
              type="button"
              className="echo-button"
              onClick={handleAbort}
              disabled={recordingTransition.status === 'running'}
            >
              取消
            </button>
          )}
          <button type="button" className="echo-button" onClick={() => navigate('settings')}>
            <Settings size={16} />
            设置
          </button>
        </div>
        {recordingTransition.status === 'error' && recordingTransition.error && (
          <div className="echo-alert echo-alert--error" role="alert">
            {recordingTransition.error}
          </div>
        )}
      </section>

      {forceUpdateRequired && (
        <section className="echo-panel echo-update-result echo-update-result--force" role="alert">
          <strong>必须安装新版本后才能继续使用主功能。</strong>
          <span>
            当前 v{desktopBootstrap?.ota?.currentVersion ?? 'unknown'} · 最新 v
            {desktopBootstrap?.ota?.latestVersion ?? 'unknown'}
          </span>
          {desktopBootstrap?.ota?.releaseNotes && <p>{desktopBootstrap.ota.releaseNotes}</p>}
          <div className="echo-action-row">
            <button
              type="button"
              className="echo-button echo-button--primary"
              onClick={openUpdatePage}
            >
              立即更新
            </button>
            <button type="button" className="echo-button" onClick={() => void quitApp()}>
              退出
            </button>
          </div>
        </section>
      )}

      {showNetworkActivation && (
        <section
          className="echo-network-activation-card"
          data-onboarding-target="network-activation"
        >
          <span className="echo-network-activation-icon" aria-hidden="true">
            {backendSttState === 'signed-out' ? <KeyRound size={20} /> : <Cloud size={20} />}
          </span>
          <div className="echo-network-activation-copy">
            <strong>
              {backendSttState === 'signed-out'
                ? '登录后启用网络服务'
                : '账号已登录，但语音服务暂不可用'}
            </strong>
            <p>
              {backendSttState === 'signed-out'
                ? '暂未开放注册，请联系管理员获取账号。'
                : '登录成功不等于语音转写已就绪；可刷新额度或改用本地配置版。'}
            </p>
          </div>
          <div className="echo-network-activation-actions">
            {backendSttState === 'signed-out' ? (
              <button
                type="button"
                className="echo-button echo-button--primary"
                onClick={onOpenNetworkLogin}
              >
                <KeyRound size={16} />
                登录网络版
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="echo-button echo-button--primary"
                  onClick={onRefreshNetwork}
                  disabled={networkRefreshBusy}
                >
                  <RefreshCw size={16} className={networkRefreshBusy ? 'echo-spin' : undefined} />
                  刷新额度
                </button>
                <button
                  type="button"
                  className="echo-button"
                  onClick={onSwitchToLocal}
                  disabled={networkSwitchBusy}
                  aria-busy={networkSwitchBusy}
                >
                  <Laptop size={16} />
                  {networkSwitchBusy ? '正在切换…' : '改用本地配置版'}
                </button>
              </>
            )}
          </div>
          {networkRefreshError && (
            <div
              className="echo-panel-alert echo-panel-alert--warn echo-network-activation-feedback"
              role="alert"
            >
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{networkRefreshError}</span>
            </div>
          )}
        </section>
      )}

      <section className="echo-panel echo-live-panel" data-onboarding-target="voice-result">
        <div className="echo-panel-title">
          <span className="echo-status-dot" />
          <div>
            <strong>{pipelineCopy[displayedPipelineState]}</strong>
            <small>
              触发键 {config.hotkey} | {config.hotkey_mode === 'hold' ? '按住说话' : '单击切换'}
            </small>
          </div>
        </div>
        <AudioLevelMeter
          className="echo-meter"
          segmentCount={24}
          simulatedLevel={onboardingSimulation === 'recording' ? 0.54 : undefined}
        />
        <div className="echo-transcript-box">
          {currentText ? (
            currentText
          ) : (
            <span>这里显示识别、润色、问答或 OCR 结果；没有内容时保持空白。</span>
          )}
        </div>
        {resultSpeechText && (
          <section className="echo-tts-result-card" aria-label="本次结果操作">
            <div className="echo-tts-result-copy">
              <span className="echo-tts-result-icon" aria-hidden="true">
                <Volume2 size={16} />
              </span>
              <div>
                <strong>本次结果</strong>
                <Tooltip content={resultSpeechText}>
                  <p>{resultSpeechText}</p>
                </Tooltip>
              </div>
            </div>
            <div className="echo-tts-result-actions">
              {ttsAvailable && (
                <Tooltip
                  content={
                    lastReadVoiceResult === resultSpeechText ? '重播本次结果' : '朗读本次结果'
                  }
                >
                  <button
                    type="button"
                    className="echo-button"
                    aria-label="朗读结果"
                    onClick={() => void speakVoiceResult()}
                    disabled={ttsBusy !== null}
                  >
                    {ttsBusy === 'result' ? (
                      <Loader2 size={16} className="echo-spin" />
                    ) : (
                      <Volume2 size={16} />
                    )}
                    {ttsBusy === 'result'
                      ? '朗读中'
                      : lastReadVoiceResult === resultSpeechText
                        ? '重播'
                        : '朗读'}
                  </button>
                </Tooltip>
              )}
              <button
                type="button"
                className="echo-button"
                aria-label="复制本次结果"
                onClick={() =>
                  void copyWorkbenchText(
                    resultSpeechText,
                    'voice',
                    voiceFeedbackResourceId,
                    '本次结果已复制。',
                  )
                }
              >
                <Clipboard size={16} />
                复制
              </button>
              <button
                type="button"
                className="echo-button"
                aria-label="插入 Markdown 编辑器"
                onClick={() => void insertVoiceResultIntoMarkdownEditor()}
                disabled={markdownEditorOpening}
              >
                <FileText size={16} />
                插入编辑器
              </button>
            </div>
            {visibleVoiceFeedback && (
              <div
                className={`echo-panel-alert echo-panel-alert--${visibleVoiceFeedback.type === 'success' ? 'ok' : 'warn'} echo-workbench-feedback echo-tts-result-feedback`}
                role={visibleVoiceFeedback.type === 'success' ? 'status' : 'alert'}
              >
                {visibleVoiceFeedback.type === 'success' ? (
                  <CheckCircle2 size={15} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={15} aria-hidden="true" />
                )}
                <span>{visibleVoiceFeedback.message}</span>
              </div>
            )}
          </section>
        )}
      </section>

      <section className="echo-grid echo-grid--three">
        <Metric label="今日输入" value={String(todayCount)} />
        <Metric label="累计历史" value={String(history.length)} />
        <Metric label="最长录音" value={`${config.max_recording_seconds}s`} />
      </section>

      <section className="echo-panel echo-ai-workspace">
        <div className="echo-ai-toolbar">
          <div className="echo-ai-title">
            <span className="echo-ai-title__icon" aria-hidden="true">
              <MessageCircle size={18} />
            </span>
            <div>
              <h3>AI 工作台</h3>
              <p>{backendManaged ? '后台托管模式' : '本机配置模式'}</p>
            </div>
          </div>
          <div className="echo-ai-toolbar__side">
            <ServiceSummary
              text={serviceSummaryText}
              detail={serviceSummaryDetail}
              tone={serviceSummaryTone}
            />
            <div className="echo-ai-toolbar__actions">
              <button
                type="button"
                className="echo-button"
                onClick={() => void openBlankMarkdownEditor()}
                disabled={forceUpdateRequired || markdownEditorOpening}
              >
                <FileText size={16} />
                写文章
              </button>
              {canResumeMarkdownDraft && markdownDraft && (
                <button
                  type="button"
                  className="echo-button"
                  onClick={() => void openMarkdownDraft(markdownDraft)}
                >
                  <FileText size={16} />
                  继续编辑
                </button>
              )}
              <button
                type="button"
                className="echo-button"
                onClick={() => void handleReadScreen('selection')}
                disabled={forceUpdateRequired || ocrBusy || !screenOcrReady}
              >
                {ocrBusy ? <Loader2 size={16} className="echo-spin" /> : <ScanLine size={16} />}
                系统截图识别
              </button>
              <button
                type="button"
                className="echo-button echo-button--primary"
                onClick={() => uploadInputRef.current?.click()}
                disabled={forceUpdateRequired || ocrBusy || !ocrReady}
              >
                {ocrBusy ? <Loader2 size={16} className="echo-spin" /> : <Upload size={16} />}
                上传附件处理
              </button>
            </div>
          </div>
          <input
            ref={uploadInputRef}
            type="file"
            accept={ocrUploadAcceptValue}
            aria-label="上传图片或 PDF 处理"
            hidden
            onChange={(event) => void handleUploadFileChange(event)}
          />
        </div>

        <div className="echo-ai-chip-row" aria-label="识别与导出能力">
          <ScenePresetSelect
            presets={scenePresets}
            value={selectedScenePresetId}
            onChange={setSelectedScenePresetId}
          />
          <div className="echo-ai-capability-chips" aria-label="导出能力">
            {aiCapabilityChips.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>

        <div className="echo-ai-result-panel">
          <div className="echo-ai-result-head">
            <div>
              <strong>{workspaceResultTitle}</strong>
              <span>{workspaceResultMeta}</span>
            </div>
            <div className="echo-ai-result-actions">
              {ttsAvailable && (
                <button
                  type="button"
                  className="echo-button"
                  onClick={() =>
                    void speakText(answer?.answer ?? '', 'answer', workspaceFeedbackResourceId)
                  }
                  disabled={!answer?.answer || ttsBusy !== null}
                >
                  {ttsBusy === 'answer' ? (
                    <Loader2 size={16} className="echo-spin" />
                  ) : (
                    <Volume2 size={16} />
                  )}
                  朗读回答
                </button>
              )}
              {answerText && (
                <button
                  type="button"
                  className="echo-button"
                  aria-label="整理 AI 回答"
                  onClick={() => answer && openAnswerInMarkdownEditor(answer)}
                >
                  <FileText size={16} />
                  整理
                </button>
              )}
              {answerText && (
                <button
                  type="button"
                  className="echo-button"
                  onClick={() =>
                    void copyWorkbenchText(
                      answerText,
                      'workspace',
                      workspaceFeedbackResourceId,
                      '回答已复制。',
                    )
                  }
                >
                  <Clipboard size={16} />
                  复制回答
                </button>
              )}
              {!answerText && ocrPreviewText && (
                <button
                  type="button"
                  className="echo-button"
                  aria-label="整理识别结果"
                  onClick={() =>
                    ocrResult &&
                    requestOpenMarkdownEditor({
                      title: ocrResult.source_name || ocrResult.window_title || 'OCR 结果',
                      text: ocrPreviewText,
                      source: ocrResult.source_kind === 'upload' ? 'upload_ocr' : 'screen_ocr',
                      sourceName: ocrResult.source_name || ocrResult.window_title,
                    })
                  }
                >
                  <FileText size={16} />
                  整理
                </button>
              )}
              {!answerText && ocrPreviewText && (
                <button
                  type="button"
                  className="echo-button"
                  onClick={() =>
                    void copyWorkbenchText(
                      ocrPreviewText,
                      'workspace',
                      workspaceFeedbackResourceId,
                      '结果已复制。',
                    )
                  }
                >
                  <Clipboard size={16} />
                  复制识别结果
                </button>
              )}
            </div>
          </div>
          {!answerText && ocrPreviewText && workspaceOcrWarning && (
            <div className="echo-panel-alert echo-panel-alert--warn" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{workspaceOcrWarning}</span>
            </div>
          )}
          <div
            className={[
              'echo-answer-box',
              (askBusy || answer || ocrPreviewText) && 'has-content',
              ocrPreviewText && 'echo-answer-box--scrollable',
              askBusy && 'is-busy',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {visibleWorkspaceFeedback && (
              <div
                className={`echo-panel-alert echo-panel-alert--${visibleWorkspaceFeedback.type === 'success' ? 'ok' : 'warn'} echo-workbench-feedback`}
                role={visibleWorkspaceFeedback.type === 'success' ? 'status' : 'alert'}
              >
                {visibleWorkspaceFeedback.type === 'success' ? (
                  <CheckCircle2 size={15} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={15} aria-hidden="true" />
                )}
                <span>{visibleWorkspaceFeedback.message}</span>
              </div>
            )}
            {askBusy && pendingQuestion ? (
              <AskPendingView question={pendingQuestion} />
            ) : answer ? (
              <AskAnswerView
                value={{ ...answer, answer: visibleAnswer }}
                streaming={visibleAnswer.length < answer.answer.length}
                error={askTask.error !== null}
              />
            ) : ocrPreviewText ? (
              <OcrPreview value={ocrPreviewText} />
            ) : llmReady ? (
              '暂无内容'
            ) : (
              llmUnavailableMessage
            )}
          </div>
        </div>

        <div
          className={
            askBusy
              ? 'echo-ask-inline echo-ai-composer is-busy'
              : 'echo-ask-inline echo-ai-composer'
          }
        >
          <input
            ref={questionInputRef}
            value={question}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            onFocus={(event) => {
              if (event.currentTarget.value) event.currentTarget.select()
            }}
            placeholder="例如：帮我判断当前窗口可能在做什么"
            disabled={forceUpdateRequired}
            readOnly={askBusy}
            aria-busy={askBusy}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAsk()
            }}
          />
          <button
            type="button"
            className="echo-button echo-button--primary"
            onClick={handleAsk}
            disabled={forceUpdateRequired || askBusy || !llmReady}
          >
            {askBusy ? <Loader2 size={16} className="echo-spin" /> : <Search size={16} />}
            {askBusy ? '思考中' : '提问'}
          </button>
        </div>
      </section>

      {history.length > 0 && (
        <RecentHistoryPanel
          entries={recentHistory}
          selectedIds={visibleSelectedHistoryIds}
          selectionStable={!historySelectionReconcilePending}
          mutation={historyMutation}
          onSendToEditor={openHistoryInMarkdownEditor}
          onSelectionChange={updateHistorySelection}
          onRequestDelete={requestHistoryDeletion}
          onDismissError={clearHistoryMutationError}
        />
      )}

      {historyDeleteRequest && (
        <HistoryDeleteConfirmDialog
          request={historyDeleteRequest}
          busy={historyMutation.status === 'running'}
          error={historyMutation.error}
          onCancel={cancelHistoryDeletion}
          onConfirm={() => void confirmHistoryDeletion()}
        />
      )}

      {ocrDialog && (
        <ScreenOcrDialog
          state={ocrDialog}
          onClose={closeOcrDialog}
          feedback={visibleOcrDialogFeedback}
          onCopy={() => {
            if (ocrDialog.status === 'success') {
              void copyOcrResult(cleanOcrText(ocrDialog.result.text))
            }
          }}
          onDownload={(result) => void downloadMarkdown(result)}
          docxExportBusy={ocrDocxExportBusy}
          onExportDocx={(result) => void exportCurrentDocx(result)}
          pdfExportFile={pdfExportFile}
          pdfExportBusy={pdfExportBusy}
          onExportPdfImages={(file) => void exportCurrentPdfImages(file)}
          onAskFromResult={(result) => handleAskFromOcr(result)}
          onSendToEditor={openOcrInMarkdownEditor}
        />
      )}
      {restorableMarkdownDraft && !markdownDraft && (
        <MarkdownDraftRestoreDialog
          draft={restorableMarkdownDraft}
          onDismiss={dismissRestorableMarkdownDraft}
          onRestore={() => void restoreRecentMarkdownDraft()}
          onDiscard={discardRecentMarkdownDraft}
        />
      )}
      {markdownEditorOpen && markdownDraft && (
        <div className="echo-dialog-backdrop" role="presentation" onMouseDown={closeMarkdownEditor}>
          <div onMouseDown={(event) => event.stopPropagation()}>
            <Suspense fallback={<MarkdownEditorLoadingDialog />}>
              <MarkdownEditorShell
                draft={markdownDraft}
                onDraftChange={updateMarkdownDraft}
                onOpenMarkdown={openMarkdownDraftFile}
                onCopyMarkdown={(draft) => void copyMarkdownDraft(draft)}
                onSaveMarkdown={(draft) => void saveMarkdownDraft(draft)}
                onExportDocx={(draft) => void exportMarkdownDraftDocx(draft)}
                speechConfig={speechConfig}
                onAiRequest={runMarkdownDraftAi}
                aiAvailable={llmReady}
                scenePresets={scenePresets}
                saveBusy={markdownSaveBusy}
                exportBusy={draftDocxExportBusy}
                voiceAppendEnabled={markdownVoiceAppendEnabled}
                onVoiceAppendEnabledChange={updateMarkdownVoiceAppendEnabled}
                fileFeedback={visibleMarkdownFileFeedback}
                onDismissFileFeedback={clearMarkdownFileFeedback}
                onClose={closeMarkdownEditor}
                onClearAndClose={clearAndCloseMarkdownEditor}
              />
            </Suspense>
          </div>
        </div>
      )}
      {pendingMarkdownRequest && (
        <MarkdownDraftConflictDialog
          request={pendingMarkdownRequest}
          onCancel={cancelPendingMarkdownRequest}
          onApply={applyMarkdownOpenRequest}
        />
      )}
    </div>
  )
}
