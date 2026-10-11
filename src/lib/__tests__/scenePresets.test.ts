import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCENE_PRESET_ID,
  findScenePreset,
  mergeScenePresetContext,
  scenePresetContext,
  scenePresetOptions,
} from '../scenePresets'

describe('scene presets', () => {
  it('keeps strengthened offline fallbacks when bootstrap scenes are unavailable', () => {
    const presets = scenePresetOptions()

    expect(presets.map((preset) => preset.slug)).toEqual([
      'meeting-notes',
      'work-report',
      'markdown-cleanup',
    ])
    for (const preset of presets) {
      expect(preset.promptTemplate).toContain('不覆盖用户当前明确的')
      expect(preset.promptTemplate).toContain('不得')
      expect(preset.promptTemplate).toMatch(/材料很短|短文本/)
      expect(preset.promptTemplate).toContain('只输出')
    }

    expect(presets.find((preset) => preset.slug === 'meeting-notes')?.promptTemplate).toContain(
      '缺失负责人或截止时间',
    )
    expect(presets.find((preset) => preset.slug === 'work-report')?.promptTemplate).toContain(
      '不得把计划写成成果',
    )
    expect(presets.find((preset) => preset.slug === 'markdown-cleanup')?.promptTemplate).toContain(
      '代码、命令、URL、路径、标识符',
    )
  })

  it('uses usable remote scenes as the authoritative source', () => {
    const remote = {
      id: 'remote:meeting',
      slug: 'meeting-notes',
      name: '远程会议',
      description: '服务端模板',
      category: 'work',
      promptTemplate: '这是服务端下发的完整处理规范。',
      dictionaryTerms: [{ word: 'EcholIKE', pronunciation: 'echo like' }],
      isPro: false,
    }

    expect(scenePresetOptions([remote])).toEqual([remote])
  })

  it('injects the exact preset contract before task context and skips the default option', () => {
    const preset = scenePresetOptions()[0]
    if (!preset) throw new Error('missing offline scene preset')

    const context = scenePresetContext(preset)
    expect(context).toContain(`预设：${preset.name}`)
    expect(context).toContain(`处理要求：\n${preset.promptTemplate}`)
    expect(mergeScenePresetContext('当前窗口上下文', preset)).toBe(`${context}\n\n当前窗口上下文`)
    expect(findScenePreset([preset], DEFAULT_SCENE_PRESET_ID)).toBeNull()
    expect(mergeScenePresetContext('当前窗口上下文', null)).toBe('当前窗口上下文')
  })
})
