import { Eye, Keyboard, Wand2, Zap } from 'lucide-react'
import type { AppConfig } from '../../stores/appStore'
import { Panel, Segmented, SettingLine, Switch, type PanelAlertState } from './settingsUi'

type HotkeyCaptureTarget = 'input' | 'screenOcr'

type InputSettingsPanelProps = {
  config: AppConfig
  capturingHotkey: HotkeyCaptureTarget | null
  hotkeyHint: string
  triggerAlert?: PanelAlertState
  inputMethodAlert?: PanelAlertState
  onBeginHotkeyCapture: (target: HotkeyCaptureTarget) => void
  onSelectedTextEnabledChange: (checked: boolean) => void
  onHotkeyModeChange: (value: AppConfig['hotkey_mode']) => void
  onOutputModeChange: (value: AppConfig['output_mode']) => void
}

export function InputSettingsPanel({
  config,
  capturingHotkey,
  hotkeyHint,
  triggerAlert,
  inputMethodAlert,
  onBeginHotkeyCapture,
  onSelectedTextEnabledChange,
  onHotkeyModeChange,
  onOutputModeChange,
}: InputSettingsPanelProps) {
  return (
    <>
      <Panel title="触发键" alert={triggerAlert}>
        <SettingLine
          icon={Zap}
          title="快速输入键"
          description="按下后依次录音、识别并写入目标应用。AI 不会默认拖慢快速输入。"
        >
          <kbd>{capturingHotkey === 'input' ? hotkeyHint : config.hotkey}</kbd>
          <button
            type="button"
            className="echo-button"
            onClick={() => onBeginHotkeyCapture('input')}
          >
            更改
          </button>
        </SettingLine>
        <SettingLine
          icon={Eye}
          title="看窗口快捷键"
          description="按下后读取当前窗口文字，结果以弹窗展示。"
        >
          <kbd>{capturingHotkey === 'screenOcr' ? hotkeyHint : config.screen_ocr_hotkey}</kbd>
          <button
            type="button"
            className="echo-button"
            onClick={() => onBeginHotkeyCapture('screenOcr')}
          >
            更改
          </button>
        </SettingLine>
        <SettingLine
          icon={Wand2}
          title="选区修改"
          description="选中文本后使用同一个输入键，后端会捕获选区并交给文本 AI 修改。"
        >
          <Switch checked={config.selected_text_enabled} onChange={onSelectedTextEnabledChange} />
        </SettingLine>
      </Panel>

      <Panel title="输入方式" alert={inputMethodAlert}>
        <SettingLine
          icon={Keyboard}
          title="触发方式"
          description="短句建议按住说话，长段落建议单击切换。"
        >
          <Segmented
            value={config.hotkey_mode}
            options={[
              { value: 'hold', label: '按住说话' },
              { value: 'toggle', label: '单击切换' },
            ]}
            onChange={(value) => onHotkeyModeChange(value as AppConfig['hotkey_mode'])}
          />
        </SettingLine>
        <SettingLine
          icon={Keyboard}
          title="输出方式"
          description="键盘写入最快；剪贴板模式适合权限受限环境。"
        >
          <Segmented
            value={config.output_mode}
            options={[
              { value: 'keyboard', label: '键盘写入' },
              { value: 'clipboard', label: '剪贴板' },
            ]}
            onChange={(value) => onOutputModeChange(value as AppConfig['output_mode'])}
          />
        </SettingLine>
      </Panel>
    </>
  )
}
