// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/styles/globals.css', 'utf8')

describe('standalone Markdown editor window style', () => {
  it('fills the native viewport instead of exposing a transparent outer frame', () => {
    expect(typeof styles).toBe('string')
    expect(styles).toContain('.echo-markdown-editor-window')

    const windowRule = styles.match(/\.echo-markdown-editor-window\s*\{([^}]*)\}/)?.[1]

    expect(windowRule).toBeDefined()
    expect(windowRule).toMatch(/padding:\s*0(?:px)?\s*;/)

    const standaloneShellRule = styles.match(
      /html\[data-echo-window='markdown-editor'\]\s+\.echo-markdown-editor-shell\s*\{([^}]*)\}/,
    )?.[1]
    expect(standaloneShellRule).toMatch(/box-sizing:\s*border-box\s*;/)
    expect(standaloneShellRule).toMatch(/width:\s*100%\s*;/)
    expect(standaloneShellRule).toMatch(/height:\s*100%\s*;/)
    expect(standaloneShellRule).not.toMatch(/border-radius:\s*0/)
  })

  it('gives renderer failures a full-viewport opaque surface before native reveal', () => {
    const errorRule = styles.match(
      /html\[data-echo-window='markdown-editor'\]\s+\.echo-renderer-error-screen\s*\{([^}]*)\}/,
    )?.[1]

    expect(errorRule).toBeDefined()
    expect(errorRule).toMatch(/width:\s*100%\s*;/)
    expect(errorRule).toMatch(/height:\s*100%\s*;/)
    expect(errorRule).toMatch(/background:\s*var\(--echo-surface,\s*#ffffff\)\s*;/)
  })

  it('uses component-width and short-height contracts without stacking every footer action', () => {
    const shellRule = styles.match(/\.echo-markdown-editor-shell\s*\{([^}]*)\}/)?.[1]

    expect(shellRule).toMatch(/container-name:\s*echo-markdown-editor\s*;/)
    expect(shellRule).toMatch(/container-type:\s*inline-size\s*;/)
    expect(styles).toContain('@container echo-markdown-editor (max-width: 760px)')
    expect(styles).toContain('@container echo-markdown-editor (max-width: 520px)')
    expect(styles).toMatch(
      /\.echo-markdown-editor-actions\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(120px,\s*1fr\)\);/s,
    )
    expect(styles).not.toMatch(
      /\.echo-markdown-editor-actions,\s*\.echo-markdown-editor-actions\s+\.echo-button\s*\{[^}]*width:\s*100%/s,
    )
    expect(styles).toContain('@media (max-height: 600px)')
  })

  it('keeps the split scroll-sync control compact and responsive', () => {
    const toggleRule = styles.match(/\.echo-markdown-scroll-sync-toggle\s*\{([^}]*)\}/)?.[1]
    expect(toggleRule).toMatch(/flex:\s*0 0 auto\s*;/)
    expect(toggleRule).toMatch(/white-space:\s*nowrap\s*;/)
    expect(styles).toMatch(
      /@container echo-markdown-editor \(max-width: 520px\)[\s\S]*?\.echo-markdown-scroll-sync-toggle\s*\{[^}]*width:\s*100%\s*;/,
    )
  })

  it('keeps the preview bottom padding inside its scroll viewport in every view mode', () => {
    const previewRule = styles.match(
      /\.echo-markdown-editor-pane\s*>\s*\.echo-markdown-view\s*\{([^}]*)\}/,
    )?.[1]

    expect(previewRule).toBeDefined()
    expect(previewRule).toMatch(/box-sizing:\s*border-box\s*;/)
    expect(previewRule).toMatch(/height:\s*100%\s*;/)
    expect(previewRule).toMatch(/scroll-padding-block:\s*16px\s*;/)

    const sharedPreviewRule = styles.match(/^\.echo-markdown-view\s*\{([^}]*)\}/m)?.[1]
    expect(sharedPreviewRule).toMatch(/overflow:\s*auto\s*;/)
    expect(sharedPreviewRule).toMatch(/padding:\s*16px\s*;/)
  })

  it('gives the editor window close control the shared hover, press, and focus feedback', () => {
    const closeHoverRule = styles.match(
      /\.echo-icon-button--window-close:hover:not\(:disabled\)\s*\{([^}]*)\}/,
    )?.[1]
    expect(closeHoverRule).toMatch(/border-color:\s*#dc2626\s*;/)
    expect(closeHoverRule).toMatch(/background:\s*#dc2626\s*;/)
    expect(closeHoverRule).toMatch(/color:\s*#ffffff\s*;/)

    const pressedRule = styles.match(
      /\.echo-icon-button:active:not\(:disabled\)\s*\{([^}]*)\}/,
    )?.[1]
    expect(pressedRule).toMatch(/transform:\s*translateY\(1px\)\s+scale\(0\.97\)\s*;/)

    const focusRule = styles.match(/\.echo-icon-button:focus-visible\s*\{([^}]*)\}/)?.[1]
    expect(focusRule).toMatch(/outline:/)
    expect(focusRule).toMatch(/outline-offset:/)
  })
})
