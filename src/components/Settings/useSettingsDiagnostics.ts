import {
  acknowledgeIdempotentOperation,
  diagnosePdfUpload,
  diagnoseTtsProxy,
  type DesktopBootstrap,
  type TtsDiagnosticResult,
} from '../../lib/tauri'
import { fileToBase64 } from '../../lib/filePayload'
import type { ErrorContext } from '../../lib/userErrors'
import { useAppStore, type DiagnosticPdfFile } from '../../stores/appStore'

type SettingsErrorMessage = (error: unknown, fallback: string, context?: ErrorContext) => string

type UseSettingsDiagnosticsOptions = {
  desktopAuthReady: boolean
  desktopBootstrap: DesktopBootstrap | null
  settingsErrorMessage: SettingsErrorMessage
  ttsDefaultVoice?: string | null
  visibleDesktopToken: string
}

export function useSettingsDiagnostics({
  desktopAuthReady,
  desktopBootstrap,
  settingsErrorMessage,
  ttsDefaultVoice,
  visibleDesktopToken,
}: UseSettingsDiagnosticsOptions) {
  const diagnosticsOutcome = useAppStore((s) => s.settingsDiagnosticsOutcome)
  const tryStartSettingsOperation = useAppStore((s) => s.tryStartSettingsOperation)
  const isCurrentSettingsOperation = useAppStore((s) => s.isCurrentSettingsOperation)
  const setSettingsDiagnosticPdfFile = useAppStore((s) => s.setSettingsDiagnosticPdfFile)
  const updateSettingsDiagnosticTts = useAppStore((s) => s.updateSettingsDiagnosticTts)
  const updateSettingsDiagnosticPdf = useAppStore((s) => s.updateSettingsDiagnosticPdf)
  const completeSettingsDiagnostics = useAppStore((s) => s.completeSettingsDiagnostics)
  const failSettingsDiagnostics = useAppStore((s) => s.failSettingsDiagnostics)

  const ttsDiagnostic = diagnosticsOutcome.tts
  const pdfDiagnostic = diagnosticsOutcome.pdf
  const diagnosticPdfFile = diagnosticsOutcome.pdfFile

  async function requestTtsDiagnostic(leaseId: number) {
    const token = desktopAuthReady ? visibleDesktopToken : ''
    if (!desktopBootstrap?.apiBaseUrl) {
      const result: TtsDiagnosticResult = {
        ok: false,
        stage: 'bootstrap',
        httpStatus: null,
        code: 'bootstrap_missing',
        message: '尚未同步后台托管配置。',
        requestId: null,
        mimeType: null,
        audioBytes: null,
        elapsedMs: 0,
      }
      if (!isCurrentSettingsOperation(leaseId)) return result
      updateSettingsDiagnosticTts(leaseId, result)
      return result
    }

    const result = await diagnoseTtsProxy(
      desktopBootstrap.apiBaseUrl,
      token,
      'EcholIKE TTS diagnostic',
      ttsDefaultVoice ?? undefined,
    )
    if (!isCurrentSettingsOperation(leaseId)) return result
    updateSettingsDiagnosticTts(leaseId, result)
    if (result.operationId) {
      await acknowledgeIdempotentOperation(result.operationId).catch((error) => {
        console.warn('TTS diagnostic operation ACK deferred:', error)
      })
    }
    return result
  }

  async function runTtsDiagnostic() {
    const leaseId = tryStartSettingsOperation('tts-diagnostic')
    if (leaseId === null) return
    try {
      await requestTtsDiagnostic(leaseId)
      completeSettingsDiagnostics(leaseId)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = settingsErrorMessage(error, '朗读服务检查未完成，请稍后重试。', 'tts')
      failSettingsDiagnostics(leaseId, message)
    }
  }

  async function requestPdfDiagnostic(leaseId: number, file: DiagnosticPdfFile) {
    const result = await diagnosePdfUpload(file)
    const next = { ...result, fileName: file.fileName }
    if (!isCurrentSettingsOperation(leaseId)) return next
    updateSettingsDiagnosticPdf(leaseId, next)
    return next
  }

  async function runPdfDiagnostic(file = diagnosticPdfFile) {
    if (!file) return
    const leaseId = tryStartSettingsOperation('pdf-diagnostic')
    if (leaseId === null) return
    try {
      await requestPdfDiagnostic(leaseId, file)
      completeSettingsDiagnostics(leaseId)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = settingsErrorMessage(error, 'PDF 解析诊断失败。', 'ocr')
      failSettingsDiagnostics(leaseId, message)
    }
  }

  async function runDiagnostics() {
    const leaseId = tryStartSettingsOperation('combined-diagnostic')
    if (leaseId === null) return
    try {
      await requestTtsDiagnostic(leaseId)
      if (!isCurrentSettingsOperation(leaseId)) return
      if (diagnosticPdfFile) {
        await requestPdfDiagnostic(leaseId, diagnosticPdfFile)
        if (!isCurrentSettingsOperation(leaseId)) return
      }
      completeSettingsDiagnostics(leaseId)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = settingsErrorMessage(error, '诊断失败。')
      failSettingsDiagnostics(leaseId, message)
    }
  }

  async function diagnoseSelectedPdf(file: File) {
    const leaseId = tryStartSettingsOperation('pdf-diagnostic')
    if (leaseId === null) return
    try {
      const mimeType =
        file.type ||
        (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream')
      const nextFile: DiagnosticPdfFile = {
        fileName: file.name || 'document.pdf',
        mimeType,
        fileBase64: await fileToBase64(file, {
          readErrorMessage: '读取诊断 PDF 失败。',
          emptyErrorMessage: '诊断 PDF 内容为空。',
        }),
        inputBytes: file.size,
      }
      if (!isCurrentSettingsOperation(leaseId)) return
      setSettingsDiagnosticPdfFile(leaseId, nextFile)
      await requestPdfDiagnostic(leaseId, nextFile)
      completeSettingsDiagnostics(leaseId)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = settingsErrorMessage(error, 'PDF 解析诊断失败。', 'ocr')
      failSettingsDiagnostics(leaseId, message)
    }
  }

  return {
    diagnoseSelectedPdf,
    diagnosticPdfFile,
    pdfDiagnostic,
    runDiagnostics,
    runPdfDiagnostic,
    runTtsDiagnostic,
    ttsDiagnostic,
  }
}
