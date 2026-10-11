import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Info, Keyboard, Mic, Settings2, ShieldCheck, Sparkles } from 'lucide-react'
import { LLM_DEFAULT_CONFIG } from '../../lib/constants'
import { APP_NAME, APP_VERSION } from '../../lib/branding'
import {
  SETTINGS_NOTICE_TIMEOUT_MS,
  useAppStore,
  type AppConfig,
  type ConfigSource,
  type SettingsNoticeScope,
} from '../../stores/appStore'
import { playTtsChunkQueue } from '../../lib/ttsPlayback'
import {
  chooseUsageMode,
  detectSystemHttpProxy,
  fetchLlmModels,
  getRuntimeAppVersion,
  pauseHotkey,
  resumeHotkey,
  setAutoStart,
  setCapsuleAutoHide,
  proxyTtsOnce,
  type DesktopBootstrap,
  updateHotkey,
  updateScreenOcrHotkey,
} from '../../lib/tauri'
import { readDesktopAuthToken } from '../../lib/desktopAuth'
import { userFacingErrorMessage, type ErrorContext } from '../../lib/userErrors'
import {
  composeProxyUrl,
  describeProxyUrl,
  describeProxyUrlRedacted,
  parseProxyUrl,
  type ProxyParts,
} from './proxyUrl'
import { type StatusTone } from './settingsCache'
import { createConfigPersistenceActions } from './configPersistence'
import { useBackendAccount } from './useBackendAccount'
import { useSettingsConnectionTests } from './useSettingsConnectionTests'
import { useSettingsDiagnostics } from './useSettingsDiagnostics'
import { useOtaSettings } from './useOtaSettings'
import { AboutSettingsPanel } from './AboutSettingsPanel'
import { DiagnosticsSettingsPanel } from './DiagnosticsSettingsPanel'
import { InputSettingsPanel } from './InputSettingsPanel'
import { SpeechSettingsPanel } from './SpeechSettingsPanel'
import { AiSettingsPanel, type BackendServiceStatusState } from './AiSettingsPanel'
import { SystemSettingsPanel } from './SystemSettingsPanel'
import type { PanelAlertState } from './settingsUi'

type SettingsTab = 'input' | 'speech' | 'ai' | 'system' | 'diagnostics' | 'about'
const TRAY_UPDATE_CHECK_PATH = '#/settings/about'
type BackendServiceId = 'llm' | 'stt' | 'tts' | 'ocr'
type Busy =
  | 'idle'
  | 'configSource'
  | 'stt'
  | 'llm'
  | 'models'
  | 'ocrTest'
  | 'ttsPreview'
  | 'systemProxy'
  | 'ttsDiagnose'
  | 'pdfDiagnose'
  | 'updateCheck'
  | 'updateDownload'
  | 'bootstrapSync'
  | 'authLogin'
  | 'authCacheClear'
type HotkeyCaptureTarget = 'input' | 'screenOcr' | null
const NETWORK_AUTH_FOCUS_TARGET = 'network-auth'

const OCR_PROXY_PDF_MAX_PAGES = 20

const tabs: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: 'input', label: '快捷键', icon: Keyboard },
  { id: 'speech', label: '麦克风', icon: Mic },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'system', label: '系统', icon: Settings2 },
  { id: 'diagnostics', label: '诊断', icon: ShieldCheck },
  { id: 'about', label: '关于', icon: Info },
]

const quotaNumberFormatter = new Intl.NumberFormat('zh-CN')
const quotaUnitLabels: Record<string, string> = {
  seconds: '秒',
  tokens: 'tokens',
  images: '次',
  chars: '字',
}

function formatQuotaRemaining(
  quota: NonNullable<DesktopBootstrap['quotas']>[BackendServiceId] | undefined,
) {
  if (!quota || !Number.isFinite(quota.remaining)) return null
  const unit = quotaUnitLabels[quota.unit] ?? quota.unit
  return `剩余 ${quotaNumberFormatter.format(Math.max(0, quota.remaining))} ${unit}`
}

function settingsErrorMessage(
  error: unknown,
  fallback: string,
  context: ErrorContext = 'settings',
) {
  return userFacingErrorMessage(error, fallback, context)
}

function isBackendConfigSource(source: AppConfig['config_source']) {
  return source === 'backend'
}

function tabFromHash(): SettingsTab {
  const tab = window.location.hash.replace('#/settings/', '').split('?')[0]
  return tabs.some((item) => item.id === tab) ? (tab as SettingsTab) : 'input'
}

function settingsFocusTarget() {
  const queryIndex = window.location.hash.indexOf('?')
  if (queryIndex < 0) return null
  return new URLSearchParams(window.location.hash.slice(queryIndex + 1)).get('focus')
}

function consumeSettingsFocusTarget(target: string) {
  const [path, query = ''] = window.location.hash.split('?', 2)
  const params = new URLSearchParams(query)
  if (params.get('focus') !== target) return
  params.delete('focus')
  const remaining = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${path}${remaining ? `?${remaining}` : ''}`,
  )
}

function hasTrayUpdateCheckRequest() {
  const [path, query = ''] = window.location.hash.split('?', 2)
  if (path !== TRAY_UPDATE_CHECK_PATH) return false
  return new URLSearchParams(query).get('check-update') === '1'
}

function consumeTrayUpdateCheckRequest() {
  const [path, query = ''] = window.location.hash.split('?', 2)
  const params = new URLSearchParams(query)
  if (path !== TRAY_UPDATE_CHECK_PATH || params.get('check-update') !== '1') return
  params.delete('check-update')
  params.delete('request')
  const remaining = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${path}${remaining ? `?${remaining}` : ''}`,
  )
}

function useSettingsPanelNotice(
  scope: SettingsNoticeScope,
  enabled: boolean,
): PanelAlertState | undefined {
  const notice = useAppStore((state) => state.settingsNotices[scope])
  const markSeen = useAppStore((state) => state.markSettingsNoticeSeen)
  const dismiss = useAppStore((state) => state.dismissSettingsNotice)

  useEffect(() => {
    if (!enabled || !notice) return
    if (notice.seenAt === null) {
      markSeen(scope, notice.id)
      return
    }

    const remaining = (notice.expiresAt ?? notice.seenAt + SETTINGS_NOTICE_TIMEOUT_MS) - Date.now()
    if (remaining <= 0) {
      dismiss(scope, notice.id)
      return
    }
    const timer = window.setTimeout(() => dismiss(scope, notice.id), remaining)
    return () => window.clearTimeout(timer)
  }, [dismiss, enabled, markSeen, notice, scope])

  if (!enabled || !notice || (notice.expiresAt !== null && notice.expiresAt <= Date.now())) {
    return undefined
  }
  return {
    text: notice.text,
    tone: notice.phase === 'success' ? 'ok' : notice.phase === 'error' ? 'warn' : 'neutral',
  }
}

