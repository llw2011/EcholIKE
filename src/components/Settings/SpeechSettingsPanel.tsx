import { Globe2, Loader2, Mic, RefreshCw, Settings2, ShieldCheck } from 'lucide-react'
import { APP_NAME } from '../../lib/branding'
import type { AppConfig } from '../../stores/appStore'
import { AudioLevelMeter } from '../shared/AudioLevelMeter'
import {
  Badge,
  Input,
  Panel,
  SecretInput,
  Select,
  ServiceStatus,
  SettingLine,
  Switch,
  type PanelAlertState,
} from './settingsUi'
import type { StatusTone } from './settingsCache'

const SENSEVOICE_LOCAL_URL = 'http://127.0.0.1:9001'

const sttProviders = [
  { value: 'sensevoice-local', label: 'SenseVoice 9001 本地' },
  { value: 'glm-asr', label: '智谱 GLM ASR' },
  { value: 'openai-whisper', label: 'OpenAI Whisper' },
  { value: 'groq-whisper', label: 'Groq Whisper' },
  { value: 'siliconflow', label: 'SiliconFlow' },
  { value: 'deepgram', label: 'Deepgram' },
  { value: 'assemblyai', label: 'AssemblyAI' },
  { value: 'custom-whisper', label: '自定义 Whisper 兼容' },
]

