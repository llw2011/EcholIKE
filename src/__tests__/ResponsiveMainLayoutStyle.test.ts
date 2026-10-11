// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/styles/globals.css', 'utf8')
const workbenchSource = readFileSync('src/components/HomePage/Workbench.tsx', 'utf8')
const audioLevelMeterSource = readFileSync('src/components/shared/AudioLevelMeter.tsx', 'utf8')

describe('responsive main layout contract', () => {
  it('uses full and compact sidebar modes without the cramped intermediate width', () => {
    expect(styles).not.toContain('--echo-sidebar-width: 214px')
    expect(styles).toContain('@media (max-width: 980px)')
    expect(styles).toMatch(
      /\.echo-brand-copy[^}]*\.echo-nav-copy[^}]*\{[^}]*white-space:\s*nowrap;/s,
    )
  })

  it('stacks the AI toolbar from its own panel width instead of the whole window width', () => {
    const workspaceRule = styles.match(/\.echo-ai-workspace\s*\{([^}]*)\}/)?.[1]

    expect(workspaceRule).toMatch(/container-name:\s*echo-ai-workspace\s*;/)
    expect(workspaceRule).toMatch(/container-type:\s*inline-size\s*;/)
    expect(styles).toContain('@container echo-ai-workspace (max-width: 760px)')
  })

  it('keeps the config source control compact until the smallest supported window', () => {
    expect(styles).toMatch(
      /html\[data-echo-window='main'\]\s+\.echo-setting-line--compact-control\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+max-content;/s,
    )
    expect(styles).toMatch(
      /\.echo-setting-line--compact-control\s+\.echo-line-control\s*\{[^}]*justify-self:\s*end;[^}]*width:\s*max-content;/s,
    )
    expect(styles).toMatch(
      /@container \(max-width:\s*560px\)[\s\S]*\.echo-setting-line--compact-control\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\);/s,
    )
  })

  it('keeps the settings tabs inside the page gutter without horizontal page overflow', () => {
    expect(styles).toMatch(/\.echo-settings-nav\s*\{[^}]*box-sizing:\s*border-box\s*;/s)
    expect(styles).toMatch(
      /\.echo-settings-nav\s*\{[^}]*width:\s*100%\s*;[^}]*overflow-x:\s*auto\s*;/s,
    )
    expect(styles).toMatch(
      /\.echo-page\s*\{[^}]*width:\s*min\(1240px,\s*calc\(100%\s*-\s*\(var\(--echo-page-gutter\)\s*\*\s*2\)\)\)\s*;[^}]*padding:\s*var\(--echo-page-pad-y\)/s,
    )
    expect(styles).toMatch(/\.echo-page\s*\{[^}]*margin:\s*0\s+auto\s*;/s)
  })

  it('keeps all 24 realtime meter segments in one row on the smallest main layout', () => {
    const meterRules = [...styles.matchAll(/\.echo-meter\s*\{([^}]*)\}/g)].map((match) => match[1])
    const mobileMeterRules = [
      ...styles.matchAll(
        /@media \(max-width:\s*640px\)\s*\{(?:(?!@media)[\s\S])*?\.echo-meter\s*\{([^}]*)\}/g,
      ),
    ].map((match) => match[1])

    expect(meterRules[0]).toMatch(/grid-template-columns:\s*repeat\(24,\s*minmax\(0,\s*1fr\)\)/)
    expect(workbenchSource).toMatch(
      /<AudioLevelMeter[\s\S]*?className="echo-meter"[\s\S]*?segmentCount=\{24\}/,
    )
    expect(audioLevelMeterSource).toMatch(/Array\.from\(\{\s*length:\s*count\s*\}/)
    expect(styles).not.toMatch(/\.echo-meter\s*\{[^}]*repeat\((?!24\b)\d+/s)
    expect(mobileMeterRules).toHaveLength(1)
    expect(mobileMeterRules[0]).toMatch(/gap:\s*3px\s*;/)
    expect(mobileMeterRules[0]).not.toContain('grid-template-columns')
  })

  it('positions every toast viewport away from titlebar controls and below them on small windows', () => {
    expect(styles).toMatch(
      /html\[data-echo-window='main'\]\s+\.echo-toast-viewport\s*\{[^}]*right:\s*calc\(var\(--echo-titlebar-pad-x\)\s*\+\s*88px\);/s,
    )
    expect(styles).toMatch(
      /@media \(max-width:\s*980px\)[\s\S]*html\[data-echo-window='main'\]\s+\.echo-toast-viewport\s*\{[^}]*top:\s*calc\(var\(--echo-titlebar-height\)\s*\+\s*10px\);/s,
    )
    expect(styles).toMatch(
      /html\[data-echo-window='markdown-editor'\]\s+\.echo-toast-viewport\s*\{[^}]*top:\s*70px;/s,
    )
    expect(styles).toMatch(
      /\.echo-toast-viewport\s+\.echo-toast\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/s,
    )
  })
})
