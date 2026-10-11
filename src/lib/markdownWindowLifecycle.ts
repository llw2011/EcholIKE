const MARKDOWN_EDITOR_WINDOW_GENERATION_PARAM = 'markdownWindowGeneration'
const FALLBACK_SURFACE = '#ffffff'

export type MarkdownEditorWindowBackgroundColor = [number, number, number, 0]

export function currentMarkdownEditorWindowBackgroundColor(
  root: Element = document.documentElement,
): MarkdownEditorWindowBackgroundColor {
  const value = window.getComputedStyle(root).getPropertyValue('--echo-surface').trim()
  return transparentSurfaceColor(value) ?? transparentSurfaceColor(FALLBACK_SURFACE)!
}

export function markdownEditorWindowGeneration(search = window.location.search) {
  const raw = new URLSearchParams(search).get(MARKDOWN_EDITOR_WINDOW_GENERATION_PARAM)
  if (!raw || !/^\d+$/.test(raw)) return null

  const generation = Number(raw)
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null
}

function transparentSurfaceColor(value: string): MarkdownEditorWindowBackgroundColor | null {
  const match = /^#([\da-f]{6})$/i.exec(value)
  if (!match) return null

  const rgb = Number.parseInt(match[1], 16)
  return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, 0]
}
