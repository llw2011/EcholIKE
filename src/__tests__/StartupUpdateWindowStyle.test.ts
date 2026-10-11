// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/styles/globals.css', 'utf8')
const startupWindowHook = readFileSync('src/hooks/useStartupUpdateWindow.ts', 'utf8')

describe('startup update window surface', () => {
  it('paints one full viewport surface without a second framed card', () => {
    const screenRule = styles.match(/\.echo-startup-update-screen\s*\{([^}]*)\}/)?.[1]
    const contentRule = styles.match(/\.echo-startup-update-dialog\s*\{([^}]*)\}/)?.[1]
    const notesRule = styles.match(/\.echo-startup-update-notes\s*\{([^}]*)\}/)?.[1]
    const actionsRule = styles.match(/\.echo-startup-update-actions\s*\{([^}]*)\}/)?.[1]

    expect(screenRule).toMatch(/width:\s*100%\s*;/)
    expect(screenRule).toMatch(/height:\s*100%\s*;/)
    expect(screenRule).toMatch(/padding:\s*0\s*;/)
    expect(screenRule).toMatch(/background:\s*var\(--echo-surface\)\s*;/)

    expect(contentRule).toMatch(/width:\s*100%\s*;/)
    expect(contentRule).toMatch(/height:\s*100%\s*;/)
    expect(contentRule).not.toMatch(/\bborder\s*:/)
    expect(contentRule).not.toMatch(/border-radius\s*:/)
    expect(contentRule).not.toMatch(/\bbackground\s*:/)
    expect(contentRule).not.toMatch(/box-shadow\s*:/)
    expect(notesRule).toMatch(/flex:\s*1\s+1\s+auto\s*;/)
    expect(notesRule).toMatch(/overflow:\s*auto\s*;/)
    expect(actionsRule).toMatch(/margin-top:\s*auto\s*;/)
    expect(styles).not.toContain('.echo-startup-update-screen--card-fit')
  })

  it('uses mode-owned compact frames instead of measuring DOM content', () => {
    expect(startupWindowHook).not.toContain('getBoundingClientRect')
    expect(startupWindowHook).not.toContain(
      "querySelector<HTMLElement>('.echo-startup-update-dialog')",
    )
    expect(startupWindowHook).not.toContain('PROMPT_WINDOW_MAX_HEIGHT')
    expect(startupWindowHook).toContain('new LogicalSize(PROMPT_WINDOW_WIDTH, height)')
  })
})
