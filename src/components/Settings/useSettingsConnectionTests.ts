import { useMemo } from 'react'
import { benchLlmConnection, benchSttConnection, testOcrConnection } from '../../lib/tauri'
import { localOcrConfigurationKey, useAppStore, type AppConfig } from '../../stores/appStore'
import {
  loadConnectionTestCache,
  saveConnectionTestResult,
  type ConnectionTestResult,
} from './settingsCache'

type SettingsErrorMessage = (
  error: unknown,
  fallback: string,
  context?: 'settings' | 'stt' | 'llm' | 'ocr',
) => string

type UseSettingsConnectionTestsOptions = {
  config: AppConfig
  settingsErrorMessage: SettingsErrorMessage
}

export function useSettingsConnectionTests({
  config,
  settingsErrorMessage,
}: UseSettingsConnectionTestsOptions) {
  const initialConnectionTests = useMemo(loadConnectionTestCache, [])
  const connectionOutcomes = useAppStore((s) => s.settingsConnectionOutcomes)
  const tryStartSettingsOperation = useAppStore((s) => s.tryStartSettingsOperation)
  const isCurrentSettingsOperation = useAppStore((s) => s.isCurrentSettingsOperation)
  const completeSettingsConnection = useAppStore((s) => s.completeSettingsConnection)
  const failSettingsConnection = useAppStore((s) => s.failSettingsConnection)
  const localOcrAvailability = useAppStore((s) => s.localOcrAvailability)
  const beginLocalOcrProbe = useAppStore((s) => s.beginLocalOcrProbe)
  const finishLocalOcrProbe = useAppStore((s) => s.finishLocalOcrProbe)

  const sttLatency =
    connectionOutcomes.stt.status === 'idle'
      ? (initialConnectionTests.stt?.latency ?? null)
      : connectionOutcomes.stt.latencyMs
  const llmLatency =
    connectionOutcomes.llm.status === 'idle'
      ? (initialConnectionTests.llm?.latency ?? null)
      : connectionOutcomes.llm.latencyMs
  const ocrLatency = connectionOutcomes.ocr.latencyMs
  const ocrTestResult =
    connectionOutcomes.ocr.status === 'idle'
      ? null
      : {
          label: connectionOutcomes.ocr.result ?? '不可用',
          tone: connectionOutcomes.ocr.status === 'success' ? ('ok' as const) : ('warn' as const),
          latency: connectionOutcomes.ocr.latencyMs,
        }
  const localOcrConfiguration = localOcrConfigurationKey(config)
  const localOcrConfigured = Boolean(localOcrConfiguration)
  const localOcrAvailabilityStatus =
    localOcrAvailability.configurationKey === localOcrConfiguration
      ? localOcrAvailability.status
      : 'idle'
  const localOcrCapabilities =
    localOcrAvailability.configurationKey === localOcrConfiguration
      ? localOcrAvailability.capabilities
      : null

  function rememberSttTest(result: ConnectionTestResult) {
    saveConnectionTestResult('stt', result)
  }

  function rememberLlmTest(result: ConnectionTestResult) {
    saveConnectionTestResult('llm', result)
  }

  async function testStt() {
    const leaseId = tryStartSettingsOperation('stt-test')
    if (leaseId === null) return
    try {
      const latency =
        config.stt_provider === 'custom-whisper' || config.stt_provider === 'sensevoice-local'
          ? await benchSttConnection(
              config.stt_custom_api_key,
              config.stt_provider,
              config.stt_custom_base_url,
              config.stt_custom_model,
            )
          : await benchSttConnection(config.stt_api_key, config.stt_provider)
      if (!isCurrentSettingsOperation(leaseId)) return
      rememberSttTest({ label: `${latency}ms`, tone: 'ok', latency })
      completeSettingsConnection(leaseId, 'stt', `${latency}ms`, latency)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = settingsErrorMessage(error, '语音识别测试未完成，请稍后重试。', 'stt')
      rememberSttTest({ label: '失败', tone: 'warn', latency: null })
      failSettingsConnection(leaseId, 'stt', message)
    }
  }

  async function testLlm() {
    const leaseId = tryStartSettingsOperation('llm-test')
    if (leaseId === null) return
    try {
      const latency = await benchLlmConnection(
        config.llm_api_key,
        config.llm_provider,
        config.llm_base_url,
        config.llm_model,
      )
      if (!isCurrentSettingsOperation(leaseId)) return
      rememberLlmTest({ label: `${latency}ms`, tone: 'ok', latency })
      completeSettingsConnection(leaseId, 'llm', `${latency}ms`, latency)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = settingsErrorMessage(error, '文本 AI 测试未完成，请稍后重试。', 'llm')
      rememberLlmTest({ label: '失败', tone: 'warn', latency: null })
      failSettingsConnection(leaseId, 'llm', message)
    }
  }

  async function testOcr() {
    const configurationKey = localOcrConfigurationKey(config)
    if (!configurationKey) return
    const leaseId = tryStartSettingsOperation('ocr-test')
    if (leaseId === null) return
    const probeLeaseId = beginLocalOcrProbe(configurationKey)
    if (probeLeaseId === null) {
      failSettingsConnection(leaseId, 'ocr', 'OCR 可用性检查正在进行，请稍候。')
      return
    }
    const rejectStaleProbe = () => {
      const message = 'OCR 配置已变化，请重新测试。'
      failSettingsConnection(leaseId, 'ocr', message)
    }
    try {
      const started = performance.now()
      const capabilities = await testOcrConnection(config.ocr_base_url, config.ocr_model)
      if (!isCurrentSettingsOperation(leaseId)) return
      if (!finishLocalOcrProbe(configurationKey, probeLeaseId, capabilities)) {
        rejectStaleProbe()
        return
      }
      if (!capabilities.imageAvailable && !capabilities.pdfAvailable) {
        const issue = capabilities.issues
          .map((value) => settingsErrorMessage(value, '', 'ocr'))
          .find((value) => value.trim())
        const message = issue || '本机识别组件不可用，请检查识别模型和文档处理组件。'
        failSettingsConnection(leaseId, 'ocr', message)
        return
      }
      const latency = Math.round(performance.now() - started)
      const message = capabilities.imageAvailable
        ? capabilities.pdfAvailable
          ? '图片与 PDF 组件已就绪'
          : '图片识别可用，PDF 文档组件不可用'
        : 'PDF 文档组件可用，图片识别组件不可用'
      completeSettingsConnection(
        leaseId,
        'ocr',
        message,
        latency,
        capabilities.imageAvailable && capabilities.pdfAvailable ? 'success' : 'info',
      )
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      if (!finishLocalOcrProbe(configurationKey, probeLeaseId, null)) {
        rejectStaleProbe()
        return
      }
      const message = settingsErrorMessage(error, '本机识别测试未完成，请稍后重试。', 'ocr')
      failSettingsConnection(leaseId, 'ocr', message)
    }
  }

  return {
    llmLatency,
    localOcrAvailabilityStatus,
    localOcrCapabilities,
    localOcrConfigured,
    ocrLatency,
    ocrTestResult,
    sttLatency,
    testLlm,
    testOcr,
    testStt,
  }
}
