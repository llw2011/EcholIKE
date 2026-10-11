export const MARKDOWN_EDITOR_PREFERRED_WIDTH = 1120
export const MARKDOWN_EDITOR_PREFERRED_HEIGHT = 780
export const MARKDOWN_EDITOR_MIN_WIDTH = 720
export const MARKDOWN_EDITOR_MIN_HEIGHT = 520

const WINDOW_WORK_AREA_GUTTER = 48
const WINDOW_HARD_MIN_WIDTH = 520
const WINDOW_HARD_MIN_HEIGHT = 340

interface MonitorWorkArea {
  workArea: {
    size: {
      width: number
      height: number
    }
  }
  scaleFactor: number
}

export interface ResponsiveMarkdownEditorWindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export function responsiveMarkdownEditorWindowSize(
  monitor: MonitorWorkArea | null,
): ResponsiveMarkdownEditorWindowSize {
  if (!monitor) {
    return {
      width: MARKDOWN_EDITOR_PREFERRED_WIDTH,
      height: MARKDOWN_EDITOR_PREFERRED_HEIGHT,
      minWidth: MARKDOWN_EDITOR_MIN_WIDTH,
      minHeight: MARKDOWN_EDITOR_MIN_HEIGHT,
    }
  }

  const scaleFactor =
    Number.isFinite(monitor.scaleFactor) && monitor.scaleFactor > 0 ? monitor.scaleFactor : 1
  const fitDimension = (physical: number, preferred: number, hardMinimum: number) => {
    const logical = Number.isFinite(physical) && physical > 0 ? physical / scaleFactor : hardMinimum
    return Math.round(Math.min(preferred, Math.max(hardMinimum, logical - WINDOW_WORK_AREA_GUTTER)))
  }
  const width = fitDimension(
    monitor.workArea.size.width,
    MARKDOWN_EDITOR_PREFERRED_WIDTH,
    WINDOW_HARD_MIN_WIDTH,
  )
  const height = fitDimension(
    monitor.workArea.size.height,
    MARKDOWN_EDITOR_PREFERRED_HEIGHT,
    WINDOW_HARD_MIN_HEIGHT,
  )

  return {
    width,
    height,
    minWidth: Math.min(MARKDOWN_EDITOR_MIN_WIDTH, width),
    minHeight: Math.min(MARKDOWN_EDITOR_MIN_HEIGHT, height),
  }
}
