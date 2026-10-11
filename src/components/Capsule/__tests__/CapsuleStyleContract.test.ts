// @ts-expect-error Vitest runs in Node; the browser bundle intentionally omits Node type packages.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { capsuleStyleOptions, getCapsuleSize, type CapsuleVisualState } from '../capsuleSkin'

const styles = readFileSync('src/styles/capsules.css', 'utf8')
const visualStates: CapsuleVisualState[] = [
  'idle',
  'recording',
  'transcribing',
  'polishing',
  'outputting',
  'error',
]

const runtimeIdentityTokens = [
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
  '--runtime-capsule-error-bg',
  '--runtime-capsule-error-text',
  '--runtime-capsule-error-border',
  '--runtime-capsule-error-accent',
] as const

function linearChannel(value: number) {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(rgb: readonly [number, number, number]) {
  return (
    linearChannel(rgb[0]) * 0.2126 + linearChannel(rgb[1]) * 0.7152 + linearChannel(rgb[2]) * 0.0722
  )
}

function contrast(foreground: readonly [number, number, number], background: readonly number[]) {
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background as [number, number, number])
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function cssToken(body: string | undefined, token: string) {
  return body?.match(new RegExp(`${token}:\\s*(?<value>[^;]+);`))?.groups?.value.trim()
}

describe('capsule style contract', () => {
  it('defines complete positive geometry for every style and visual state', () => {
    expect(capsuleStyleOptions).toHaveLength(8)

    for (const style of capsuleStyleOptions) {
      for (const state of visualStates) {
        const size = getCapsuleSize(style.id, state)
        expect(size.width, `${style.id}/${state} width`).toBeGreaterThan(0)
        expect(size.height, `${style.id}/${state} height`).toBeGreaterThan(0)
      }
    }
  })

  it('gives errors the full recording width without changing the flush height', () => {
    for (const style of capsuleStyleOptions) {
      expect(getCapsuleSize(style.id, 'error')).toEqual(getCapsuleSize(style.id, 'recording'))
    }

    expect(getCapsuleSize('compact', 'error')).toEqual({ width: 180, height: 32 })
  })

  it('keeps every skin material in the single capsule stylesheet', () => {
    for (const style of capsuleStyleOptions) {
      const body = styles.match(
        new RegExp(
          `\\.echo-capsule-skin\\[data-capsule-style='${style.id}'\\]\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`,
        ),
      )?.groups?.body

      expect(body, `${style.id} skin body`).toBeTruthy()
      for (const token of runtimeIdentityTokens) {
        expect(body, `${style.id} ${token}`).toContain(`${token}:`)
      }
    }

    expect(styles).toContain('.echo-capsule-skin--preview-card .is-animated')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).toContain('animation: none !important')
  })

  it('removes every capsule surface shadow while keeping the native window flush', () => {
    for (const style of capsuleStyleOptions) {
      const body = styles.match(
        new RegExp(
          `\\.echo-capsule-skin\\[data-capsule-style='${style.id}'\\]\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`,
        ),
      )?.groups?.body

      expect(body, `${style.id} skin body`).toBeTruthy()
      expect(body, `${style.id} shadow token`).not.toContain('--runtime-capsule-shadow')
      expect(body, `${style.id} shadow declaration`).not.toContain('box-shadow')
    }

    const surface = styles.match(/\.echo-capsule-surface\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body
    expect(surface).toContain('box-shadow: none;')
    expect(styles).not.toContain('drop-shadow(')
    expect(styles).toContain('overflow: hidden')
    expect(styles).toContain('contain: layout paint')
  })

  it('bounds all inline glyph variants inside the 10 by 10 error slot', () => {
    expect(styles).toMatch(
      /\.echo-capsule-glyph--inline\s*\{[^}]*width:\s*10px;[^}]*height:\s*10px;/s,
    )
    expect(styles).toContain('grid-template-columns: repeat(3, 2px)')
    expect(styles).toMatch(
      /\.echo-capsule-glyph--inline\.echo-capsule-glyph--command i\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;/s,
    )
    expect(styles).toMatch(
      /\.echo-capsule-glyph--inline\.echo-capsule-glyph--glass b\s*\{[^}]*width:\s*8px;[^}]*height:\s*5px;/s,
    )
    expect(styles).toMatch(
      /\.echo-capsule-glyph--inline\.echo-capsule-glyph--pulse b\s*\{[^}]*width:\s*10px;[^}]*height:\s*10px;/s,
    )
    expect(styles).toMatch(
      /\.echo-capsule-glyph--inline\.echo-capsule-glyph--orbit b\s*\{[^}]*width:\s*10px;[^}]*height:\s*6px;/s,
    )
  })

  it('keeps each error surface on the selected skin material instead of a shared danger fill', () => {
    const errorSurface = styles.match(/\.echo-capsule-surface--error\s*\{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.body
    const errorBackgrounds = new Set<string>()

    expect(errorSurface).toContain('border-color: var(--runtime-capsule-error-border);')
    expect(errorSurface).toContain('background: var(--runtime-capsule-error-bg);')
    expect(errorSurface).toContain('color: var(--runtime-capsule-error-text);')
    expect(styles).not.toContain('#6b1720')

    for (const style of capsuleStyleOptions) {
      const body = styles.match(
        new RegExp(
          `\\.echo-capsule-skin\\[data-capsule-style='${style.id}'\\]\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`,
        ),
      )?.groups?.body
      const errorBackground = cssToken(body, '--runtime-capsule-error-bg')

      expect(errorBackground, `${style.id} error background`).toBeTruthy()
      errorBackgrounds.add(errorBackground as string)
      expect(errorBackground, `${style.id} keeps active material`).toBe(
        cssToken(body, '--runtime-capsule-active-bg'),
      )
      expect(cssToken(body, '--runtime-capsule-error-text'), `${style.id} keeps active text`).toBe(
        cssToken(body, '--runtime-capsule-active-text'),
      )
      expect(
        cssToken(body, '--runtime-capsule-error-accent'),
        `${style.id} keeps skin accent`,
      ).toBe(cssToken(body, '--runtime-capsule-dot'))
      expect(
        cssToken(body, '--runtime-capsule-error-border'),
        `${style.id} error border`,
      ).toContain('var(--runtime-capsule-danger)')
    }

    expect(errorBackgrounds.size).toBe(capsuleStyleOptions.length)
    expect(styles).toMatch(
      /\.echo-capsule-content--error \.echo-capsule-glyph\s*\{[^}]*color:\s*var\(--runtime-capsule-error-accent\);/s,
    )

    const copy = styles.match(/\.echo-capsule-copy\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body
    expect(copy).toContain('min-width: 0;')
    expect(copy).toContain('overflow: hidden;')
    expect(copy).toContain('text-overflow: ellipsis;')
    expect(copy).toContain('white-space: nowrap;')
  })

  it('keeps Glass readable on a black desktop and bounded on a light desktop', () => {
    const glass = styles.match(
      /\.echo-capsule-skin\[data-capsule-style='glass'\]\s*\{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body
    expect(glass).toBeTruthy()

    const fill = glass?.match(
      /--runtime-capsule-bg:\s*rgba\(244,\s*250,\s*255,\s*(?<alpha>[\d.]+)\)/,
    )
    const alpha = Number(fill?.groups?.alpha)
    const compositedOnBlack = [244, 250, 255].map((channel) => Math.round(channel * alpha))

    expect(alpha).toBeGreaterThanOrEqual(0.66)
    expect(contrast([8, 51, 75], compositedOnBlack)).toBeGreaterThanOrEqual(4.5)
    expect(glass).not.toContain('--runtime-capsule-shadow')
    expect(glass).toContain('--runtime-capsule-blur: blur(16px) saturate(150%)')
  })

  it('keeps Pulse and Orbit recording identities materially distinct', () => {
    const pulse = styles.match(
      /\.echo-capsule-skin\[data-capsule-style='pulse'\]\s*\{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body
    const orbit = styles.match(
      /\.echo-capsule-skin\[data-capsule-style='orbit'\]\s*\{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body

    expect(pulse).toContain('--runtime-capsule-indicator-animation: echo-capsule-indicator-pulse')
    expect(orbit).toContain('--runtime-capsule-indicator-animation: echo-capsule-indicator-orbit')
    expect(pulse).toContain('--runtime-capsule-wave-gap: 3px')
    expect(orbit).toContain('--runtime-capsule-wave-gap: 4px')
    expect(styles).toContain("[data-capsule-style='orbit'] .echo-capsule-status-dot::after")
  })
})
