export interface MarkdownScrollPoint {
  sourceLine: number
  scrollTop: number
}

export type MarkdownScrollSide = 'editor' | 'preview'

export interface MarkdownScrollPort {
  readSourceLine(): number | null
  writeSourceLine(sourceLine: number): void
}

export interface MarkdownScrollSurface extends MarkdownScrollPort {
  element: HTMLElement
}

interface CodeMirrorScrollView {
  readonly scrollDOM: HTMLElement
  readonly documentTop: number
  readonly scaleY: number
  readonly state: {
    readonly doc: {
      readonly lines: number
      line(number: number): { from: number }
      lineAt(position: number): { number: number }
    }
  }
  lineBlockAtHeight(height: number): { from: number; top: number; height: number }
  lineBlockAt(position: number): { top: number; height: number }
}

export interface MarkdownAnimationFrameScheduler {
  request(callback: FrameRequestCallback): number
  cancel(id: number): void
}

export interface MarkdownScrollCoordinator {
  onScroll(side: MarkdownScrollSide): 'inactive' | 'scheduled' | 'suppressed'
  onUserIntent(side: MarkdownScrollSide): void
  setActive(active: boolean): void
  owner(): MarkdownScrollSide | null
  destroy(): void
}

export function createMarkdownEditorInputScrollSurface(
  view: CodeMirrorScrollView,
): MarkdownScrollSurface {
  const element = view.scrollDOM

  return {
    element,
    readSourceLine() {
      const lineCount = Math.max(1, view.state.doc.lines)
      const maxScrollTop = scrollMaximum(element)
      if (maxScrollTop <= 0 || element.scrollTop <= 0.5) return 1
      if (element.scrollTop >= maxScrollTop - 0.5) return lineCount

      const visibleDocumentTop = codeMirrorVisibleDocumentTop(view)
      const block = view.lineBlockAtHeight(visibleDocumentTop)
      const lineNumber = Math.min(lineCount, view.state.doc.lineAt(block.from).number)
      if (lineNumber >= lineCount || block.height <= 0) return lineNumber
      const progress = clamp((visibleDocumentTop - block.top) / block.height, 0, 1)
      return lineNumber + progress
    },
    writeSourceLine(sourceLine) {
      const lineCount = Math.max(1, view.state.doc.lines)
      const maxScrollTop = scrollMaximum(element)
      const targetLine = clamp(sourceLine, 1, lineCount)
      if (maxScrollTop <= 0 || targetLine <= 1) {
        element.scrollTop = 0
        return
      }
      if (targetLine >= lineCount) {
        element.scrollTop = maxScrollTop
        return
      }

      const lineNumber = Math.floor(targetLine)
      const lineProgress = targetLine - lineNumber
      const lineBlock = view.lineBlockAt(view.state.doc.line(lineNumber).from)
      const targetDocumentTop = lineBlock.top + lineBlock.height * lineProgress
      const nextScrollTop =
        element.scrollTop + targetDocumentTop - codeMirrorVisibleDocumentTop(view)
      element.scrollTop = clamp(nextScrollTop, 0, maxScrollTop)
    },
  }
}

export function createMarkdownEditorPreviewScrollSurface(
  element: HTMLElement,
  sourceLineCount: () => number,
): MarkdownScrollSurface {
  return {
    element,
    readSourceLine() {
      const maximum = scrollMaximum(element)
      if (maximum <= 0) return 1
      return scrollTopToSourceLine(
        previewScrollPoints(element, sourceLineCount()),
        element.scrollTop,
      )
    },
    writeSourceLine(sourceLine) {
      const maximum = scrollMaximum(element)
      if (maximum <= 0) {
        element.scrollTop = 0
        return
      }
      const scrollTop = sourceLineToScrollTop(
        previewScrollPoints(element, sourceLineCount()),
        sourceLine,
      )
      if (scrollTop !== null) element.scrollTop = clamp(scrollTop, 0, maximum)
    },
  }
}

export function sourceLineToScrollTop(
  points: readonly MarkdownScrollPoint[],
  sourceLine: number,
): number | null {
  return interpolate(points, sourceLine, 'sourceLine', 'scrollTop')
}

export function scrollTopToSourceLine(
  points: readonly MarkdownScrollPoint[],
  scrollTop: number,
): number | null {
  return interpolate(points, scrollTop, 'scrollTop', 'sourceLine')
}

