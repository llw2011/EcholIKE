import { APP_NAME } from './branding'

export const THEME_PROFILE_IDS = [
  'echo',
  'pearl',
  'mint',
  'graphite',
  'ray',
  'linear',
  'command',
  'ember',
  'carbon',
] as const

export type ThemeProfile = (typeof THEME_PROFILE_IDS)[number]

export interface ThemeProfileOption {
  id: ThemeProfile
  name: string
  note: string
  appearance: 'adaptive' | 'fixed-dark'
  swatches: readonly [string, string, string]
  preview: {
    app: string
    shell: string
    panel: string
    panelAlt: string
    text: string
    accent: string
  }
}

export const THEME_PROFILE_OPTIONS: readonly ThemeProfileOption[] = [
  {
    id: 'echo',
    name: APP_NAME,
    note: '清透蓝 · 温暖品牌高光',
    appearance: 'adaptive',
    swatches: ['#eaf1ff', '#ffffff', '#1d4ed8'],
    preview: {
      app: '#eaf1ff',
      shell: '#f4f8ff',
      panel: '#ffffff',
      panelAlt: '#dbeafe',
      text: '#102033',
      accent: '#1d4ed8',
    },
  },
  {
    id: 'pearl',
    name: 'Pearl',
    note: '瓷白灰 · 精细系统层次',
    appearance: 'adaptive',
    swatches: ['#f1f2f4', '#ffffff', '#111827'],
    preview: {
      app: '#f1f2f4',
      shell: '#ffffff',
      panel: '#ffffff',
      panelAlt: '#e5e7eb',
      text: '#1d1d1f',
      accent: '#111827',
    },
  },
  {
    id: 'mint',
    name: 'Mint',
    note: '柔和绿 · 长时阅读舒适',
    appearance: 'adaptive',
    swatches: ['#dcfce7', '#fbfffd', '#047857'],
    preview: {
      app: '#dcfce7',
      shell: '#effaf3',
      panel: '#fbfffd',
      panelAlt: '#bbf7d0',
      text: '#10231a',
      accent: '#047857',
    },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    note: '深侧栏 · 银灰工作台',
    appearance: 'adaptive',
    swatches: ['#111827', '#f8fafc', '#64748b'],
    preview: {
      app: '#e7ebf0',
      shell: '#111827',
      panel: '#f8fafc',
      panelAlt: '#d7dde6',
      text: '#0f172a',
      accent: '#64748b',
    },
  },
  {
    id: 'ray',
    name: 'Ray',
    note: '近黑琥珀 · 快捷指令感',
    appearance: 'fixed-dark',
    swatches: ['#07080b', '#17191f', '#ffc533'],
    preview: {
      app: '#07080b',
      shell: '#101115',
      panel: '#121318',
      panelAlt: '#242832',
      text: '#f4f4f6',
      accent: '#ffc533',
    },
  },
  {
    id: 'linear',
    name: 'Linear',
    note: '深靛蓝 · 精密产品层级',
    appearance: 'fixed-dark',
    swatches: ['#0b0d13', '#1c1f2a', '#4f56d9'],
    preview: {
      app: '#0b0d13',
      shell: '#11131a',
      panel: '#181b24',
      panelAlt: '#252938',
      text: '#f7f8f8',
      accent: '#4f56d9',
    },
  },
  {
    id: 'command',
    name: 'Command',
    note: '纯黑白 · 锐利命令界面',
    appearance: 'fixed-dark',
    swatches: ['#07080a', '#101111', '#ffffff'],
    preview: {
      app: '#07080a',
      shell: '#0d0d0d',
      panel: '#101111',
      panelAlt: '#18191a',
      text: '#f4f4f6',
      accent: '#ffffff',
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    note: '炭黑红 · 温暖边缘反馈',
    appearance: 'fixed-dark',
    swatches: ['#080607', '#151011', '#ff6161'],
    preview: {
      app: '#080607',
      shell: '#100d0e',
      panel: '#151011',
      panelAlt: '#241617',
      text: '#fff5f5',
      accent: '#ff6161',
    },
  },
  {
    id: 'carbon',
    name: 'Carbon',
    note: '碳黑青 · 冷静技术层次',
    appearance: 'fixed-dark',
    swatches: ['#0a0d10', '#151a1f', '#57c1ff'],
    preview: {
      app: '#0a0d10',
      shell: '#11161b',
      panel: '#151a1f',
      panelAlt: '#1d252d',
      text: '#f4f7fb',
      accent: '#57c1ff',
    },
  },
]

export const FIXED_DARK_THEME_PROFILES: ReadonlySet<ThemeProfile> = new Set(
  THEME_PROFILE_OPTIONS.filter((profile) => profile.appearance === 'fixed-dark').map(
    (profile) => profile.id,
  ),
)

export function isFixedDarkThemeProfile(profile: string): profile is ThemeProfile {
  return FIXED_DARK_THEME_PROFILES.has(profile as ThemeProfile)
}

export function isDarkThemeAppearance(prefersDark: boolean, profile: string) {
  return prefersDark || isFixedDarkThemeProfile(profile)
}

export const CAPSULE_STYLE_IDS = [
  'classic',
  'compact',
  'glass',
  'ink',
  'command',
  'signal',
  'pulse',
  'orbit',
] as const

export type CapsuleStyle = (typeof CAPSULE_STYLE_IDS)[number]

export const CAPSULE_STYLE_OPTIONS: ReadonlyArray<{
  id: CapsuleStyle
  name: string
  note: string
}> = [
  { id: 'classic', name: 'Classic', note: '柔和高光，稳妥通用' },
  { id: 'compact', name: 'Compact', note: '紧凑棱角，低干扰' },
  { id: 'glass', name: 'Glass', note: '透亮折射，轻盈悬浮' },
  { id: 'ink', name: 'Ink', note: '墨黑高对比，录屏清晰' },
  { id: 'command', name: 'Command', note: '锐角面板，琥珀指示' },
  { id: 'signal', name: 'Signal', note: '青绿声场，实时反馈' },
  { id: 'pulse', name: 'Pulse', note: '暖色扫描，节奏可见' },
  { id: 'orbit', name: 'Orbit', note: '冷蓝轨迹，持续待命' },
]
