export const DEFAULT_SCENE_PRESET_ID = 'default'

export interface SceneDictionaryTerm {
  word: string
  pronunciation?: string | null
}

export interface ScenePreset {
  id: string
  slug?: string
  name: string
  description: string
  category: string
  promptTemplate: string
  dictionaryTerms: SceneDictionaryTerm[]
  isPro: boolean
}

const offlineScenePresets: ScenePreset[] = [
  {
    id: 'offline:meeting-notes',
    slug: 'meeting-notes',
    name: '会议纪要',
    description: '区分结论、讨论与待办，缺失责任人不猜。',
    category: 'work',
    promptTemplate:
      '本预设补充输出结构，不覆盖用户当前明确的翻译、总结、润色或问答要求。仅依据输入整理“会议结论、讨论要点、待办事项、待确认”，空章节省略。原文未明确为结论的意见不得升级为结论；待办只收录明确行动，缺失负责人或截止时间时写“待确认”，不得猜测或补写事实。材料很短时只输出少量要点，不硬凑完整纪要。只输出可直接使用的 Markdown 纪要正文。',
    dictionaryTerms: [],
    isPro: false,
  },
  {
    id: 'offline:work-report',
    slug: 'work-report',
    name: '工作汇报',
    description: '先结果后过程，区分完成、进行中与计划。',
    category: 'work',
    promptTemplate:
      '本预设补充输出结构，不覆盖用户当前明确的翻译、总结、润色或问答要求。仅依据输入，按实际内容选择“本期进展、关键结果、问题与风险、下一步、需要协同/决策”。明确区分已完成、进行中、计划和设想，不得把计划写成成果；数字、截止时间、负责人和阻塞只引用原文，缺失时写“待确认”。材料很短时输出 3～5 条要点，不套完整周报。只输出可直接使用的汇报正文。',
    dictionaryTerms: [],
    isPro: false,
  },
  {
    id: 'offline:markdown-cleanup',
    slug: 'markdown-cleanup',
    name: 'Markdown 清理',
    description: '修复结构与 OCR 噪声，保护代码和原始事实。',
    category: 'markdown',
    promptTemplate:
      '本预设补充 Markdown 结构与低风险清理规则，不覆盖用户当前明确的翻译、总结、润色或问答要求。先完成当前任务，再统一标题层级、列表缩进、空行、引用、表格、代码围栏和链接格式。代码、命令、URL、路径、标识符、数字和引用内容不得改写；只删除可以确认的重复 OCR 片段，存疑内容保留。不得补充原文没有的事实或结论。短文本只做轻量整理，不为了“完整”而扩写。只输出完整、可直接替换的 Markdown 正文。',
    dictionaryTerms: [{ word: 'Markdown' }],
    isPro: false,
  },
]

export function scenePresetOptions(remoteScenes?: ScenePreset[] | null): ScenePreset[] {
  const remote = Array.isArray(remoteScenes) ? remoteScenes.filter(isUsableScenePreset) : []
  return remote.length ? remote : offlineScenePresets
}

export function findScenePreset(presets: ScenePreset[], selectedId: string): ScenePreset | null {
  if (selectedId === DEFAULT_SCENE_PRESET_ID) return null
  return presets.find((preset) => preset.id === selectedId) ?? null
}

export function scenePresetContext(preset: ScenePreset | null): string {
  if (!preset) return ''

  const promptTemplate = preset.promptTemplate.trim()
  const lines = [`预设：${preset.name}`]
  if (promptTemplate) {
    lines.push(`处理要求：\n${promptTemplate}`)
  }

  const terms = preset.dictionaryTerms
    .map(formatDictionaryTerm)
    .filter((term): term is string => Boolean(term))
  if (terms.length) {
    lines.push(`优先术语：\n${terms.map((term) => `- ${term}`).join('\n')}`)
  }

  return lines.join('\n\n')
}

export function mergeScenePresetContext(
  context: string | undefined,
  preset: ScenePreset | null,
): string | undefined {
  const presetContext = scenePresetContext(preset)
  return [presetContext, context?.trim()].filter(Boolean).join('\n\n') || undefined
}

function isUsableScenePreset(value: ScenePreset): boolean {
  return Boolean(
    value &&
    typeof value.id === 'string' &&
    value.id.trim() &&
    typeof value.name === 'string' &&
    value.name.trim() &&
    typeof value.promptTemplate === 'string',
  )
}

function formatDictionaryTerm(term: SceneDictionaryTerm): string | null {
  const word = sanitizeTerm(term.word)
  if (!word) return null
  const pronunciation = sanitizeTerm(term.pronunciation ?? '')
  return pronunciation ? `${word} (${pronunciation})` : word
}

function sanitizeTerm(value: string) {
  return value
    .replace(/["\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
