import { useEffect, useRef, useState } from 'react'
import { APP_NAME } from '../../lib/branding'
import { isDesktopAuthSessionAuthenticated } from '../../lib/desktopAuth'
import {
  acknowledgeIdempotentOperation,
  readScreenOcr,
  readScreenOcrProxy,
  readScreenOcrSelection,
  readScreenOcrSelectionProxy,
  readUploadedOcr,
  readUploadedOcrProxy,
  readUploadedPdfProxy,
  testOcrConnection,
  type DetectedAppContext,
  type OcrReadResult,
  type UploadedOcrFile,
} from '../../lib/tauri'
import { backendErrorDiagnostic, userFacingErrorMessage } from '../../lib/userErrors'
import { useFileCommandDomain } from '../../stores/fileCommandStore'
import { localOcrConfigurationKey, useAppStore, type OcrTaskKind } from '../../stores/appStore'
import {
  OCR_PROXY_PDF_MAX_PAGES,
  OCR_UPLOAD_IMAGE_MIME_TYPES,
  OCR_UPLOAD_MAX_BYTES,
  OCR_UPLOAD_MIME_TYPES,
  backendOcrFailureImpairsService,
  buildUploadedOcrFile,
  canonicalOcrMimeType,
  cleanOcrResult,
  isPdfOcrUpload,
  ocrUploadAccept,
  selectionOcrResult,
  type ScreenOcrMode,
} from './ocrDomain'

type UseWorkbenchOcrOptions = {
  forceUpdateRequired: boolean
  onRequiredUpdate: () => void
}

function ocrErrorMessage(error: unknown, fallback: string) {
  return userFacingErrorMessage(error, fallback, 'ocr')
}

