// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CAPSULE_STYLE_IDS,
  FIXED_DARK_THEME_PROFILES,
  THEME_PROFILE_IDS,
} from '../lib/appearanceProfiles'

interface CssRule {
  selectors: string[]
  declarations: Map<string, string>
}

const themesPath = 'src/styles/themes.css'
const capsulesPath = 'src/styles/capsules.css'
const globalsPath = 'src/styles/globals.css'
const mainSource = readFileSync('src/main.tsx', 'utf8')
const globalsSource = readFileSync(globalsPath, 'utf8')
const themesSource = existsSync(themesPath) ? readFileSync(themesPath, 'utf8') : ''
const capsulesSource = existsSync(capsulesPath) ? readFileSync(capsulesPath, 'utf8') : ''

const requiredThemeTokens = [
  '--echo-app-bg',
  '--echo-shell-bg',
  '--echo-titlebar-bg',
  '--echo-surface',
  '--echo-surface-2',
  '--echo-surface-3',
  '--echo-surface-hover',
  '--echo-input-bg',
  '--echo-text',
  '--echo-muted',
  '--echo-muted-strong',
  '--echo-subtle',
  '--echo-border-strong',
  '--echo-border-soft',
  '--echo-accent',
  '--echo-on-accent',
  '--echo-accent-soft',
  '--echo-accent-warm',
  '--echo-nav-active-bg',
  '--echo-nav-active-text',
  '--echo-nav-idle-bg',
  '--echo-sidebar-text',
  '--echo-sidebar-muted',
  '--echo-sidebar-card-bg',
  '--echo-sidebar-card-border',
  '--echo-sidebar-accent',
  '--echo-panel-accent',
  '--echo-hover-bg',
  '--echo-hover-border',
  '--echo-hover-text',
  '--echo-sidebar-hover-bg',
  '--echo-sidebar-hover-border',
  '--echo-sidebar-hover-text',
  '--echo-ok',
  '--echo-warn',
  '--echo-danger',
] as const

const requiredCapsuleTokens = [
  '--runtime-capsule-bg',
  '--runtime-capsule-text',
  '--runtime-capsule-border',
  '--runtime-capsule-active-bg',
  '--runtime-capsule-active-text',
  '--runtime-capsule-dot',
  '--runtime-capsule-wave-fill',
  '--runtime-capsule-wave-width',
  '--runtime-capsule-wave-gap',
  '--runtime-capsule-wave-radius',
  '--runtime-capsule-indicator-width',
  '--runtime-capsule-indicator-height',
  '--runtime-capsule-indicator-bg',
  '--runtime-capsule-indicator-border',
  '--runtime-capsule-indicator-radius',
  '--runtime-capsule-indicator-animation',
  '--runtime-capsule-progress-fill',
  '--echo-capsule-preview-stage',
  '--echo-capsule-preview-stage-border',
] as const

const requiredContrastPairs = [
  ['--echo-text', '--echo-surface', 4.5],
  ['--echo-muted', '--echo-surface', 3],
  ['--echo-nav-active-text', '--echo-nav-active-bg', 4.5],
  ['--echo-hover-text', '--echo-hover-bg', 4.5],
  ['--echo-sidebar-hover-text', '--echo-sidebar-hover-bg', 4.5],
] as const

function parseCssRules(source: string): CssRule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => {
      const declarations = new Map<string, string>()
      for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
        declarations.set(declaration[1], declaration[2].trim())
      }
      return {
        selectors: match[1]
          .split(',')
          .map((selector) => selector.replace(/\s+/g, ' ').trim())
          .filter(Boolean),
        declarations,
      }
    })
    .filter((rule) => rule.selectors.every((selector) => !selector.startsWith('@')))
}

function quotedAttributeSelector(attribute: string, value: string) {
  return new RegExp(`^:root\\[${attribute}=(['"])${value}\\1\\]$`)
}

function quotedDarkAttributeSelector(attribute: string, value: string) {
  return new RegExp(`^:root\\.dark\\[${attribute}=(['"])${value}\\1\\]$`)
}

function matchingRules(rules: CssRule[], selector: RegExp) {
  return rules.filter((rule) => rule.selectors.some((candidate) => selector.test(candidate)))
}