const languageOptions = [
  { value: 'multi', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

type SpeechSettingsPanelProps = {
  config: AppConfig
  backendManaged: boolean
  backendSttStatus: { label: string; tone: StatusTone }
  sttAlert?: PanelAlertState
  recordingAlert?: PanelAlertState
  sttStatusSummary: string
  sttBusy: boolean
  settingsOperationBusy: boolean
  hasSttKey: boolean
  onTestStt: () => void
  onUpdateStt: (patch: Partial<AppConfig>) => void
  onUpdateRecording: (patch: Partial<AppConfig>) => void
}

export function SpeechSettingsPanel({
  config,
  backendManaged,
  backendSttStatus,
  sttAlert,
  recordingAlert,
  sttStatusSummary,
  sttBusy,
  settingsOperationBusy,
  hasSttKey,
  onTestStt,
  onUpdateStt,
  onUpdateRecording,
}: SpeechSettingsPanelProps) {
  const sttTestAction = (
    <button
      type="button"
      className="echo-button echo-button--primary"
      onClick={onTestStt}
      disabled={settingsOperationBusy || !hasSttKey}
    >
      {sttBusy ? <Loader2 size={16} className="echo-spin" /> : <RefreshCw size={16} />}
      测试识别
    </button>
  )

  return (
    <>
      {backendManaged ? (
        <Panel title="语音识别">
          <SettingLine
            icon={Mic}
            title="后台语音转写"
            description="按住说话结束后，音频只提交到后台语音识别服务；本机识别配置不会参与。"
          >
            <Badge tone={backendSttStatus.tone}>{backendSttStatus.label}</Badge>
          </SettingLine>
        </Panel>
      ) : (
        <Panel
          title="语音识别"
          onboardingTarget="local-stt-config"
          alert={sttAlert}
          actions={sttTestAction}
          status={
            <ServiceStatus>
              <span>{sttStatusSummary}</span>
            </ServiceStatus>
          }
        >
          <SettingLine
            icon={Mic}
            title="识别服务"
            description="选择语音转写引擎；测试结果显示在面板状态里。"
          >
            <Select
              value={config.stt_provider}
              options={sttProviders}
              onChange={(value) => {
                const provider = value as AppConfig['stt_provider']
                onUpdateStt(
                  provider === 'sensevoice-local'
                    ? {
                        stt_provider: provider,
                        stt_custom_base_url: SENSEVOICE_LOCAL_URL,
                        stt_custom_model: 'SenseVoiceSmall',
                      }
                    : { stt_provider: provider },
                )
              }}
            />
          </SettingLine>
          <SettingLine icon={Globe2} title="识别语言" description="自动识别适合中英混说。">
            <Select
              value={config.stt_language}
              options={languageOptions}
              onChange={(value) => onUpdateStt({ stt_language: value })}
            />
          </SettingLine>
          {config.stt_provider === 'sensevoice-local' ? (
            <SettingLine
              icon={ShieldCheck}
              title="鉴权"
              description={`本地 9001 服务只在本机访问，${APP_NAME} 不向它发送 API Key。`}
            >
              <Badge tone="neutral">本地无密钥</Badge>
            </SettingLine>
          ) : (
            <SettingLine
              icon={ShieldCheck}
              title="语音识别 API Key"
              description="后端下发或手动输入后，本机保存真实值，界面只脱敏回读。"
            >
              <SecretInput
                value={
                  config.stt_provider === 'custom-whisper'
                    ? config.stt_custom_api_key
                    : config.stt_api_key
                }
                preview={undefined}
                placeholder="API Key"
                onChange={(value) =>
                  onUpdateStt(
                    config.stt_provider === 'custom-whisper'
                      ? { stt_custom_api_key: value }
                      : { stt_api_key: value },
                  )
                }
              />
            </SettingLine>
          )}
          {(config.stt_provider === 'custom-whisper' ||
            config.stt_provider === 'sensevoice-local') && (
            <>
              <SettingLine
                icon={Globe2}
                title={
                  config.stt_provider === 'sensevoice-local' ? 'SenseVoice 地址' : 'Whisper 地址'
                }
                description={
                  config.stt_provider === 'sensevoice-local'
                    ? '本地 FastAPI 服务地址，会自动补 /asr。'
                    : '例如 http://localhost:8000/v1。'
                }
              >
                <Input
                  value={config.stt_custom_base_url}
                  placeholder={
                    config.stt_provider === 'sensevoice-local'
                      ? SENSEVOICE_LOCAL_URL
                      : 'http://localhost:8000/v1'
                  }
                  onChange={(value) => onUpdateStt({ stt_custom_base_url: value })}
                />
              </SettingLine>
              {config.stt_provider === 'custom-whisper' && (
                <SettingLine
                  icon={Settings2}
                  title="Whisper 模型"
                  description="兼容服务要求的 model 字段。"
                >
                  <Input
                    value={config.stt_custom_model}
                    placeholder="Systran/faster-whisper-large-v3"
                    onChange={(value) => onUpdateStt({ stt_custom_model: value })}
                  />
                </SettingLine>
              )}
            </>
          )}
        </Panel>
      )}

      <Panel title="录音" alert={recordingAlert}>
        <SettingLine icon={Mic} title="输入设备" description="当前版本跟随系统默认输入设备。">
          <Badge tone="neutral">跟随系统</Badge>
        </SettingLine>
        <SettingLine icon={Mic} title="实时输入电平" description="录音时会随 Tauri 音频事件更新。">
          <AudioLevelMeter className="echo-mini-meter" segmentCount={14} />
        </SettingLine>
        <SettingLine
          icon={Settings2}
          title="最长录音时长"
          description="超时自动结束，避免误触后持续录音。"
        >
          <Select
            value={String(config.max_recording_seconds)}
            options={[
              { value: '30', label: '30 秒' },
              { value: '60', label: '1 分钟' },
              { value: '300', label: '5 分钟' },
              { value: '600', label: '10 分钟' },
            ]}
            onChange={(value) => onUpdateRecording({ max_recording_seconds: Number(value) })}
          />
        </SettingLine>
        <SettingLine
          icon={Mic}
          title="录音时静音系统声音"
          description="开始录音时临时静音默认播放设备，停止或中断后恢复原状态。"
        >
          <Switch
            checked={config.mute_system_audio_during_recording}
            onChange={(checked) =>
              onUpdateRecording({ mute_system_audio_during_recording: checked })
            }
          />
        </SettingLine>
      </Panel>
    </>
  )
}
