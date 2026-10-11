// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/styles/globals.css', 'utf8')

describe('main window boundary surface', () => {
  it('draws one theme-aware inset boundary above every main-window surface', () => {
    const surfaceRule = styles.match(
      /html\[data-echo-window='main'\]\s+\.echo-shell,\s*html\[data-echo-window='main'\]\s+\.echo-boot-screen,\s*html\[data-echo-window='main'\]\s+\.echo-startup-update-screen,\s*html\[data-echo-window='main'\]\s+\.echo-renderer-error-screen\s*\{([^}]*)\}/s,
    )?.[1]
    const boundaryRule = styles.match(
      /html\[data-echo-window='main'\]\s+\.echo-shell::after,\s*html\[data-echo-window='main'\]\s+\.echo-boot-screen::after,\s*html\[data-echo-window='main'\]\s+\.echo-startup-update-screen::after,\s*html\[data-echo-window='main'\]\s+\.echo-renderer-error-screen::after\s*\{([^}]*)\}/s,
    )?.[1]

    expect(surfaceRule).toMatch(/position:\s*relative\s*;/)
    expect(surfaceRule).toMatch(
      /--echo-window-outline:\s*color-mix\(in srgb,\s*var\(--echo-text\)\s+24%,\s*transparent\)\s*;/,
    )
    expect(surfaceRule).not.toMatch(/\bborder\s*:/)
    expect(surfaceRule).not.toMatch(/box-shadow\s*:/)

    expect(boundaryRule).toMatch(/content:\s*['"]{2}\s*;/)
    expect(boundaryRule).toMatch(/position:\s*absolute\s*;/)
    expect(boundaryRule).toMatch(/inset:\s*0\s*;/)
    expect(boundaryRule).toMatch(/z-index:\s*20000\s*;/)
    expect(boundaryRule).toMatch(/pointer-events:\s*none\s*;/)
    expect(boundaryRule).toMatch(/border:\s*1px\s+solid\s+var\(--echo-window-outline\)\s*;/)
    expect(boundaryRule).toMatch(/border-radius:\s*inherit\s*;/)
    expect(boundaryRule).toMatch(/box-sizing:\s*border-box\s*;/)
  })
})