function linesMatching(source: string, pattern: RegExp) {
  return source
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(({ text }) => pattern.test(text))
}

function parseHexColor(value: string, label: string): readonly [number, number, number] {
  expect(value, `${label} must be a six-digit hex color`).toMatch(/^#[\da-f]{6}$/i)
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ]
}

function linearColorChannel(value: number) {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(color: readonly [number, number, number]) {
  return (
    linearColorChannel(color[0]) * 0.2126 +
    linearColorChannel(color[1]) * 0.7152 +
    linearColorChannel(color[2]) * 0.0722
  )
}

function contrastRatio(
  foreground: readonly [number, number, number],
  background: readonly [number, number, number],
) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function expectCompleteTokens(rule: CssRule, tokens: readonly string[]) {
  for (const token of tokens) {
    expect(rule.declarations.has(token), `${rule.selectors.join(', ')} is missing ${token}`).toBe(
      true,
    )
  }
}

describe('appearance CSS authority', () => {
  it('loads the two domain authorities after shared component styles', () => {
    expect(existsSync(themesPath)).toBe(true)
    expect(existsSync(capsulesPath)).toBe(true)

    const globalsImport = mainSource.indexOf("'./styles/globals.css'")
    const themesImport = mainSource.indexOf("'./styles/themes.css'")
    const capsulesImport = mainSource.indexOf("'./styles/capsules.css'")
    expect(globalsImport).toBeGreaterThanOrEqual(0)
    expect(themesImport).toBeGreaterThan(globalsImport)
    expect(capsulesImport).toBeGreaterThan(themesImport)
  })

  it('keeps exactly nine base and four adaptive-dark appearances complete and self-contained', () => {
    const rules = parseCssRules(themesSource)
    const adaptiveProfiles = THEME_PROFILE_IDS.filter(
      (profile) => !FIXED_DARK_THEME_PROFILES.has(profile),
    )
    const sharedRelationships = rules.find(
      (rule) => rule.selectors.length === 1 && rule.selectors[0] === ':root',
    )

    expect(sharedRelationships).toBeDefined()
    expect(sharedRelationships?.declarations.get('--echo-active-bg')).toBe('var(--echo-accent)')
    expect(sharedRelationships?.declarations.get('--echo-active-text')).toBe(
      'var(--echo-on-accent)',
    )
    expect(sharedRelationships?.declarations.get('--echo-sidebar-bg')).toBe('var(--echo-shell-bg)')
    expect(sharedRelationships?.declarations.get('--echo-nav-hover-bg')).toBe(
      'var(--echo-sidebar-hover-bg)',
    )

    for (const profile of THEME_PROFILE_IDS) {
      const baseRules = matchingRules(rules, quotedAttributeSelector('data-theme-profile', profile))
      expect(baseRules, `${profile} must have one base appearance rule`).toHaveLength(1)
      expectCompleteTokens(baseRules[0], requiredThemeTokens)
      expect(baseRules[0].declarations.get('--echo-surface')).toMatch(/^#[\da-f]{6}$/i)

      if (profile === 'echo') {
        expect(baseRules[0].selectors).toContain(':root')
      }
    }

    for (const profile of adaptiveProfiles) {
      const darkRules = matchingRules(
        rules,
        quotedDarkAttributeSelector('data-theme-profile', profile),
      )
      expect(darkRules, `${profile} must have one adaptive dark appearance rule`).toHaveLength(1)
      expectCompleteTokens(darkRules[0], requiredThemeTokens)
      expect(darkRules[0].declarations.get('--echo-surface')).toMatch(/^#[\da-f]{6}$/i)
    }

    for (const profile of FIXED_DARK_THEME_PROFILES) {
      const baseRules = matchingRules(rules, quotedAttributeSelector('data-theme-profile', profile))
      const fixedDarkRules = matchingRules(
        rules,
        quotedDarkAttributeSelector('data-theme-profile', profile),
      )
      expect(
        fixedDarkRules.every((rule) => baseRules.includes(rule)),
        `${profile} may alias its base rule but must not fork a second palette`,
      ).toBe(true)
    }
  })

  it('keeps all thirteen appearances above the required WCAG contrast thresholds', () => {
    const rules = parseCssRules(themesSource)
    const appearances: Array<{ name: string; rule: CssRule }> = []

    for (const profile of THEME_PROFILE_IDS) {
      const baseRule = matchingRules(
        rules,
        quotedAttributeSelector('data-theme-profile', profile),
      )[0]
      expect(baseRule, `${profile} base appearance must exist`).toBeDefined()
      appearances.push({
        name: `${profile}/${FIXED_DARK_THEME_PROFILES.has(profile) ? 'fixed-dark' : 'light'}`,
        rule: baseRule,
      })

      if (!FIXED_DARK_THEME_PROFILES.has(profile)) {
        const darkRule = matchingRules(
          rules,
          quotedDarkAttributeSelector('data-theme-profile', profile),
        )[0]
        expect(darkRule, `${profile} dark appearance must exist`).toBeDefined()
        appearances.push({ name: `${profile}/dark`, rule: darkRule })
      }
    }

    expect(appearances).toHaveLength(13)

    for (const appearance of appearances) {
      for (const [foregroundToken, backgroundToken, minimum] of requiredContrastPairs) {
        const foregroundValue = appearance.rule.declarations.get(foregroundToken)
        const backgroundValue = appearance.rule.declarations.get(backgroundToken)
        expect(foregroundValue, `${appearance.name} is missing ${foregroundToken}`).toBeDefined()
        expect(backgroundValue, `${appearance.name} is missing ${backgroundToken}`).toBeDefined()

        const ratio = contrastRatio(
          parseHexColor(foregroundValue!, `${appearance.name} ${foregroundToken}`),
          parseHexColor(backgroundValue!, `${appearance.name} ${backgroundToken}`),
        )
        expect(
          ratio,
          `${appearance.name} ${foregroundToken} ${foregroundValue} on ${backgroundToken} ${backgroundValue} has ${ratio.toFixed(2)}:1 contrast; expected at least ${minimum}:1`,
        ).toBeGreaterThanOrEqual(minimum)
      }
    }
  })

  it('keeps theme selectors in themes.css and capsule selectors in capsules.css only', () => {
    const styleFiles = readdirSync('src/styles').filter((file: string) => file.endsWith('.css'))
    for (const file of styleFiles) {
      const source = readFileSync(`src/styles/${file}`, 'utf8')
      if (file !== 'themes.css') {
        expect(
          linesMatching(source, /data-theme-profile/),
          `${file} must not own theme profile selectors`,
        ).toEqual([])
      }
      if (file !== 'capsules.css') {
        expect(
          linesMatching(source, /data-capsule-style/),
          `${file} must not own capsule style selectors`,
        ).toEqual([])
      }
    }

    expect(linesMatching(globalsSource, /data-theme-profile/)).toEqual([])
    expect(linesMatching(globalsSource, /data-capsule-style/)).toEqual([])
  })

  it('keeps every capsule catalog id backed by one complete skin selector', () => {
    const rules = parseCssRules(capsulesSource)
    const authoredIds = new Set<string>()

    for (const profile of CAPSULE_STYLE_IDS) {
      const selector = new RegExp(
        `^\\.echo-capsule-skin\\[data-capsule-style=(['"])${profile}\\1\\]$`,
      )
      const skinRules = matchingRules(rules, selector)
      expect(skinRules, `${profile} must have one capsule skin authority`).toHaveLength(1)
      expectCompleteTokens(skinRules[0], requiredCapsuleTokens)
      authoredIds.add(profile)
    }

    expect([...authoredIds]).toEqual([...CAPSULE_STYLE_IDS])
  })

  it('does not revive retired palette facades or root-level capsule selectors', () => {
    const allAppearanceCss = `${themesSource}\n${capsulesSource}\n${globalsSource}`

    expect(
      linesMatching(
        allAppearanceCss,
        /--echo-brand-mark-(?:bg|color)\s*:|--echo-capsule-(?:bg|text|border|active-bg|active-text|shadow)\s*:|--capsule-preview-[\w-]+\s*:/,
      ),
    ).toEqual([])
    expect(
      linesMatching(allAppearanceCss, /:root(?:\.[\w-]+)?\[data-capsule-style=(?:'|")/),
    ).toEqual([])
  })
})
