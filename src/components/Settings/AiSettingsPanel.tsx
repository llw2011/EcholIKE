import type { RefObject } from 'react'
import {
  Eye,
  Globe2,
  Languages,
  Loader2,
  LogOut,
  Mic,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Volume2,
} from 'lucide-react'
import type { AppConfig, ConfigSource } from '../../stores/appStore'
import { Tooltip } from '../Tooltip'
import type { StatusTone } from './settingsCache'
import {
  Badge,
  Input,
  Panel,
  SecretInput,
  Segmented,
  Select,
  ServiceStatus,
  SettingLine,
  Switch,
  type PanelAlertState,
} from './settingsUi'

const llmProviders = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: 'Qwen / 阿里云百炼' },
  { value: 'openrouter', label: 'OpenAI 兼容 / OpenRouter' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'moonshot', label: 'Kimi / Moonshot' },
  { value: 'zhipu', label: 'GLM / 智谱' },
  { value: 'ollama', label: 'Ollama 本地服务' },
]

const targetLanguages = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

export type BackendServiceStatusState = {
  label: string
  tone: StatusTone
  description: string
  quotaLabel?: string | null
}

type AiSettingsPanelProps = {
  config: AppConfig
  backendManaged: boolean
  pipelineIdle: boolean
  settingsOperationBusy: boolean
  configSourceAlert?: PanelAlertState
  authAlert?: PanelAlertState
  voiceProcessingAlert?: PanelAlertState
  ttsAlert?: PanelAlertState
  ocrAlert?: PanelAlertState
  textAiAlert?: PanelAlertState
  bootstrapStatusTone: StatusTone
  bootstrapStatusLabel: string
  bootstrapSummary: string
  hasDesktopBootstrap: boolean
  backendLlmStatus: BackendServiceStatusState
  backendSttStatus: BackendServiceStatusState
  backendTtsStatus: BackendServiceStatusState
  backendOcrStatus: BackendServiceStatusState
  desktopAuthReady: boolean
  hasDesktopToken: boolean
  authRejected: boolean
  backendAuthBadgeTone: StatusTone
  backendAuthBadgeLabel: string
  backendAuthFormRef: RefObject<HTMLDivElement | null>
  backendAuthEmailRef: RefObject<HTMLInputElement | null>
  backendAuthAccountValue: string
  backendAuthLevelValue: string
  backendAuthEmail: string
  backendAuthPassword: string
  bootstrapSyncBusy: boolean
  authLoginBusy: boolean
  cloudTts?: {
    mode?: string
    configured?: boolean
    displayName?: string | null
    providerId?: string | null
  }
  previewBusy: boolean
  previewTarget: string | null
  localOcrStatus: { label: string; tone: StatusTone; description: string }
  localOcrStatusSummary: string
  localOcrConfigured: boolean
  localOcrChecking: boolean
  ocrTestBusy: boolean
  llmStatusSummary: string
  llmTestBusy: boolean
  modelsBusy: boolean
  hasLlmKey: boolean
  models: string[]
  onConfigSourceChange: (source: ConfigSource) => void
  onRefreshQuota: () => void
  onRevalidateSavedAuth: () => void
  onBackendAuthEmailChange: (value: string) => void
  onBackendAuthPasswordChange: (value: string) => void
  onSignInBackend: () => void
  onCancelBackendAuthorization: () => void
  onVoiceProcessingChange: (patch: Partial<AppConfig>) => void
  onPreviewTts: () => void
  onTestOcr: () => void
  onOcrChange: (patch: Partial<AppConfig>) => void
  onTestLlm: () => void
  onLoadModels: () => void
  onLlmProviderChange: (provider: AppConfig['llm_provider']) => void
  onLlmChange: (patch: Partial<AppConfig>) => void
}

function renderBackendServiceStatus(status: BackendServiceStatusState) {
  return (
    <ServiceStatus>
      {status.quotaLabel ? <span>{status.quotaLabel}</span> : null}
      <Badge tone={status.tone}>{status.label}</Badge>
    </ServiceStatus>
  )
}

