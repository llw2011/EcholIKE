// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = [
  readFileSync('src/styles/globals.css', 'utf8'),
  readFileSync('src/styles/themes.css', 'utf8'),
  readFileSync('src/styles/capsules.css', 'utf8'),
].join('\n')
const mainLayout = readFileSync('src/components/MainLayout/index.tsx', 'utf8')
const accessibilityBanner = readFileSync(
  'src/components/MainLayout/AccessibilityBanner.tsx',
  'utf8',
)
const startupUpdatePrompt = readFileSync('src/components/StartupUpdatePrompt.tsx', 'utf8')
const errorBoundary = readFileSync('src/components/ErrorBoundary.tsx', 'utf8')
const capsuleContextMenu = readFileSync('src/components/Capsule/CapsuleContextMenu.tsx', 'utf8')
const toast = readFileSync('src/components/Toast.tsx', 'utf8')
const packageJson = readFileSync('package.json', 'utf8')
const viteConfig = readFileSync('vite.config.ts', 'utf8')

describe('shared button interaction contract', () => {
  it('routes titlebar, OTA, accessibility, and renderer-error actions through shared controls', () => {
    expect(mainLayout).toContain('className="echo-icon-button echo-icon-button--titlebar"')
    expect(mainLayout).toContain(
      'className="echo-icon-button echo-icon-button--titlebar echo-icon-button--window-close"',
    )
    expect(mainLayout).not.toContain('className="echo-window-help"')
    expect(mainLayout).not.toContain('className="echo-window-close"')

    expect(startupUpdatePrompt).toContain('className="echo-button echo-button--primary"')
    expect(startupUpdatePrompt).toContain('className="echo-button"')
    expect(startupUpdatePrompt).not.toContain('echo-startup-update-primary')
    expect(startupUpdatePrompt).not.toContain('echo-startup-update-secondary')

    expect(accessibilityBanner).toContain("import { ShieldAlert, X } from 'lucide-react'")
    expect(accessibilityBanner).toContain(
      'className="echo-button echo-button--primary echo-accessibility-grant"',
    )
    expect(accessibilityBanner).toContain('className="echo-icon-button echo-icon-button--compact"')
    expect(accessibilityBanner).not.toContain('echo-icon-button--window-close')
    expect(accessibilityBanner).toContain('<X size={14} />')
    expect(errorBoundary).toContain('className="echo-button"')
  })

  it('uses semantic component styles without a utility CSS compiler or retired UI skins', () => {
    expect(accessibilityBanner).toContain('className="echo-accessibility-banner"')
    expect(errorBoundary).toContain('className="echo-renderer-error-screen"')
    expect(capsuleContextMenu).toContain('className="echo-capsule-menu"')
    expect(toast).toContain('className="echo-toast"')

    expect(packageJson).not.toContain('tailwindcss')
    expect(viteConfig).not.toContain('tailwindcss')
    expect(styles).not.toContain("@import 'tailwindcss'")
    expect(styles).toMatch(/\.echo-capsule-menu\s*\{[^}]*background:\s*var\(--echo-surface\);/s)
    expect(styles).toMatch(/\.echo-toast\s*\{[^}]*pointer-events:\s*auto;/s)

    expect(styles).not.toContain('.jelly-')
    expect(styles).not.toContain('@keyframes shimmer-sweep')
    expect(styles).not.toContain('@keyframes jelly-wobble')
    expect(styles).not.toContain('@keyframes jelly-breathe')
    expect(styles).not.toContain('.echo-capsule-style-preview')
    expect(styles).not.toContain('.echo-capsule-current-stage')
    expect(styles).not.toContain('.echo-capsule-current-pill')
    expect(styles).not.toContain('.echo-capsule-preview-glyph')
  })

  it('keeps one interaction authority with layout-only icon modifiers', () => {
    const buttonActiveRule = styles.match(
      /\.echo-button:active:not\(:disabled\)\s*\{([^}]*)\}/,
    )?.[1]
    const titlebarModifier = styles.match(/\.echo-icon-button--titlebar\s*\{([^}]*)\}/)?.[1]
    const compactModifier = styles.match(/\.echo-icon-button--compact\s*\{([^}]*)\}/)?.[1]
    const installingRule = styles.match(
      /\.echo-startup-update-actions \.echo-button:disabled\s*\{([^}]*)\}/,
    )?.[1]

    expect(buttonActiveRule).toMatch(/transform:\s*translateY\(1px\)\s*;/)
    expect(titlebarModifier).toMatch(/width:\s*34px\s*;/)
    expect(titlebarModifier).toMatch(/height:\s*32px\s*;/)
    expect(compactModifier).toMatch(/width:\s*28px\s*;/)
    expect(compactModifier).toMatch(/height:\s*28px\s*;/)
    expect(installingRule).toMatch(/cursor:\s*wait\s*;/)
    expect(styles).toMatch(
      /\.echo-nav-item:focus-visible[\s\S]*outline:\s*2px solid color-mix\(in srgb, var\(--echo-accent\) 68%, transparent\);/,
    )

    expect(styles).not.toContain('.echo-window-controls button')
    expect(styles).not.toContain('.echo-window-help')
    expect(styles).not.toContain('.echo-window-close')
    expect(styles).not.toContain('.echo-startup-update-primary')
    expect(styles).not.toContain('.echo-startup-update-secondary')

    const dangerRules = styles.match(/\.echo-button--danger\s*\{/g) ?? []
    expect(dangerRules).toHaveLength(1)
    expect(styles).not.toContain('.echo-markdown-editor-actions .echo-button--danger')
    expect(styles).not.toContain('.echo-markdown-clear-dialog .echo-button--danger')
  })

  it('gives compact editor and capsule controls the same press, focus, and motion boundaries', () => {
    const markdownButtonRule = styles.match(/\.echo-markdown-tool-button\s*\{([^}]*)\}/)?.[1]
    const markdownActiveRule = styles.match(
      /\.echo-markdown-tool-button:active:not\(:disabled\)\s*\{([^}]*)\}/,
    )?.[1]
    const capsuleMenuRule = styles.match(/\.echo-capsule-menu-item\s*\{([^}]*)\}/)?.[1]
    const capsuleMenuActiveRule = styles.match(/\.echo-capsule-menu-item:active\s*\{([^}]*)\}/)?.[1]
    const capsuleCancelRule = styles.match(/\.echo-capsule-cancel\s*\{([^}]*)\}/)?.[1]

    expect(markdownButtonRule).toMatch(/transition:/)
    expect(markdownActiveRule).toMatch(/transform:\s*translateY\(1px\)\s+scale\(0\.97\)\s*;/)
    expect(capsuleMenuRule).toMatch(/min-height:\s*32px\s*;/)
    expect(capsuleMenuRule).toMatch(/transition:/)
    expect(capsuleMenuActiveRule).toMatch(/transform:\s*translateY\(1px\)\s*;/)
    expect(capsuleCancelRule).toMatch(/width:\s*26px\s*;/)
    expect(capsuleCancelRule).toMatch(/height:\s*26px\s*;/)
    expect(styles).toMatch(
      /button\.echo-capsule-cancel:active\s*\{[^}]*transform:\s*translateY\(1px\)\s+scale\(0\.96\)\s*;/,
    )

    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.echo-button:active:not\(:disabled\)[\s\S]*\.echo-icon-button:active:not\(:disabled\)[\s\S]*transform:\s*none\s*!important\s*;/,
    )
  })

  it('keeps special navigation, picker, switch, and onboarding controls visibly interactive', () => {
    const navigationPressRule = styles.match(
      /\.echo-nav-item:active:not\(:disabled\),\s*\.echo-settings-nav button:active:not\(:disabled\),\s*\.echo-segmented-lite button:active:not\(:disabled\)\s*\{([^}]*)\}/,
    )?.[1]
    const switchHoverRule = styles.match(
      /\.echo-switch-lite:hover:not\(:disabled\)\s*\{([^}]*)\}/,
    )?.[1]
    const switchPressRule = styles.match(
      /\.echo-switch-lite:active:not\(:disabled\)\s*\{([^}]*)\}/,
    )?.[1]
    const pickerPressRule = styles.match(
      /\.echo-appearance-card:active:not\(:disabled\)\s*\{([^}]*)\}/,
    )?.[1]
    const onboardingFocusRule = styles.match(
      /\.echo-onboarding-mode-card:focus-visible\s*\{([^}]*)\}/,
    )?.[1]
    const onboardingPressRule = [
      ...styles.matchAll(/\.echo-onboarding-mode-card:active:not\(:disabled\)\s*\{([^}]*)\}/g),
    ].find((rule) => rule[1].includes('translateY'))?.[1]

    expect(navigationPressRule).toMatch(/transform:\s*translateY\(1px\)\s*;/)
    expect(switchHoverRule).toMatch(/border-color:\s*var\(--echo-hover-border\)\s*;/)
    expect(switchHoverRule).toMatch(/box-shadow:/)
    expect(switchPressRule).toMatch(/transform:\s*translateY\(1px\)\s+scale\(0\.98\)\s*;/)
    expect(pickerPressRule).toMatch(/box-shadow:/)

    expect(styles).toMatch(/\.echo-onboarding-mode-card:hover:not\(:disabled\)\s*\{/)
    expect(styles).not.toMatch(
      /\.echo-onboarding-mode-card:hover\s*,\s*\.echo-onboarding-mode-card:focus-visible/,
    )
    expect(onboardingFocusRule).toMatch(
      /outline:\s*2px solid color-mix\(in srgb, var\(--echo-accent\) 68%, transparent\)\s*;/,
    )
    expect(onboardingFocusRule).toMatch(/outline-offset:\s*2px\s*;/)
    expect(onboardingPressRule).toMatch(/transform:\s*translateY\(1px\)\s*;/)

    expect(styles).toMatch(
      /\.echo-nav-item:active:not\(:disabled\),\s*\.echo-settings-nav button:active:not\(:disabled\),\s*\.echo-segmented-lite button:active:not\(:disabled\),\s*\.echo-switch-lite:active:not\(:disabled\),\s*\.echo-onboarding-mode-card:active:not\(:disabled\)\s*\{\s*transform:\s*none\s*!important\s*;/,
    )
  })
})
