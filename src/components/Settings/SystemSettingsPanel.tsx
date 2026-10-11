import type { CSSProperties } from 'react'
import { Globe2, Loader2, Palette, RefreshCw, Settings2, ShieldCheck, Zap } from 'lucide-react'
import { THEME_PROFILE_OPTIONS } from '../../lib/appearanceProfiles'
import type { AppConfig, CapsuleStyle, ThemeProfile } from '../../stores/appStore'
import { CapsuleSkinPreview } from '../Capsule/CapsuleSkinPreview'
import { capsuleStyleOption, capsuleStyleOptions } from '../Capsule/capsuleSkin'
import { asProxyScheme, defaultProxyPorts, proxySchemeOptions, type ProxyParts } from './proxyUrl'
import type { StatusTone } from './settingsCache'
import {
  Badge,
  Input,
  Panel,
  Select,
  SettingLine,
  Switch,
  type PanelAlertState,
} from './settingsUi'

type SystemSettingsPanelProps = {
  config: AppConfig
  proxyParts: ProxyParts
  startupTrayAlert?: PanelAlertState
  proxyAlert?: PanelAlertState
  managedConfigAlert?: PanelAlertState
  appearanceAlert?: PanelAlertState
  settingsOperationBusy: boolean
  systemProxyBusy: boolean
  managedConfigPanelTitle: string
  bootstrapSummary: string
  bootstrapStatusTone: StatusTone
  bootstrapStatusLabel: string
  canSyncDesktopBootstrap: boolean
  bootstrapSyncBusy: boolean
  managedConfigActionLabel: string
  managedConfigModeDescription: string
  bootstrapModeTone: StatusTone
  bootstrapModeSummary: string
  onAutoStartChange: (checked: boolean) => void
  onCloseToTrayChange: (checked: boolean) => void
  onCapsuleAutoHideChange: (checked: boolean) => void
  onNetworkProxyToggle: (checked: boolean) => void
  onProxyPartsChange: (patch: Partial<ProxyParts>) => void
  onApplySystemHttpProxy: () => void
  onProxyBypassChange: (value: string) => void
  onSyncDesktopBootstrap: () => void
  onThemeProfileChange: (value: ThemeProfile) => void
  onCapsuleStyleChange: (value: CapsuleStyle) => void
}