export function AiSettingsPanel({
  config,
  backendManaged,
  pipelineIdle,
  settingsOperationBusy,
  configSourceAlert,
  authAlert,
  voiceProcessingAlert,
  ttsAlert,
  ocrAlert,
  textAiAlert,
  bootstrapStatusTone,
  bootstrapStatusLabel,
  bootstrapSummary,
  hasDesktopBootstrap,
  backendLlmStatus,
  backendSttStatus,
  backendTtsStatus,
  backendOcrStatus,
  desktopAuthReady,
  hasDesktopToken,
  authRejected,
  backendAuthBadgeTone,
  backendAuthBadgeLabel,
  backendAuthFormRef,
  backendAuthEmailRef,
  backendAuthAccountValue,
  backendAuthLevelValue,
  backendAuthEmail,
  backendAuthPassword,
  bootstrapSyncBusy,
  authLoginBusy,
  cloudTts,
  previewBusy,
  previewTarget,
  localOcrStatus,
  localOcrStatusSummary,
  localOcrConfigured,
  localOcrChecking,
  ocrTestBusy,
  llmStatusSummary,
  llmTestBusy,
  modelsBusy,
  hasLlmKey,
  models,
  onConfigSourceChange,
  onRefreshQuota,
  onRevalidateSavedAuth,
  onBackendAuthEmailChange,
  onBackendAuthPasswordChange,
  onSignInBackend,
  onCancelBackendAuthorization,
  onVoiceProcessingChange,
  onPreviewTts,
  onTestOcr,
  onOcrChange,
  onTestLlm,
  onLoadModels,
  onLlmProviderChange,
  onLlmChange,
}: AiSettingsPanelProps) {
  const cloudTtsReady = cloudTts?.mode === 'proxy' && cloudTts.configured !== false

  return (
    <>
      <Panel
        title="配置来源"
        alert={configSourceAlert}
        status={
          backendManaged ? (
            <ServiceStatus>
              <Badge tone={bootstrapStatusTone}>{bootstrapStatusLabel}</Badge>
              <span>{hasDesktopBootstrap ? bootstrapSummary : '托管配置在系统页统一拉取。'}</span>
            </ServiceStatus>
          ) : undefined
        }
      >
        <SettingLine
          icon={Globe2}
          title="业务能力来源"
          description={
            !pipelineIdle
              ? '当前录音或文字处理结束后才能切换使用方式。'
              : backendManaged
                ? '问答、OCR、语音转写和朗读走后台托管；托管配置在系统页统一拉取。'
                : '问答、OCR 和语音转写按本机配置执行；后台用于版本、服务状态和公共配置同步。'
          }
          compactControl
        >
          <Segmented
            value={config.config_source}
            options={[
              { value: 'backend', label: '后台托管' },
              { value: 'local', label: '本机配置' },
            ]}
            disabled={settingsOperationBusy || !pipelineIdle}
            onChange={(value) => onConfigSourceChange(value as ConfigSource)}
          />
        </SettingLine>
        {backendManaged ? (
          <>
            <SettingLine icon={Sparkles} title="文本 AI" description={backendLlmStatus.description}>
              {renderBackendServiceStatus(backendLlmStatus)}
            </SettingLine>
            <SettingLine icon={Mic} title="语音转写" description={backendSttStatus.description}>
              {renderBackendServiceStatus(backendSttStatus)}
            </SettingLine>
            <SettingLine icon={Volume2} title="语音合成" description={backendTtsStatus.description}>
              {renderBackendServiceStatus(backendTtsStatus)}
            </SettingLine>
            <SettingLine icon={Eye} title="OCR" description={backendOcrStatus.description}>
              {renderBackendServiceStatus(backendOcrStatus)}
            </SettingLine>
          </>
        ) : (
          <SettingLine
            icon={ShieldCheck}
            title="当前使用方式"
            description="切回后台托管前，本机已填写的服务地址、模型和密钥会继续保留。"
          >
            <Badge tone="neutral">本机配置生效</Badge>
          </SettingLine>
        )}
      </Panel>

      {backendManaged ? (
        <Panel
          title="后台授权"
          alert={authAlert}
          actions={
            desktopAuthReady ? (
              <Tooltip content="刷新全部服务的剩余额度">
                <button
                  type="button"
                  className="echo-button echo-quota-refresh-button"
                  data-onboarding-target="network-quota-refresh"
                  onClick={onRefreshQuota}
                  disabled={settingsOperationBusy}
                >
                  {bootstrapSyncBusy ? (
                    <Loader2 size={14} className="echo-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  刷新额度
                </button>
              </Tooltip>
            ) : hasDesktopToken && !authRejected ? (
              <Tooltip content="使用已保存的凭据重新验证，无需再次输入账号密码">
                <button
                  type="button"
                  className="echo-button"
                  onClick={onRevalidateSavedAuth}
                  disabled={settingsOperationBusy}
                >
                  {bootstrapSyncBusy ? (
                    <Loader2 size={14} className="echo-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  重新验证已保存授权
                </button>
              </Tooltip>
            ) : undefined
          }
        >
          <SettingLine
            icon={ShieldCheck}
            title="账号连接"
            description={
              desktopAuthReady
                ? '已验证当前账号；拉取托管配置会自动携带令牌。'
                : hasDesktopToken
                  ? '登录凭据已保存，账号与额度会在身份验证成功后显示。'
                  : '后台托管需先登录；暂未开放注册，请联系管理员获取账号。'
            }
            status={
              <div className="echo-backend-auth-status">
                <Badge tone={backendAuthBadgeTone}>{backendAuthBadgeLabel}</Badge>
              </div>
            }
            wide
          >
            <div
              ref={backendAuthFormRef}
              className={`echo-backend-auth-form ${desktopAuthReady ? 'is-locked' : ''}`}
              data-onboarding-target="network-auth"
            >
              <div className="echo-backend-auth-fields">
                <Input
                  inputRef={backendAuthEmailRef}
                  value={backendAuthAccountValue}
                  onChange={onBackendAuthEmailChange}
                  placeholder="后台账号邮箱"
                  ariaLabel="后台账号邮箱"
                  disabled={desktopAuthReady}
                />
                <Input
                  value={backendAuthLevelValue}
                  onChange={onBackendAuthPasswordChange}
                  placeholder={desktopAuthReady ? '授权等级待同步' : '后台账号密码'}
                  type={desktopAuthReady ? 'text' : 'password'}
                  ariaLabel={desktopAuthReady ? '授权账号等级' : '后台账号密码'}
                  disabled={desktopAuthReady}
                />
              </div>
              <div className="echo-backend-auth-actions">
                {!desktopAuthReady && (
                  <button
                    type="button"
                    className="echo-button echo-button--primary"
                    onClick={onSignInBackend}
                    disabled={
                      settingsOperationBusy || !backendAuthEmail.trim() || !backendAuthPassword
                    }
                  >
                    {authLoginBusy ? (
                      <Loader2 size={16} className="echo-spin" />
                    ) : (
                      <ShieldCheck size={16} />
                    )}
                    登录授权
                  </button>
                )}
                {hasDesktopToken ? (
                  <button
                    type="button"
                    className="echo-button"
                    onClick={onCancelBackendAuthorization}
                    disabled={settingsOperationBusy}
                  >
                    <LogOut size={16} />
                    取消授权
                  </button>
                ) : null}
              </div>
            </div>
          </SettingLine>
        </Panel>
      ) : null}

      <Panel title="按住说话后的处理" alert={voiceProcessingAlert}>
        <SettingLine
          icon={Sparkles}
          title="润色/纠错"
          description="按住说话结束后，先用文本 AI 优化转写，再写入目标应用；关闭后直接输出识别结果。"
        >
          <Switch
            checked={config.polish_enabled}
            onChange={(checked) => onVoiceProcessingChange({ polish_enabled: checked })}
          />
        </SettingLine>
        <SettingLine
          icon={Languages}
          title="结束后翻译"
          description="按住说话结束后，将识别文本翻译成目标语言再输出。"
        >
          <Switch
            checked={config.translate_enabled}
            onChange={(checked) => onVoiceProcessingChange({ translate_enabled: checked })}
          />
        </SettingLine>
        {config.translate_enabled && (
          <SettingLine icon={Languages} title="目标语言" description="用于按住说话后的翻译输出。">
            <Select
              value={config.target_lang}
              options={targetLanguages}
              onChange={(value) => onVoiceProcessingChange({ target_lang: value })}
            />
          </SettingLine>
        )}
      </Panel>

      {backendManaged ? (
        <Panel
          title="回答与文本朗读"
          alert={ttsAlert}
          actions={
            cloudTtsReady ? (
              <button
                type="button"
                className="echo-button"
                onClick={onPreviewTts}
                disabled={previewBusy}
              >
                {previewTarget === 'preview' ? (
                  <Loader2 size={16} className="echo-spin" />
                ) : (
                  <Volume2 size={16} />
                )}
                朗读测试
              </button>
            ) : null
          }
        >
          <SettingLine
            icon={Volume2}
            title="朗读能力"
            description="后台启用后，主页回答和可朗读文本会显示朗读动作；音频只通过 /echo-api/proxy/tts 获取。"
          >
            {cloudTtsReady ? (
              <Badge tone="ok">{cloudTts?.displayName ?? cloudTts?.providerId ?? '云端朗读'}</Badge>
            ) : (
              <Badge tone={backendTtsStatus.tone}>{backendTtsStatus.label}</Badge>
            )}
          </SettingLine>
        </Panel>
      ) : (
        <>
          <Panel
            title="截图与附件识别"
            alert={ocrAlert}
            actions={
              <button
                type="button"
                className="echo-button"
                onClick={onTestOcr}
                disabled={settingsOperationBusy || !localOcrConfigured || localOcrChecking}
              >
                {ocrTestBusy ? (
                  <Loader2 size={16} className="echo-spin" />
                ) : (
                  <RefreshCw size={16} />
                )}
                测试本机识别
              </button>
            }
            status={
              <ServiceStatus>
                <span>{localOcrStatusSummary}</span>
              </ServiceStatus>
            }
          >
            <SettingLine icon={Eye} title="识别来源" description={localOcrStatus.description}>
              <Badge tone={localOcrStatus.tone}>{localOcrStatus.label}</Badge>
            </SettingLine>
            <SettingLine
              icon={Globe2}
              title="本机识别地址"
              description="默认使用本机 Ollama 服务。"
            >
              <Input
                value={config.ocr_base_url}
                placeholder="http://127.0.0.1:11434"
                onChange={(value) => onOcrChange({ ocr_base_url: value })}
              />
            </SettingLine>
            <SettingLine
              icon={Settings2}
              title="本机识别模型"
              description="需要 vision 能力；当前推荐 glm-ocr:latest。"
            >
              <Input
                value={config.ocr_model}
                placeholder="glm-ocr:latest"
                onChange={(value) => onOcrChange({ ocr_model: value })}
              />
            </SettingLine>
          </Panel>

          <Panel
            title="文本 AI 模型"
            alert={textAiAlert}
            actions={
              <>
                <button
                  type="button"
                  className="echo-button echo-button--primary"
                  onClick={onTestLlm}
                  disabled={
                    settingsOperationBusy || !hasLlmKey || !config.llm_base_url || !config.llm_model
                  }
                >
                  {llmTestBusy ? (
                    <Loader2 size={16} className="echo-spin" />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                  测试文本 AI
                </button>
                <button
                  type="button"
                  className="echo-button"
                  onClick={onLoadModels}
                  disabled={settingsOperationBusy || !config.llm_base_url}
                >
                  {modelsBusy ? (
                    <Loader2 size={16} className="echo-spin" />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                  读取模型
                </button>
              </>
            }
            status={
              <ServiceStatus>
                <span>{llmStatusSummary}</span>
              </ServiceStatus>
            }
          >
            <SettingLine
              icon={Sparkles}
              title="模型来源"
              description="供按住说话后的润色/翻译、选区修改和主页“问一下”共用。"
            >
              <Select
                value={config.llm_provider}
                options={llmProviders}
                onChange={(value) => onLlmProviderChange(value as AppConfig['llm_provider'])}
              />
            </SettingLine>
            <SettingLine
              icon={ShieldCheck}
              title="文本 AI API Key"
              description="手动输入或后台下发后保存在本机，界面只脱敏回读。"
            >
              <SecretInput
                value={config.llm_api_key}
                preview={undefined}
                placeholder="API Key"
                onChange={(value) => onLlmChange({ llm_api_key: value })}
              />
            </SettingLine>
            <SettingLine
              icon={Globe2}
              title="接口地址"
              description="OpenAI 兼容基础地址，会自动调用 chat/completions。"
            >
              <Input
                value={config.llm_base_url}
                placeholder="https://api.deepseek.com/v1"
                onChange={(value) => onLlmChange({ llm_base_url: value })}
              />
            </SettingLine>
            <SettingLine
              icon={Settings2}
              title="处理模型"
              description="填写用于问答、润色、翻译的聊天模型名。"
            >
              <Input
                value={config.llm_model}
                placeholder="deepseek-chat"
                list="echo-llm-models"
                onChange={(value) => onLlmChange({ llm_model: value })}
              />
              <datalist id="echo-llm-models">
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </SettingLine>
          </Panel>
        </>
      )}
    </>
  )
}