export function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>(tabFromHash)
  const previewBusy = useAppStore((s) => s.ttsPlaybackBusy !== null)
  const previewTarget = useAppStore((s) => s.ttsPlaybackBusy)
  const tryStartTtsPlayback = useAppStore((s) => s.tryStartTtsPlayback)
  const finishTtsPlayback = useAppStore((s) => s.finishTtsPlayback)
  const [capturingHotkey, setCapturingHotkey] = useState<HotkeyCaptureTarget>(null)
  const [hotkeyHint, setHotkeyHint] = useState('')
  const [runtimeAppVersion, setRuntimeAppVersion] = useState(APP_VERSION)
  const backendAuthFormRef = useRef<HTMLDivElement | null>(null)
  const backendAuthEmailRef = useRef<HTMLInputElement | null>(null)

  const config = useAppStore((s) => s.config)
  const settingsOperation = useAppStore((s) => s.settingsOperation)
  const tryStartSettingsOperation = useAppStore((s) => s.tryStartSettingsOperation)
  const publishSettingsNotice = useAppStore((s) => s.publishSettingsNotice)
  const dismissSettingsNotice = useAppStore((s) => s.dismissSettingsNotice)
  const isCurrentSettingsOperation = useAppStore((s) => s.isCurrentSettingsOperation)
  const finishSettingsOperation = useAppStore((s) => s.finishSettingsOperation)
  const failSettingsSync = useAppStore((s) => s.failSettingsSync)
  const models = useAppStore((s) => s.llmModels)
  const setModels = useAppStore((s) => s.setLlmModels)
  const completeSettingsModels = useAppStore((s) => s.completeSettingsModels)
  const failSettingsModels = useAppStore((s) => s.failSettingsModels)
  const completeSettingsProxy = useAppStore((s) => s.completeSettingsProxy)
  const failSettingsProxy = useAppStore((s) => s.failSettingsProxy)
  const settingsBusyByKind: Record<NonNullable<typeof settingsOperation>['kind'], Busy> = {
    'auth-login': 'authLogin',
    'auth-cache-clear': 'authCacheClear',
    'config-source': 'configSource',
    'bootstrap-sync': 'bootstrapSync',
    'quota-refresh': 'bootstrapSync',
    'models-load': 'models',
    'system-proxy': 'systemProxy',
    'stt-test': 'stt',
    'llm-test': 'llm',
    'ocr-test': 'ocrTest',
    'tts-diagnostic': 'ttsDiagnose',
    'pdf-diagnostic': 'pdfDiagnose',
    'combined-diagnostic': 'ttsDiagnose',
  }
  const busy: Busy = settingsOperation ? settingsBusyByKind[settingsOperation.kind] : 'idle'
  const updateStoreConfig = useAppStore((s) => s.updateConfig)
  const applyPersistedConfigPatch = useAppStore((s) => s.applyPersistedConfigPatch)
  const setSavedConfig = useAppStore((s) => s.setSavedConfig)
  const { updateConfig, updateConfigViaCommand } = createConfigPersistenceActions({
    updateStoreConfig,
    applyPersistedConfigPatch,
    setSavedConfig,
    publishSettingsNotice,
    settingsErrorMessage,
  })
  const pipelineState = useAppStore((s) => s.pipelineState)
  const proxyParts = useMemo(
    () => parseProxyUrl(config.network_proxy_url),
    [config.network_proxy_url],
  )

  const backendManaged = isBackendConfigSource(config.config_source)
  const appVersion = runtimeAppVersion || APP_VERSION
  const appVersionMismatch = appVersion !== APP_VERSION
  const {
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
  } = useSettingsConnectionTests({ config, settingsErrorMessage })
  const {
    backendAuthAccountValue,
    backendAuthEmail,
    backendAuthLevelValue,
    backendAuthPassword,
    cancelBackendAuthorization,
    desktopAuthReady,
    desktopAuthStatus,
    desktopBootstrap,
    desktopOwner,
    hasDesktopToken,
    setBackendAuthEmail,
    setBackendAuthPassword,
    signInBackend,
    syncDesktopBootstrap,
    visibleDesktopToken,
  } = useBackendAccount({
    appVersion,
    backendManaged,
    settingsErrorMessage,
  })
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.id !== 'diagnostics' || desktopOwner),
    [desktopOwner],
  )
  const authNotice = useSettingsPanelNotice('backend-auth', activeTab === 'ai' && backendManaged)
  const backendAuthBadgeTone: StatusTone =
    desktopAuthStatus === 'rejected'
      ? 'warn'
      : desktopAuthReady
        ? 'ok'
        : authNotice?.tone === 'warn'
          ? 'warn'
          : 'neutral'
  const backendAuthBadgeLabel =
    desktopAuthStatus === 'rejected'
      ? '授权过期'
      : desktopAuthReady
        ? '已授权'
        : hasDesktopToken
          ? '待验证'
          : authNotice?.tone === 'warn'
            ? '连接失败'
            : '未授权'
  const inputTriggerNotice = useSettingsPanelNotice('input-trigger', activeTab === 'input')
  const inputMethodNotice = useSettingsPanelNotice('input-method', activeTab === 'input')
  const recordingNotice = useSettingsPanelNotice('recording', activeTab === 'speech')
  const voiceProcessingNotice = useSettingsPanelNotice('voice-processing', activeTab === 'ai')
  const rawManagedConfigNotice = useSettingsPanelNotice(
    'managed-config',
    activeTab === 'system' || activeTab === 'ai',
  )
  const sttNotice = useSettingsPanelNotice('stt', activeTab === 'speech' && !backendManaged)
  const textAiNotice = useSettingsPanelNotice('text-ai', activeTab === 'ai' && !backendManaged)
  const ocrNotice = useSettingsPanelNotice('ocr', activeTab === 'ai' && !backendManaged)
  const ttsNotice = useSettingsPanelNotice('tts', activeTab === 'ai' && backendManaged)
  const proxyNotice = useSettingsPanelNotice('network-proxy', activeTab === 'system')
  const startupTrayNotice = useSettingsPanelNotice('startup-tray', activeTab === 'system')
  const appearanceNotice = useSettingsPanelNotice('appearance', activeTab === 'system')
  const diagnosticsNotice = useSettingsPanelNotice(
    'diagnostics',
    activeTab === 'diagnostics' && desktopOwner,
  )
  const settingsOperationBusy = settingsOperation !== null
  const canSyncDesktopBootstrap =
    !settingsOperationBusy &&
    (!backendManaged || (hasDesktopToken && desktopAuthStatus !== 'rejected'))
  const hasLlmKey = config.llm_provider === 'ollama' || Boolean(config.llm_api_key.trim())
  const hasSttKey = useMemo(() => {
    if (config.stt_provider === 'sensevoice-local')
      return Boolean(config.stt_custom_base_url.trim())
    if (config.stt_provider === 'custom-whisper') return Boolean(config.stt_custom_base_url.trim())
    return Boolean(config.stt_api_key.trim())
  }, [config.stt_api_key, config.stt_custom_base_url, config.stt_provider])
  const localOcrStatus = (() => {
    if (!localOcrConfigured) {
      return {
        label: '缺配置',
        tone: 'warn' as StatusTone,
        description: '填写本机地址和模型后再测试。',
      }
    }
    if (busy === 'ocrTest' || localOcrAvailabilityStatus === 'checking') {
      return {
        label: '测试中',
        tone: 'neutral' as StatusTone,
        description: '正在确认本机图片与 PDF 识别组件是否可用。',
      }
    }
    if (localOcrAvailabilityStatus === 'available') {
      const fullyAvailable = Boolean(
        localOcrCapabilities?.imageAvailable && localOcrCapabilities?.pdfAvailable,
      )
      const capabilityLabel = localOcrCapabilities?.imageAvailable
        ? localOcrCapabilities.pdfAvailable
          ? '组件就绪'
          : '图片就绪'
        : localOcrCapabilities?.pdfAvailable
          ? 'PDF 就绪'
          : '组件就绪'
      const componentSummary = [
        localOcrCapabilities?.routerAvailable === true ? '图片识别组件已就绪' : null,
        localOcrCapabilities?.pipelineAvailable === true ? 'PDF 文档组件已就绪' : null,
      ]
        .filter(Boolean)
        .join('；')
      return {
        label: capabilityLabel,
        tone: (fullyAvailable ? 'ok' : 'warn') as StatusTone,
        description: ocrTestResult?.latency
          ? `最近组件检查 ${ocrTestResult.latency}ms。${componentSummary}`
          : componentSummary || '当前服务和模型已通过组件检查。',
      }
    }
    if (localOcrAvailabilityStatus === 'unavailable') {
      return {
        label: '不可用',
        tone: 'warn' as StatusTone,
        description: '上次检查失败，请确认服务已启动且模型已安装。',
      }
    }
    return {
      label: '待测试',
      tone: 'neutral' as StatusTone,
      description: '已填写地址和模型，点击测试后才会标记为可用。',
    }
  })()
  const cloudTts = desktopBootstrap?.services?.tts
  const {
    diagnoseSelectedPdf,
    diagnosticPdfFile,
    pdfDiagnostic,
    runDiagnostics,
    runPdfDiagnostic,
    runTtsDiagnostic,
    ttsDiagnostic,
  } = useSettingsDiagnostics({
    desktopAuthReady,
    desktopBootstrap,
    settingsErrorMessage,
    ttsDefaultVoice: cloudTts?.defaultVoice,
    visibleDesktopToken,
  })
  const backendServiceStatus = (service: BackendServiceId): BackendServiceStatusState => {
    const serviceConfig = desktopBootstrap?.services?.[service]
    const quotaLabel = formatQuotaRemaining(desktopBootstrap?.quotas?.[service])
    if (!backendManaged) {
      return {
        label: '未参与',
        tone: 'neutral' as StatusTone,
        description: '当前业务调用由本机配置决定。',
      }
    }
    if (!desktopAuthReady) {
      return {
        label: '需授权',
        tone: 'warn' as StatusTone,
        description: '登录后台账号后，桌面端才可调用托管代理。',
      }
    }
    if (!desktopBootstrap?.apiBaseUrl) {
      return {
        label: '不可用',
        tone: 'warn' as StatusTone,
        description: '尚未同步后台托管配置。',
      }
    }
    if (serviceConfig?.mode === 'proxy' && serviceConfig.configured !== false) {
      return {
        label: '可用',
        tone: 'ok' as StatusTone,
        description: serviceConfig.displayName || serviceConfig.providerId || '后台托管已启用。',
        quotaLabel,
      }
    }
    if (serviceConfig?.configured === true) {
      return {
        label: '未授权',
        tone: 'warn' as StatusTone,
        description: '后台已配置，但当前账号没有后台代理权限。',
      }
    }
    return {
      label: '不可用',
      tone: 'warn' as StatusTone,
      description: '后台暂未启用该服务。',
    }
  }
  const backendLlmStatus = backendServiceStatus('llm')
  const backendSttStatus = backendServiceStatus('stt')
  const backendTtsStatus = backendServiceStatus('tts')
  const backendOcrBaseStatus = backendServiceStatus('ocr')
  const backendOcrService = desktopBootstrap?.services?.ocr
  const backendOcrCapabilities = desktopBootstrap?.services?.ocr?.capabilities
  const backendOcrServiceReady = Boolean(
    backendManaged &&
    desktopAuthReady &&
    desktopBootstrap?.apiBaseUrl &&
    backendOcrService?.mode === 'proxy' &&
    backendOcrService.configured !== false,
  )
  const backendOcrAcceptedMimeTypes = backendOcrCapabilities?.acceptedMimeTypes?.map((value) =>
    value.trim().toLowerCase(),
  ) ?? ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'application/pdf']
  const backendOcrDirectRouteReady =
    backendOcrCapabilities?.processingRoutes === undefined ||
    backendOcrCapabilities.processingRoutes.includes('direct')
  const backendOcrPipelineRouteReady =
    backendOcrCapabilities?.processingRoutes?.includes('pipeline') === true
  const backendOcrImageAvailable = Boolean(
    backendOcrServiceReady &&
    backendOcrCapabilities?.imageAvailable !== false &&
    backendOcrDirectRouteReady &&
    backendOcrAcceptedMimeTypes.some((value) => value.startsWith('image/')),
  )
  const backendOcrServerPdfAvailable = Boolean(
    backendOcrCapabilities?.pdfAvailable === true &&
    backendOcrCapabilities.documentContract === 'ocr-document-v1' &&
    backendOcrCapabilities.pdfMode === 'server-pipeline' &&
    backendOcrPipelineRouteReady &&
    (backendOcrCapabilities.maxPdfPages ?? 0) >= OCR_PROXY_PDF_MAX_PAGES,
  )
  const backendOcrLegacyPdfAvailable = Boolean(
    backendOcrCapabilities === undefined ||
    (backendOcrCapabilities.pdfAvailable === true &&
      backendOcrCapabilities.pdfMode === 'client-rasterized' &&
      backendOcrDirectRouteReady &&
      (backendOcrCapabilities.maxPdfPages ?? 0) >= OCR_PROXY_PDF_MAX_PAGES),
  )
  const backendOcrPdfMode = backendOcrServerPdfAvailable
    ? 'server-pipeline'
    : backendOcrLegacyPdfAvailable
      ? 'client-rasterized'
      : null
  const backendOcrPdfDiagnosticMode =
    backendOcrCapabilities === undefined ? 'legacy-unknown' : (backendOcrPdfMode ?? 'unsupported')
  const backendOcrPdfAvailable = Boolean(
    backendOcrServiceReady &&
    backendOcrPdfMode &&
    backendOcrAcceptedMimeTypes.includes('application/pdf'),
  )
  const backendOcrStatus: BackendServiceStatusState = backendOcrServiceReady
    ? {
        ...backendOcrBaseStatus,
        label:
          backendOcrImageAvailable && backendOcrPdfAvailable
            ? '图片/PDF 可用'
            : backendOcrImageAvailable
              ? '仅图片可用'
              : backendOcrPdfAvailable
                ? '仅 PDF 可用'
                : '不可用',
        tone: backendOcrImageAvailable && backendOcrPdfAvailable ? 'ok' : 'warn',
        description:
          backendOcrImageAvailable && backendOcrPdfAvailable
            ? backendOcrCapabilities === undefined
              ? `${backendOcrBaseStatus.description}；旧后台兼容模式下，图片直接识别，PDF 由 Windows 桌面端分页兼容识别。`
              : backendOcrPdfMode === 'server-pipeline'
                ? `${backendOcrBaseStatus.description}；图片直接识别，PDF 由后台文档识别处理（最多 ${backendOcrCapabilities?.maxPdfPages ?? 20} 页）。`
                : `${backendOcrBaseStatus.description}；图片直接识别，PDF 由 Windows 桌面端分页兼容识别（最多 ${backendOcrCapabilities?.maxPdfPages ?? 20} 页）。`
            : backendOcrImageAvailable
              ? `${backendOcrBaseStatus.description}；当前仅开放图片识别。`
              : backendOcrPdfAvailable
                ? backendOcrPdfMode === 'server-pipeline'
                  ? `${backendOcrBaseStatus.description}；当前仅开放后台 PDF 文档识别。`
                  : `${backendOcrBaseStatus.description}；当前仅开放 PDF 分页兼容识别。`
                : '后台 OCR 已配置，但图片与 PDF 能力均未开放。',
      }
    : backendOcrBaseStatus
  const bootstrapGeneratedAt = desktopBootstrap?.generatedAt
    ? new Date(desktopBootstrap.generatedAt)
    : null
  const bootstrapSyncedAt =
    bootstrapGeneratedAt && Number.isFinite(bootstrapGeneratedAt.getTime())
      ? bootstrapGeneratedAt.toLocaleString('zh-CN', { hour12: false })
      : null
  const bootstrapSyncing = busy === 'bootstrapSync'
  const managedConfigSuccessMessage = backendManaged
    ? '账号配置已同步。'
    : '后台状态已刷新，本机配置仍生效。'
  const managedConfigNotice =
    rawManagedConfigNotice?.tone === 'ok'
      ? { ...rawManagedConfigNotice, text: managedConfigSuccessMessage }
      : rawManagedConfigNotice
  const bootstrapStatusLabel = bootstrapSyncing
    ? backendManaged
      ? '拉取中'
      : '刷新中'
    : backendManaged
      ? desktopAuthStatus === 'rejected'
        ? '授权过期'
        : desktopAuthReady
          ? '账号配置已同步'
          : hasDesktopToken
            ? '授权待验证'
            : desktopBootstrap
              ? '公共状态已获取'
              : '等待登录'
      : desktopBootstrap
        ? '后台状态已获取'
        : '未获取'
  const bootstrapStatusTone: StatusTone = bootstrapSyncing
    ? 'neutral'
    : backendManaged && desktopAuthStatus === 'rejected'
      ? 'warn'
      : backendManaged && desktopAuthReady
        ? 'ok'
        : 'neutral'
  const bootstrapSummary = backendManaged
    ? desktopAuthStatus === 'rejected'
      ? '后台授权已过期；重新登录前托管服务不可用。'
      : desktopAuthReady
        ? bootstrapSyncedAt
          ? `账号配置最近同步于 ${bootstrapSyncedAt}`
          : '账号配置已同步。'
        : hasDesktopToken
          ? '登录凭据正在等待验证；验证通过后才会启用托管服务。'
          : desktopBootstrap
            ? bootstrapSyncedAt
              ? `公共状态最近获取于 ${bootstrapSyncedAt}；登录授权后才能同步账号配置。`
              : '公共状态已获取；登录授权后才能同步账号配置。'
            : '登录授权后才能拉取账号配置并使用托管服务。'
    : desktopBootstrap
      ? bootstrapSyncedAt
        ? `后台状态最近获取于 ${bootstrapSyncedAt}；当前业务仍使用本机配置。`
        : '后台状态已获取；当前业务仍使用本机配置。'
      : '当前业务使用本机配置；可按需刷新后台版本和账号状态。'
  const bootstrapModeSummary = backendManaged
    ? desktopAuthStatus === 'rejected'
      ? '后台托管不可用'
      : desktopAuthReady
        ? '后台托管可用'
        : hasDesktopToken
          ? '等待授权验证'
          : '等待登录授权'
    : '本机配置生效'
  const bootstrapModeTone: StatusTone = backendManaged
    ? desktopAuthStatus === 'rejected'
      ? 'warn'
      : desktopAuthReady
        ? 'ok'
        : 'neutral'
    : 'neutral'
  const managedConfigPanelTitle = backendManaged ? '托管配置' : '后台状态'
  const managedConfigActionLabel = backendManaged
    ? desktopAuthReady
      ? '拉取托管配置'
      : hasDesktopToken && desktopAuthStatus !== 'rejected'
        ? '验证后台授权'
        : '登录后可拉取'
    : '刷新后台状态'
  const managedConfigModeDescription = backendManaged
    ? desktopAuthStatus === 'rejected'
      ? '已选择后台托管，但授权已经过期；重新登录前托管服务不可用。'
      : desktopAuthReady
        ? '启动、手动拉取或更新后同步后台配置，不在运行中自动改配置。'
        : hasDesktopToken
          ? '已选择后台托管；授权验证通过后才会启用托管服务。'
          : '已选择后台托管；登录授权后才会启用托管服务。'
    : '本机配置保持生效；刷新后台状态不会切换业务能力来源。'
  const diagnosticsBusy = busy === 'ttsDiagnose' || busy === 'pdfDiagnose'
  const diagnosticsStatusSummary = [
    ttsDiagnostic ? `朗读 ${ttsDiagnostic.ok ? '通过' : '未通过'}` : null,
    pdfDiagnostic ? `PDF ${pdfDiagnostic.ok ? '通过' : '失败'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const ttsDiagnosticDescription = ttsDiagnostic
    ? ttsDiagnostic.ok
      ? '朗读服务检查通过，已收到可播放音频。'
      : settingsErrorMessage(
          {
            service: 'tts',
            status: ttsDiagnostic.httpStatus,
            code: ttsDiagnostic.code,
            message: ttsDiagnostic.message,
            requestId: ttsDiagnostic.requestId,
            stage: ttsDiagnostic.stage,
          },
          '朗读服务检查未通过，请检查网络和后台配置后重试。',
          'tts',
        )
    : null
  const pdfDiagnosticDescription = pdfDiagnostic
    ? pdfDiagnostic.ok
      ? `PDF 文件读取和页面解析正常${
          pdfDiagnostic.pageCount ? `，共 ${pdfDiagnostic.pageCount} 页` : ''
        }。`
      : settingsErrorMessage(
          {
            service: 'ocr',
            message: pdfDiagnostic.message,
            stage: pdfDiagnostic.stage,
          },
          'PDF 文件检查未通过，请重新选择文件后重试。',
          'ocr',
        )
    : null
  const diagnosticReport = useMemo(() => {
    const lines = [
      `${APP_NAME} diagnosis`,
      `appVersion=${appVersion}`,
      `configSource=${config.config_source}`,
      `backendApi=${desktopBootstrap?.apiBaseUrl ? 'present' : 'missing'}`,
      `desktopToken=${desktopAuthReady ? 'present' : 'missing'}`,
      `bootstrap=${bootstrapStatusLabel}`,
      `bootstrapSummary=${bootstrapSummary}`,
      `networkProxy=${
        config.network_proxy_enabled && config.network_proxy_url.trim()
          ? describeProxyUrlRedacted(config.network_proxy_url)
          : 'disabled'
      }`,
      `service.llm=${backendLlmStatus.label}`,
      `service.stt=${backendSttStatus.label}`,
      `service.tts=${backendTtsStatus.label}`,
      `service.ocr=${backendOcrStatus.label}`,
      `service.ocr.image=${backendOcrImageAvailable}`,
      `service.ocr.pdf=${backendOcrPdfAvailable}`,
      `service.ocr.pdfMode=${backendOcrPdfDiagnosticMode}`,
      ttsDiagnostic
        ? [
            `tts.ok=${ttsDiagnostic.ok}`,
            `tts.stage=${ttsDiagnostic.stage}`,
            `tts.httpStatus=${ttsDiagnostic.httpStatus ?? '-'}`,
            `tts.code=${ttsDiagnostic.code ?? '-'}`,
            `tts.requestId=${ttsDiagnostic.requestId ?? '-'}`,
            `tts.mimeType=${ttsDiagnostic.mimeType ?? '-'}`,
            `tts.audioBytes=${ttsDiagnostic.audioBytes ?? '-'}`,
            `tts.elapsedMs=${ttsDiagnostic.elapsedMs}`,
          ].join('\n')
        : 'tts=not_run',
      pdfDiagnostic
        ? [
            `pdf.file=${pdfDiagnostic.fileName}`,
            `pdf.ok=${pdfDiagnostic.ok}`,
            `pdf.stage=${pdfDiagnostic.stage}`,
            `pdf.pageCount=${pdfDiagnostic.pageCount ?? '-'}`,
            `pdf.inputBytes=${pdfDiagnostic.inputBytes ?? '-'}`,
            `pdf.elapsedMs=${pdfDiagnostic.elapsedMs}`,
          ].join('\n')
        : diagnosticPdfFile
          ? `pdf.file=${diagnosticPdfFile.fileName}\npdf=not_run`
          : 'pdf=not_selected',
    ]
    return lines.join('\n')
  }, [
    appVersion,
    backendLlmStatus.label,
    backendOcrPdfDiagnosticMode,
    backendOcrImageAvailable,
    backendOcrPdfAvailable,
    backendOcrStatus.label,
    backendSttStatus.label,
    backendTtsStatus.label,
    bootstrapStatusLabel,
    bootstrapSummary,
    config.config_source,
    config.network_proxy_enabled,
    config.network_proxy_url,
    desktopAuthReady,
    desktopBootstrap?.apiBaseUrl,
    diagnosticPdfFile,
    pdfDiagnostic,
    ttsDiagnostic,
  ])

  useEffect(() => {
    if (useAppStore.getState().savedConfig === null) setSavedConfig(config)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    getRuntimeAppVersion(APP_VERSION)
      .then((version) => {
        if (!cancelled) setRuntimeAppVersion(version)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const {
    checkForUpdate,
    displayUpdateActionLabel,
    downloadUpdate,
    otaPolicySummary,
    otaResultNotice,
    otaStatusSummary,
    otaTask,
    updateActionDisabled,
    updateActionMode,
    updatePolicyTone,
    updateVersionTone,
  } = useOtaSettings({ appVersion, config, desktopBootstrap, settingsErrorMessage })

  useEffect(() => {
    const syncTabFromHash = () => setActiveTab(tabFromHash())
    window.addEventListener('hashchange', syncTabFromHash)
    return () => window.removeEventListener('hashchange', syncTabFromHash)
  }, [])

  useLayoutEffect(() => {
    if (
      activeTab !== 'ai' ||
      !backendManaged ||
      settingsFocusTarget() !== NETWORK_AUTH_FOCUS_TARGET
    ) {
      return
    }

    const form = backendAuthFormRef.current
    if (!form) return
    if (!desktopAuthReady && backendAuthEmailRef.current) {
      form.scrollIntoView?.({ behavior: 'auto', block: 'nearest', inline: 'nearest' })
      backendAuthEmailRef.current.focus({ preventScroll: true })
    }
    consumeSettingsFocusTarget(NETWORK_AUTH_FOCUS_TARGET)
  }, [activeTab, backendManaged, desktopAuthReady])

  useEffect(() => {
    if (activeTab !== 'diagnostics' || desktopOwner) return
    setActiveTab('system')
    if (window.location.hash === '#/settings/diagnostics') {
      window.location.hash = '#/settings/system'
    }
  }, [activeTab, desktopOwner])

  useEffect(() => {
    if (!capturingHotkey) return

    function finish(combo: string) {
      const isScreenOcr = capturingHotkey === 'screenOcr'
      const conflictingHotkey = isScreenOcr ? config.hotkey : config.screen_ocr_hotkey
      if (combo === conflictingHotkey) {
        publishSettingsNotice('input-trigger', 'error', '看窗口快捷键和快速输入键不能相同。')
        setCapturingHotkey(null)
        resumeHotkey().catch(() => undefined)
        return
      }

      setHotkeyHint(combo)
      const command = isScreenOcr ? updateScreenOcrHotkey(combo) : updateHotkey(combo)
      command
        .then(() => {
          const patch = isScreenOcr ? { screen_ocr_hotkey: combo } : { hotkey: combo }
          applyPersistedConfigPatch(patch)
          dismissSettingsNotice('input-trigger')
        })
        .catch((error) => {
          publishSettingsNotice(
            'input-trigger',
            'error',
            settingsErrorMessage(error, '快捷键注册失败。'),
          )
          resumeHotkey().catch(() => undefined)
        })
        .finally(() => {
          setCapturingHotkey(null)
        })
    }

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault()
      event.stopPropagation()

      const parts: string[] = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      if (event.metaKey) parts.push('Meta')

      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
        setHotkeyHint(parts.length ? `${parts.join('+')}+...` : '按下组合键')
        return
      }

      const key = normalizeKey(event.key)
      if (!parts.length && key.length === 1) return
      parts.push(key)
      finish(parts.join('+'))
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (capturingHotkey) {
        resumeHotkey().catch(() => undefined)
      }
    }
  }, [
    applyPersistedConfigPatch,
    capturingHotkey,
    config.hotkey,
    config.screen_ocr_hotkey,
    dismissSettingsNotice,
    publishSettingsNotice,
  ])

  function updateProxyParts(patch: Partial<ProxyParts>) {
    const next = { ...proxyParts, ...patch }
    updateConfig({ network_proxy_url: composeProxyUrl(next) }, 'network-proxy')
  }

  function toggleNetworkProxy(checked: boolean) {
    updateConfig(
      {
        network_proxy_enabled: checked,
        network_proxy_url:
          checked && !config.network_proxy_url.trim()
            ? composeProxyUrl(proxyParts)
            : config.network_proxy_url,
      },
      'network-proxy',
    )
  }

  async function beginHotkeyCapture(target: Exclude<HotkeyCaptureTarget, null>) {
    setCapturingHotkey(target)
    setHotkeyHint('按下新的组合键')
    try {
      await pauseHotkey()
    } catch {
      // The webview can still try to capture the shortcut.
    }
  }

  function selectTab(tab: SettingsTab) {
    setActiveTab(tab)
    window.location.hash = tab === 'input' ? '#/settings' : `#/settings/${tab}`
  }

  async function loadModels() {
    const leaseId = tryStartSettingsOperation('models-load')
    if (leaseId === null) return
    try {
      const result = await fetchLlmModels(
        config.llm_api_key,
        config.llm_provider,
        config.llm_base_url,
      )
      if (!isCurrentSettingsOperation(leaseId)) return
      const currentModel = config.llm_model.trim()
      if (
        result.length &&
        (!currentModel || (config.llm_provider === 'ollama' && !result.includes(currentModel)))
      ) {
        try {
          await updateConfig({ llm_model: result[0] }, 'text-ai', { reportFailure: false })
        } catch (error) {
          if (!isCurrentSettingsOperation(leaseId)) return
          failSettingsModels(
            leaseId,
            settingsErrorMessage(error, '模型已读取，但自动选择结果保存失败。'),
          )
          return
        }
        if (!isCurrentSettingsOperation(leaseId)) return
      }
      const message = result.length ? `读取到 ${result.length} 个模型。` : '没有读取到模型列表。'
      completeSettingsModels(leaseId, result, message)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = settingsErrorMessage(error, '模型列表读取失败。', 'llm')
      failSettingsModels(leaseId, message)
    }
  }

  function updateLlmProvider(provider: AppConfig['llm_provider']) {
    const defaults = LLM_DEFAULT_CONFIG[provider]
    updateConfig(
      {
        llm_provider: provider,
        llm_base_url: defaults?.baseUrl ?? config.llm_base_url,
        llm_model: defaults?.model ?? config.llm_model,
      },
      'text-ai',
    )
    setModels([])
  }

  async function playTtsPreview() {
    dismissSettingsNotice('tts')
    if (!backendManaged) {
      publishSettingsNotice('tts', 'info', '本机配置暂未启用朗读功能。')
      return
    }
    if (
      cloudTts?.mode !== 'proxy' ||
      cloudTts.configured === false ||
      !desktopBootstrap?.apiBaseUrl
    ) {
      publishSettingsNotice('tts', 'info', '后台朗读服务暂未启用。')
      return
    }
    const token = desktopAuthReady ? visibleDesktopToken : null
    if (!token) {
      publishSettingsNotice('tts', 'error', '后台授权已失效，暂时无法试听。请重新登录。')
      return
    }

    const playbackId = tryStartTtsPlayback('preview')
    if (playbackId === null) return
    try {
      const played = await playTtsChunkQueue(
        ['EcholIKE TTS preview'],
        async (text, lease) => {
          const result = await proxyTtsOnce(
            desktopBootstrap.apiBaseUrl,
            token,
            text,
            cloudTts.defaultVoice ?? undefined,
            lease.leaseId,
          )
          return {
            audioUrl: URL.createObjectURL(
              new Blob([new Uint8Array(result.audioBytes)], {
                type: result.mimeType || 'audio/mpeg',
              }),
            ),
            operationId: result.operationId,
          }
        },
        () => undefined,
      )
      if (!played) {
        publishSettingsNotice('tts', 'error', '已有朗读任务正在进行，请稍后再试。')
      }
    } catch (error) {
      publishSettingsNotice(
        'tts',
        'error',
        settingsErrorMessage(error, '朗读未完成，请稍后重试。', 'tts'),
      )
    } finally {
      finishTtsPlayback(playbackId)
    }
  }

  async function applySystemHttpProxy() {
    const leaseId = tryStartSettingsOperation('system-proxy')
    if (leaseId === null) return
    try {
      const proxyUrl = await detectSystemHttpProxy()
      if (!isCurrentSettingsOperation(leaseId)) return
      if (!proxyUrl) {
        const message = '当前系统没有启用 HTTP 代理。'
        failSettingsProxy(leaseId, message)
        return
      }
      try {
        await updateConfig(
          {
            network_proxy_enabled: true,
            network_proxy_url: composeProxyUrl(parseProxyUrl(proxyUrl)),
          },
          'network-proxy',
          { reportFailure: false },
        )
      } catch (error) {
        if (!isCurrentSettingsOperation(leaseId)) return
        failSettingsProxy(leaseId, settingsErrorMessage(error, '系统代理已读取，但设置保存失败。'))
        return
      }
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = `已使用系统代理：${describeProxyUrl(proxyUrl)}`
      completeSettingsProxy(leaseId, message)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = settingsErrorMessage(error, '系统代理读取失败，请手动填写代理信息。')
      failSettingsProxy(leaseId, message)
    }
  }

  async function updateConfigSource(source: ConfigSource) {
    if (config.config_source === source) return
    if (useAppStore.getState().pipelineState !== 'idle') return
    const leaseId = tryStartSettingsOperation('config-source')
    if (leaseId === null) return
    dismissSettingsNotice('managed-config')
    try {
      const saved = await chooseUsageMode(source)
      if (!isCurrentSettingsOperation(leaseId)) return
      const currentSaved = useAppStore.getState().savedConfig ?? useAppStore.getState().config
      updateStoreConfig({
        config_source: saved.config_source,
        onboarding_version: saved.onboarding_version,
      })
      setSavedConfig({
        ...currentSaved,
        config_source: saved.config_source,
        onboarding_version: saved.onboarding_version,
      })
      finishSettingsOperation(leaseId)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      failSettingsSync(
        leaseId,
        'config',
        settingsErrorMessage(error, '使用方式切换失败，仍保持原配置来源。'),
      )
      return
    }
    if (source === 'backend' && Boolean(readDesktopAuthToken())) {
      await syncDesktopBootstrap({ requireAuth: true })
    }
  }

  useEffect(() => {
    const runTrayUpdateCheck = () => {
      if (!hasTrayUpdateCheckRequest()) return
      consumeTrayUpdateCheckRequest()
      void checkForUpdate()
    }

    runTrayUpdateCheck()
    window.addEventListener('hashchange', runTrayUpdateCheck)
    return () => window.removeEventListener('hashchange', runTrayUpdateCheck)
  }, [checkForUpdate])

  async function copyDiagnosticReport() {
    dismissSettingsNotice('diagnostics')
    try {
      await navigator.clipboard.writeText(diagnosticReport)
      publishSettingsNotice('diagnostics', 'success', '诊断报告已复制。')
    } catch (error) {
      publishSettingsNotice(
        'diagnostics',
        'error',
        settingsErrorMessage(error, '诊断报告复制失败。'),
      )
    }
  }

  const sttStatusSummary = sttLatency
    ? `最近测试 ${sttLatency}ms`
    : '测试鉴权和语音转写服务可达性。'
  const ocrStatusSummary =
    localOcrAvailabilityStatus === 'available' && ocrLatency
      ? `最近组件检查 ${ocrLatency}ms`
      : '分别检查本机模型、图片识别组件与 PDF 文档组件。'
  const llmStatusSummary = [
    llmLatency ? `最近测试 ${llmLatency}ms` : null,
    models.length ? `已读取 ${models.length} 个模型` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const displayLlmStatusSummary = llmStatusSummary || '测试文本 AI 连接，或读取可用模型列表。'

  return (
    <div className="echo-settings-lite">
      <div className="echo-settings-nav" role="tablist" aria-label="设置分组">
        {visibleTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={activeTab === id ? 'is-active' : ''}
            onClick={() => selectTab(id)}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </div>

      <div className="echo-settings-stack">
        {activeTab === 'input' && (
          <InputSettingsPanel
            config={config}
            capturingHotkey={capturingHotkey}
            hotkeyHint={hotkeyHint}
            triggerAlert={inputTriggerNotice}
            inputMethodAlert={inputMethodNotice}
            onBeginHotkeyCapture={(target) => void beginHotkeyCapture(target)}
            onSelectedTextEnabledChange={(checked) =>
              void updateConfig({ selected_text_enabled: checked }, 'input-trigger')
            }
            onHotkeyModeChange={(value) =>
              void updateConfig({ hotkey_mode: value }, 'input-method')
            }
            onOutputModeChange={(value) =>
              void updateConfig({ output_mode: value }, 'input-method')
            }
          />
        )}

        {activeTab === 'speech' && (
          <SpeechSettingsPanel
            config={config}
            backendManaged={backendManaged}
            backendSttStatus={backendSttStatus}
            sttAlert={sttNotice}
            recordingAlert={recordingNotice}
            sttStatusSummary={sttStatusSummary}
            sttBusy={busy === 'stt'}
            settingsOperationBusy={settingsOperationBusy}
            hasSttKey={hasSttKey}
            onTestStt={() => void testStt()}
            onUpdateStt={(patch) => void updateConfig(patch, 'stt')}
            onUpdateRecording={(patch) => void updateConfig(patch, 'recording')}
          />
        )}

        {activeTab === 'ai' && (
          <AiSettingsPanel
            config={config}
            backendManaged={backendManaged}
            pipelineIdle={pipelineState === 'idle'}
            settingsOperationBusy={settingsOperationBusy}
            configSourceAlert={managedConfigNotice}
            authAlert={authNotice}
            voiceProcessingAlert={voiceProcessingNotice}
            ttsAlert={ttsNotice}
            ocrAlert={ocrNotice}
            textAiAlert={textAiNotice}
            bootstrapStatusTone={bootstrapStatusTone}
            bootstrapStatusLabel={bootstrapStatusLabel}
            bootstrapSummary={bootstrapSummary}
            hasDesktopBootstrap={Boolean(desktopBootstrap)}
            backendLlmStatus={backendLlmStatus}
            backendSttStatus={backendSttStatus}
            backendTtsStatus={backendTtsStatus}
            backendOcrStatus={backendOcrStatus}
            desktopAuthReady={desktopAuthReady}
            hasDesktopToken={hasDesktopToken}
            authRejected={desktopAuthStatus === 'rejected'}
            backendAuthBadgeTone={backendAuthBadgeTone}
            backendAuthBadgeLabel={backendAuthBadgeLabel}
            backendAuthFormRef={backendAuthFormRef}
            backendAuthEmailRef={backendAuthEmailRef}
            backendAuthAccountValue={backendAuthAccountValue}
            backendAuthLevelValue={backendAuthLevelValue}
            backendAuthEmail={backendAuthEmail}
            backendAuthPassword={backendAuthPassword}
            bootstrapSyncBusy={busy === 'bootstrapSync'}
            authLoginBusy={busy === 'authLogin'}
            cloudTts={cloudTts}
            previewBusy={previewBusy}
            previewTarget={previewTarget}
            localOcrStatus={localOcrStatus}
            localOcrStatusSummary={ocrStatusSummary}
            localOcrConfigured={localOcrConfigured}
            localOcrChecking={localOcrAvailabilityStatus === 'checking'}
            ocrTestBusy={busy === 'ocrTest'}
            llmStatusSummary={displayLlmStatusSummary}
            llmTestBusy={busy === 'llm'}
            modelsBusy={busy === 'models'}
            hasLlmKey={hasLlmKey}
            models={models}
            onConfigSourceChange={(source) => void updateConfigSource(source)}
            onRefreshQuota={() =>
              void syncDesktopBootstrap({ requireAuth: true, purpose: 'quota' })
            }
            onRevalidateSavedAuth={() =>
              void syncDesktopBootstrap({ requireAuth: true, purpose: 'auth' })
            }
            onBackendAuthEmailChange={setBackendAuthEmail}
            onBackendAuthPasswordChange={setBackendAuthPassword}
            onSignInBackend={() => void signInBackend()}
            onCancelBackendAuthorization={() => void cancelBackendAuthorization()}
            onVoiceProcessingChange={(patch) => void updateConfig(patch, 'voice-processing')}
            onPreviewTts={() => void playTtsPreview()}
            onTestOcr={() => void testOcr()}
            onOcrChange={(patch) => void updateConfig(patch, 'ocr')}
            onTestLlm={() => void testLlm()}
            onLoadModels={() => void loadModels()}
            onLlmProviderChange={updateLlmProvider}
            onLlmChange={(patch) => void updateConfig(patch, 'text-ai')}
          />
        )}

        {activeTab === 'system' && (
          <SystemSettingsPanel
            config={config}
            proxyParts={proxyParts}
            startupTrayAlert={startupTrayNotice}
            proxyAlert={proxyNotice}
            managedConfigAlert={managedConfigNotice}
            appearanceAlert={appearanceNotice}
            settingsOperationBusy={settingsOperationBusy}
            systemProxyBusy={busy === 'systemProxy'}
            managedConfigPanelTitle={managedConfigPanelTitle}
            bootstrapSummary={bootstrapSummary}
            bootstrapStatusTone={bootstrapStatusTone}
            bootstrapStatusLabel={bootstrapStatusLabel}
            canSyncDesktopBootstrap={canSyncDesktopBootstrap}
            bootstrapSyncBusy={busy === 'bootstrapSync'}
            managedConfigActionLabel={managedConfigActionLabel}
            managedConfigModeDescription={managedConfigModeDescription}
            bootstrapModeTone={bootstrapModeTone}
            bootstrapModeSummary={bootstrapModeSummary}
            onAutoStartChange={(checked) =>
              updateConfigViaCommand(
                { auto_start: checked },
                () => setAutoStart(checked),
                '自启动设置失败。',
                'startup-tray',
              )
            }
            onCloseToTrayChange={(checked) =>
              void updateConfig({ close_to_tray: checked }, 'startup-tray')
            }
            onCapsuleAutoHideChange={(checked) =>
              updateConfigViaCommand(
                { capsule_auto_hide: checked },
                () => setCapsuleAutoHide(checked),
                '悬浮球设置失败。',
                'startup-tray',
              )
            }
            onNetworkProxyToggle={toggleNetworkProxy}
            onProxyPartsChange={updateProxyParts}
            onApplySystemHttpProxy={() => void applySystemHttpProxy()}
            onProxyBypassChange={(value) =>
              void updateConfig({ network_proxy_bypass: value }, 'network-proxy')
            }
            onSyncDesktopBootstrap={() => void syncDesktopBootstrap()}
            onThemeProfileChange={(value) =>
              void updateConfig({ theme_profile: value }, 'appearance')
            }
            onCapsuleStyleChange={(value) =>
              void updateConfig({ capsule_style: value }, 'appearance')
            }
          />
        )}

        {activeTab === 'diagnostics' && desktopOwner && (
          <DiagnosticsSettingsPanel
            alert={diagnosticsNotice}
            statusSummary={diagnosticsStatusSummary}
            operationBusy={settingsOperationBusy}
            diagnosticsBusy={diagnosticsBusy}
            ttsBusy={busy === 'ttsDiagnose'}
            pdfBusy={busy === 'pdfDiagnose'}
            ttsDiagnostic={ttsDiagnostic}
            ttsDiagnosticDescription={ttsDiagnosticDescription}
            pdfDiagnostic={pdfDiagnostic}
            pdfDiagnosticDescription={pdfDiagnosticDescription}
            diagnosticPdfFile={diagnosticPdfFile}
            diagnosticReport={diagnosticReport}
            onRunDiagnostics={runDiagnostics}
            onCopyDiagnosticReport={copyDiagnosticReport}
            onRunTtsDiagnostic={runTtsDiagnostic}
            onDiagnoseSelectedPdf={diagnoseSelectedPdf}
            onRunPdfDiagnostic={runPdfDiagnostic}
          />
        )}

        {activeTab === 'about' && (
          <AboutSettingsPanel
            appVersion={appVersion}
            packageVersion={APP_VERSION}
            appVersionMismatch={appVersionMismatch}
            otaStatusSummary={otaStatusSummary}
            otaPolicySummary={otaPolicySummary}
            otaResultNotice={otaResultNotice}
            updateActionDisabled={updateActionDisabled}
            updateActionMode={updateActionMode}
            updatePolicyTone={updatePolicyTone}
            updateVersionTone={updateVersionTone}
            updateRunning={otaTask.status === 'running'}
            updateProgress={otaTask.progress}
            displayUpdateActionLabel={displayUpdateActionLabel}
            onCheckForUpdate={checkForUpdate}
            onDownloadUpdate={downloadUpdate}
          />
        )}
      </div>
    </div>
  )
}

function normalizeKey(key: string) {
  const map: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
  }
  const normalized = map[key] ?? key
  return normalized.length === 1 ? normalized.toUpperCase() : normalized
}
