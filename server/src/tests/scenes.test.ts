import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultScenePacks } from '../services/scenes/scene-service.js'

describe('scene route visibility', () => {
  it('ships useful default scene presets for fresh backends', () => {
    expect(defaultScenePacks.map((scene) => scene.slug)).toEqual([
      'meeting-notes',
      'technical-doc',
      'customer-reply',
      'work-report',
      'markdown-cleanup',
      'legal-contract-review',
    ])
    expect(new Set(defaultScenePacks.map((scene) => scene.promptTemplate))).toHaveLength(6)

    for (const scene of defaultScenePacks) {
      expect(scene.promptTemplate.length).toBeGreaterThan(180)
      expect(scene.promptTemplate.length).toBeLessThanOrEqual(4000)
      expect(scene.promptTemplate).toContain('不覆盖用户当前明确的')
      expect(scene.promptTemplate).toContain('不得')
      expect(scene.promptTemplate).toContain('只输出')
      expect(scene.promptTemplate).toMatch(/材料很短|短文本/)
    }

    expect(scenePrompt('meeting-notes')).toContain('事项｜负责人｜截止时间')
    expect(scenePrompt('technical-doc')).toContain('已观察/已验证')
    expect(scenePrompt('technical-doc')).toContain('风险与回滚')
    expect(scenePrompt('customer-reply')).toContain('SLA')
    expect(scenePrompt('customer-reply')).toContain('不得杜撰处理进度')
    expect(scenePrompt('work-report')).toContain('不得把计划写成成果')
    expect(scenePrompt('markdown-cleanup')).toContain('重复 OCR 片段')
    expect(scenePrompt('markdown-cleanup')).toContain('代码围栏')
    expect(scenePrompt('legal-contract-review')).toContain('条款/原文依据｜潜在影响｜建议核对')
    expect(scenePrompt('legal-contract-review')).toContain('不给出法律结论')
    expect(defaultScenePacks.find((scene) => scene.slug === 'legal-contract-review')).toMatchObject(
      { isPro: true },
    )
    expect(defaultScenePacks.find((scene) => scene.slug === 'markdown-cleanup')).toMatchObject({
      isPro: false,
    })
  })

  it('upgrades only untouched official scene defaults', () => {
    const migration = readFileSync(
      new URL('../db/migrations/0008_strengthen_default_scenes.sql', import.meta.url),
      'utf8',
    )

    expect(migration).toContain(
      'current_scene."description" = official_default."previous_description"',
    )
    expect(migration).toContain(
      'current_scene."prompt_template" = official_default."previous_prompt_template"',
    )
    expect(migration).toContain('current_scene."slug" = official_default."slug"')

    for (const legacy of legacySceneDefaults) {
      expect(migration).toContain(`'${legacy.slug}'`)
      expect(migration).toContain(`'${legacy.description}'`)
      expect(migration).toContain(`'${legacy.promptTemplate}'`)
      expect(migration).toContain(`'${scenePrompt(legacy.slug)}'`)
    }
  })
})

function scenePrompt(slug: string): string {
  const prompt = defaultScenePacks.find((scene) => scene.slug === slug)?.promptTemplate
  if (!prompt) throw new Error(`missing default scene: ${slug}`)
  return prompt
}

const legacySceneDefaults = [
  {
    slug: 'meeting-notes',
    description: '把讨论内容整理为结论、待办和责任人。',
    promptTemplate:
      '请把输入整理成结构化会议纪要：背景、结论、待办、负责人、时间点。保留关键数字和人名，不扩写事实。',
  },
  {
    slug: 'technical-doc',
    description: '把零散说明整理为问题、方案、步骤和验证。',
    promptTemplate:
      '请把输入整理为技术文档风格：问题、原因、方案、步骤、风险、验证。术语保持准确，代码、接口、配置项不要随意改名。',
  },
  {
    slug: 'customer-reply',
    description: '生成清晰、礼貌、可执行的客户沟通文本。',
    promptTemplate:
      '请把输入改写成清晰、礼貌、可执行的客户回复。先回应诉求，再说明方案和下一步，避免生硬或推诿。',
  },
  {
    slug: 'work-report',
    description: '整理为进展、问题、风险和下一步。',
    promptTemplate:
      '请整理为工作汇报：进展、问题、风险、下一步。语言简洁正式，适合发给团队或上级。',
  },
  {
    slug: 'markdown-cleanup',
    description: '规范标题、列表、表格、代码块和空行。',
    promptTemplate:
      '请清理并规范 Markdown：修正标题层级、列表、表格、代码块和空行；不要改变事实，不要添加原文不存在的信息。',
  },
  {
    slug: 'legal-contract-review',
    description: '谨慎标出合同文本中的风险点和需确认处。',
    promptTemplate:
      '请以谨慎的合同审阅口吻整理文本：标出权利义务、风险点、模糊表述和需人工确认处；不要给出法律结论。',
  },
]