export function createMarkdownScrollCoordinator(options: {
  ports: Record<MarkdownScrollSide, MarkdownScrollPort>
  scheduler?: MarkdownAnimationFrameScheduler
  active?: boolean
  epsilon?: number
}): MarkdownScrollCoordinator {
  const scheduler = options.scheduler ?? browserAnimationFrameScheduler
  const epsilon = Math.max(0, options.epsilon ?? 0.01)
  const suppressed: Record<MarkdownScrollSide, boolean> = { editor: false, preview: false }
  const releaseFrames: Record<MarkdownScrollSide, { first: number | null; second: number | null }> =
    {
      editor: { first: null, second: null },
      preview: { first: null, second: null },
    }
  let active = options.active ?? true
  let destroyed = false
  let currentOwner: MarkdownScrollSide | null = null
  let pendingSource: MarkdownScrollSide | null = null
  let syncFrame: number | null = null

  function clearSuppression(side: MarkdownScrollSide) {
    suppressed[side] = false
    const release = releaseFrames[side]
    if (release.first !== null) scheduler.cancel(release.first)
    if (release.second !== null) scheduler.cancel(release.second)
    release.first = null
    release.second = null
  }

  function armSuppression(side: MarkdownScrollSide) {
    clearSuppression(side)
    suppressed[side] = true
    releaseFrames[side].first = scheduler.request(() => {
      releaseFrames[side].first = null
      releaseFrames[side].second = scheduler.request(() => clearSuppression(side))
    })
  }

  function cancelSyncFrame() {
    if (syncFrame !== null) scheduler.cancel(syncFrame)
    syncFrame = null
    pendingSource = null
  }

  function reset() {
    cancelSyncFrame()
    clearSuppression('editor')
    clearSuppression('preview')
    currentOwner = null
  }

  function synchronize() {
    syncFrame = null
    const source = pendingSource
    pendingSource = null
    if (!active || destroyed || !source || currentOwner !== source) return

    const target: MarkdownScrollSide = source === 'editor' ? 'preview' : 'editor'
    const sourceLine = options.ports[source].readSourceLine()
    if (sourceLine === null || !Number.isFinite(sourceLine)) return
    const currentTargetLine = options.ports[target].readSourceLine()
    if (
      currentTargetLine !== null &&
      Number.isFinite(currentTargetLine) &&
      Math.abs(currentTargetLine - sourceLine) <= epsilon
    ) {
      return
    }

    armSuppression(target)
    try {
      options.ports[target].writeSourceLine(sourceLine)
    } catch {
      clearSuppression(target)
    }
  }

  return {
    onScroll(side) {
      if (!active || destroyed) return 'inactive'
      if (suppressed[side]) {
        clearSuppression(side)
        return 'suppressed'
      }
      currentOwner = side
      pendingSource = side
      if (syncFrame === null) syncFrame = scheduler.request(synchronize)
      return 'scheduled'
    },

    onUserIntent(side) {
      if (!active || destroyed) return
      clearSuppression(side)
      if (currentOwner !== side) cancelSyncFrame()
      currentOwner = side
    },

    setActive(nextActive) {
      if (destroyed || active === nextActive) return
      active = nextActive
      if (!active) reset()
    },

    owner() {
      return currentOwner
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      active = false
      reset()
    },
  }
}

const browserAnimationFrameScheduler: MarkdownAnimationFrameScheduler = {
  request(callback) {
    return window.requestAnimationFrame(callback)
  },
  cancel(id) {
    window.cancelAnimationFrame(id)
  },
}

function codeMirrorVisibleDocumentTop(view: CodeMirrorScrollView) {
  const scaleY = Number.isFinite(view.scaleY) && view.scaleY > 0 ? view.scaleY : 1
  return Math.max(0, (view.scrollDOM.getBoundingClientRect().top - view.documentTop) / scaleY)
}

function previewScrollPoints(element: HTMLElement, sourceLineCount: number): MarkdownScrollPoint[] {
  const lineCount = Math.max(1, sourceLineCount)
  const maximum = scrollMaximum(element)
  const containerRect = element.getBoundingClientRect()
  const points: MarkdownScrollPoint[] = [{ sourceLine: 1, scrollTop: 0 }]

  for (const child of Array.from(element.children)) {
    const startLine = Number.parseInt(child.getAttribute('data-markdown-source-start') ?? '', 10)
    const endLine = Number.parseInt(child.getAttribute('data-markdown-source-end') ?? '', 10)
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue
    const rect = child.getBoundingClientRect()
    if (startLine > 1 && startLine < lineCount) {
      points.push({
        sourceLine: startLine,
        scrollTop: clamp(element.scrollTop + rect.top - containerRect.top, 0, maximum),
      })
    }
    if (endLine > startLine && endLine < lineCount) {
      points.push({
        sourceLine: endLine,
        scrollTop: clamp(element.scrollTop + rect.bottom - containerRect.top, 0, maximum),
      })
    }
  }

  if (lineCount > 1) points.push({ sourceLine: lineCount, scrollTop: maximum })
  return points
}

function scrollMaximum(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function interpolate(
  points: readonly MarkdownScrollPoint[],
  input: number,
  inputKey: keyof MarkdownScrollPoint,
  outputKey: keyof MarkdownScrollPoint,
): number | null {
  if (!Number.isFinite(input)) return null
  const normalized = normalizePoints(points, inputKey)
  if (!normalized.length) return null
  if (normalized.length === 1 || input <= normalized[0][inputKey]) {
    return normalized[0][outputKey]
  }
  const last = normalized[normalized.length - 1]
  if (input >= last[inputKey]) return last[outputKey]

  let low = 0
  let high = normalized.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (normalized[middle][inputKey] <= input) low = middle
    else high = middle
  }

  const before = normalized[low]
  const after = normalized[high]
  const span = after[inputKey] - before[inputKey]
  if (span <= 0) return after[outputKey]
  const progress = (input - before[inputKey]) / span
  return before[outputKey] + (after[outputKey] - before[outputKey]) * progress
}

function normalizePoints(
  points: readonly MarkdownScrollPoint[],
  inputKey: keyof MarkdownScrollPoint,
): MarkdownScrollPoint[] {
  const sorted = points
    .filter((point) => Number.isFinite(point.sourceLine) && Number.isFinite(point.scrollTop))
    .slice()
    .sort((left, right) => left[inputKey] - right[inputKey])
  const normalized: MarkdownScrollPoint[] = []
  for (const point of sorted) {
    if (normalized[normalized.length - 1]?.[inputKey] === point[inputKey]) {
      normalized[normalized.length - 1] = point
    } else normalized.push(point)
  }
  return normalized
}