export function useWorkbenchOcr({ forceUpdateRequired, onRequiredUpdate }: UseWorkbenchOcrOptions) {
  const config = useAppStore((state) => state.config)
  const desktopBootstrap = useAppStore((state) => state.desktopBootstrap)
  const desktopAuthToken = useAppStore((state) => state.desktopAuthToken)
  const desktopAuthStatus = useAppStore((state) => state.desktopAuthStatus)
  const desktopBootstrapAuthToken = useAppStore((state) => state.desktopBootstrapAuthToken)
  const screenOcrShortcutRequest = useAppStore((state) => state.screenOcrShortcutRequest)
  const claimScreenOcrShortcutRequest = useAppStore((state) => state.claimScreenOcrShortcutRequest)
  const ocrTask = useAppStore((state) => state.ocrTask)
  const tryStartOcrTask = useAppStore((state) => state.tryStartOcrTask)
  const finishOcrTask = useAppStore((state) => state.finishOcrTask)
  const finalizeOcrTaskAcknowledgement = useAppStore(
    (state) => state.finalizeOcrTaskAcknowledgement,
  )
  const cancelOcrTask = useAppStore((state) => state.cancelOcrTask)
  const failOcrTask = useAppStore((state) => state.failOcrTask)
  const dismissOcrDialog = useAppStore((state) => state.dismissOcrDialog)
  const localOcrAvailability = useAppStore((state) => state.localOcrAvailability)
  const beginLocalOcrProbe = useAppStore((state) => state.beginLocalOcrProbe)
  const finishLocalOcrProbe = useAppStore((state) => state.finishLocalOcrProbe)
  const setOcrDialogFeedback = useFileCommandDomain((state) => state.setOcrFeedback)
  const [detectedContext, setDetectedContext] = useState<DetectedAppContext | null>(null)
  const [backendServiceError, setBackendServiceError] = useState<string | undefined>()
  const handleReadScreenRef = useRef<(mode?: ScreenOcrMode) => Promise<void>>(async () => undefined)

  const backendManaged = config.config_source === 'backend'
  const desktopToken = isDesktopAuthSessionAuthenticated(
    desktopBootstrap,
    desktopAuthToken,
    desktopAuthStatus,
    desktopBootstrapAuthToken,
  )
    ? desktopAuthToken
    : null
  const localOcrConfiguration = localOcrConfigurationKey(config)
  const localOcrConfigured = Boolean(localOcrConfiguration)
  const localOcrStatus =
    localOcrAvailability.configurationKey === localOcrConfiguration
      ? localOcrAvailability.status
      : 'idle'
  const localOcrCapabilities =
    localOcrAvailability.configurationKey === localOcrConfiguration
      ? localOcrAvailability.capabilities
      : null
  const localOcrImageReady = Boolean(
    localOcrConfigured && localOcrStatus === 'available' && localOcrCapabilities?.imageAvailable,
  )
  const localOcrPdfReady = Boolean(
    localOcrConfigured && localOcrStatus === 'available' && localOcrCapabilities?.pdfAvailable,
  )
  const localOcrReady = localOcrImageReady || localOcrPdfReady
  const cloudOcr = desktopBootstrap?.services?.ocr
  const cloudOcrCapabilities = cloudOcr?.capabilities
  const cloudOcrBaseReady = Boolean(
    backendManaged &&
    cloudOcr?.mode === 'proxy' &&
    cloudOcr.configured !== false &&
    desktopBootstrap?.apiBaseUrl &&
    desktopToken,
  )
  const cloudOcrAcceptedMimeTypes =
    cloudOcrCapabilities?.acceptedMimeTypes === undefined
      ? OCR_UPLOAD_MIME_TYPES
      : cloudOcrCapabilities.acceptedMimeTypes
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
  const cloudOcrDirectRouteReady =
    cloudOcrCapabilities?.processingRoutes === undefined ||
    cloudOcrCapabilities.processingRoutes.includes('direct')
  const cloudOcrPipelineRouteReady =
    cloudOcrCapabilities?.processingRoutes?.includes('pipeline') === true
  const cloudOcrImageReady = Boolean(
    cloudOcrBaseReady &&
    cloudOcrCapabilities?.imageAvailable !== false &&
    cloudOcrDirectRouteReady &&
    cloudOcrAcceptedMimeTypes.some((value) => value.startsWith('image/')),
  )
  const cloudOcrScreenReady = cloudOcrImageReady && cloudOcrAcceptedMimeTypes.includes('image/png')
  const cloudOcrServerPdfReady = Boolean(
    cloudOcrCapabilities?.pdfAvailable === true &&
    cloudOcrCapabilities.documentContract === 'ocr-document-v1' &&
    cloudOcrCapabilities.pdfMode === 'server-pipeline' &&
    cloudOcrPipelineRouteReady &&
    (cloudOcrCapabilities.maxPdfPages ?? 0) >= OCR_PROXY_PDF_MAX_PAGES,
  )
  const cloudOcrLegacyPdfReady = Boolean(
    cloudOcrCapabilities === undefined ||
    (cloudOcrCapabilities.pdfAvailable === true &&
      cloudOcrCapabilities.pdfMode === 'client-rasterized' &&
      cloudOcrDirectRouteReady &&
      (cloudOcrCapabilities.maxPdfPages ?? 0) >= OCR_PROXY_PDF_MAX_PAGES),
  )
  const cloudOcrPdfMode = cloudOcrServerPdfReady
    ? 'server-pipeline'
    : cloudOcrLegacyPdfReady
      ? 'client-rasterized'
      : null
  const cloudOcrPdfReady = Boolean(
    cloudOcrBaseReady && cloudOcrPdfMode && cloudOcrAcceptedMimeTypes.includes('application/pdf'),
  )
  const cloudOcrUploadMimeTypes = cloudOcrAcceptedMimeTypes.filter((mimeType) =>
    mimeType === 'application/pdf'
      ? cloudOcrPdfReady
      : mimeType.startsWith('image/') && cloudOcrImageReady,
  )
  const cloudOcrReady = cloudOcrImageReady || cloudOcrPdfReady
  const cloudOcrMaxInputBytes =
    typeof cloudOcrCapabilities?.maxInputBytes === 'number' &&
    Number.isFinite(cloudOcrCapabilities.maxInputBytes) &&
    cloudOcrCapabilities.maxInputBytes > 0
      ? Math.min(OCR_UPLOAD_MAX_BYTES, Math.floor(cloudOcrCapabilities.maxInputBytes))
      : OCR_UPLOAD_MAX_BYTES
  const localOcrAcceptedMimeTypes = [
    ...(localOcrImageReady ? OCR_UPLOAD_IMAGE_MIME_TYPES : []),
    ...(localOcrPdfReady ? ['application/pdf'] : []),
  ]
  const ocrUploadAcceptValue = ocrUploadAccept(
    backendManaged ? cloudOcrUploadMimeTypes : localOcrAcceptedMimeTypes,
  )
  const ocrReady = backendManaged ? cloudOcrReady : localOcrReady
  const screenOcrReady = backendManaged ? cloudOcrScreenReady : localOcrImageReady
  const cloudImageOcrUnavailableMessage =
    '后台托管图片识别不可用，请先同步后台配置或切换到本机配置。'
  const cloudPdfOcrUnavailableMessage = '后台托管 PDF 识别不可用，请先同步后台配置或更新后台服务。'
  const localImageOcrUnavailableMessage =
    localOcrStatus === 'checking'
      ? '正在检查本机图片识别组件，请稍候。'
      : '本机图片识别组件不可用，请在设置里检查识别模型和图片识别组件。'
  const localPdfOcrUnavailableMessage =
    localOcrStatus === 'checking'
      ? '正在检查本机文档处理组件，请稍候。'
      : '本机 PDF 文档组件不可用，请在设置里检查 PDF 文档组件。'
  const statusText = backendManaged
    ? backendServiceError
      ? '后台托管异常'
      : cloudOcrImageReady && cloudOcrPdfReady
        ? '后台图片/PDF 就绪'
        : cloudOcrImageReady
          ? '后台图片就绪'
          : cloudOcrPdfReady
            ? '后台 PDF 就绪'
            : '后台托管不可用'
    : !localOcrConfigured
      ? '缺配置'
      : localOcrStatus === 'checking'
        ? '检测中'
        : localOcrImageReady && localOcrPdfReady
          ? '本机组件就绪'
          : localOcrImageReady
            ? '本机图片就绪'
            : localOcrPdfReady
              ? '本机 PDF 就绪'
              : localOcrStatus === 'unavailable'
                ? '本机不可用'
                : '待验证'
  const hasServiceIssue =
    (backendManaged
      ? !cloudOcrImageReady || !cloudOcrPdfReady
      : !localOcrImageReady || !localOcrPdfReady) || Boolean(backendServiceError)
  const ocrDialogOpen = Boolean(ocrTask.dialogState)

  useEffect(() => {
    if (backendManaged || !localOcrConfiguration || localOcrStatus !== 'idle') return
    const leaseId = beginLocalOcrProbe(localOcrConfiguration)
    if (leaseId === null) return
    void testOcrConnection(config.ocr_base_url, config.ocr_model)
      .then((capabilities) => {
        finishLocalOcrProbe(localOcrConfiguration, leaseId, capabilities)
      })
      .catch(() => {
        finishLocalOcrProbe(localOcrConfiguration, leaseId, null)
      })
  }, [
    backendManaged,
    beginLocalOcrProbe,
    config.ocr_base_url,
    config.ocr_model,
    finishLocalOcrProbe,
    localOcrConfiguration,
    localOcrStatus,
  ])

  function beginOcrTask(kind: OcrTaskKind, sourceName: string, message?: string) {
    const leaseId = tryStartOcrTask(kind, sourceName, message)
    if (leaseId !== null) setOcrDialogFeedback(null)
    return leaseId
  }

  async function readScreenByConfigSource(mode: ScreenOcrMode): Promise<OcrReadResult | null> {
    if (backendManaged) {
      if (!desktopBootstrap?.apiBaseUrl || !desktopToken || !cloudOcrScreenReady) {
        throw new Error(cloudImageOcrUnavailableMessage)
      }
      try {
        const result =
          mode === 'selection'
            ? selectionOcrResult(
                await readScreenOcrSelectionProxy(desktopBootstrap.apiBaseUrl, desktopToken),
              )
            : await readScreenOcrProxy(desktopBootstrap.apiBaseUrl, desktopToken)
        if (result !== null) setBackendServiceError(undefined)
        return result
      } catch (error) {
        const diagnostic = backendErrorDiagnostic(error)
        const message = ocrErrorMessage(error, '识别未完成，请稍后重试。')
        if (diagnostic) {
          if (backendOcrFailureImpairsService(diagnostic)) setBackendServiceError(message)
          throw error
        }
        throw new Error(message)
      }
    }

    if (localOcrImageReady) {
      if (mode === 'selection') {
        return selectionOcrResult(
          await readScreenOcrSelection(config.ocr_base_url, config.ocr_model),
        )
      }
      return await readScreenOcr(config.ocr_base_url, config.ocr_model)
    }

    throw new Error(localImageOcrUnavailableMessage)
  }

  async function readUploadedByConfigSource(file: UploadedOcrFile) {
    if (backendManaged) {
      const pdfUpload =
        file.mimeType === 'application/pdf' || file.fileName.toLowerCase().endsWith('.pdf')
      if (
        !desktopBootstrap?.apiBaseUrl ||
        !desktopToken ||
        (pdfUpload ? !cloudOcrPdfReady : !cloudOcrImageReady)
      ) {
        throw new Error(pdfUpload ? cloudPdfOcrUnavailableMessage : cloudImageOcrUnavailableMessage)
      }
      try {
        const result =
          pdfUpload && cloudOcrPdfMode === 'server-pipeline'
            ? await readUploadedPdfProxy(desktopBootstrap.apiBaseUrl, desktopToken, file)
            : await readUploadedOcrProxy(desktopBootstrap.apiBaseUrl, desktopToken, file)
        setBackendServiceError(undefined)
        return result
      } catch (error) {
        const diagnostic = backendErrorDiagnostic(error)
        const message = ocrErrorMessage(error, '识别未完成，请稍后重试。')
        if (diagnostic) {
          if (backendOcrFailureImpairsService(diagnostic)) setBackendServiceError(message)
          throw error
        }
        throw new Error(message)
      }
    }

    const pdfUpload =
      file.mimeType === 'application/pdf' || file.fileName.toLowerCase().endsWith('.pdf')
    if (pdfUpload ? localOcrPdfReady : localOcrImageReady) {
      return await readUploadedOcr(config.ocr_base_url, config.ocr_model, file)
    }

    throw new Error(pdfUpload ? localPdfOcrUnavailableMessage : localImageOcrUnavailableMessage)
  }

  async function handleReadScreen(mode: ScreenOcrMode = 'window') {
    if (forceUpdateRequired) {
      onRequiredUpdate()
      return
    }
    if (!screenOcrReady) {
      const message = backendManaged
        ? cloudImageOcrUnavailableMessage
        : localImageOcrUnavailableMessage
      const leaseId = beginOcrTask(
        mode === 'selection' ? 'screen-selection' : 'screen-window',
        'screen',
      )
      if (leaseId !== null) failOcrTask(leaseId, message)
      return
    }

    const leaseId = beginOcrTask(
      mode === 'selection' ? 'screen-selection' : 'screen-window',
      'screen',
      mode === 'selection'
        ? `正在打开系统截图工具。请框选要识别的区域，截图完成后 ${APP_NAME} 会自动 OCR。`
        : `正在隐藏 ${APP_NAME} 并读取当前窗口文字，请稍候。`,
    )
    if (leaseId === null) return
    try {
      const rawResult = await readScreenByConfigSource(mode)
      if (rawResult === null) {
        cancelOcrTask(leaseId)
        return
      }
      const result = cleanOcrResult(rawResult)
      setDetectedContext({
        app_name: result.app_name,
        window_title: result.window_title,
        app_type: result.app_type,
      })
      const operationId = result.operation_id?.trim() || null
      const accepted = finishOcrTask(leaseId, result)
      if (accepted && operationId) {
        try {
          await acknowledgeIdempotentOperation(operationId)
        } catch (error) {
          console.warn('OCR operation ACK deferred:', error)
        } finally {
          finalizeOcrTaskAcknowledgement(leaseId, operationId)
        }
      }
    } catch (error) {
      const message = ocrErrorMessage(error, '屏幕内容识别未完成，请稍后重试。')
      failOcrTask(leaseId, message, backendErrorDiagnostic(error))
    }
  }

  async function readUploadedFile(file: File) {
    if (forceUpdateRequired) {
      onRequiredUpdate()
      return
    }
    const uploadOcrReady = backendManaged
      ? isPdfOcrUpload(file)
        ? cloudOcrPdfReady
        : cloudOcrImageReady
      : isPdfOcrUpload(file)
        ? localOcrPdfReady
        : localOcrImageReady
    if (!uploadOcrReady) {
      const message = backendManaged
        ? isPdfOcrUpload(file)
          ? cloudPdfOcrUnavailableMessage
          : cloudImageOcrUnavailableMessage
        : isPdfOcrUpload(file)
          ? localPdfOcrUnavailableMessage
          : localImageOcrUnavailableMessage
      const leaseId = beginOcrTask('upload', file.name || '上传附件')
      if (leaseId !== null) failOcrTask(leaseId, message)
      return
    }

    if (backendManaged && !cloudOcrAcceptedMimeTypes.includes(canonicalOcrMimeType(file))) {
      const leaseId = beginOcrTask('upload', file.name || '上传附件')
      if (leaseId !== null) failOcrTask(leaseId, '后台托管 OCR 不支持该附件格式。')
      return
    }

    const leaseId = beginOcrTask(
      'upload',
      file.name || '上传附件',
      `正在识别 ${file.name || '上传附件'}，会尽量还原为 Markdown，完成后可导出 .md 或 Word。`,
    )
    if (leaseId === null) return

    try {
      const uploaded = await buildUploadedOcrFile(
        file,
        backendManaged ? cloudOcrMaxInputBytes : OCR_UPLOAD_MAX_BYTES,
      )
      const result = cleanOcrResult(await readUploadedByConfigSource(uploaded))
      setDetectedContext({
        app_name: result.app_name,
        window_title: result.window_title,
        app_type: result.app_type,
      })
      const operationId = result.operation_id?.trim() || null
      const accepted = finishOcrTask(
        leaseId,
        result,
        isPdfOcrUpload(file, uploaded.mimeType) ? uploaded : null,
      )
      if (accepted && operationId) {
        try {
          await acknowledgeIdempotentOperation(operationId)
        } catch (error) {
          console.warn('OCR operation ACK deferred:', error)
        } finally {
          finalizeOcrTaskAcknowledgement(leaseId, operationId)
        }
      }
    } catch (error) {
      const message = ocrErrorMessage(error, '附件识别未完成，请检查文件后重试。')
      failOcrTask(leaseId, message, backendErrorDiagnostic(error))
    }
  }

  useEffect(() => {
    handleReadScreenRef.current = handleReadScreen
  })

  useEffect(() => {
    if (!claimScreenOcrShortcutRequest()) return
    void handleReadScreenRef.current('selection')
  }, [claimScreenOcrShortcutRequest, screenOcrShortcutRequest])

  useEffect(() => {
    if (!ocrDialogOpen) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') dismissOcrDialog()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismissOcrDialog, ocrDialogOpen])

  return {
    backendServiceError,
    detectedContext,
    dismissOcrDialog,
    hasServiceIssue,
    ocrBusy: ocrTask.status === 'running' || ocrTask.ackPending,
    ocrDialog: ocrTask.dialogState,
    ocrReady,
    ocrResult: ocrTask.result,
    ocrTask,
    ocrUploadAcceptValue,
    pdfExportFile: ocrTask.pdfExportFile,
    readScreen: handleReadScreen,
    readUploadedFile,
    screenOcrReady,
    statusText,
  }
}
