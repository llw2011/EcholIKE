import { describe, expect, it } from 'vitest'
import {
  MARKDOWN_EDITOR_MIN_HEIGHT,
  MARKDOWN_EDITOR_MIN_WIDTH,
  responsiveMarkdownEditorWindowSize,
} from '../markdownWindowSize'

function monitor(width: number, height: number, scaleFactor = 1) {
  return {
    workArea: { size: { width, height } },
    scaleFactor,
  }
}

describe('responsive Markdown editor window size', () => {
  it.each([
    [1920, 1040, 1, 1120, 780],
    [1366, 728, 1, 1120, 680],
    [1024, 560, 1, 976, 512],
    [1366, 728, 1.25, 1045, 534],
  ])(
    'fits %sx%s at %sx without exceeding the preferred size',
    (width, height, scaleFactor, expectedWidth, expectedHeight) => {
      expect(responsiveMarkdownEditorWindowSize(monitor(width, height, scaleFactor))).toEqual({
        width: expectedWidth,
        height: expectedHeight,
        minWidth: Math.min(MARKDOWN_EDITOR_MIN_WIDTH, expectedWidth),
        minHeight: Math.min(MARKDOWN_EDITOR_MIN_HEIGHT, expectedHeight),
      })
    },
  )

  it('falls back to the preferred window when monitor discovery is unavailable', () => {
    expect(responsiveMarkdownEditorWindowSize(null)).toEqual({
      width: 1120,
      height: 780,
      minWidth: 720,
      minHeight: 520,
    })
  })
})