export function SystemSettingsPanel({
  config,
  proxyParts,
  startupTrayAlert,
  proxyAlert,
  managedConfigAlert,
  appearanceAlert,
  settingsOperationBusy,
  systemProxyBusy,
  managedConfigPanelTitle,
  bootstrapSummary,
  bootstrapStatusTone,
  bootstrapStatusLabel,
  canSyncDesktopBootstrap,
  bootstrapSyncBusy,
  managedConfigActionLabel,
  managedConfigModeDescription,
  bootstrapModeTone,
  bootstrapModeSummary,
  onAutoStartChange,
  onCloseToTrayChange,
  onCapsuleAutoHideChange,
  onNetworkProxyToggle,
  onProxyPartsChange,
  onApplySystemHttpProxy,
  onProxyBypassChange,
  onSyncDesktopBootstrap,
  onThemeProfileChange,
  onCapsuleStyleChange,
}: SystemSettingsPanelProps) {
  return (
    <>
      <Panel title="启动与托盘" alert={startupTrayAlert}>
        <SettingLine
          icon={Settings2}
          title="开机启动"
          description="调用系统自启动插件，不只是保存开关。"
        >
          <Switch checked={config.auto_start} onChange={onAutoStartChange} />
        </SettingLine>
        <SettingLine
          icon={Settings2}
          title="系统托盘"
          description="关闭主窗口时隐藏到系统托盘，后台继续响应快捷键和胶囊。"
        >
          <Switch checked={config.close_to_tray} onChange={onCloseToTrayChange} />
        </SettingLine>
        <SettingLine
          icon={Settings2}
          title="悬浮球空闲时自动隐藏"
          description="调用托盘/胶囊配置命令同步。"
        >
          <Switch checked={config.capsule_auto_hide} onChange={onCapsuleAutoHideChange} />
        </SettingLine>
      </Panel>

      <Panel title="网络代理" alert={proxyAlert}>
        <SettingLine
          icon={Globe2}
          title="应用内代理"
          description="内网机器可通过 HTTP/SOCKS 代理访问后台托管、OTA 和云服务。"
        >
          <Switch checked={config.network_proxy_enabled} onChange={onNetworkProxyToggle} />
        </SettingLine>
        <SettingLine
          icon={Globe2}
          title="代理服务器"
          description="先选择代理类型，再分别填写地址和端口。"
          wide
        >
          <div className="echo-proxy-editor">
            <Select
              value={proxyParts.scheme}
              ariaLabel="代理类型"
              options={proxySchemeOptions}
              onChange={(value) => {
                const scheme = asProxyScheme(value)
                onProxyPartsChange({
                  scheme,
                  port:
                    proxyParts.port === defaultProxyPorts[proxyParts.scheme]
                      ? defaultProxyPorts[scheme]
                      : proxyParts.port,
                })
              }}
            />
            <Input
              value={proxyParts.host}
              ariaLabel="代理地址"
              placeholder="127.0.0.1"
              onChange={(value) => onProxyPartsChange({ host: value })}
            />
            <input
              className="echo-field echo-proxy-editor-port"
              value={proxyParts.port}
              inputMode="numeric"
              aria-label="代理端口"
              placeholder={defaultProxyPorts[proxyParts.scheme]}
              onChange={(event) => onProxyPartsChange({ port: event.currentTarget.value })}
            />
            <button
              type="button"
              className="echo-button echo-proxy-editor-action"
              onClick={onApplySystemHttpProxy}
              disabled={settingsOperationBusy}
            >
              {systemProxyBusy ? (
                <Loader2 size={16} className="echo-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              使用当前系统 HTTP 代理
            </button>
          </div>
        </SettingLine>
        <SettingLine
          icon={ShieldCheck}
          title="直连地址"
          description="这些主机不会走代理，避免影响本机 Ollama、SenseVoice 和内网服务。"
        >
          <Input
            value={config.network_proxy_bypass}
            placeholder="localhost,127.0.0.1,10.0.0.0/8"
            onChange={onProxyBypassChange}
          />
        </SettingLine>
      </Panel>

      <Panel title={managedConfigPanelTitle} alert={managedConfigAlert}>
        <SettingLine icon={Globe2} title="后台配置" description={bootstrapSummary}>
          <Badge tone={bootstrapStatusTone}>{bootstrapStatusLabel}</Badge>
          <button
            type="button"
            className="echo-button"
            onClick={onSyncDesktopBootstrap}
            disabled={!canSyncDesktopBootstrap}
          >
            {bootstrapSyncBusy ? (
              <Loader2 size={16} className="echo-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            {managedConfigActionLabel}
          </button>
        </SettingLine>
        <SettingLine icon={ShieldCheck} title="配置模式" description={managedConfigModeDescription}>
          <Badge tone={bootstrapModeTone}>{bootstrapModeSummary}</Badge>
        </SettingLine>
      </Panel>

      <Panel title="外观" alert={appearanceAlert}>
        <SettingLine
          icon={Palette}
          title="界面皮肤"
          description="界面保持少装饰、清楚层级和稳定对比。"
          wide
        >
          <ThemeProfilePicker value={config.theme_profile} onChange={onThemeProfileChange} />
        </SettingLine>
        <SettingLine
          icon={Zap}
          title="胶囊风格"
          description="同一套录音流程，不同悬浮球外观；设置会随主窗口和胶囊窗口同步。"
          wide
        >
          <CapsuleStylePicker value={config.capsule_style} onChange={onCapsuleStyleChange} />
        </SettingLine>
      </Panel>
    </>
  )
}

function ThemeProfilePicker({
  value,
  onChange,
}: {
  value: ThemeProfile
  onChange: (value: ThemeProfile) => void
}) {
  return (
    <div className="echo-theme-profile-grid">
      {THEME_PROFILE_OPTIONS.map((profile) => (
        <button
          key={profile.id}
          type="button"
          className={`echo-appearance-card echo-theme-profile-card echo-theme-profile-card--${profile.id} ${
            value === profile.id ? 'is-active' : ''
          }`}
          aria-pressed={value === profile.id}
          aria-label={`${profile.name}：${profile.note}`}
          style={
            {
              '--theme-preview-app': profile.preview.app,
              '--theme-preview-shell': profile.preview.shell,
              '--theme-preview-panel': profile.preview.panel,
              '--theme-preview-panel-alt': profile.preview.panelAlt,
              '--theme-preview-text': profile.preview.text,
              '--theme-preview-accent': profile.preview.accent,
            } as CSSProperties
          }
          onClick={() => onChange(profile.id)}
        >
          <span className="echo-theme-preview" aria-hidden="true">
            <i className="echo-theme-preview-sidebar" />
            <i className="echo-theme-preview-body">
              <em />
              <em />
            </i>
            <i className="echo-theme-preview-accent" />
          </span>
          <span className="echo-theme-swatch-row" aria-hidden="true">
            {profile.swatches.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </span>
          <strong>{profile.name}</strong>
          <small>{profile.note}</small>
        </button>
      ))}
    </div>
  )
}

function CapsuleStylePicker({
  value,
  onChange,
}: {
  value: CapsuleStyle
  onChange: (value: CapsuleStyle) => void
}) {
  const currentStyle = capsuleStyleOption(value)

  return (
    <div className="echo-capsule-style-picker">
      <div className="echo-capsule-current-preview">
        <div className="echo-capsule-current-copy">
          <strong>当前胶囊预览</strong>
          <small>
            {currentStyle.name} · {currentStyle.note}
          </small>
        </div>
        <CapsuleSkinPreview capsuleStyle={value} variant="current" />
      </div>
      <div className="echo-capsule-style-grid">
        {capsuleStyleOptions.map((style) => (
          <button
            key={style.id}
            type="button"
            className={`echo-appearance-card echo-capsule-style-card echo-capsule-style-card--${style.id} ${
              value === style.id ? 'is-active' : ''
            }`}
            aria-pressed={value === style.id}
            onClick={() => onChange(style.id)}
          >
            <CapsuleSkinPreview capsuleStyle={style.id} />
            <strong>{style.name}</strong>
            <small>{style.note}</small>
          </button>
        ))}
      </div>
    </div>
  )
}
