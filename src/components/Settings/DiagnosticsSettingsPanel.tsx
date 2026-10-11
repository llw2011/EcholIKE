import { useRef } from 'react'
import type { ChangeEvent } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  FileText,
  Loader2,
  RefreshCw,
  Volume2,
} from 'lucide-react'
import type { TtsDiagnosticResult } from '../../lib/tauri'
import type { DiagnosticPdfFile, SettingsPdfDiagnosticResult } from '../../stores/appStore'
import {
  DiagnosticResult,
  Panel,
  ServiceStatus,
  SettingLine,
  type PanelAlertState,
} from './settingsUi'

interface DiagnosticsSettingsPanelProps {
  alert?: PanelAlertState
  statusSummary: string
  operationBusy: boolean
  diagnosticsBusy: boolean
  ttsBusy: boolean
  pdfBusy: boolean
  ttsDiagnostic: TtsDiagnosticResult | null
  ttsDiagnosticDescription: string | null
  pdfDiagnostic: SettingsPdfDiagnosticResult | null
  pdfDiagnosticDescription: string | null
  diagnosticPdfFile: DiagnosticPdfFile | null
  diagnosticReport: string
  onRunDiagnostics: () => Promise<void>
  onCopyDiagnosticReport: () => Promise<void>
  onRunTtsDiagnostic: () => Promise<void>
  onDiagnoseSelectedPdf: (file: File) => Promise<void>
  onRunPdfDiagnostic: () => Promise<void>
}

function formatByteSize(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN)) return '-'
  const bytes = value ?? 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function DiagnosticsSettingsPanel({
  alert,
  statusSummary,
  operationBusy,
  diagnosticsBusy,
  ttsBusy,
  pdfBusy,
  ttsDiagnostic,
  ttsDiagnosticDescription,
  pdfDiagnostic,
  pdfDiagnosticDescription,
  diagnosticPdfFile,
  diagnosticReport,
  onRunDiagnostics,
  onCopyDiagnosticReport,
  onRunTtsDiagnostic,
  onDiagnoseSelectedPdf,
  onRunPdfDiagnostic,
}: DiagnosticsSettingsPanelProps) {
  const diagnosticPdfInputRef = useRef<HTMLInputElement | null>(null)

  async function handleDiagnosticPdfChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    await onDiagnoseSelectedPdf(file)
  }

  const actions = (
    <>
      <button
        type="button"
        className="echo-button echo-button--primary"
        onClick={() => void onRunDiagnostics()}
        disabled={operationBusy}
      >
        {diagnosticsBusy ? <Loader2 size={16} className="echo-spin" /> : <RefreshCw size={16} />}
        运行诊断
      </button>
      <button
        type="button"
        className="echo-button"
        onClick={() => void onCopyDiagnosticReport()}
        disabled={operationBusy}
      >
        <Clipboard size={16} />
        复制报告
      </button>
    </>
  )

  return (
    <Panel
      title="诊断"
      alert={alert}
      actions={actions}
      status={
        <ServiceStatus>
          <span>{statusSummary || '朗读服务与 PDF 文件解析。'}</span>
        </ServiceStatus>
      }
    >
      <SettingLine
        icon={Volume2}
        title="朗读服务"
        description="检查账号权限、后台服务配置和音频返回。"
      >
        <button
          type="button"
          className="echo-button"
          onClick={() => void onRunTtsDiagnostic()}
          disabled={operationBusy}
        >
          {ttsBusy ? <Loader2 size={16} className="echo-spin" /> : <Volume2 size={16} />}
          检查朗读服务
        </button>
      </SettingLine>
      {ttsDiagnostic && (
        <SettingLine
          icon={ttsDiagnostic.ok ? CheckCircle2 : AlertTriangle}
          title="朗读检查结果"
          description={ttsDiagnosticDescription ?? '朗读服务检查未完成。'}
          wide
        >
          <DiagnosticResult
            ok={ttsDiagnostic.ok}
            items={[
              ttsDiagnostic.mimeType ? `类型 ${ttsDiagnostic.mimeType}` : null,
              `音频 ${formatByteSize(ttsDiagnostic.audioBytes)}`,
              `${ttsDiagnostic.elapsedMs}ms`,
            ]}
          />
        </SettingLine>
      )}

      <SettingLine
        icon={FileText}
        title="PDF 解析"
        description="选择一份 PDF，检查文件读取、应用通信和页面解析。"
        wide
      >
        <input
          ref={diagnosticPdfInputRef}
          type="file"
          accept="application/pdf,.pdf"
          aria-label="选择 PDF 诊断文件"
          hidden
          onChange={(event) => void handleDiagnosticPdfChange(event)}
        />
        <div className="echo-diagnostic-actions">
          <button
            type="button"
            className="echo-button"
            onClick={() => diagnosticPdfInputRef.current?.click()}
            disabled={operationBusy}
          >
            {pdfBusy ? <Loader2 size={16} className="echo-spin" /> : <FileText size={16} />}
            选择 PDF
          </button>
          {diagnosticPdfFile && (
            <button
              type="button"
              className="echo-button"
              onClick={() => void onRunPdfDiagnostic()}
              disabled={operationBusy}
            >
              <RefreshCw size={16} />
              重新诊断
            </button>
          )}
          {diagnosticPdfFile && (
            <span className="echo-diagnostic-file">
              {diagnosticPdfFile.fileName} · {formatByteSize(diagnosticPdfFile.inputBytes)}
            </span>
          )}
        </div>
      </SettingLine>
      {pdfDiagnostic && (
        <SettingLine
          icon={pdfDiagnostic.ok ? CheckCircle2 : AlertTriangle}
          title="PDF 结果"
          description={pdfDiagnosticDescription ?? 'PDF 文件检查未完成。'}
          wide
        >
          <DiagnosticResult
            ok={pdfDiagnostic.ok}
            items={[
              `文件 ${pdfDiagnostic.fileName}`,
              `页数 ${pdfDiagnostic.pageCount ?? '-'}`,
              `大小 ${formatByteSize(pdfDiagnostic.inputBytes)}`,
              `${pdfDiagnostic.elapsedMs}ms`,
            ]}
          />
        </SettingLine>
      )}

      <SettingLine
        icon={Clipboard}
        title="诊断报告"
        description="报告会脱敏，不包含后台令牌和服务密钥。"
        wide
      >
        <pre className="echo-diagnostic-report">{diagnosticReport}</pre>
      </SettingLine>
    </Panel>
  )
}
