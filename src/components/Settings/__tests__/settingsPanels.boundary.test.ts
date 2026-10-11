import { describe, expect, it } from 'vitest'
import controlPanelSource from '../ControlPanel.tsx?raw'
import inputPanelSource from '../InputSettingsPanel.tsx?raw'
import speechPanelSource from '../SpeechSettingsPanel.tsx?raw'
import aiPanelSource from '../AiSettingsPanel.tsx?raw'
import systemPanelSource from '../SystemSettingsPanel.tsx?raw'

const controlledPanels = [inputPanelSource, speechPanelSource, aiPanelSource, systemPanelSource]

describe('Settings controlled panel boundaries', () => {
  it('keeps each tab branch as a single controlled panel composition', () => {
    for (const component of [
      'InputSettingsPanel',
      'SpeechSettingsPanel',
      'AiSettingsPanel',
      'SystemSettingsPanel',
    ]) {
      expect(controlPanelSource).toContain(`<${component}`)
    }

    for (const legacyRootView of [
      '<Panel title="触发键"',
      '<Panel title="语音识别"',
      '<Panel title="配置来源"',
      '<Panel title="启动与托盘"',
      'const configSourcePanel =',
      'const backendAuthPanel =',
      'function ThemeProfilePicker(',
      'function CapsuleStylePicker(',
    ]) {
      expect(controlPanelSource).not.toContain(legacyRootView)
    }
  })

  it('keeps runtime ownership out of the controlled view modules', () => {
    for (const source of controlledPanels) {
      expect(source).not.toContain('useAppStore')
      expect(source).not.toContain("from '../../lib/tauri'")
      expect(source).not.toContain('useEffect(')
      expect(source).not.toContain('localStorage')
      expect(source).not.toContain('invoke(')
    }
  })
})
